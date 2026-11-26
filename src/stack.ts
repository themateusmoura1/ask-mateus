import { hasClaude, hasOpenAI } from "./providers";
import type { Env } from "./types";

/**
 * What this site runs on. This is the one list. The page shows it, the README
 * repeats it, and a test checks each entry against the code and the config,
 * so it can't claim a product that isn't used or leave out one that is.
 */
export interface StackItem {
  id: string;
  name: string;
  where: "cloudflare" | "outside";
  /** One short line: what it does here. */
  what: string;
  /** One line for the README: why this and not something else. */
  why: string;
  /** Where the code uses it: a file and a pattern that must be found there. */
  proof: { file: string; pattern: string };
  /** The config key in wrangler.jsonc that binds it, if it has one. */
  binding?: string;
  /** The outside host it talks to, if any. */
  host?: string;
  /** Whether it is switched on in this deployment. Missing means always. */
  active?: (env: Env) => boolean;
}

export const STACK: StackItem[] = [
  {
    id: "workers",
    name: "Cloudflare Workers",
    where: "cloudflare",
    what: "Runs every request: the gate, the limits, the answer check and the demos.",
    why: "One small program at the edge, with no server to run and nothing to pay while nobody is using it.",
    proof: { file: "wrangler.jsonc", pattern: '"main": "src/index.ts"' },
  },
  {
    id: "assets",
    name: "Workers Static Assets",
    where: "cloudflare",
    what: "Serves the page itself.",
    why: "The front end ships with the Worker, so the site is one deploy and one address.",
    proof: { file: "wrangler.jsonc", pattern: '"assets"' },
    binding: "assets",
  },
  {
    id: "kv",
    name: "Workers KV",
    where: "cloudflare",
    what: "Holds the notes, the hashed access codes, the logs, the counters and the contact requests.",
    why: "Simple private storage where every record can carry its own expiry, which is how the 90 day log deletion works.",
    proof: { file: "wrangler.jsonc", pattern: '"kv_namespaces"' },
    binding: "kv_namespaces",
  },
  {
    id: "durable-objects",
    name: "Durable Objects",
    where: "cloudflare",
    what: "One per visitor session. Holds the WebSocket that carries the live trace and approval updates.",
    why: "A visitor needs one live connection that the server can push to. A Durable Object gives each session its own, and sleeps when idle.",
    proof: { file: "src/live.ts", pattern: "acceptWebSocket" },
    binding: "durable_objects",
  },
  {
    id: "secrets",
    name: "Worker secrets",
    where: "cloudflare",
    what: "Keeps the API keys, the admin token and the cookie signing key out of the code.",
    why: "No key is ever in the repo or in the page.",
    proof: { file: "src/gate.ts", pattern: "env.SESSION_SECRET" },
  },
  {
    id: "secrets-store",
    name: "Cloudflare Secrets Store",
    where: "cloudflare",
    what: "Holds the provider keys the gateway uses, and the token the Worker shows the gateway.",
    why: "Keys live in one place for the whole account, and can be rotated without a deploy.",
    proof: { file: "wrangler.jsonc", pattern: "\"secrets_store_secrets\"" },
    binding: "secrets_store_secrets",
    active: (env) => typeof env.AI_GATEWAY_TOKEN === "object",
  },
  {
    id: "ai-gateway",
    name: "Cloudflare AI Gateway",
    where: "cloudflare",
    what: "Sits between the Worker and the models. It holds the provider keys and records every call, its tokens and its cost.",
    why: "The Worker never holds a provider key, and there is one view of model traffic and spend.",
    proof: { file: "src/providers.ts", pattern: "cf-aig-authorization" },
    host: "gateway.ai.cloudflare.com",
    active: (env) => Boolean(env.AI_GATEWAY_URL) && (hasClaude(env) || hasOpenAI(env)),
  },
  {
    id: "claude",
    name: "Claude API (Anthropic)",
    where: "outside",
    what: "Writes the answers, from the notes it is given.",
    why: "It follows the grounding rules well and returns a strict JSON shape the answer check can verify.",
    proof: { file: "src/providers.ts", pattern: "@anthropic-ai/sdk" },
    host: "api.anthropic.com",
    active: (env) => hasClaude(env),
  },
  {
    id: "openai",
    name: "OpenAI API",
    where: "outside",
    what: "Embeds the notes and each question for search, and speaks the answers.",
    why: "Search by meaning finds the right note when the question uses different words, and the same key gives a natural voice.",
    proof: { file: "src/providers.ts", pattern: "api.openai.com/v1" },
    host: "api.openai.com",
    active: (env) => hasOpenAI(env),
  },
  {
    id: "telegram",
    name: "Telegram",
    where: "outside",
    what: "Tells the owner a contact request is waiting, with Approve and Decline buttons.",
    why: "The owner can approve from a phone in one tap.",
    proof: { file: "src/contact.ts", pattern: "api.telegram.org" },
    host: "api.telegram.org",
    active: (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  },
  {
    id: "resend",
    name: "Resend",
    where: "outside",
    what: "Emails the owner when a contact request is waiting.",
    why: "A fallback for the owner's own alerts. It never emails a visitor.",
    proof: { file: "src/contact.ts", pattern: "api.resend.com" },
    host: "api.resend.com",
    active: (env) => Boolean(env.RESEND_API_KEY && env.NOTIFY_EMAIL_TO && env.NOTIFY_EMAIL_FROM),
  },
];

/** What is switched on in this deployment, in the form the page shows. */
export function activeStack(env: Env) {
  return STACK.filter((item) => !item.active || item.active(env)).map(({ id, name, where, what }) => ({ id, name, where, what }));
}
