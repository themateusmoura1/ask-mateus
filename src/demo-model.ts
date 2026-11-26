import { settings } from "./config";
import type { Demo, DemoDraft, DemoRun } from "./demo";
import { addSpend, budgetLeft } from "./limits";
import { claude, hasClaude } from "./providers";
import type { Deps, Env } from "./types";

/**
 * Model calls made by the demos, and the rule that picks the model.
 *
 * A demo does not use one model for everything. Cheap, quick work goes to a
 * small fast model. Work that decides something a person will approve goes to
 * a stronger one. Which model is which is a setting, and every call reports
 * its tokens and its cost.
 */

export type Tier = "fast" | "strong";

export interface Route {
  tier: Tier;
  model: string;
  /** False when no call was made: stub mode, the budget is used up, or the call failed. */
  called: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  /** One line for the visitor: what happened and why. */
  note: string;
}

export function tiers(env: Env) {
  const cfg = settings(env);
  const num = (value: string | undefined, fallback: number) => (value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    fast: {
      model: env.DEMO_FAST_MODEL || "claude-haiku-5-5",
      priceInput: num(env.DEMO_FAST_PRICE_INPUT_PER_MTOK, 0.1),
      priceOutput: num(env.DEMO_FAST_PRICE_OUTPUT_PER_MTOK, 0.5),
    },
    strong: {
      model: env.DEMO_STRONG_MODEL || cfg.model,
      priceInput: num(env.DEMO_STRONG_PRICE_INPUT_PER_MTOK, cfg.priceInput),
      priceOutput: num(env.DEMO_STRONG_PRICE_OUTPUT_PER_MTOK, cfg.priceOutput),
    },
  };
}

/** The score decides the model. A path can name its tier; otherwise 70 and up is strong. */
export function tierFor(run: Pick<DemoRun, "score" | "path">): Tier {
  if (run.path?.model) return run.path.model;
  return (run.score?.total ?? 0) >= 70 ? "strong" : "fast";
}

/**
 * One call that must return JSON in a given shape. Returns null, with the
 * reason, instead of throwing: a demo always has something canned to fall
 * back on.
 */
export async function callJson<T>(
  env: Env,
  deps: Deps,
  tier: Tier,
  request: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number },
): Promise<{ value: T | null; route: Route }> {
  const chosen = tiers(env)[tier];
  const route: Route = { tier, model: chosen.model, called: false, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, note: "" };

  if (!hasClaude(env)) {
    route.note = `Stub mode: no model was called. With a key this goes to ${chosen.model}.`;
    return { value: null, route };
  }
  // Demo calls count against the same daily cap as the assistant's answers.
  if (!(await budgetLeft(env, deps))) {
    route.note = "The daily budget is used up, so no model was called.";
    return { value: null, route };
  }

  const reached = await claude(env, deps, { app: "ask-demo", tier });
  if (!reached) {
    route.note = "The model could not be reached, so the prepared version is shown.";
    return { value: null, route };
  }
  const { client } = reached;

  try {
    const response = await client.messages.create({
      model: chosen.model,
      // Thinking counts toward this limit on current models.
      max_tokens: request.maxTokens ?? 2500,
      output_config: { effort: "low", format: { type: "json_schema", schema: request.schema } },
      system: request.system,
      messages: [{ role: "user", content: request.user }],
    });
    route.called = true;
    route.inputTokens = response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
    route.outputTokens = response.usage.output_tokens;
    route.costMicroUsd = Math.ceil(route.inputTokens * chosen.priceInput + route.outputTokens * chosen.priceOutput);
    await addSpend(env, deps, route.costMicroUsd);

    if (response.stop_reason === "refusal") {
      route.note = `${chosen.model} declined, so the prepared version is shown.`;
      return { value: null, route };
    }
    let text = "";
    for (const block of response.content) if (block.type === "text") text += block.text;
    route.note = `${chosen.model}: ${route.inputTokens} tokens in, ${route.outputTokens} out, $${(route.costMicroUsd / 1_000_000).toFixed(4)}.`;
    return { value: JSON.parse(text) as T, route };
  } catch (error) {
    console.error("demo model call failed", error);
    route.note = `The call to ${chosen.model} failed, so the prepared version is shown.`;
    return { value: null, route };
  }
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"],
  additionalProperties: false,
};

/**
 * Writes the outreach email for a scored company, on the model its score
 * earned. The recipient is never the model's to choose, and a draft that
 * contains an address or a link is thrown away for the prepared one.
 */
export async function writeDraft(env: Env, deps: Deps, demo: Demo, run: DemoRun): Promise<{ draft: DemoDraft | undefined; route: Route }> {
  const tier = tierFor(run);
  const prepared = run.draft;
  if (!prepared || !run.score) return { draft: prepared, route: { tier, model: tiers(env)[tier].model, called: false, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, note: "" } };

  const facts = run.score.lines.flatMap((line) => line.evidence.filter((e) => e.counted).map((e) => `- ${e.fact} (${e.source})`));
  const length = tier === "strong" ? "Write 90 to 140 words. Open with the most specific fact. Include the one idea for the meeting." : "Write at most 60 words. One fact, one offer, one question.";
  const system =
    `You write one outreach email for this offering: ${demo.offering ?? "the sender's service"}\n\n` +
    `Use only the facts you are given. Each has a source. Do not add facts, names, numbers, prices, links or email addresses. ` +
    `Plain words, short sentences, no buzzwords, no dashes. ${length}\n` +
    `End the body after the last sentence. No sign-off, no name, no company name and no signature.`;
  const user = `Company: ${run.case.name}\n\nFacts:\n${facts.join("\n")}\n\n${run.research?.length && tier === "strong" ? `Research notes:\n${run.research.map((r) => `- ${r}`).join("\n")}` : ""}`;

  const { value, route } = await callJson<{ subject: string; body: string }>(env, deps, tier, { system, user, schema: DRAFT_SCHEMA });
  const usable = value && typeof value.subject === "string" && typeof value.body === "string" && value.body.length > 40 && value.body.length < 2000 && !/@|https?:\/\/|www\./i.test(`${value.subject} ${value.body}`);
  if (!usable) {
    if (value) route.note += " Its draft contained an address or a link, so the prepared version is shown.";
    return { draft: prepared, route };
  }
  return { draft: { to: prepared.to, subject: value.subject.slice(0, 200), body: value.body }, route };
}
