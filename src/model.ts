import Anthropic from "@anthropic-ai/sdk";
import { settings } from "./config";
import { claude } from "./providers";
import { DRAFT_SCHEMA, systemPrompt, visitorContext, wrapVisitorText } from "./prompt";
import type { Bundle, CodeRecord, Deps, Draft, Env, Note, Usage } from "./types";

export interface Asked {
  /** Raw model text, or null when the model declined. Parsed and checked in guard.ts. */
  raw: string | null;
  usage: Usage;
}

/**
 * Only the visitor's own questions go to the model. Assistant turns sent by the
 * browser are dropped, so nobody can forge "the assistant already agreed to...".
 */
function toMessages(question: string, earlier: string[]): Anthropic.Beta.BetaMessageParam[] {
  let content = wrapVisitorText(question);
  if (earlier.length > 0) {
    const list = earlier.map((q) => `- ${q.replace(/\s+/g, " ")}`).join("\n");
    content =
      `Earlier questions from this visitor, for context only:\n` +
      `${wrapVisitorText(list)}\n\nThe question to answer now:\n${content}`;
  }
  return [{ role: "user", content }];
}

export async function askClaude(
  env: Env,
  deps: Deps,
  bundle: Bundle,
  code: CodeRecord,
  question: string,
  earlier: string[],
  liveNote?: Note,
): Promise<Asked> {
  const cfg = settings(env);
  // Through the AI Gateway when it holds the key. Each call is tagged with the
  // access code's id, never its label or the code itself.
  const reached = await claude(env, deps, { app: "ask", code: code.id });
  if (!reached) throw new Error("No Claude credentials are configured");
  const { client } = reached;

  // The notes block is the same for every visitor, so it is the cached part.
  // The per-code context comes after it and does not disturb the cache.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: systemPrompt(bundle), cache_control: { type: "ephemeral" } },
  ];
  const context = visitorContext(code);
  if (context) system.push({ type: "text", text: context });
  // Numbers read from the site's own logs a moment ago. They change with every
  // message, so they go after the cached block and are never cached.
  if (liveNote) {
    system.push({
      type: "text",
      text: `One more note, read from this site's logs just now. Use it like any other note and cite its id when you use it. It is the only source for questions about this assistant's own usage, cost or blocked attempts.\n\n<note id="${liveNote.id}" title="${liveNote.title}">\n${liveNote.body}\n</note>`,
    });
  }

  const response = await client.beta.messages.create({
    model: cfg.model,
    // Thinking is always on for this model and counts toward max_tokens.
    max_tokens: 3000,
    // If the model's safety checks decline a request, the API retries it once
    // on Anthropic's recommended fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
    system,
    messages: toMessages(question, earlier),
  });

  const usage: Usage = {
    inputTokens:
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0),
    outputTokens: response.usage.output_tokens,
  };

  if (response.stop_reason === "refusal") return { raw: null, usage };

  let raw = "";
  for (const block of response.content) {
    if (block.type === "text") raw += block.text;
  }
  return { raw, usage };
}

// ------------------------------------------------------------------ attacks

const INJECTION =
  /(ignore|disregard|forget|override|bypass)\b.{0,40}\b(rules?|instructions?|prompt|guidelines|restrictions)|you are now\b|pretend (to be|you)|developer mode|jailbreak|from now on you\b|new instructions?\b|^\s*system\s*:/i;
const DUMP =
  /\b(print|show|reveal|dump|list|output|repeat|give me|display|export|enumerate|recite|leak|translate|summari[sz]e)\b.{0,60}\b(system prompt|prompt|instructions|rules|knowledge base|knowledge files?|all (of )?(your|the) (notes|files|sources|knowledge|documents)|your (notes|files|sources|documents|context|configuration)|everything (above|you know|you were told)|(text|words) above)\b|\bwhat (are|is) your (system prompt|instructions|rules)\b/i;

/**
 * Obvious attempts are refused before the model is called. It costs nothing,
 * it is the same every time, and it gives the log a clear safety event.
 * The model's own rules and the checks in guard.ts catch the less obvious ones.
 */
export function detectAttack(question: string): "injection" | "dump" | null {
  if (DUMP.test(question)) return "dump";
  if (INJECTION.test(question)) return "injection";
  return null;
}

// ------------------------------------------------------------------ stub mode

const STOPWORDS = new Set(
  "a an and are as at be been by can could did do does for from had has have he her him his how i if in is it its me my of on or she so that the their them then there they this to was we were what when where which who why will with would you your about tell more any some".split(" "),
);

const OFF_LIMITS =
  /\b(salary|salaries|paid|pay|earn|earns|wage|compensation|money|net worth|girlfriend|boyfriend|wife|husband|married|family|parents|kids|children|religion|politic\w*|vote|health|address|phone number|how old|age)\b/i;
const OFF_TOPIC = /\b(write|code|script|poem|essay|translate|recipe|joke|reply with|repeat after me|say exactly)\b/i;
const CONTACT =
  /\b(book|schedule|call|meet|meeting|interview|hire|promise|talk to (him|her|them)|speak (to|with)|reach (him|her|them)|get in touch|contact (him|her|them))\b/i;
const SMALLTALK = /^\s*(hi|hello|hey|hola|ol[áa]|thanks|thank you|obrigad[oa]|bye|goodbye|good (morning|afternoon|evening))\b[\s!.,]*$/i;

/**
 * Stub mode: no API key, no model. A keyword match over the notes so the page,
 * the limits and the approval flow can all be tried for free. It returns the
 * same Draft shape as the model and goes through the same checks.
 */
export function askStub(bundle: Bundle, question: string): Asked {
  const done = (draft: Draft): Asked => ({ raw: JSON.stringify(draft), usage: { inputTokens: 0, outputTokens: 0 } });
  const empty = { answer: "", sources: [] };
  const first = bundle.site.firstName;

  if (OFF_LIMITS.test(question) || OFF_TOPIC.test(question)) return done({ kind: "off_limits", ...empty });
  if (SMALLTALK.test(question)) return done({ kind: "smalltalk", answer: `Hello. Ask me anything about ${first}'s work.`, sources: [] });
  if (CONTACT.test(question)) return done({ kind: "contact", ...empty });

  const ignore = new Set([...STOPWORDS, ...bundle.site.name.toLowerCase().split(/\s+/)]);
  const words = question.toLowerCase().match(/[\p{L}\p{N}%]+/gu)?.filter((w) => w.length > 1 && !ignore.has(w)) ?? [];
  let best: { note: Bundle["notes"][number]; score: number; hits: number } | null = null;
  for (const note of bundle.notes) {
    const body = note.body.toLowerCase();
    let score = 0;
    let hits = 0;
    for (const word of words) {
      if (note.keywords.some((k) => k === word || k.split(" ").includes(word))) score += 2;
      else if (body.includes(word)) score += 1;
      else continue;
      hits++;
    }
    if (score > (best?.score ?? 0)) best = { note, score, hits };
  }
  // At least half of the question's content words must appear in the note.
  if (!best || best.score < 2 || best.hits * 2 < words.length) return done({ kind: "unknown", ...empty });

  const paragraphs = best.note.body.split(/\n\s*\n/).filter((p) => !p.startsWith("#"));
  let quote = "";
  for (const p of paragraphs) {
    if (quote && quote.length + p.length > 520) break;
    quote += (quote ? " " : "") + p.replace(/\s+/g, " ");
  }
  // The live numbers are the site's own, not something the owner wrote.
  const answer = best.note.id === "live-stats" ? quote : `From ${first}'s notes: "${quote}"`;
  return done({ kind: "answer", answer, sources: [best.note.id] });
}
