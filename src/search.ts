import { addSpend } from "./limits";
import { hasOpenAI, openai } from "./providers";
import type { Bundle, Deps, Env, Note } from "./types";

/**
 * Embedding search over the notes, using OpenAI embeddings.
 *
 * Each note is cut into its sections. Every section gets a vector, once, and
 * the vectors are kept in KV next to the notes. A question gets one vector of
 * its own, and the notes whose sections sit closest to it are the ones the
 * model is given. The model still has to cite a note, so search decides what
 * it reads, not what it may claim.
 */

const INDEX_KEY = "kb:vectors";
const DIMENSIONS = 256;
const TOP_NOTES = 5;

interface Chunk {
  note: string;
  heading: string;
  vector: number[];
}

interface Index {
  /** A fingerprint of the notes this index was built from. */
  fingerprint: string;
  model: string;
  chunks: Chunk[];
}

export interface SearchHit {
  note: string;
  heading: string;
  score: number;
}

export interface SearchResult {
  /** The notes to give the model, best first. */
  notes: Note[];
  hits: SearchHit[];
  model: string;
  /** True when the index had to be built on this request. */
  indexed: boolean;
  chunks: number;
  costMicroUsd: number;
}

export function searchSettings(env: Env) {
  return {
    on: hasOpenAI(env),
    model: env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    // Dollars per million tokens, for the daily spend cap.
    price: Number(env.OPENAI_EMBEDDING_PRICE_PER_MTOK || "0.02"),
  };
}

/** A note becomes one piece per "## " section, each carrying the note's title. */
export function chunksOf(notes: Note[]): { note: string; heading: string; text: string }[] {
  return notes.flatMap((note) => {
    const parts = note.body.split(/\n(?=## )/);
    return parts
      .map((part) => {
        const heading = part.startsWith("## ") ? part.slice(3, part.indexOf("\n") > 0 ? part.indexOf("\n") : undefined).trim() : "Overview";
        return { note: note.id, heading, text: `${note.title}. ${heading}.\n${part.replace(/^## .*\n?/, "").trim()}` };
      })
      .filter((c) => c.text.length > note.title.length + c.heading.length + 6);
  });
}

async function fingerprintOf(bundle: Bundle, model: string): Promise<string> {
  const bytes = new TextEncoder().encode(model + JSON.stringify(bundle.notes.map((n) => [n.id, n.title, n.body])));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function embed(env: Env, deps: Deps, inputs: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const { model } = searchSettings(env);
  const res = await openai(env, deps, "/embeddings", { model, input: inputs, dimensions: DIMENSIONS });
  if (!res.ok) throw new Error(`OpenAI embeddings returned ${res.status}`);
  const body = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
  const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (vectors.length !== inputs.length) throw new Error("OpenAI embeddings returned the wrong number of vectors");
  return { vectors, tokens: body.usage?.total_tokens ?? 0 };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Finds the notes closest to the question. Returns null when search is off or
 * fails, and the caller then gives the model every note, as before.
 */
export async function searchNotes(env: Env, deps: Deps, bundle: Bundle, question: string): Promise<SearchResult | null> {
  const cfg = searchSettings(env);
  if (!cfg.on) return null;
  try {
    let tokens = 0;
    const fingerprint = await fingerprintOf(bundle, cfg.model);
    const stored = await env.STORE.get(INDEX_KEY);
    let index = stored ? (JSON.parse(stored) as Index) : null;
    let indexed = false;

    // The index is rebuilt whenever the notes change, on the first question after.
    if (!index || index.fingerprint !== fingerprint) {
      const pieces = chunksOf(bundle.notes);
      const built = await embed(env, deps, pieces.map((p) => p.text));
      tokens += built.tokens;
      index = { fingerprint, model: cfg.model, chunks: pieces.map((p, i) => ({ note: p.note, heading: p.heading, vector: built.vectors[i] })) };
      await env.STORE.put(INDEX_KEY, JSON.stringify(index));
      indexed = true;
    }

    const asked = await embed(env, deps, [question]);
    tokens += asked.tokens;
    const scored = index.chunks.map((c) => ({ note: c.note, heading: c.heading, score: cosine(asked.vectors[0], c.vector) })).sort((a, b) => b.score - a.score);

    // A note ranks by its best section.
    const best = new Map<string, SearchHit>();
    for (const hit of scored) if (!best.has(hit.note)) best.set(hit.note, hit);
    const hits = [...best.values()].slice(0, TOP_NOTES).map((h) => ({ ...h, score: Math.round(h.score * 100) / 100 }));

    // The contact note always rides along, so "how do I reach them" never misses.
    const ids = new Set([...hits.map((h) => h.note), "contact"]);
    const notes = [...hits.map((h) => h.note), "contact"]
      .filter((id, i, all) => all.indexOf(id) === i && ids.has(id))
      .map((id) => bundle.notes.find((n) => n.id === id))
      .filter((n): n is Note => Boolean(n));

    const costMicroUsd = Math.ceil(tokens * cfg.price);
    await addSpend(env, deps, costMicroUsd);
    return { notes, hits, model: cfg.model, indexed, chunks: index.chunks.length, costMicroUsd };
  } catch (error) {
    console.error("search failed", error);
    return null;
  }
}
