import { Router, Request, Response } from 'express';
import type { Db } from 'mongodb';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { Conversation, Message, DocumentChunk, AnalyticsEvent } from '../contract.js';
import { retrieveChunks, buildPrompt, computeConfidence } from '../lib/rag';

// ---------------------------------------------------------------------------
// Anthropic client — created lazily with a 30 s timeout
// ---------------------------------------------------------------------------
function getAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    timeout: 30_000,
  });
}

// Confidence threshold below which we escalate
const ESCALATION_THRESHOLD = 0.30;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------
export function createConversationsRouter(db: Db): Router {
  const router = Router();

  const conversations = db.collection<Conversation & { _id?: unknown }>('conversations');
  const messages = db.collection<Message & { _id?: unknown }>('messages');
  const chunks = db.collection<DocumentChunk & { _id?: unknown }>('document_chunks');
  const analytics = db.collection<AnalyticsEvent & { _id?: unknown }>('analytics_events');

  // -------------------------------------------------------------------------
  // Helper: fire-and-forget analytics insert
  // -------------------------------------------------------------------------
  function trackEvent(event: Omit<AnalyticsEvent, 'id' | 'createdAt'>): void {
    const doc: AnalyticsEvent = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...event,
    };
    analytics.insertOne({ ...doc }).catch((err) => {
      console.error('analytics insert error:', err);
    });
  }

  // -------------------------------------------------------------------------
  // POST /api/conversations — start a new conversation
  // -------------------------------------------------------------------------
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = req.body as { sessionId?: unknown };

      if (!body.sessionId || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
        res.status(400).json({ error: 'sessionId is required.' });
        return;
      }

      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        sessionId: body.sessionId.trim(),
        title: 'New Conversation',
        createdAt: now,
        updatedAt: now,
        status: 'active',
      };

      await conversations.insertOne({ ...conversation });

      res.status(201).json(conversation);
    } catch (err) {
      console.error('create-conversation error:', err);
      res.status(500).json({ error: 'Failed to create conversation.' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/conversations — list conversations for a session
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.query;

      const filter: Record<string, unknown> = {};
      if (sessionId && typeof sessionId === 'string' && sessionId.trim()) {
        filter.sessionId = sessionId.trim();
      }

      const results = await conversations
        .find(filter)
        .sort({ updatedAt: -1 })
        .project<Conversation>({ _id: 0 })
        .toArray();

      res.json(results);
    } catch (err) {
      console.error('list-conversations error:', err);
      res.status(500).json({ error: 'Failed to list conversations.' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/conversations/:id — get conversation + messages
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const conversation = await conversations.findOne(
        { id },
        { projection: { _id: 0 } },
      );

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }

      const msgs = await messages
        .find({ conversationId: id })
        .sort({ createdAt: 1 })
        .project<Message>({ _id: 0 })
        .toArray();

      res.json({ conversation: conversation as Conversation, messages: msgs });
    } catch (err) {
      console.error('get-conversation error:', err);
      res.status(500).json({ error: 'Failed to retrieve conversation.' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/conversations/:id/messages — send a message + RAG + Claude
  // -------------------------------------------------------------------------
  router.post('/:id/messages', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const body = req.body as { content?: unknown };

      if (!body.content || typeof body.content !== 'string' || !body.content.trim()) {
        res.status(400).json({ error: 'content is required.' });
        return;
      }

      // Verify conversation exists
      const conversation = await conversations.findOne({ id });
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }

      const now = new Date().toISOString();
      const userContent = body.content.trim();

      // -----------------------------------------------------------------------
      // 1. Persist the user message
      // -----------------------------------------------------------------------
      const userMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: id,
        role: 'user',
        content: userContent,
        escalated: false,
        createdAt: now,
      };

      await messages.insertOne({ ...userMessage });

      // Track analytics
      trackEvent({
        type: 'question_asked',
        conversationId: id,
        messageId: userMessage.id,
        documentId: null,
        metadata: JSON.stringify({ question: userContent.slice(0, 200) }),
      });

      // -----------------------------------------------------------------------
      // 2. Retrieve relevant chunks (RAG)
      // -----------------------------------------------------------------------
      const rankedChunks = await retrieveChunks(chunks, userContent, 5);
      const confidence = computeConfidence(rankedChunks);
      const { systemPrompt, userContent: promptContent, citations } = buildPrompt(
        userContent,
        rankedChunks,
      );

      // -----------------------------------------------------------------------
      // 3. Build conversation history for Claude (last 10 messages for context)
      // -----------------------------------------------------------------------
      const history = await messages
        .find({ conversationId: id, id: { $ne: userMessage.id } })
        .sort({ createdAt: -1 })
        .limit(10)
        .project<Message>({ _id: 0 })
        .toArray();

      history.reverse(); // chronological order

      const claudeMessages: Anthropic.MessageParam[] = [
        ...history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user' as const, content: promptContent },
      ];

      // -----------------------------------------------------------------------
      // 4. Call Claude 3.5 Sonnet
      // -----------------------------------------------------------------------
      let assistantContent: string;

      try {
        const anthropic = getAnthropicClient();
        const response = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1024,
          system: systemPrompt,
          messages: claudeMessages,
        });

        // Extract text from content blocks
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === 'text',
        );
        assistantContent =
          textBlocks.map((b) => b.text).join('\n') ||
          "I'm sorry, I couldn't generate a response. Please try again.";
      } catch (aiErr) {
        console.error('Anthropic API error:', aiErr);
        res.status(502).json({
          error:
            'The AI service is temporarily unavailable. Please try again in a moment.',
        });
        return;
      }

      // -----------------------------------------------------------------------
      // 5. Determine escalation
      // -----------------------------------------------------------------------
      const shouldEscalate = confidence < ESCALATION_THRESHOLD;

      // -----------------------------------------------------------------------
      // 6. Persist assistant message
      // -----------------------------------------------------------------------
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: id,
        role: 'assistant',
        content: assistantContent,
        citations: citations.length > 0 ? citations : undefined,
        confidenceScore: confidence,
        escalated: shouldEscalate,
        createdAt: new Date().toISOString(),
      };

      await messages.insertOne({ ...assistantMessage });

      // -----------------------------------------------------------------------
      // 7. Update conversation title (first exchange) and updatedAt / status
      // -----------------------------------------------------------------------
      const updatedAt = assistantMessage.createdAt;
      const newStatus: Conversation['status'] = shouldEscalate ? 'escalated' : conversation.status;

      // Generate a title from the first user message if the title is still default
      const titleUpdate: Record<string, unknown> = { updatedAt, status: newStatus };
      if (conversation.title === 'New Conversation') {
        // Truncate to ~60 chars for a readable title
        titleUpdate.title =
          userContent.length > 60
            ? userContent.slice(0, 57).trimEnd() + '…'
            : userContent;
      }

      await conversations.updateOne({ id }, { $set: titleUpdate });

      // -----------------------------------------------------------------------
      // 8. Fire analytics for escalation if triggered
      // -----------------------------------------------------------------------
      if (shouldEscalate) {
        trackEvent({
          type: 'escalated',
          conversationId: id,
          messageId: assistantMessage.id,
          documentId: null,
          metadata: JSON.stringify({ confidenceScore: confidence }),
        });
      }

      res.status(201).json({ userMessage, assistantMessage });
    } catch (err) {
      console.error('send-message error:', err);
      res.status(500).json({ error: 'Failed to send message.' });
    }
  });

  return router;
}
