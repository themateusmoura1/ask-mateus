import { settings } from "./config";
import type { Deps, Env, Store, Usage } from "./types";

const TWO_DAYS = 60 * 60 * 48;

export function today(deps: Deps): string {
  return deps.now().toISOString().slice(0, 10);
}

/**
 * A visitor is a salted hash of the IP address and the date. The raw IP is
 * never stored, and the hash changes every day.
 */
export async function visitorId(request: Request, env: Env, deps: Deps): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const salt = env.VISITOR_SALT || "dev-salt-change-me";
  const bytes = new TextEncoder().encode(`${salt}|${today(deps)}|${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readNumber(store: Store, key: string): Promise<number> {
  const n = Number(await store.get(key));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Counts one use against a daily cap. Returns false when the cap is already
 * reached. KV has no atomic increment, so two requests in the same instant can
 * both pass. That is fine for a per-visitor cap on a small site.
 */
export async function takeOne(store: Store, key: string, cap: number): Promise<boolean> {
  const used = await readNumber(store, key);
  if (used >= cap) return false;
  await store.put(key, String(used + 1), { expirationTtl: TWO_DAYS });
  return true;
}

export const keys = {
  messages: (day: string, visitor: string) => `msg:${day}:${visitor}`,
  contacts: (day: string, visitor: string) => `ctc:${day}:${visitor}`,
  wrongCodes: (day: string, visitor: string) => `bad:${day}:${visitor}`,
  spend: (day: string) => `spend:${day}`,
  voiceChars: (day: string) => `voice:${day}`,
};

/** Spend is stored in millionths of a dollar so it stays an integer. */
export function costMicroUsd(env: Env, usage: Usage): number {
  const cfg = settings(env);
  return Math.ceil(usage.inputTokens * cfg.priceInput + usage.outputTokens * cfg.priceOutput);
}

export async function budgetLeft(env: Env, deps: Deps): Promise<boolean> {
  const spent = await readNumber(env.STORE, keys.spend(today(deps)));
  return spent < settings(env).dailySpendCapUsd * 1_000_000;
}

export async function recordSpend(env: Env, deps: Deps, usage: Usage): Promise<void> {
  const key = keys.spend(today(deps));
  const spent = await readNumber(env.STORE, key);
  await env.STORE.put(key, String(spent + costMicroUsd(env, usage)), { expirationTtl: TWO_DAYS });
}

export async function takeVoiceChars(env: Env, deps: Deps, chars: number): Promise<boolean> {
  const key = keys.voiceChars(today(deps));
  const used = await readNumber(env.STORE, key);
  if (used + chars > settings(env).dailyVoiceChars) return false;
  await env.STORE.put(key, String(used + chars), { expirationTtl: TWO_DAYS });
  return true;
}

/** Adds a cost that was worked out elsewhere, for calls that use another model's prices. */
export async function addSpend(env: Env, deps: Deps, microUsd: number): Promise<void> {
  const key = keys.spend(today(deps));
  const spent = await readNumber(env.STORE, key);
  await env.STORE.put(key, String(spent + Math.max(0, Math.ceil(microUsd))), { expirationTtl: TWO_DAYS });
}