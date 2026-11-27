import { hasClaude, hasOpenAI } from "./providers";
import type { Env, Site } from "./types";

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && value !== undefined && value !== "" ? n : fallback;
}

export function settings(env: Env) {
  return {
    model: env.MODEL || "claude-opus-5-5",
    priceInput: num(env.PRICE_INPUT_PER_MTOK, 4),
    priceOutput: num(env.PRICE_OUTPUT_PER_MTOK, 20),
    dailySpendCapUsd: num(env.DAILY_SPEND_CAP_USD, 2),
    visitorDailyMessages: num(env.VISITOR_DAILY_MESSAGES, 20),
    visitorDailyContactRequests: num(env.VISITOR_DAILY_CONTACT_REQUESTS, 3),
    visitorDailyWrongCodes: num(env.VISITOR_DAILY_WRONG_CODES, 8),
    maxMessageChars: num(env.MAX_MESSAGE_CHARS, 500),
    sessionDays: num(env.SESSION_DAYS, 7),
    retentionDays: Math.max(1, num(env.LOG_RETENTION_DAYS, 90)),
    dailyVoiceChars: num(env.DAILY_VOICE_CHARS, 20000),
    live: hasClaude(env),
    // OpenAI speaks the answers. Without it, the browser's own voice is used.
    voice: hasOpenAI(env),
    ttsModel: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    ttsVoice: env.OPENAI_TTS_VOICE || "cedar",
  };
}

/**
 * The site's own wording. The model never writes these, so a prompt cannot
 * change them. "unknown" and "off_limits" are small pools, so a visitor who
 * hits them twice does not read the same sentence twice.
 */
export function fixed(site: Site) {
  const { firstName: name, pronoun } = site;
  return {
    unknown: [
      `I'm not sure about that one. ${name} is the right person to ask, and "Talk to the real ${name}" below reaches ${pronoun}.`,
      `I don't know that, and I'd rather not guess. Ask ${name} directly with the button below.`,
      `That hasn't come up in what ${name} told me. You can ask ${pronoun} yourself with the button below.`,
      `I can't say for sure, so I won't make something up. ${name} can answer that one. The button below reaches ${pronoun}.`,
      `I don't have an answer to that yet. Send it to ${name} with the button below and you'll get a real one.`,
    ],
    off_limits: [
      `That's one I stay out of. Ask me about ${name}'s work and I can help.`,
      `I'll pass on that one. I'm here for questions about ${name}'s work and how it was built.`,
      `I can't help with that here. Try me on ${name}'s projects, agents or career.`,
      `I keep to ${name}'s work, so I'll leave that alone. What would you like to know about the work?`,
    ],
    contact: `To reach ${name}, leave your name, email and reason below and you'll get a reply by email. I can't book or promise anything myself.`,
    visitorLimit: `That's the message limit for today. It resets tomorrow, or you can reach ${name} with "Talk to the real ${name}".`,
    budgetLimit: `I've used up today's budget, so I'm off until tomorrow. You can still leave ${name} a request below.`,
    tooLong: "That's too long for me. Can you ask it in a sentence or two?",
    broken: `Something broke on my side. Try again in a minute, or leave ${name} a request below.`,
    contactSaved: `Got it. ${name} reads every request and replies by email. Nothing is sent automatically.`,
  };
}

/** Picks one line from a pool. Tests pass their own picker. */
export type Pick = (pool: string[]) => string;
export const anyOf: Pick = (pool) => pool[Math.floor(Math.random() * pool.length)];

/** True on a developer's own machine, where missing secrets get a fallback. */
export function isLocal(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
