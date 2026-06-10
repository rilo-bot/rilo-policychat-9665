import { Router, Request, Response } from 'express';
import type { Db } from 'mongodb';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import type { PolicyDocument, DocumentChunk, AnalyticsEvent } from '../contract.js';

// ---------------------------------------------------------------------------
// S3 client — credentials come from environment variables only
// ---------------------------------------------------------------------------
function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    requestHandler: {
      // Give each S3 call a generous but bounded timeout (10 s)
      requestTimeout: 10_000,
    },
  });
}

// ---------------------------------------------------------------------------
// Multer — store upload in memory so we can read bytes and ship to S3
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain', 'text/markdown'];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.txt') || file.originalname.endsWith('.md')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, TXT, and Markdown files are supported.'));
    }
  },
});

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/** Extract plain text from a Buffer, dispatching on mime type / extension. */
async function extractText(buffer: Buffer, mimetype: string, filename: string): Promise<string> {
  if (mimetype === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
    // Dynamically import pdf-parse (CJS interop)
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text ?? '';
  }
  // Plain text / markdown — just decode as UTF-8
  return buffer.toString('utf-8');
}

/** Split text into overlapping chunks of ~500 words each with a 50-word overlap. */
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + chunkSize);
    chunks.push(slice.join(' '));
    i += chunkSize - overlap;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------
export function createDocumentsRouter(db: Db): Router {
  const router = Router();

  const docs = db.collection<PolicyDocument & { _id?: unknown }>('policy_documents');
  const chunks = db.collection<DocumentChunk & { _id?: unknown }>('document_chunks');
  const analytics = db.collection<AnalyticsEvent & { _id?: unknown }>('analytics_events');

  // -------------------------------------------------------------------------
  // GET /api/admin/documents — list all documents
  // -------------------------------------------------------------------------
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const results = await docs.find({}).sort({ uploadedAt: -1 }).toArray();
      const documents: PolicyDocument[] = results.map((d) => {
        const { _id, ...rest } = d;
        void _id;
        return rest as PolicyDocument;
      });
      res.json(documents);
    } catch (err) {
      console.error('list-documents error:', err);
      res.status(500).json({ error: 'Failed to retrieve documents.' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/admin/documents — upload a new document
  // -------------------------------------------------------------------------
  router.post(
    '/',
    upload.single('file'),
    async (req: Request, res: Response) => {
      try {
        const file = req.file;
        if (!file) {
          res.status(400).json({ error: 'A file is required.' });
          return;
        }

        const { displayName, description } = req.body as {
          displayName?: string;
          description?: string;
        };

        if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
          res.status(400).json({ error: 'displayName is required.' });
          return;
        }

        const bucket = process.env.S3_BUCKET;
        if (!bucket) {
          res.status(500).json({ error: 'S3 bucket is not configured.' });
          return;
        }

        // Build a unique S3 key
        const ext = file.originalname.split('.').pop() ?? 'bin';
        const docId = crypto.randomUUID();
        const s3Key = `policy-documents/${docId}/${file.originalname}`;

        // Upload to S3
        const s3 = getS3Client();
        try {
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: s3Key,
              Body: file.buffer,
              ContentType: file.mimetype,
            })
          );
        } catch (s3Err) {
          console.error('S3 upload error:', s3Err);
          res.status(502).json({ error: 'Failed to upload file to storage. Please try again.' });
          return;
        }
        void ext;

        const now = new Date().toISOString();

        // Persist document record as 'processing' first
        const docRecord: PolicyDocument = {
          id: docId,
          filename: file.originalname,
          s3Key,
          displayName: displayName.trim(),
          description: description?.trim() ?? undefined,
          status: 'processing',
          uploadedAt: now,
          retiredAt: null,
          chunkCount: 0,
        };

        await docs.insertOne({ ...docRecord });

        // Fire analytics event
        const uploadEvent: AnalyticsEvent = {
          id: crypto.randomUUID(),
          type: 'document_uploaded',
          documentId: docId,
          conversationId: null,
          messageId: null,
          metadata: JSON.stringify({ filename: file.originalname, displayName: displayName.trim() }),
          createdAt: now,
        };
        await analytics.insertOne({ ...uploadEvent });

        // Extract text and chunk — do this synchronously so the caller knows
        // the final chunk count, but guard against extraction failures.
        let finalStatus: PolicyDocument['status'] = 'active';
        let chunkCount = 0;

        try {
          const text = await extractText(file.buffer, file.mimetype, file.originalname);
          const textChunks = chunkText(text);

          const chunkDocs: (DocumentChunk & { _id?: unknown })[] = textChunks.map((content, idx) => ({
            id: crypto.randomUUID(),
            documentId: docId,
            documentName: displayName.trim(),
            chunkIndex: idx,
            content,
            createdAt: now,
          }));

          if (chunkDocs.length > 0) {
            await chunks.insertMany(chunkDocs);
          }

          chunkCount = chunkDocs.length;
        } catch (extractErr) {
          console.error('Text extraction error (document will remain processing):', extractErr);
          // Keep status as 'processing' if extraction failed — the admin can retry later
          finalStatus = 'processing';
        }

        // Update document to active with final chunk count
        await docs.updateOne(
          { id: docId },
          { $set: { status: finalStatus, chunkCount } }
        );

        const finalDoc: PolicyDocument = {
          ...docRecord,
          status: finalStatus,
          chunkCount,
        };

        res.status(201).json(finalDoc);
      } catch (err) {
        console.error('upload-document error:', err);
        res.status(500).json({ error: 'Failed to upload document.' });
      }
    }
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/documents/:id/retire — retire a document
  // -------------------------------------------------------------------------
  router.patch('/:id/retire', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'Document id is required.' });
        return;
      }

      const existing = await docs.findOne({ id });
      if (!existing) {
        res.status(404).json({ error: 'Document not found.' });
        return;
      }

      if (existing.status === 'retired') {
        // Already retired — return as-is (idempotent)
        const { _id, ...rest } = existing;
        void _id;
        res.json(rest as PolicyDocument);
        return;
      }

      const retiredAt = new Date().toISOString();
      await docs.updateOne({ id }, { $set: { status: 'retired', retiredAt } });

      // Fire analytics event
      const retireEvent: AnalyticsEvent = {
        id: crypto.randomUUID(),
        type: 'document_retired',
        documentId: id,
        conversationId: null,
        messageId: null,
        metadata: JSON.stringify({ displayName: existing.displayName }),
        createdAt: retiredAt,
      };
      await analytics.insertOne({ ...retireEvent });

      const { _id, ...rest } = existing;
      void _id;
      const updated: PolicyDocument = {
        ...(rest as PolicyDocument),
        status: 'retired',
        retiredAt,
      };

      res.json(updated);
    } catch (err) {
      console.error('retire-document error:', err);
      res.status(500).json({ error: 'Failed to retire document.' });
    }
  });

  return router;
}
