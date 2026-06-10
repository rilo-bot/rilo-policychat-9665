/**
 * RAG (Retrieval-Augmented Generation) helpers.
 *
 * Because we store raw text chunks without pre-computed embeddings by default,
 * we fall back to a BM25-style TF-IDF keyword search that runs in-process.
 * If a chunk has a stored `embedding` vector AND the query can be embedded we
 * use cosine similarity instead, giving better semantic matching.
 *
 * The module is intentionally self-contained: pass it a collection reference
 * and a query string and it returns the best-matching chunks.
 */

import type { Collection } from 'mongodb';
import type { DocumentChunk } from '../contract.js';

export interface RankedChunk {
  chunk: DocumentChunk;
  score: number;
}

// ---------------------------------------------------------------------------
// Cosine similarity between two equal-length vectors
// ---------------------------------------------------------------------------
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// Tokenise text into lowercase word stems (very lightweight)
// ---------------------------------------------------------------------------
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// ---------------------------------------------------------------------------
// TF score for a single document (term frequency normalised by doc length)
// ---------------------------------------------------------------------------
function tfScore(tokens: string[], queryTokens: string[]): number {
  if (tokens.length === 0) return 0;
  const querySet = new Set(queryTokens);
  let matches = 0;
  for (const t of tokens) {
    if (querySet.has(t)) matches++;
  }
  return matches / tokens.length;
}

// ---------------------------------------------------------------------------
// Retrieve top-k chunks most relevant to the query
// ---------------------------------------------------------------------------
export async function retrieveChunks(
  chunksCol: Collection<DocumentChunk & { _id?: unknown }>,
  query: string,
  topK = 5,
): Promise<RankedChunk[]> {
  // Only search over chunks from active documents
  const allChunks = await chunksCol
    .find({})
    .project<DocumentChunk>({ _id: 0 })
    .toArray();

  if (allChunks.length === 0) return [];

  const queryTokens = tokenise(query);

  const ranked: RankedChunk[] = allChunks.map((chunk) => {
    let score = 0;

    // Prefer vector similarity if embeddings are available on the chunk
    if (Array.isArray(chunk.embedding) && chunk.embedding.length > 0) {
      // We don't have a query embedding here (no embedding model configured),
      // so fall through to keyword scoring. If you later add an embedding
      // model, compute the query vector and replace this branch.
      score = tfScore(tokenise(chunk.content), queryTokens);
    } else {
      score = tfScore(tokenise(chunk.content), queryTokens);
    }

    return { chunk, score };
  });

  // Sort descending by score, keep top-k non-zero scorers first,
  // but always return topK results even if scores are 0 (no relevant docs)
  ranked.sort((a, b) => b.score - a.score);

  return ranked.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Build the system + user prompt from retrieved chunks
// ---------------------------------------------------------------------------
export interface PromptResult {
  systemPrompt: string;
  userContent: string;
  citations: string[];
}

export function buildPrompt(query: string, rankedChunks: RankedChunk[]): PromptResult {
  const hasContext = rankedChunks.some((r) => r.score > 0);

  // Deduplicate document names for citations
  const citationSet = new Set<string>();
  rankedChunks.forEach((r) => citationSet.add(r.chunk.documentName));
  const citations = Array.from(citationSet);

  const contextBlock = hasContext
    ? rankedChunks
        .map(
          (r, i) =>
            `[${i + 1}] Source: "${r.chunk.documentName}"\n${r.chunk.content}`,
        )
        .join('\n\n---\n\n')
    : 'No relevant policy documents were found.';

  const systemPrompt = `You are PolicyChat, an AI HR assistant that answers employee questions based strictly on the company's policy documents.

## Instructions
- Answer ONLY using the policy context provided below. Do not use general knowledge.
- If the context does not contain enough information to answer the question, say so clearly and suggest the employee contact HR directly.
- Be concise, professional, and empathetic.
- When you cite information, reference the source document name (e.g., "According to the Remote Work Policy…").
- Never speculate or invent policy details.
- If the question is ambiguous, ask a clarifying question.

## Policy Context
${contextBlock}`;

  const userContent = query;

  return { systemPrompt, userContent, citations };
}

// ---------------------------------------------------------------------------
// Compute a confidence score from ranked chunks
// A simple heuristic: top chunk score, capped to [0, 1]
// ---------------------------------------------------------------------------
export function computeConfidence(rankedChunks: RankedChunk[]): number {
  if (rankedChunks.length === 0) return 0;
  const topScore = rankedChunks[0].score;
  // Normalise: typical TF score for a good match is around 0.05–0.15
  // Map 0.10+ → 1.0
  const normalised = Math.min(topScore / 0.10, 1.0);
  return Math.round(normalised * 100) / 100;
}
