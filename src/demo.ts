import type { Deps, Env } from "./types";

/**
 * A demo is a working re-creation of something the owner built, run on
 * made-up cases. The rules (what is scored, where the gates are, what needs
 * approval) are data in the private knowledge folder. This file is the engine
 * that applies them, so what the visitor watches is computed, not scripted.
 */

export interface DemoCriterion {
  id: string;
  label: string;
  max: number;
}

export interface DemoPath {
  /** Lowest total score that takes this path. */
  min: number;
  label: string;
  research: string;
  approval: boolean;
  /** Which model writes the draft on this path. Left out, 70 and up is the strong one. */
  model?: "fast" | "strong";
}

export interface DemoEvidence {
  criterion: string;
  points: number;
  fact: string;
  /** Where the fact comes from. A point with no source does not count. */
  source: string;
}

export interface DemoDraft {
  to: string;
  subject: string;
  body: string;
}

export interface DemoCase {
  id: string;
  name: string;
  summary: string;
  /** Set when the case must not be scored at all, with the reason. */
  blocked?: string;
  identity: string;
  mailbox: string;
  evidence: DemoEvidence[];
  /** Where this lead came from, in a sentence. */
  source?: string;
  /** "researcher" when it arrived as a hand-off from the other agent. */
  from?: "researcher" | "list";
  /** A check that fails before drafting, if any. */
  failedGate?: { id: string; reason: string; /** A few words for a list: "a competitor". */ short?: string };
  research?: string[];
  draft?: DemoDraft;
}

/** One step of a demo's flow. The demo file lists them in the order the real system works. */
export interface DemoFlowStep {
  type: "source" | "text" | "verify" | "mailbox" | "gates" | "score" | "path" | "research" | "handoff" | "draft" | "approval";
  agent?: "researcher" | "sender";
  title?: string;
  detail?: string;
}

export interface Demo {
  /** "pipeline" is a scored flow with approval. Left out means pipeline. */
  type?: "pipeline";
  id: string;
  title: string;
  /** The question on the starter chip that opens it. */
  starter: string;
  /** Words that make the assistant open this demo. */
  triggers: string[];
  /** What the assistant says when it opens. */
  intro: string;
  disclaimer: string;
  /** The note the demo is drawn from, shown as its source. */
  source?: string;
  agents: { id: string; name: string; role: string }[];
  researcher: string;
  sender: string;
  criteria: DemoCriterion[];
  paths: DemoPath[];
  gates: { id: string; label: string }[];
  /** The order of work. Left out, the default two-agent order is used. */
  flow?: DemoFlowStep[];
  handoff: string;
  approval: { expiresHours: number; covers: string };
  sendRules: string[];
  /** What a company is being matched against. Shown above the score. */
  offering?: string;
  cases: DemoCase[];
  /**
   * The same rules pointed at someone else's offering. An access code can name
   * a variant, so a visitor watches leads being scored for what their own
   * company sells. Only the offering, the intro and the cases change.
   */
  variants?: Record<string, { label: string; offering: string; note: string; intro?: string; cases: DemoCase[] }>;
  /** Set on a resolved variant: says plainly that this is a re-targeted illustration. */
  retargeted?: string;
  /** One line about why different scores go to different models. */
  routingNote?: string;
  /**
   * A second, shorter run: the research agent working on one company with its
   * own rubric. It ends at a score and a hand-off. It never drafts.
   */
  researchRun?: { criteria: DemoCriterion[]; flow?: DemoFlowStep[]; cases: DemoCase[] };
}

export type AnyDemo = Demo | import("./data-demo").DataDemo | import("./flow-demo").FlowDemo;

export const isPipeline = (demo: AnyDemo): demo is Demo => demo.type !== "data" && demo.type !== "flow";

/** Where a demo sits on the page. A file can say; otherwise the scored pipeline is first and the data agent later. */
export const orderOf = (demo: AnyDemo): number => (demo as { order?: number }).order ?? (isPipeline(demo) ? 10 : 40);

/** The demo as one visitor should see it: the base, or the variant their access code names. */
export function resolveDemo(demo: Demo, variant?: string): Demo {
  const chosen = variant ? demo.variants?.[variant] : undefined;
  if (!chosen) return demo;
  return { ...demo, offering: chosen.offering, retargeted: chosen.note, intro: chosen.intro ?? demo.intro, cases: chosen.cases };
}

export interface DemoStep {
  agent: string;
  /** What sort of step this is, so the page knows where to show the score or the research. */
  kind: string;
  title: string;
  detail: string;
  status: "ok" | "blocked" | "info" | "waiting";
}

export interface ScoreLine {
  id: string;
  label: string;
  max: number;
  points: number;
  evidence: { fact: string; source: string; points: number; counted: boolean }[];
  note: string;
}

export interface DemoRun {
  demo: string;
  case: { id: string; name: string; summary: string };
  steps: DemoStep[];
  score?: { lines: ScoreLine[]; total: number; outOf: number };
  path?: DemoPath;
  research?: string[];
  draft?: DemoDraft;
  needsApproval: boolean;
  /** "blocked": stopped at a check. "draft": a draft exists and may be sent. "scored": a research run, which ends at a score. */
  outcome: "blocked" | "draft" | "scored";
  /** Which model wrote the draft, and what the call cost. */
  route?: import("./demo-model").Route;
}

/** What a visitor may see before running anything: no evidence, no drafts. */
export function describeDemo(demo: Demo) {
  return {
    id: demo.id,
    title: demo.title,
    disclaimer: demo.disclaimer,
    offering: demo.offering ?? "",
    retargeted: demo.retargeted ?? "",
    agents: demo.agents,
    researcherName: demo.agents.find((a) => a.id === demo.researcher)?.name ?? "",
    senderName: demo.agents.find((a) => a.id === demo.sender)?.name ?? "",
    criteria: demo.criteria,
    paths: demo.paths,
    approval: demo.approval,
    type: "pipeline" as const,
    routingNote: demo.routingNote ?? "",
    hasList: true,
    researchCases: (demo.researchRun?.cases ?? []).map((c) => ({ id: c.id, name: c.name, summary: c.summary })),
    cases: demo.cases.map((c) => ({ id: c.id, name: c.name, summary: c.summary })),
  };
}

/** The demo a question is asking for, if any. */
export function detectDemo(question: string, demos: AnyDemo[] = []): AnyDemo | null {
  const text = question.toLowerCase();
  return demos.find((d) => d.triggers.some((t) => text.includes(t.toLowerCase()))) ?? null;
}

/**
 * Scores a case. Points count only when the evidence names its source, each
 * criterion is capped at its maximum, and a criterion with nothing behind it
 * scores zero rather than a guess.
 */
export function scoreCase(demo: Demo, item: DemoCase): { lines: ScoreLine[]; total: number; outOf: number } {
  const lines = demo.criteria.map((criterion) => {
    const evidence = item.evidence
      .filter((e) => e.criterion === criterion.id)
      .map((e) => ({ fact: e.fact, source: e.source, points: e.points, counted: Boolean(e.fact.trim() && e.source.trim()) && e.points > 0 }));
    const claimed = evidence.filter((e) => e.counted).reduce((sum, e) => sum + e.points, 0);
    const points = Math.min(criterion.max, Math.max(0, Math.round(claimed)));
    const note = !evidence.length
      ? "Unknown. Scores 0, not a guess."
      : evidence.some((e) => !e.counted)
        ? "A point without a cited source does not count."
        : claimed > criterion.max
          ? `Capped at ${criterion.max}.`
          : "";
    return { id: criterion.id, label: criterion.label, max: criterion.max, points, evidence, note };
  });
  return { lines, total: lines.reduce((sum, l) => sum + l.points, 0), outOf: demo.criteria.reduce((sum, c) => sum + c.max, 0) };
}

export function pathFor(demo: Demo, total: number): DemoPath {
  return [...demo.paths].sort((a, b) => b.min - a.min).find((p) => total >= p.min) ?? demo.paths[demo.paths.length - 1];
}

/**
 * The order of work when a demo file does not give its own: one agent
 * researches and scores, then hands over to the one that drafts.
 */
const DEFAULT_FLOW: DemoFlowStep[] = [
  { type: "verify", agent: "researcher", title: "Verify the company" },
  { type: "mailbox", agent: "researcher", title: "Find a public business mailbox" },
  { type: "score", agent: "researcher", title: "Score" },
  { type: "path", agent: "researcher", title: "What the score decides" },
  { type: "research", agent: "researcher", title: "Research" },
  { type: "handoff", agent: "researcher", title: "Hand off" },
  { type: "gates", agent: "sender" },
  { type: "draft", agent: "sender", title: "Draft" },
  { type: "approval", agent: "sender" },
];

/**
 * Runs one case through the demo's flow, step by step, and stops where the
 * real system would stop: at a failed check, or at a draft that waits.
 */
/** Every company a demo knows: the list, plus the ones the research agent hands over. */
export function findCase(demo: Demo, caseId: string): DemoCase | undefined {
  const handed = (demo.researchRun?.cases ?? []).map((c) => ({ ...c, from: "researcher" as const, source: c.source ?? "Handed over by the research agent, with its research and its score." }));
  return [...demo.cases, ...handed].find((c) => c.id === caseId);
}

export function runCase(demo: Demo, caseId: string): DemoRun | null {
  const item = findCase(demo, caseId);
  if (!item) return null;
  const name = (id: string) => demo.agents.find((a) => a.id === id)?.name ?? id;
  const researcher = name(demo.researcher);
  const sender = name(demo.sender);
  const steps: DemoStep[] = [];
  const base = { demo: demo.id, case: { id: item.id, name: item.name, summary: item.summary } };
  let score: DemoRun["score"];
  let path: DemoPath | undefined;
  const stopped = (): DemoRun => ({ ...base, steps, score, path, research: path ? item.research : undefined, needsApproval: false, outcome: "blocked" });

  for (const step of demo.flow ?? DEFAULT_FLOW) {
    const agent = step.agent === "researcher" ? researcher : sender;
    const add = (title: string, detail: string, status: DemoStep["status"], kind: string = step.type, by = agent) => steps.push({ agent: by, kind, title, detail, status });

    switch (step.type) {
      case "source": {
        // Where this lead came from. A batch from the other agent is a hand-off.
        const handed = item.from === "researcher";
        add(step.title ?? "Where the lead came from", item.source ?? step.detail ?? "", "ok", handed ? "handoff" : "source", handed ? researcher : agent);
        break;
      }
      case "text":
        add(step.title ?? "", step.detail ?? "", "ok");
        break;
      case "verify":
        add(step.title ?? "Verify the company", item.identity, "ok");
        if (item.blocked) {
          add("Blocked, not scored", item.blocked, "blocked", "blocked");
          return stopped();
        }
        break;
      case "mailbox":
        if (item.failedGate?.id === "recipient") {
          add(step.title ?? "Find a public business mailbox", item.failedGate.reason, "blocked");
          return stopped();
        }
        add(step.title ?? "Find a public business mailbox", item.mailbox, "ok");
        break;
      case "gates":
        for (const gate of demo.gates) {
          if (item.failedGate?.id === gate.id) {
            add(gate.label, item.failedGate.reason, "blocked", "gate");
            return stopped();
          }
          add(gate.label, "Passed", "ok", "gate");
        }
        break;
      case "score":
        score = scoreCase(demo, item);
        add(step.title ?? "Score", `${score.total} of ${score.outOf}. Every point is backed by a cited fact.`, "ok");
        break;
      case "path":
        path = pathFor(demo, (score ??= scoreCase(demo, item)).total);
        add(step.title ?? "What the score decides", path.label, "info");
        break;
      case "research":
        path ??= pathFor(demo, (score ??= scoreCase(demo, item)).total);
        add(step.title ?? "Research", path.research, "ok");
        break;
      case "handoff":
        add(step.title ?? "Hand off", demo.handoff.replace("{sender}", sender), "ok");
        break;
      case "draft":
        add(step.title ?? "Draft", step.detail ?? "Written from the cited research, then run through a plain-writing check.", "ok");
        break;
      case "approval":
        path ??= pathFor(demo, (score ??= scoreCase(demo, item)).total);
        if (path.approval) add("Wait for approval", `A person approves ${demo.approval.covers}. The approval works once and expires after ${demo.approval.expiresHours} hours.`, "waiting");
        else add("No approval needed", step.detail ?? "Below the approval threshold. It may send once every gate has passed.", "info");
        break;
    }
  }

  path ??= pathFor(demo, (score ??= scoreCase(demo, item)).total);
  // A flow with no draft step is a research run: it ends at the score.
  if (!(demo.flow ?? DEFAULT_FLOW).some((s) => s.type === "draft")) {
    return { ...base, steps, score, path, research: item.research, needsApproval: false, outcome: "scored" };
  }
  return { ...base, steps, score, path, research: item.research, draft: item.draft, needsApproval: path.approval, outcome: "draft" };
}

const RESEARCH_FLOW: DemoFlowStep[] = [
  { type: "verify", agent: "researcher", title: "Verify the company" },
  { type: "mailbox", agent: "researcher", title: "Find a public business mailbox" },
  { type: "text", agent: "researcher", title: "Research", detail: "Reads public sources and keeps only what can be cited." },
  { type: "score", agent: "researcher", title: "Score" },
  { type: "handoff", agent: "researcher", title: "Hand off" },
];

/**
 * The research agent's run on one company, and what happens next. It verifies,
 * researches and scores on its own rubric, then hands over. The outreach agent
 * picks the company up, runs its own checks and scoring, and drafts.
 */
export function runResearch(demo: Demo, caseId?: string): { research: DemoRun; outreach: DemoRun } | null {
  const research = demo.researchRun;
  if (!research?.cases.length) return null;
  const id = caseId ?? research.cases[0].id;
  const view: Demo = { ...demo, criteria: research.criteria, flow: research.flow ?? RESEARCH_FLOW, cases: research.cases, researchRun: undefined };
  const first = runCase(view, id);
  const second = runCase(demo, id);
  return first && second ? { research: first, outreach: second } : null;
}

export interface ListRow {
  id: string;
  name: string;
  source: string;
  score: number | null;
  outcome: "blocked" | "draft" | "scored";
  /** Where it goes next, in a few words. */
  route: string;
  model: "fast" | "strong" | null;
  approval: boolean;
}

/** The outreach agent working down its whole list: one line per company with the route it takes. */
export function runList(demo: Demo): ListRow[] {
  return demo.cases.map((item) => {
    const run = runCase(demo, item.id)!;
    const held = run.outcome === "blocked";
    const total = run.score?.total ?? null;
    const model = held ? null : (run.path?.model ?? ((total ?? 0) >= 70 ? "strong" : "fast"));
    return {
      id: item.id,
      name: item.name,
      source: item.from === "researcher" ? "Research agent batch" : (item.source ?? "").split(/[.,]/)[0],
      score: held ? null : total,
      outcome: run.outcome,
      route: held ? `Held: ${item.failedGate?.short ?? (item.blocked ? "blocked" : "failed a check")}` : run.needsApproval ? (model === "strong" ? "Deep research, then approval" : "Draft, then approval") : "Short email, direct send",
      model,
      approval: !held && run.needsApproval,
    };
  });
}

// ------------------------------------------------------------------ approval

interface StoredApproval {
  sid: string;
  demo: string;
  case: string;
  hash: string;
  expiresAt: string;
  used: boolean;
}

function clean(draft: DemoDraft): DemoDraft {
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
  return { to: text(draft?.to, 200), subject: text(draft?.subject, 300), body: text(draft?.body, 4000) };
}

/** The approval is for these exact words. Change one and the fingerprint changes. */
async function fingerprint(draft: DemoDraft): Promise<string> {
  const d = clean(draft);
  const bytes = new TextEncoder().encode(JSON.stringify([d.to, d.subject, d.body]));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function approveDraft(env: Env, deps: Deps, sid: string, demo: Demo, caseId: string, draft: DemoDraft) {
  const id = crypto.randomUUID().slice(0, 8).toUpperCase();
  const seconds = demo.approval.expiresHours * 3600;
  const expiresAt = new Date(deps.now().getTime() + seconds * 1000).toISOString();
  const stored: StoredApproval = { sid, demo: demo.id, case: caseId, hash: await fingerprint(draft), expiresAt, used: false };
  await env.STORE.put(`dap:${id}`, JSON.stringify(stored), { expirationTtl: seconds });
  return { approvalId: id, expiresAt };
}

/**
 * The send step of the demo. Nothing is ever sent: there is no mail code in
 * this project. It checks what a real send would check and reports the result.
 */
export async function sendDraft(
  env: Env,
  deps: Deps,
  sid: string,
  demo: Demo,
  run: DemoRun,
  draft: DemoDraft,
  approvalId?: string,
): Promise<{ ok: boolean; reason: string; rules?: string[] }> {
  if (run.outcome !== "draft") return { ok: false, reason: "This company was blocked before drafting. There is nothing to send." };

  if (run.needsApproval) {
    if (!approvalId) return { ok: false, reason: "This email needs a person's approval first." };
    const key = `dap:${approvalId.toUpperCase().replace(/[^0-9A-F]/g, "")}`;
    const raw = await env.STORE.get(key);
    if (!raw) return { ok: false, reason: "That approval does not exist or has expired." };
    const approval = JSON.parse(raw) as StoredApproval;
    if (approval.sid !== sid || approval.demo !== demo.id || approval.case !== run.case.id) return { ok: false, reason: "That approval is for a different email." };
    if (approval.expiresAt <= deps.now().toISOString()) return { ok: false, reason: "The approval has expired. A new one is needed." };
    if (approval.used) return { ok: false, reason: "That approval was already used. Each approval works once." };
    if (approval.hash !== (await fingerprint(draft))) return { ok: false, reason: "The email changed after it was approved. It needs a new approval." };
    approval.used = true;
    await env.STORE.put(key, JSON.stringify(approval), { expirationTtl: 3600 });
  }
  return { ok: true, reason: "Cleared to send. This is a demo, so nothing was sent.", rules: demo.sendRules };
}
