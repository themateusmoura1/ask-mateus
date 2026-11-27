import type { TraceStep } from "./live";

// Calls to the Worker. Nothing about the person lives in the front end:
// names, greetings and notes all arrive from these routes after a valid code.

export interface SessionInfo {
  authed: boolean;
  title: string;
  owner: string;
  retentionDays: number;
}

export interface Config {
  mode: "live" | "stub";
  voice: boolean;
  title: string;
  firstName: string;
  opening: string;
  starters: string[];
  links: { label: string; url: string }[];
  maxMessageChars: number;
  retentionDays: number;
  /** What this deployment runs on, already filtered to what is switched on. */
  stack?: { id: string; name: string; where: "cloudflare" | "outside"; what: string }[];
  demos?: { id: string; title: string; type: "pipeline" | "data" | "flow"; starter: string }[];
}

export interface Source {
  id: string;
  title: string;
  source: string;
  url: string;
}

export interface Reply {
  kind: "answer" | "unknown" | "off_limits" | "contact" | "smalltalk" | "limit";
  text: string;
  sources: Source[];
  openContact: boolean;
  speak?: string;
  /** Set when the reply opens a demo. */
  demo?: string;
  /** The steps the server took to produce this reply. */
  trace?: TraceStep[];
}

const json = { "content-type": "application/json" };

export async function getSession(): Promise<SessionInfo> {
  try {
    return await (await fetch("/api/session")).json();
  } catch {
    return { authed: false, title: "Ask", owner: "the owner", retentionDays: 90 };
  }
}

export async function enterCode(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/gate", { method: "POST", headers: json, body: JSON.stringify({ code }) });
    if (res.ok) return { ok: true };
    return { ok: false, error: (await res.json()).error || "That code didn't work. Check it and try again." };
  } catch {
    return { ok: false, error: "I couldn't reach the server. Try again." };
  }
}

/**
 * A personal link looks like /acme-k7x2q9wd3f: a name, then ten random characters.
 * Returns the part after the slash when the address has that shape.
 */
export function personalLink(path = location.pathname): string | null {
  const slug = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{10}$/.test(slug) && slug.length <= 80 ? slug : null;
}

export async function enterLink(link: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/gate", { method: "POST", headers: json, body: JSON.stringify({ link }) });
    if (res.ok) return { ok: true };
    return { ok: false, error: (await res.json()).error || "That link didn't work. Enter your access code instead." };
  } catch {
    return { ok: false, error: "I couldn't reach the server. Try again." };
  }
}

/** null means the session ended (revoked code or expired cookie). */
export async function getConfig(): Promise<Config | null | { error: string }> {
  const res = await fetch("/api/config");
  if (res.status === 401) return null;
  if (!res.ok) return { error: (await res.json().catch(() => ({}))).error || "The site isn't ready yet." };
  return res.json();
}

export async function ask(message: string, earlier: string[]): Promise<Reply | "signed-out"> {
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: json, body: JSON.stringify({ message, earlier }) });
    if (res.status === 401) return "signed-out";
    const reply = (await res.json()) as Reply;
    if (!reply.text) throw new Error("bad reply");
    return reply;
  } catch {
    return { kind: "limit", text: "I couldn't reach the server. Check your connection and try again.", sources: [], openContact: false };
  }
}

export async function sendContact(form: Record<string, unknown>): Promise<{ ok: true; message: string; requestId?: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/contact", { method: "POST", headers: json, body: JSON.stringify(form) });
    const body = await res.json();
    return res.ok ? { ok: true, message: body.message, requestId: body.requestId } : { ok: false, error: body.error || "That didn't come through. Try again." };
  } catch {
    return { ok: false, error: "I couldn't reach the server. Try again." };
  }
}

export async function fetchSpeech(id: string): Promise<Blob> {
  const res = await fetch(`/api/speak/${id}`);
  if (!res.ok) throw new Error("no audio");
  return res.blob();
}

// ------------------------------------------------------------------ demos

export interface DemoInfo {
  id: string;
  title: string;
  disclaimer: string;
  /** What companies are being matched against. */
  offering: string;
  /** Set when the demo was pointed at the visitor's own offering. */
  retargeted: string;
  /** Why different scores go to different models. */
  routingNote: string;
  researchCases: { id: string; name: string; summary: string }[];
  agents: { id: string; name: string; role: string }[];
  researcherName: string;
  senderName: string;
  criteria: { id: string; label: string; max: number }[];
  approval: { expiresHours: number; covers: string };
  cases: { id: string; name: string; summary: string }[];
}

export interface DemoDraft {
  to: string;
  subject: string;
  body: string;
}

export interface DemoRun {
  case: { id: string; name: string; summary: string };
  steps: { agent: string; kind: string; title: string; detail: string; status: "ok" | "blocked" | "info" | "waiting" }[];
  score?: {
    lines: { id: string; label: string; max: number; points: number; note: string; evidence: { fact: string; source: string; points: number; counted: boolean }[] }[];
    total: number;
    outOf: number;
  };
  path?: { label: string; approval: boolean };
  research?: string[];
  draft?: DemoDraft;
  needsApproval: boolean;
  outcome: "blocked" | "draft" | "scored";
  /** Which model wrote the draft and what the call cost. */
  route?: Route;
  /** Every step the server took, in order. */
  trace?: TraceStep[];
}

async function demoPost<T>(id: string, action: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/demo/${id}/${action}`, { method: "POST", headers: json, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
  return data as T;
}

export const getDemo = async (id: string): Promise<DemoInfo> => (await fetch(`/api/demo/${id}`)).json();
export const runDemo = (id: string, caseId: string) => demoPost<DemoRun>(id, "run", { caseId });
export const approveDemo = (id: string, caseId: string, draft: DemoDraft) => demoPost<{ approvalId: string; expiresAt: string; trace: TraceStep[] }>(id, "approve", { caseId, draft });
export const sendDemo = (id: string, caseId: string, draft: DemoDraft, approvalId?: string) =>
  demoPost<{ ok: boolean; reason: string; rules?: string[]; trace: TraceStep[] }>(id, "send", { caseId, draft, approvalId });

// ------------------------------------------------------------------ more demo actions

export interface Route {
  tier: "fast" | "strong";
  model: string;
  called: boolean;
  costMicroUsd: number;
  note: string;
}

export interface ListRow {
  id: string;
  name: string;
  source: string;
  score: number | null;
  outcome: string;
  route: string;
  model: "fast" | "strong" | null;
  approval: boolean;
}

export interface Routing {
  fast: string;
  strong: string;
  live: boolean;
  note: string;
}

export const researchDemo = (id: string) => demoPost<{ research: DemoRun; outreach: DemoRun; trace: TraceStep[] }>(id, "research", {});
export const listDemo = (id: string) => demoPost<{ rows: ListRow[]; routing: Routing; trace: TraceStep[] }>(id, "list", {});

export interface DataInfo {
  type: "data";
  id: string;
  title: string;
  disclaimer: string;
  agentName: string;
  company: string;
  table: string;
  examples: string[];
}

export interface DataAnswer {
  ok: boolean;
  answer: string;
  sql?: string;
  table?: string;
  columns?: string[];
  rows?: (string | number)[][];
  route: Route;
  /** Lets the page speak this answer with the site's own voice. */
  speak?: string;
  trace?: TraceStep[];
}

export const getData = async (id: string): Promise<DataInfo> => (await fetch(`/api/demo/${id}`)).json();
export const askData = (id: string, question: string) => demoPost<DataAnswer>(id, "ask", { question });

// ------------------------------------------------------------------ one agent, one job

export type FlowKind = "desk" | "support" | "intake" | "review";

export interface FlowInfo {
  type: "flow";
  flow: FlowKind;
  id: string;
  title: string;
  agentName: string;
  role: string;
  company: string;
  disclaimer: string;
  scenarios: { id: string; label: string }[];
}

/** One piece of a run's result. `after` is how many server steps come before it. */
export type Block = { after: number } & (
  | { type: "message"; label: string; from?: string; subject?: string; body: string }
  | { type: "answer"; label: string; text: string; source?: { title: string; excerpt: string } }
  | { type: "fields"; label: string; rows: [string, string][] }
  | { type: "draft"; label: string; to?: string; subject: string; body: string }
  | { type: "handover"; text: string }
  | { type: "output"; label: string; text: string }
  | { type: "checklist"; label: string; items: { label: string; pass: boolean; note: string }[] }
  | { type: "note"; tone: "info" | "stop" | "ok"; title: string; text: string }
  | { type: "approval" }
);

export interface FlowRun {
  scenario: { id: string; label: string };
  blocks: Block[];
  needsDecision: boolean;
  draft?: { subject: string; body: string };
  trace: TraceStep[];
}

export const getFlow = async (id: string): Promise<FlowInfo> => (await fetch(`/api/demo/${id}`)).json();
export const runFlow = (id: string, scenarioId: string) => demoPost<FlowRun>(id, "run", { scenarioId });
export const decideFlow = (id: string, scenarioId: string, decision: "approve" | "reject", draft: { subject: string; body: string }) =>
  demoPost<{ record: { id: string; decision: string; at: string; covers: string }; trace: TraceStep[] }>(id, "decide", { scenarioId, decision, draft });
