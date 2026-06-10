/**
 * AUTO-GENERATED — DO NOT EDIT.
 * This is the shared API contract for this app, regenerated from the plan on
 * every build. Both the frontend (@/contract) and the backend (./contract)
 * import these types so the request/response shapes can never drift.
 */


export interface Conversation {
  /** Unique conversation identifier */
  id: string;
  /** Anonymous session identifier for the employee */
  sessionId: string;
  /** Auto-generated title from the first message */
  title: string;
  /** ISO timestamp when conversation started */
  createdAt: string;
  /** ISO timestamp of last message */
  updatedAt: string;
  /** Current state of the conversation */
  status: 'active' | 'escalated' | 'resolved';
}

export interface Message {
  /** Unique message identifier */
  id: string;
  /** Parent conversation id */
  conversationId: string;
  /** Who sent the message */
  role: 'user' | 'assistant';
  /** Text content of the message */
  content: string;
  /** Policy document names or sections cited in the response */
  citations?: string[];
  /** Retrieval confidence score 0–1 for assistant messages */
  confidenceScore?: number;
  /** Whether this message triggered human escalation */
  escalated: boolean;
  /** Employee thumbs up/down rating for this message */
  feedback?: 'up' | 'down' | null;
  /** ISO timestamp */
  createdAt: string;
}

export interface PolicyDocument {
  /** Unique document identifier */
  id: string;
  /** Original uploaded filename */
  filename: string;
  /** S3 object key for the stored file */
  s3Key: string;
  /** Human-readable policy name */
  displayName: string;
  /** Short description of what the policy covers */
  description?: string;
  /** Whether the document is live, retired, or still being indexed */
  status: 'active' | 'retired' | 'processing';
  /** ISO timestamp of upload */
  uploadedAt: string;
  /** ISO timestamp when retired, if applicable */
  retiredAt?: string | null;
  /** Number of text chunks indexed from this document */
  chunkCount?: number;
}

export interface DocumentChunk {
  /** Unique chunk identifier */
  id: string;
  /** Parent PolicyDocument id */
  documentId: string;
  /** Display name of source document */
  documentName: string;
  /** Position of this chunk within the document */
  chunkIndex: number;
  /** Raw text content of the chunk */
  content: string;
  /** Vector embedding for semantic search */
  embedding?: number[];
  /** ISO timestamp */
  createdAt: string;
}

export interface AnalyticsEvent {
  /** Unique event identifier */
  id: string;
  /** Type of event */
  type: 'question_asked' | 'escalated' | 'feedback_given' | 'document_uploaded' | 'document_retired';
  /** Related conversation, if applicable */
  conversationId?: string | null;
  /** Related message, if applicable */
  messageId?: string | null;
  /** Related policy document, if applicable */
  documentId?: string | null;
  /** JSON-encoded extra details (e.g. top question text) */
  metadata?: string;
  /** ISO timestamp */
  createdAt: string;
}

export interface ApiContract {
  "create-conversation": { method: "POST"; path: "/api/conversations"; request: { sessionId: string }; response: Conversation };
  "list-conversations": { method: "GET"; path: "/api/conversations"; request: void; response: Conversation[] };
  "get-conversation": { method: "GET"; path: "/api/conversations/:id"; request: void; response: { conversation: Conversation; messages: Message[] } };
  "send-message": { method: "POST"; path: "/api/conversations/:id/messages"; request: { content: string }; response: { userMessage: Message; assistantMessage: Message } };
  "submit-feedback": { method: "PATCH"; path: "/api/messages/:id/feedback"; request: { feedback: 'up' | 'down' }; response: Message };
  "list-documents": { method: "GET"; path: "/api/admin/documents"; request: void; response: PolicyDocument[] };
  "upload-document": { method: "POST"; path: "/api/admin/documents"; request: FormData; response: PolicyDocument };
  "retire-document": { method: "PATCH"; path: "/api/admin/documents/:id/retire"; request: void; response: PolicyDocument };
  "get-analytics": { method: "GET"; path: "/api/admin/analytics"; request: void; response: { totalConversations: number; totalMessages: number; escalationRate: number; thumbsUp: number; thumbsDown: number; topQuestions: { question: string; count: number }[] } };
  "get-audit-log": { method: "GET"; path: "/api/admin/audit"; request: void; response: { events: AnalyticsEvent[]; total: number; page: number; pageSize: number } };
}

export const API_ROUTES = {
  "create-conversation": { method: "POST", path: "/api/conversations" },
  "list-conversations": { method: "GET", path: "/api/conversations" },
  "get-conversation": { method: "GET", path: "/api/conversations/:id" },
  "send-message": { method: "POST", path: "/api/conversations/:id/messages" },
  "submit-feedback": { method: "PATCH", path: "/api/messages/:id/feedback" },
  "list-documents": { method: "GET", path: "/api/admin/documents" },
  "upload-document": { method: "POST", path: "/api/admin/documents" },
  "retire-document": { method: "PATCH", path: "/api/admin/documents/:id/retire" },
  "get-analytics": { method: "GET", path: "/api/admin/analytics" },
  "get-audit-log": { method: "GET", path: "/api/admin/audit" },
} as const;
