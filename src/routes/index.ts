import type { Express } from 'express';
import type { Db } from 'mongodb';
import { createDocumentsRouter } from './documents';
import { createConversationsRouter } from './conversations';
import { createMessagesRouter } from './messages';
import { createAnalyticsRouter } from './analytics';

/**
 * Register every API route here.
 *
 * Create route modules under src/ (e.g. src/routes/tasks.ts) and call them from
 * this function. `db` is the connected MongoDB database (native driver) —
 * use `db.collection('name')` directly; there are NO schemas or models.
 *
 * The shared API contract lives in ./contract (engine-owned — DO NOT edit it).
 * Import its types so your request/response shapes match the frontend exactly.
 */
export function registerRoutes(app: Express, db: Db): void {
  // Conversations: create, list, get, send message (RAG + Claude)
  app.use('/api/conversations', createConversationsRouter(db));

  // Policy document management (list, upload, retire)
  app.use('/api/admin/documents', createDocumentsRouter(db));

  // Message-level operations: feedback (thumbs up/down)
  app.use('/api/messages', createMessagesRouter(db));

  // Analytics & audit log for the admin dashboard
  app.use('/api/admin', createAnalyticsRouter(db));
}
