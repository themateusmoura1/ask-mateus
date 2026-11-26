import Anthropic from "@anthropic-ai/sdk";
import { fixed, settings } from "./config";
import { createRequest, decide, listRequests, notify, validate, type ContactInput, type RequestState } from "./contact";
import { askData, describeData } from "./data-demo";
import { approveDraft, describeDemo, detectDemo, isPipeline, orderOf, resolveDemo, runCase, runList, runResearch, sendDraft, type DemoDraft, type DemoRun } from "./demo";
import { tierFor, tiers, writeDraft, type Route } from "./demo-model";
import { clearCookie, createCode, listCodes, readSession, redeem, revokeCode, sessionCookie } from "./gate";
import { enforce } from "./guard";
import { loadBundle } from "./kb";
import { budgetLeft, costMicroUsd, keys, recordSpend, takeOne, today, visitorId } from "./limits";
import { decideIntake, describeFlow, runFlow } from "./flow-demo";
import { connect, emit, SessionRoom, type TraceStep } from "./live";
import { logEvent, readLogs, summarise } from "./log";
import { askClaude, askStub, detectAttack } from "./model";
import { searchNotes } from "./search";
import { activeStack } from "./stack";
import { liveNote, wantsStats } from "./stats";
import type { Bundle, Deps, Env, Note, Reply, Session } from "./types";
import { rememberForSpeech, speak } from "./voice";

const MAX_BODY_BYTES = 8_000;
const EARLIER_QUESTIONS = 4;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

function limitReply(text: string): Reply {
  return { kind: "limit", text, sources: [], openContact: true };
}

/** Browsers send Origin on POST. A page on another site cannot use this API. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------ the gate

async function enter(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  const code = typeof body?.code === "string" ? body.code : "";
  const visitor = await visitorId(request, env, deps);
  const failKey = keys.wrongCodes(today(deps), visitor);
  const cap = settings(env).visitorDailyWrongCodes;

  // Too many wrong codes today: stop checking, even if this one is right.
  if (Number(await env.STORE.get(failKey)) >= cap) {
    await logEvent(env, deps, { type: "safety", what: "wrong_code_limit" });
    return json({ error: "Too many wrong codes today. Try again tomorrow." }, 429);
  }

  const found = await redeem(env, deps, code);
  if (!found) {
    await takeOne(env.STORE, failKey, cap);
    // The code that was tried is never written anywhere.
    await logEvent(env, deps, { type: "access", ok: false, label: "unknown" });
    return json({ error: "That code isn't valid." }, 401);
  }

  const cookie = await sessionCookie(request, env, deps, found.hash);
  if (!cookie) {
    await logEvent(env, deps, { type: "error", where: "gate", message: "SESSION_SECRET is not set" });
    return json({ error: "The site isn't fully set up yet." }, 503);
  }
  await logEvent(env, deps, { type: "access", ok: true, label: found.record.label, codeId: found.record.id });
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

// ------------------------------------------------------------------ chat

function outcomeOf(kind: Reply["kind"]): "answered" | "refused" | "unknown" | "contact" | "smalltalk" {
  if (kind === "answer") return "answered";
  if (kind === "off_limits" || kind === "limit") return "refused";
  return kind;
}

async function chat(request: Request, env: Env, deps: Deps, bundle: Bundle, session: Session): Promise<Response> {
  const cfg = settings(env);
  const words = fixed(bundle.site);
  const who = { sid: session.sid, label: session.code.label };

  // Every check below is also a step in the trace. Each step is pushed to the
  // visitor's page the moment it happens, and the full list rides along with
  // the reply in case the live connection is down.
  const began = deps.now().getTime();
  const turn = crypto.randomUUID().slice(0, 8);
  const trace: TraceStep[] = [];
  const step = async (id: string, label: string, status: TraceStep["status"], detail: string) => {
    const entry: TraceStep = { id, label, status, detail, ms: deps.now().getTime() - began };
    const at = trace.findIndex((s) => s.id === id);
    if (at >= 0) trace[at] = entry;
    else trace.push(entry);
    await emit(env, session.sid, { type: "trace", turn, step: entry });
  };
  const stop = (text: string, status: number) => json({ ...limitReply(text), trace }, status);

  await step("access", "Access code", "ok", `Signed in as "${session.code.label}"`);

  const body = await readJson(request);
  const question = typeof body?.message === "string" ? body.message.trim() : "";
  if (!question) return json({ error: "Send a message." }, 400);
  if (question.length > cfg.maxMessageChars) {
    await step("limits", "Message limits", "blocked", `Over ${cfg.maxMessageChars} characters. The model was not called.`);
    return stop(words.tooLong, 200);
  }

  const earlier = Array.isArray(body?.earlier)
    ? body.earlier
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim().slice(0, cfg.maxMessageChars))
        .filter(Boolean)
        .slice(-EARLIER_QUESTIONS)
    : [];

  const visitor = await visitorId(request, env, deps);
  const messageKey = keys.messages(today(deps), visitor);
  if (!(await takeOne(env.STORE, messageKey, cfg.visitorDailyMessages))) {
    await logEvent(env, deps, { type: "safety", what: "visitor_limit", ...who });
    await step("limits", "Message limits", "blocked", `Daily limit of ${cfg.visitorDailyMessages} messages reached. The model was not called.`);
    return stop(words.visitorLimit, 429);
  }
  await step("limits", "Message limits", "ok", `Message ${Number(await env.STORE.get(messageKey))} of ${cfg.visitorDailyMessages} today`);

  let reply: Reply;
  let usage = { inputTokens: 0, outputTokens: 0 };
  // The notes for this answer. Usually the stored ones, plus live numbers when asked.
  let known = bundle;
  const attack = detectAttack(question);
  if (attack) {
    // Refused in code. The model is not called, so this costs nothing.
    await logEvent(env, deps, { type: "safety", what: attack, ...who, question });
    await step(
      "filter",
      "Injection filter",
      "blocked",
      attack === "dump" ? "Asked for the notes or instructions. Refused in code, model not called." : "Tried to change the rules. Refused in code, model not called.",
    );
    reply = enforce(JSON.stringify({ kind: "off_limits", answer: "", sources: [] }), bundle).reply;
  } else {
    await step("filter", "Injection filter", "ok", "Nothing suspicious in the question");

    // "Show me the agents working" opens a demo. The words are the owner's, fixed
    // in the notes, so the model is not needed and nothing can be invented.
    const found = detectDemo(question, bundle.demos);
    if (found) {
      const demo = isPipeline(found) ? resolveDemo(found, session.code.variant) : found;
      const note = bundle.notes.find((n) => n.id === demo.source);
      await step("demo", "Demo", "info", `Opened "${demo.title}". It runs on made-up cases and sends nothing.`);
      const opened: Reply = {
        kind: "answer",
        text: demo.intro,
        sources: note ? [{ id: note.id, title: note.title, source: note.source, url: note.url }] : [],
        openContact: false,
        demo: demo.id,
      };
      await logEvent(env, deps, { type: "turn", sid: session.sid, codeId: session.code.id, label: session.code.label, question, answer: opened.text, outcome: "answered", sources: opened.sources.map((s) => s.id), mode: cfg.live ? "live" : "stub", inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
      await step("logged", "Logged", "ok", `Cost $0.0000. Saved for ${cfg.retentionDays} days.`);
      opened.speak = await rememberForSpeech(env, opened.text);
      opened.trace = trace;
      return json(opened);
    }

    // A question about the assistant itself (usage, cost, blocked attempts) is
    // answered from its own logs, read right now and handed over as one more note.
    let live: Note | undefined;
    if (wantsStats(question)) {
      const read = await liveNote(env, deps, env.SITE_URL || new URL(request.url).origin);
      live = read.note;
      known = { ...bundle, notes: [...bundle.notes, live] };
      await step("live", "Live data", "ok", `Read ${read.records} log records from the last 7 days. Counts only, no one else's questions.`);
    }

    // With an OpenAI key, the notes are searched by meaning and only the closest
    // ones are given to the model. Without one, it gets every note.
    let searched = bundle;
    const nearest = await searchNotes(env, deps, bundle, question);
    if (nearest) {
      searched = { ...bundle, notes: nearest.notes };
      known = { ...known, notes: [...nearest.notes, ...(live ? [live] : [])] };
      await step(
        "search",
        "Search",
        "ok",
        `OpenAI ${nearest.model} over ${nearest.chunks} sections${nearest.indexed ? ", index rebuilt" : ""}. Closest notes: ${nearest.hits.map((h) => `${h.note} ${h.score.toFixed(2)}`).join(", ")}.`,
      );
    }

    let raw: string | null;
    if (!cfg.live) {
      await step("model", "Model", "info", "Stub mode: keyword match over the notes, no model call");
      raw = askStub(known, question).raw;
    } else {
      const spent = Number(await env.STORE.get(keys.spend(today(deps)))) / 1_000_000;
      if (!(await budgetLeft(env, deps))) {
        await logEvent(env, deps, { type: "safety", what: "spend_cap", ...who });
        await step("budget", "Daily budget", "blocked", `$${spent.toFixed(2)} of $${cfg.dailySpendCapUsd.toFixed(2)} used. The model was not called.`);
        return stop(words.budgetLimit, 429);
      }
      await step("budget", "Daily budget", "ok", `$${spent.toFixed(2)} of $${cfg.dailySpendCapUsd.toFixed(2)} used today`);
      const route = env.AI_GATEWAY_URL ? " through Cloudflare AI Gateway" : "";
      await step("model", "Model", "running", `Asking ${cfg.model}${route} with ${known.notes.length} notes`);
      try {
        const called = deps.now().getTime();
        const asked = await askClaude(env, deps, searched, session.code, question, earlier, live);
        usage = asked.usage;
        await recordSpend(env, deps, usage);
        raw = asked.raw;
        const seconds = ((deps.now().getTime() - called) / 1000).toFixed(1);
        await step("model", "Model", raw === null ? "blocked" : "ok", raw === null ? "The model declined to answer" : `${cfg.model} answered${route} in ${seconds}s: ${usage.inputTokens} tokens in, ${usage.outputTokens} out`);
      } catch (error) {
        let message = "Model call failed";
        if (error instanceof Anthropic.AuthenticationError) message = "Anthropic rejected the API key";
        else if (error instanceof Anthropic.RateLimitError) message = "Anthropic rate limit reached";
        else if (error instanceof Anthropic.APIError) message = `Anthropic API error ${error.status}`;
        console.error(message, error);
        await logEvent(env, deps, { type: "error", where: "chat", message });
        await step("model", "Model", "blocked", "The model call failed");
        return stop(words.broken, 503);
      }
    }

    const checked = enforce(raw, known, cfg.live && raw === null);
    if (checked.leakBlocked) await logEvent(env, deps, { type: "safety", what: "leak_blocked", ...who, question });
    reply = checked.reply;
    await step("guard", "Answer check", ...guardVerdict(reply, checked.leakBlocked));
  }

  const cost = costMicroUsd(env, usage);
  await logEvent(env, deps, {
    type: "turn",
    sid: session.sid,
    codeId: session.code.id,
    label: session.code.label,
    question,
    answer: reply.text,
    outcome: outcomeOf(reply.kind),
    sources: reply.sources.map((s) => s.id),
    mode: cfg.live ? "live" : "stub",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicroUsd: cost,
  });
  await step("logged", "Logged", "ok", `Cost $${(cost / 1_000_000).toFixed(4)}. Saved for ${cfg.retentionDays} days.`);

  reply.speak = await rememberForSpeech(env, reply.text);
  reply.trace = trace;
  return json(reply);
}

/** What the answer check decided, in words for the trace. */
function guardVerdict(reply: Reply, leakBlocked: boolean): [TraceStep["status"], string] {
  if (leakBlocked) return ["blocked", "The reply looked like the notes or instructions being read out. Replaced with a refusal."];
  switch (reply.kind) {
    case "answer":
      return ["ok", `${reply.sources.length} source${reply.sources.length === 1 ? "" : "s"} verified: ${reply.sources.map((s) => s.id).join(", ")}`];
    case "unknown":
      return ["info", "No note covers this, or the answer had no valid source. Fixed \"not in my notes\" text shown."];
    case "off_limits":
      return ["blocked", "Off limits. Fixed refusal text shown, the model's wording discarded."];
    case "contact":
      return ["info", "A request for the owner. Fixed text shown: the assistant cannot act on its own."];
    default:
      return ["ok", "Small talk, capped at 200 characters, no facts"];
  }
}

async function contact(request: Request, env: Env, deps: Deps, bundle: Bundle, session: Session): Promise<Response> {
  const body = (await readJson(request)) as ContactInput | null;
  if (!body) return json({ error: "Send the form again." }, 400);

  const done = { ok: true, message: fixed(bundle.site).contactSaved };
  // A filled honeypot gets the same answer as a real request and is dropped.
  if (typeof body.website === "string" && body.website.trim() !== "") return json(done);

  const checked = validate(body);
  if (!checked.ok) return json({ error: checked.error }, 400);

  const visitor = await visitorId(request, env, deps);
  const cap = settings(env).visitorDailyContactRequests;
  if (!(await takeOne(env.STORE, keys.contacts(today(deps), visitor), cap))) {
    return json({ error: "You've already sent a few requests today. They have been received." }, 429);
  }

  const saved = await createRequest(env, deps, bundle.site, { label: session.code.label, sid: session.sid }, checked);
  await logEvent(env, deps, { type: "contact", id: saved.id, state: "pending", label: session.code.label });
  // The visitor's page shows "waiting" now, and changes the moment the owner decides.
  await emit(env, session.sid, { type: "request", id: saved.id, state: "pending" });
  await notify(env, deps, bundle.site, saved, new URL(request.url).origin);
  return json({ ...done, requestId: saved.id });
}

// ------------------------------------------------------------------ demos

/**
 * Runs the owner's demos. Everything here works on made-up cases from the
 * private notes folder, and there is no code path that sends anything.
 */
async function demoRoute(request: Request, env: Env, deps: Deps, bundle: Bundle, session: Session, path: string): Promise<Response> {
  const [, , , id, action] = path.split("/");
  const found = (bundle.demos ?? []).find((d) => d.id === id);
  if (!found) return json({ error: "Not found" }, 404);
  const who = { sid: session.sid, label: session.code.label, demo: found.id };

  if (!action && request.method === "GET") return json(found.type === "flow" ? describeFlow(found) : isPipeline(found) ? describeDemo(resolveDemo(found, session.code.variant)) : describeData(found));
  if (request.method !== "POST") return json({ error: "Not found" }, 404);

  const visitor = await visitorId(request, env, deps);
  if (!(await takeOne(env.STORE, `demo:${today(deps)}:${visitor}`, 120))) return json({ error: "That is enough demo runs for today." }, 429);
  const body = await readJson(request);

  // Every demo action returns the full trace of what the server did, in order:
  // each step of the run, the model routing, and the model call with its cost.
  const began = deps.now().getTime();
  const trace: TraceStep[] = [];
  const step = (label: string, status: TraceStep["status"], detail: string) => {
    trace.push({ id: `d${trace.length}`, label, status, detail, ms: deps.now().getTime() - began });
  };
  const stepsOf = (run: DemoRun) => {
    for (const s of run.steps) step(`${s.agent}: ${s.title}`, s.status === "waiting" ? "info" : s.status, s.detail);
  };
  /** The score picks the model that writes the email. */
  const draftFor = async (run: DemoRun, demo: Parameters<typeof writeDraft>[2]) => {
    if (run.outcome !== "draft") return;
    const tier = tierFor(run);
    step("Model routing", "info", `A score of ${run.score!.total} goes to the ${tier} model, ${tiers(env)[tier].model}.`);
    const written = await writeDraft(env, deps, demo, run);
    run.draft = written.draft;
    run.route = written.route;
    step("Model", written.route.called ? "ok" : "info", written.route.note || "No model call was needed.");
  };

  // ---- one agent doing one job on a made-up input the site offers
  if (found.type === "flow") {
    const scenarioId = typeof body?.scenarioId === "string" ? body.scenarioId : "";
    const rec = { step, count: () => trace.length };
    if (action === "run") {
      const done = await runFlow(env, deps, found, scenarioId, rec);
      if (!done) return json({ error: "Pick one of the listed inputs." }, 400);
      await logEvent(env, deps, { type: "demo", ...who, case: scenarioId, action: "run", result: `${found.flow}, $${(done.spentMicroUsd / 1_000_000).toFixed(4)}` });
      return json({ scenario: done.scenario, blocks: done.blocks, needsDecision: done.needsDecision, draft: done.draft, trace });
    }
    if (action === "decide" && found.flow === "intake") {
      const scenario = found.scenarios.find((s) => s.id === scenarioId);
      const decision = body?.decision === "approve" || body?.decision === "reject" ? body.decision : null;
      const draft = body?.draft as { subject: string; body: string };
      if (!scenario || !decision || !draft || typeof draft.body !== "string") return json({ error: "Send the decision and the draft." }, 400);
      const record = await decideIntake(found, scenario, decision, draft, rec, deps.now());
      await logEvent(env, deps, { type: "demo", ...who, case: scenarioId, action: "decide", result: `${decision} ${record.id}` });
      return json({ record, trace });
    }
    return json({ error: "Not found" }, 404);
  }

  // ---- the data agent: one question over a made-up table
  if (!isPipeline(found)) {
    if (action !== "ask") return json({ error: "Not found" }, 404);
    const question = typeof body?.question === "string" ? body.question.trim().slice(0, settings(env).maxMessageChars) : "";
    if (!question) return json({ error: "Ask a question." }, 400);
    step("Data agent: read the question", "ok", `For the table "${found.table}". The model only describes a query. Code runs it.`);
    const result = await askData(env, deps, found, question);
    step("Model", result.route.called ? "ok" : "info", result.route.note || "No model call was needed.");
    if (result.ok) {
      step("Check the query", "ok", `${result.spec!.measure} by ${result.spec!.groupBy}${result.spec!.market ? `, ${result.spec!.market} only` : ""}. Every field is one the table has.`);
      step("Run the query", "ok", `Over ${found.rows.length} made-up rows. Returned ${result.rows!.length}.`);
      step("Write the answer", "ok", "Written by code from the result, so every number is exact.");
    } else {
      step("Check the query", "blocked", "Not a question this table can answer. Nothing was run.");
    }
    await logEvent(env, deps, { type: "demo", ...who, case: question.slice(0, 120), action: "ask", result: result.ok ? `${result.spec!.measure} by ${result.spec!.groupBy}, $${(result.route.costMicroUsd / 1_000_000).toFixed(4)}` : "not answerable" });
    // The answer is the server's own text, so it can be spoken with the site's voice.
    return json({ ...result, trace, speak: await rememberForSpeech(env, result.answer) });
  }

  // ---- the scored pipeline
  const demo = resolveDemo(found, session.code.variant);

  if (action === "list") {
    const rows = runList(demo);
    for (const row of rows) {
      step(row.name, row.outcome === "blocked" ? "blocked" : "ok", row.score === null ? `${row.route}. Not scored.` : `Scored ${row.score}. ${row.route}${row.model ? `, written by the ${row.model} model` : ""}.`);
    }
    step("Model", "info", "Scoring is code, so the list made no model call.");
    await logEvent(env, deps, { type: "demo", ...who, case: "list", action: "list", result: `${rows.length} companies` });
    return json({ rows, routing: routingOf(env, demo), trace });
  }

  if (action === "research") {
    const both = runResearch(demo, typeof body?.caseId === "string" ? body.caseId : undefined);
    if (!both) return json({ error: "This demo has no research run." }, 400);
    stepsOf(both.research);
    stepsOf(both.outreach);
    await draftFor(both.outreach, demo);
    await logEvent(env, deps, { type: "demo", ...who, case: both.research.case.id, action: "research", result: `research ${both.research.score?.total}, outreach ${both.outreach.score?.total ?? "held"}, ${both.outreach.outcome}` });
    return json({ ...both, trace });
  }

  const caseId = typeof body?.caseId === "string" ? body.caseId : "";
  const run = runCase(demo, caseId);
  if (!run) return json({ error: "Pick one of the listed cases." }, 400);

  if (action === "run") {
    stepsOf(run);
    await draftFor(run, demo);
    await logEvent(env, deps, { type: "demo", ...who, case: caseId, action: "run", result: `${run.score ? `${run.score.total}/${run.score.outOf}, ` : ""}${run.outcome}${run.route?.called ? `, ${run.route.model} $${(run.route.costMicroUsd / 1_000_000).toFixed(4)}` : ""}` });
    return json({ ...run, trace });
  }

  const draft = body?.draft as DemoDraft;
  if (!draft || typeof draft.body !== "string") return json({ error: "Send the draft." }, 400);

  if (action === "approve") {
    if (run.outcome !== "draft" || !run.needsApproval) return json({ error: "This case has nothing to approve." }, 400);
    const approval = await approveDraft(env, deps, session.sid, demo, caseId, draft);
    step("Approval", "ok", `A person approved the exact recipient, subject and body. Approval ${approval.approvalId}, valid once, for ${demo.approval.expiresHours} hours.`);
    await logEvent(env, deps, { type: "demo", ...who, case: caseId, action: "approve", result: approval.approvalId });
    return json({ ...approval, trace });
  }
  if (action === "send") {
    const result = await sendDraft(env, deps, session.sid, demo, run, draft, typeof body?.approvalId === "string" ? body.approvalId : undefined);
    step("Send check", result.ok ? "ok" : "blocked", result.reason);
    await logEvent(env, deps, { type: "demo", ...who, case: caseId, action: "send", result: result.ok ? "cleared" : result.reason });
    return json({ ...result, trace });
  }
  return json({ error: "Not found" }, 404);
}
/** Which model each kind of score goes to in this deployment, for the page to show. */
function routingOf(env: Env, demo: { routingNote?: string }) {
  const t = tiers(env);
  return { fast: t.fast.model, strong: t.strong.model, live: Boolean(env.ANTHROPIC_API_KEY), note: demo.routingNote ?? "" };
}

// ------------------------------------------------------------------ decisions

/**
 * Records the owner's decision and tells the visitor's open page at once.
 * Used by the admin page and by the Telegram buttons. It sends nothing to the
 * visitor by email or any other channel: the owner still replies personally.
 */
async function settle(env: Env, deps: Deps, id: string, state: RequestState) {
  const updated = await decide(env, deps, id, state);
  if (!updated) return null;
  await logEvent(env, deps, { type: "contact", id: updated.id, state, label: updated.label });
  if (updated.sid) await emit(env, updated.sid, { type: "request", id: updated.id, state });
  return updated;
}

/**
 * Telegram calls this when the owner taps Approve or Decline under a request
 * notification. Three things must hold: the secret header Telegram was given
 * when the webhook was registered, the owner's own chat, and a request that
 * is still pending.
 */
async function telegramWebhook(request: Request, env: Env, deps: Deps): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!secret || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ error: "Not found" }, 404);
  if (!sameSecret(given, secret)) return json({ error: "Unauthorized" }, 401);

  const update = await readJson(request);
  const tap = update?.callback_query as { id?: string; data?: string; message?: { message_id?: number; chat?: { id?: number | string } } } | undefined;
  if (!tap?.id || typeof tap.data !== "string") return json({ ok: true });
  if (String(tap.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return json({ error: "Forbidden" }, 403);

  const match = tap.data.match(/^(approved|declined):([0-9a-f-]{36})$/);
  const api = (method: string, body: unknown) =>
    deps.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);

  let text = "That request no longer exists.";
  if (match) {
    const current = (await listRequests(env)).find((r) => r.id === match[2]);
    if (current && current.status !== "pending") {
      text = `Already ${current.status}.`;
    } else if (current) {
      await settle(env, deps, current.id, match[1] as RequestState);
      text = match[1] === "approved" ? "Approved. Nothing was sent: reply from your own email." : "Declined. Nothing was sent.";
    }
  }
  await api("answerCallbackQuery", { callback_query_id: tap.id, text });
  if (tap.message?.message_id) await api("editMessageReplyMarkup", { chat_id: env.TELEGRAM_CHAT_ID, message_id: tap.message.message_id, reply_markup: { inline_keyboard: [] } });
  return json({ ok: true });
}

// ------------------------------------------------------------------ admin

const STATES: RequestState[] = ["approved", "declined", "sent"];

async function admin(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  // No token configured means no admin surface at all.
  if (!env.ADMIN_TOKEN) return json({ error: "Not found" }, 404);
  const given = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !sameSecret(given, env.ADMIN_TOKEN)) return json({ error: "Unauthorized" }, 401);

  const path = url.pathname;
  const get = request.method === "GET";
  const post = request.method === "POST";

  if (path === "/api/admin/requests" && get) return json({ requests: await listRequests(env) });

  const requestMatch = path.match(/^\/api\/admin\/requests\/([0-9a-f-]{36})$/);
  if (requestMatch && post) {
    const body = await readJson(request);
    const state = body?.decision as RequestState;
    if (!STATES.includes(state)) return json({ error: "decision must be approved, declined or sent" }, 400);
    const updated = await settle(env, deps, requestMatch[1], state);
    return updated ? json({ request: updated }) : json({ error: "Not found" }, 404);
  }

  if (path === "/api/admin/codes" && get) {
    const variants = [...new Set(((await loadBundle(env))?.demos ?? []).flatMap((d) => (isPipeline(d) ? Object.keys(d.variants ?? {}) : [])))];
    return json({ codes: (await listCodes(env)).map((c) => c.record), variants });
  }
  if (path === "/api/admin/codes" && post) {
    const body = await readJson(request);
    const label = typeof body?.label === "string" ? body.label.trim().slice(0, 60) : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 200) : "";
    const expiresAt = typeof body?.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt)) ? new Date(body.expiresAt).toISOString() : undefined;
    const variant = typeof body?.variant === "string" ? body.variant.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) : "";
    if (!label) return json({ error: "A code needs a label." }, 400);
    // The plain code is returned once, here, and stored nowhere.
    return json(await createCode(env, deps, { label, note, expiresAt, variant }));
  }
  const codeMatch = path.match(/^\/api\/admin\/codes\/([0-9a-f]{12})\/revoke$/);
  if (codeMatch && post) {
    const record = await revokeCode(env, codeMatch[1]);
    return record ? json({ record }) : json({ error: "Not found" }, 404);
  }

  if (path === "/api/admin/activity" && get) {
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 1), settings(env).retentionDays);
    return json({ days, retentionDays: settings(env).retentionDays, ...summarise(await readLogs(env, deps, days)) });
  }
  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ router

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // The static files hold no facts about anyone. Everything personal comes
  // from the API routes below, and those need a session.
  if (!path.startsWith("/api/")) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  }
  if (request.method === "POST" && !sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (path.startsWith("/api/admin/")) return admin(request, env, deps, url);

  if (path === "/api/gate" && request.method === "POST") return enter(request, env, deps);
  if (path === "/api/logout" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie });
  if (path === "/api/telegram/webhook" && request.method === "POST") return telegramWebhook(request, env, deps);

  const session = await readSession(request, env, deps);
  const bundle = await loadBundle(env);
  if (path === "/api/session" && request.method === "GET") {
    // The only things an outsider can learn: whose site this is, and that it logs.
    return json({
      authed: Boolean(session),
      title: bundle?.site.title ?? "Ask",
      owner: bundle?.site.firstName ?? "the owner",
      retentionDays: settings(env).retentionDays,
    });
  }
  if (!session) return json({ error: "An access code is needed." }, 401);

  if (!bundle) {
    await logEvent(env, deps, { type: "error", where: "knowledge", message: "No knowledge has been uploaded" });
    return json({ error: "The assistant has no notes yet. Run `npm run knowledge:push`." }, 503);
  }

  if (path === "/api/config" && request.method === "GET") {
    const cfg = settings(env);
    const { site } = bundle;
    const label = session.code.label.replace(/[<>]/g, "").trim();
    return json({
      mode: cfg.live ? "live" : "stub",
      voice: cfg.voice,
      title: site.title,
      firstName: site.firstName,
      opening: label && site.openingFor ? site.openingFor.replace("{label}", label) : site.opening,
      starters: [...site.starters, ...(bundle.demos ?? []).map((d) => d.starter)],
      // In the order the files ask for. Without one, the scored pipeline is first.
      demos: [...(bundle.demos ?? [])].sort((a, b) => orderOf(a) - orderOf(b)).map((d) => ({ id: d.id, title: d.title, type: d.type ?? "pipeline", starter: d.starter })),
      links: site.links,
      maxMessageChars: cfg.maxMessageChars,
      retentionDays: cfg.retentionDays,
      stack: activeStack(env),
    });
  }
  if (path === "/api/chat" && request.method === "POST") return chat(request, env, deps, bundle, session);
  if (path === "/api/contact" && request.method === "POST") return contact(request, env, deps, bundle, session);
  if (path.startsWith("/api/speak/") && request.method === "GET") return speak(env, deps, session, path.slice("/api/speak/".length));
  if (path.startsWith("/api/demo/")) return demoRoute(request, env, deps, bundle, session, path);
  // The live connection. It is tied to this session, so it only ever carries this visitor's events.
  if (path === "/api/live" && request.method === "GET") return connect(env, session.sid, request);
  return json({ error: "Not found" }, 404);
}

// The Durable Object class has to be exported from the Worker's entry file.
export { SessionRoom };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init), now: () => new Date() });
  },
};
