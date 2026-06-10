import { Router, Request, Response } from 'express';
import type { Db } from 'mongodb';
import type { AnalyticsEvent } from '../contract.js';

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------
export function createAnalyticsRouter(db: Db): Router {
  const router = Router();

  const analytics = db.collection<AnalyticsEvent & { _id?: unknown }>('analytics_events');
  const conversations = db.collection<{ id: string }>('conversations');
  const messages = db.collection<{ id: string; feedback?: 'up' | 'down' | null }>('messages');

  // -------------------------------------------------------------------------
  // GET /api/admin/analytics — aggregate usage stats for the dashboard
  // -------------------------------------------------------------------------
  router.get('/analytics', async (_req: Request, res: Response) => {
    try {
      // Total conversations
      const totalConversations = await conversations.countDocuments({});

      // Total messages
      const totalMessages = await messages.countDocuments({});

      // Escalation rate: number of escalated events / total conversations
      const escalatedCount = await analytics.countDocuments({ type: 'escalated' });
      const escalationRate =
        totalConversations > 0
          ? parseFloat((escalatedCount / totalConversations).toFixed(4))
          : 0;

      // Feedback breakdown from the messages collection
      const thumbsUp = await messages.countDocuments({ feedback: 'up' });
      const thumbsDown = await messages.countDocuments({ feedback: 'down' });

      // Top questions — pulled from analytics_events of type 'question_asked'
      // where metadata JSON contains a 'question' field.
      // We aggregate and count by the question text (stored in metadata).
      const questionEvents = await analytics
        .find({ type: 'question_asked' }, { projection: { metadata: 1 } })
        .toArray();

      // Tally questions by text
      const questionCounts: Record<string, number> = {};
      for (const event of questionEvents) {
        if (!event.metadata) continue;
        try {
          const parsed = JSON.parse(event.metadata) as { question?: string };
          const q = parsed.question?.trim();
          if (q) {
            questionCounts[q] = (questionCounts[q] ?? 0) + 1;
          }
        } catch {
          // Malformed metadata — skip silently
        }
      }

      // Sort by count descending, take top 10
      const topQuestions = Object.entries(questionCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([question, count]) => ({ question, count }));

      res.json({
        totalConversations,
        totalMessages,
        escalationRate,
        thumbsUp,
        thumbsDown,
        topQuestions,
      });
    } catch (err) {
      console.error('get-analytics error:', err);
      res.status(500).json({ error: 'Failed to retrieve analytics.' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/admin/audit — paginated audit log of all analytics events
  // -------------------------------------------------------------------------
  router.get('/audit', async (req: Request, res: Response) => {
    try {
      const pageParam = parseInt((req.query.page as string) ?? '1', 10);
      const pageSizeParam = parseInt((req.query.pageSize as string) ?? '20', 10);

      const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
      const pageSize =
        isNaN(pageSizeParam) || pageSizeParam < 1
          ? 20
          : pageSizeParam > 100
          ? 100
          : pageSizeParam;

      const skip = (page - 1) * pageSize;

      const [total, rawEvents] = await Promise.all([
        analytics.countDocuments({}),
        analytics
          .find({})
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(pageSize)
          .toArray(),
      ]);

      const events: AnalyticsEvent[] = rawEvents.map((e) => {
        const { _id, ...rest } = e;
        void _id;
        return rest as AnalyticsEvent;
      });

      res.json({ events, total, page, pageSize });
    } catch (err) {
      console.error('get-audit-log error:', err);
      res.status(500).json({ error: 'Failed to retrieve audit log.' });
    }
  });

  return router;
}
