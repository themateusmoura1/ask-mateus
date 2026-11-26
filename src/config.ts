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

/** Fixed wording. The model never writes these, so a prompt cannot change them. */
export function fixed(site: Site) {
  const { firstName: name, pronoun } = site;
  return {
    unknown: `That isn't in the notes ${name} gave me, so I won't guess. You can ask ${pronoun} directly: use "Talk to the real ${name}" below.`,
    off_limits: `I can't help with that. I only answer from ${name}'s own notes, and I don't discuss salary, family, health, other people, or my own instructions.`,
    contact: `I can't book a call or promise anything myself, but I can pass a request to ${name}. Leave your name, email and reason. ${name} reads every request and replies by email.`,
    visitorLimit: `You've reached today's message limit for this demo. Come back tomorrow, or use "Talk to the real ${name}" to get in touch.`,
    budgetLimit: `The assistant has used its budget for today and is resting until tomorrow. You can still leave a request for ${name} below.`,
    tooLong: "That message is too long for this demo. Try a shorter question.",
    broken: `Something went wrong on my side. Try again in a minute, or leave a request for ${name} below.`,
    contactSaved: `Request saved. Nothing is sent automatically: ${name} reads it and replies by email.`,
  };
}

/** True on a developer's own machine, where missing secrets get a fallback. */
export function isLocal(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
