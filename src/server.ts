import 'dotenv/config';
// Makes Express 4 forward errors thrown in ASYNC route handlers to the central
// error handler below — without it, an async throw/rejection hangs the request
// until the socket times out. Import once, before routes are registered.
import 'express-async-errors';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import cors from 'cors';
import { connectDb } from './db';
import { registerRoutes } from './routes';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Request log — one line per request: method, path, status, and duration. This
// is the app's OWN observability (independent of the host's access logs). The
// host pings /health every few seconds to check liveness; skip it so the log
// shows real API traffic instead of a wall of health checks.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// Liveness probe — the deploy waits for this to return 200 before connecting
// the frontend. Always available, even before the database is ready.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

async function main(): Promise<void> {
  const db = await connectDb();

  // The build wires every API route in here.
  registerRoutes(app, db);

  // Unknown route → 404 JSON.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler — the single error shape the whole API returns:
  // { error: string }. Never leak stack traces to the client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
