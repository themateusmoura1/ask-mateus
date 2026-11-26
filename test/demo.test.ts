import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lint, readKnowledge } from "../scripts/knowledge.mjs";
import { pathFor, runCase, scoreCase, type Demo } from "../src/demo";
import { BUNDLE, LIVE, world } from "./helpers";

const demo = BUNDLE.demos!.find((d) => d.id === "returns") as Demo;
const post = async (w: ReturnType<typeof world>, action: string, body: unknown) => {
  const res = await w.send(`/api/demo/returns/${action}`, { body });
  return { status: res.status, data: (await res.json()) as any };
};

describe("the demo engine", () => {
  it("scores from cited evidence, caps each criterion and adds it up", () => {
    const clear = demo.cases.find((c) => c.id === "clear")!;
    const score = scoreCase(demo, clear);
    expect(score.lines.map((l) => `${l.id}:${l.points}/${l.max}`)).toEqual(["window:40/40", "condition:30/35", "history:20/25"]);
    expect(score).toMatchObject({ total: 90, outOf: 100 });
  });

  it("gives no points for a claim without a source, and none for what is unknown", () => {
    const item = { ...demo.cases[0], evidence: [{ criterion: "window", points: 40, fact: "Looks recent.", source: "" }, { criterion: "condition", points: 99, fact: "Torn cover.", source: "Photo" }] };
    const score = scoreCase(demo, item);
    const line = (id: string) => score.lines.find((l) => l.id === id)!;
    expect(line("window")).toMatchObject({ points: 0, note: "A point without a cited source does not count." });
    expect(line("condition")).toMatchObject({ points: 35, note: "Capped at 35." });
    expect(line("history")).toMatchObject({ points: 0, note: "Unknown. Scores 0, not a guess." });
    expect(score.total).toBe(35);
  });

  it("lets the score decide the path at the exact thresholds", () => {
    expect(pathFor(demo, 100).min).toBe(70);
    expect(pathFor(demo, 70).min).toBe(70);
    expect(pathFor(demo, 69).min).toBe(40);
    expect(pathFor(demo, 40).approval).toBe(true);
    expect(pathFor(demo, 39).approval).toBe(false);
    expect(pathFor(demo, 0).min).toBe(0);
  });

  it("walks a clear case from research to a draft that waits for approval", () => {
    const run = runCase(demo, "clear")!;
    expect(run.outcome).toBe("draft");
    expect(run.needsApproval).toBe(true);
    expect(run.steps.map((s) => `${s.agent}: ${s.title}`)).toEqual([
      "Checker: Verify the company",
      "Checker: Find a public business mailbox",
      "Checker: Score",
      "Checker: What the score decides",
      "Checker: Research",
      "Checker: Hand off",
      "Writer: The order was found",
      "Writer: No earlier reply to this request",
      "Writer: Draft",
      "Writer: Wait for approval",
    ]);
    expect(run.steps.at(-1)!.status).toBe("waiting");
  });

  it("stops at a failed gate and produces no draft", () => {
    const run = runCase(demo, "unknown")!;
    expect(run.outcome).toBe("blocked");
    expect(run.draft).toBeUndefined();
    expect(run.steps.at(-1)).toMatchObject({ agent: "Writer", status: "blocked" });
  });

  it("does not score a blocked case at all", () => {
    const blocked: Demo = { ...demo, cases: [{ ...demo.cases[0], id: "b", blocked: "A public body." }] };
    const run = runCase(blocked, "b")!;
    expect(run.score).toBeUndefined();
    expect(run.outcome).toBe("blocked");
  });
});

describe("the demo's approval rules", () => {
  const draft = demo.cases[0].draft!;

  it("needs a session, and shows no evidence or drafts until a case is run", async () => {
    const w = world();
    expect((await w.send("/api/demo/returns")).status).toBe(401);
    await w.login();
    const shown = (await (await w.send("/api/demo/returns")).json()) as any;
    expect(shown.cases).toEqual([
      { id: "clear", name: "Order 1042 (made up)", summary: "A damaged book, returned within a week." },
      { id: "unknown", name: "Order 9999 (made up)", summary: "A request for an order that can't be found." },
    ]);
    expect(JSON.stringify(shown)).not.toContain("reader@example.com");
  });

  it("refuses to send without approval", async () => {
    const w = world();
    await w.login();
    const sent = await post(w, "send", { caseId: "clear", draft });
    expect(sent.data).toMatchObject({ ok: false, reason: "This email needs a person's approval first." });
  });

  it("clears an approved email once, and only once", async () => {
    const w = world();
    await w.login();
    const { data: approval } = await post(w, "approve", { caseId: "clear", draft });
    expect(approval.approvalId).toMatch(/^[0-9A-F]{8}$/);
    expect(approval.expiresAt).toBe("2026-11-27T12:00:00.000Z");

    const first = await post(w, "send", { caseId: "clear", draft, approvalId: approval.approvalId });
    expect(first.data.ok).toBe(true);
    expect(first.data.reason).toContain("nothing was sent");
    const second = await post(w, "send", { caseId: "clear", draft, approvalId: approval.approvalId });
    expect(second.data).toMatchObject({ ok: false, reason: "That approval was already used. Each approval works once." });
    // The demo talks to nobody.
    expect(w.calls).toEqual([]);
  });

  it("rejects an email that was edited after it was approved", async () => {
    const w = world();
    await w.login();
    const { data: approval } = await post(w, "approve", { caseId: "clear", draft });
    for (const edited of [{ ...draft, body: draft.body + " PS: 50% off today." }, { ...draft, to: "someone-else@example.com" }, { ...draft, subject: "Changed" }]) {
      const sent = await post(w, "send", { caseId: "clear", draft: edited, approvalId: approval.approvalId });
      expect(sent.data).toMatchObject({ ok: false, reason: "The email changed after it was approved. It needs a new approval." });
    }
    // The untouched email still goes through: the failed attempts did not use the approval up.
    expect((await post(w, "send", { caseId: "clear", draft, approvalId: approval.approvalId })).data.ok).toBe(true);
  });

  it("lets an approval expire after 24 hours", async () => {
    const w = world();
    await w.login();
    const { data: approval } = await post(w, "approve", { caseId: "clear", draft });
    w.advanceDays(1.01);
    // The cookie is still valid (7 days). The approval is not.
    const sent = await post(w, "send", { caseId: "clear", draft, approvalId: approval.approvalId });
    expect(sent.data).toMatchObject({ ok: false, reason: "That approval does not exist or has expired." });
  });

  it("does not accept one visitor's approval from another visitor", async () => {
    const a = world();
    await a.login();
    const { data: approval } = await post(a, "approve", { caseId: "clear", draft });
    const mine = a.cookie();
    await a.enter(a.code());
    expect(a.cookie()).not.toBe(mine);
    const sent = await post(a, "send", { caseId: "clear", draft, approvalId: approval.approvalId });
    expect(sent.data).toMatchObject({ ok: false, reason: "That approval is for a different email." });
  });

  it("has nothing to approve or send for a blocked case", async () => {
    const w = world();
    await w.login();
    expect((await post(w, "approve", { caseId: "unknown", draft })).status).toBe(400);
    expect((await post(w, "send", { caseId: "unknown", draft })).data.ok).toBe(false);
  });

  it("logs each demo action", async () => {
    const w = world({ code: { label: "Northwind" } });
    await w.login();
    await post(w, "run", { caseId: "clear" });
    const event = (await w.logs()).find((e) => e.type === "demo") as any;
    expect(event).toMatchObject({ label: "Northwind", demo: "returns", case: "clear", action: "run", result: "90/100, draft" });
  });
});

describe("the assistant opens a demo when asked", () => {
  it("replies with the owner's fixed intro, cites the note, and never calls the model", async () => {
    const w = world({ env: LIVE });
    const { reply } = await w.ask("Show me the returns agent working");
    expect(reply.demo).toBe("returns");
    expect(reply.text).toBe(demo.intro);
    expect(reply.sources.map((s: any) => s.id)).toEqual(["returns-agent"]);
    expect(reply.trace.map((s: any) => s.id)).toEqual(["access", "limits", "filter", "demo", "logged"]);
    expect(w.modelCalls()).toHaveLength(0);
  });

  it("offers each demo as a starter question", async () => {
    const w = world();
    await w.login();
    const config = (await (await w.send("/api/config")).json()) as any;
    expect(config.starters).toContain("Show me the returns agent working");
    expect(config.starters).toContain("Ask Atlas about the sales numbers");
    expect(config.demos).toContainEqual({ id: "returns", title: "The returns agent", type: "pipeline", starter: "Show me the returns agent working" });
    expect(config.demos).toContainEqual({ id: "data", title: "Atlas, the data agent", type: "data", starter: "Ask Atlas about the sales numbers" });
  });

  it("does not open a demo for an ordinary question", async () => {
    const { reply } = await world().ask("How does the returns agent work?");
    expect(reply.demo).toBeUndefined();
  });
});

describe("demo data must be made up", () => {
  it("passes the example, and refuses a real-looking address or a phone number", () => {
    expect(lint(BUNDLE)).toEqual([]);
    const withCase = (patch: object) => ({ ...BUNDLE, demos: [{ ...demo, cases: [{ ...demo.cases[0], ...patch }] }] });
    expect(lint(withCase({ mailbox: "info@realcompany.pt" }))).toHaveLength(1);
    expect(lint(withCase({ summary: "Call +351 912 345 678." }))).toHaveLength(1);
    expect(lint(withCase({ mailbox: "geral@made-up.example, on the contact page." }))).toEqual([]);
  });
});

// The owner's own demo lives in the private knowledge folder, which is not in
// the repo. When it is present on this machine, check it too.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const privateFolder = join(root, "knowledge");
describe.skipIf(!existsSync(join(privateFolder, "demos")))("the private demo data on this machine", () => {
  it("is safe to publish and every case runs", () => {
    const bundle = readKnowledge(privateFolder);
    expect(lint(bundle)).toEqual([]);
    // Every demo, whatever its kind, must point at a note the assistant can cite.
    for (const d of bundle.demos as { id: string; source?: string }[]) {
      expect(bundle.notes.some((n: { id: string }) => n.id === d.source), `${d.id} source note`).toBe(true);
    }
    for (const d of (bundle.demos as Demo[]).filter((x) => !["data", "flow"].includes((x as { type?: string }).type ?? ""))) {
      expect(d.cases.length).toBeGreaterThan(0);
      for (const c of d.cases) {
        const run = runCase(d, c.id)!;
        expect(run.steps.length, `${d.id}/${c.id}`).toBeGreaterThan(1);
        if (run.outcome === "draft") expect(run.draft, `${d.id}/${c.id} needs a draft`).toBeDefined();
      }
      expect(bundle.notes.some((n: { id: string }) => n.id === d.source), `${d.id} source note`).toBe(true);
    }
  });
});

describe("a demo pointed at the visitor's own offering", () => {
  const shown = async (w: ReturnType<typeof world>) => (await (await w.send("/api/demo/returns")).json()) as any;

  it("shows the base demo, with its offering stated, to an ordinary code", async () => {
    const w = world();
    await w.login();
    const d = await shown(w);
    expect(d.offering).toBe("Lanterna Books: a 30 day return window on books in resaleable condition.");
    expect(d.retargeted).toBe("");
    expect(d.cases.map((c: any) => c.id)).toEqual(["clear", "unknown"]);
  });

  it("shows the variant's offering and cases to a code that names it, and says it was re-targeted", async () => {
    const w = world({ code: { label: "Acme", variant: "acme" } as any });
    await w.login();
    const d = await shown(w);
    expect(d.offering).toBe("Acme Outdoor: a 90 day return window on unused gear.");
    expect(d.retargeted).toContain("Re-targeted for you");
    expect(d.cases.map((c: any) => c.id)).toEqual(["tent"]);
    // The rules did not change: the same engine scores the variant's case.
    const run = await post(w, "run", { caseId: "tent" });
    expect(run.data.score.total).toBe(50);
    expect(run.data.path.label).toContain("40 to 69");
  });

  it("keeps each visitor to their own variant's cases", async () => {
    const acme = world({ code: { label: "Acme", variant: "acme" } as any });
    await acme.login();
    expect((await post(acme, "run", { caseId: "clear" })).status).toBe(400);
    const plain = world();
    await plain.login();
    expect((await post(plain, "run", { caseId: "tent" })).status).toBe(400);
  });

  it("falls back to the base demo when a code names a variant that does not exist", async () => {
    const w = world({ code: { label: "Typo", variant: "acmee" } as any });
    await w.login();
    expect((await shown(w)).cases.map((c: any) => c.id)).toEqual(["clear", "unknown"]);
  });

  it("lets the owner set the variant when creating a code, and lists the ones that exist", async () => {
    const w = world({ env: { ADMIN_TOKEN: "test-admin-token" } });
    const auth = { Authorization: "Bearer test-admin-token" };
    const made = (await (await w.send("/api/admin/codes", { body: { label: "Acme", variant: " Acme " }, headers: auth })).json()) as any;
    expect(made.record.variant).toBe("acme");
    const list = (await (await w.send("/api/admin/codes", { headers: auth })).json()) as any;
    expect(list.variants).toEqual(["acme"]);
  });
});

describe("a demo with its own order of work", () => {
  const custom: Demo = {
    ...demo,
    flow: [
      { type: "source", agent: "sender", title: "Take the next request" },
      { type: "verify", agent: "sender", title: "Find the order" },
      { type: "gates", agent: "sender" },
      { type: "text", agent: "sender", title: "Update the record", detail: "One record per order." },
      { type: "score", agent: "sender" },
      { type: "path", agent: "sender" },
      { type: "draft", agent: "sender" },
      { type: "approval", agent: "sender" },
    ],
    cases: [
      { ...demo.cases[0], id: "listed", source: "Row 3 of the list." },
      { ...demo.cases[0], id: "handed", source: "From the other agent's batch.", from: "researcher" },
      { ...demo.cases[1], id: "missing" },
    ],
  };

  it("follows the flow in the file, with one agent doing the whole run", () => {
    const run = runCase(custom, "listed")!;
    expect(run.steps.map((s) => `${s.agent}: ${s.title}`)).toEqual([
      "Writer: Take the next request",
      "Writer: Find the order",
      "Writer: The order was found",
      "Writer: No earlier reply to this request",
      "Writer: Update the record",
      "Writer: Score",
      "Writer: What the score decides",
      "Writer: Draft",
      "Writer: Wait for approval",
    ]);
    expect(run.steps[0]).toMatchObject({ kind: "source", detail: "Row 3 of the list." });
    expect(run.score!.total).toBe(90);
  });

  it("shows a lead handed over by the other agent as a hand-off from that agent", () => {
    expect(runCase(custom, "handed")!.steps[0]).toMatchObject({ agent: "Checker", kind: "handoff", detail: "From the other agent's batch." });
  });

  it("stops at the failed check, before any score or draft", () => {
    const run = runCase(custom, "missing")!;
    expect(run.outcome).toBe("blocked");
    expect(run.score).toBeUndefined();
    expect(run.steps.at(-1)).toMatchObject({ kind: "gate", status: "blocked" });
  });
});
