import { settings } from "./config";
import type { Deps, Env } from "./types";

/**
 * Every record is one JSON value in private KV under "log:<time>:<random>".
 * Each is written with a time to live, so KV deletes it by itself when the
 * retention period ends. Records never hold access codes, secrets or IPs.
 */
export type LogEvent =
  | { type: "access"; ok: boolean; label: string; codeId?: string }
  | {
      type: "turn";
      sid: string;
      codeId: string;
      label: string;
      question: string;
      answer: string;
      /** answered, refused or unknown, plus the two minor kinds. */
      outcome: "answered" | "refused" | "unknown" | "contact" | "smalltalk";
      sources: string[];
      mode: "live" | "stub";
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
    }
  | {
      type: "safety";
      what: "injection" | "dump" | "leak_blocked" | "visitor_limit" | "spend_cap" | "wrong_code_limit" | "voice_cap";
      sid?: string;
      label?: string;
      question?: string;
    }
  | { type: "voice"; sid: string; codeId: string; label: string; chars: number }
  | { type: "contact"; id: string; state: string; label: string }
  | { type: "demo"; sid: string; label: string; demo: string; case: string; action: "run" | "approve" | "send" | "list" | "research" | "ask" | "decide"; result: string }
  | { type: "error"; where: string; message: string };

export type Logged = LogEvent & { at: string };

let sequence = 0;

export async function logEvent(env: Env, deps: Deps, event: LogEvent): Promise<void> {
  try {
    const at = deps.now().toISOString();
    // The counter keeps events written in the same millisecond in order.
    const key = `log:${at}:${String(sequence++ % 1_000_000).padStart(6, "0")}${crypto.randomUUID().slice(0, 6)}`;
    const ttl = settings(env).retentionDays * 86_400;
    await env.STORE.put(key, JSON.stringify({ ...event, at }), { expirationTtl: ttl });
  } catch (error) {
    // Logging must never break an answer.
    console.error("log write failed", error);
  }
}

export async function readLogs(env: Env, deps: Deps, days: number): Promise<Logged[]> {
  const since = new Date(deps.now().getTime() - days * 86_400_000).toISOString();
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STORE.list({ prefix: "log:", cursor });
    for (const key of page.keys) if (key.name.slice(4) >= since) names.push(key.name);
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);

  const events: Logged[] = [];
  for (let i = 0; i < names.length; i += 50) {
    const values = await Promise.all(names.slice(i, i + 50).map((name) => env.STORE.get(name)));
    for (const value of values) if (value) events.push(JSON.parse(value) as Logged);
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** The numbers and lists the admin page shows. */
export function summarise(events: Logged[]) {
  const perCode: Record<string, { label: string; entries: number; messages: number; costUsd: number; voiceChars: number; lastSeen: string }> = {};
  const perDay: Record<string, { messages: number; inputTokens: number; outputTokens: number; costUsd: number; voiceChars: number }> = {};
  const conversations: Record<string, { sid: string; label: string; startedAt: string; turns: { at: string; question: string; answer: string; outcome: string; sources: string[]; costUsd: number }[] }> = {};
  const unanswered: { at: string; label: string; question: string }[] = [];
  const safety: Logged[] = [];
  const errors: Logged[] = [];
  let failedCodes = 0;

  const code = (id: string, label: string) => (perCode[id] ??= { label, entries: 0, messages: 0, costUsd: 0, voiceChars: 0, lastSeen: "" });
  const day = (at: string) => (perDay[at.slice(0, 10)] ??= { messages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, voiceChars: 0 });

  for (const e of events) {
    if (e.type === "access") {
      if (!e.ok) failedCodes++;
      else if (e.codeId) {
        const c = code(e.codeId, e.label);
        c.entries++;
        c.lastSeen = e.at;
      }
    } else if (e.type === "turn") {
      const usd = e.costMicroUsd / 1_000_000;
      const c = code(e.codeId, e.label);
      c.messages++;
      c.costUsd += usd;
      c.lastSeen = e.at;
      const d = day(e.at);
      d.messages++;
      d.inputTokens += e.inputTokens;
      d.outputTokens += e.outputTokens;
      d.costUsd += usd;
      const convo = (conversations[e.sid] ??= { sid: e.sid, label: e.label, startedAt: e.at, turns: [] });
      convo.turns.push({ at: e.at, question: e.question, answer: e.answer, outcome: e.outcome, sources: e.sources, costUsd: usd });
      if (e.outcome === "unknown") unanswered.push({ at: e.at, label: e.label, question: e.question });
    } else if (e.type === "voice") {
      code(e.codeId, e.label).voiceChars += e.chars;
      day(e.at).voiceChars += e.chars;
    } else if (e.type === "safety") {
      safety.push(e);
    } else if (e.type === "error") {
      errors.push(e);
    }
  }

  return {
    failedCodes,
    perCode,
    perDay,
    conversations: Object.values(conversations).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    unanswered: unanswered.reverse(),
    safety: safety.reverse(),
    errors: errors.reverse(),
  };
}
