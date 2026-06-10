import { Router, Request, Response } from 'express';
import type { Db } from 'mongodb';
import crypto from 'crypto';
import type { Message, AnalyticsEvent } from '../contract.js';

/**
 * Route factory for message-level operations.
 * Currently handles: PATCH /api/messages/:id/feedback
 */
export function createMessagesRouter(db: Db): Router {
  const router = Router();

  const messages = db.collection<Message & { _id?: unknown }>('messages');
  const analytics = db.collection<AnalyticsEvent & { _id?: unknown }>('analytics_events');

  // ---------------------------------------------------------------------------
  // Helper: fire-and-forget analytics insert
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // PATCH /api/messages/:id/feedback — record thumbs up/down on a message
  // ---------------------------------------------------------------------------
  router.patch('/:id/feedback', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const body = req.body as { feedback?: unknown };

      // Validate feedback value
      if (
        !body.feedback ||
        (body.feedback !== 'up' && body.feedback !== 'down')
      ) {
        res.status(400).json({ error: "feedback must be 'up' or 'down'." });
        return;
      }

      const feedback = body.feedback as 'up' | 'down';

      // Retrieve the message to confirm it exists
      const existing = await messages.findOne({ id }, { projection: { _id: 0 } });
      if (!existing) {
        res.status(404).json({ error: 'Message not found.' });
        return;
      }

      // Persist the feedback rating
      await messages.updateOne({ id }, { $set: { feedback } });

      // Build the updated message for the response
      const updated: Message = { ...(existing as Message), feedback };

      // Fire analytics event (non-blocking)
      trackEvent({
        type: 'feedback_given',
        conversationId: existing.conversationId ?? null,
        messageId: id,
        documentId: null,
        metadata: JSON.stringify({ feedback }),
      });

      res.json(updated);
    } catch (err) {
      console.error('submit-feedback error:', err);
      res.status(500).json({ error: 'Failed to record feedback.' });
    }
  });

  return router;
}
