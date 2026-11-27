import { isLocal, settings } from "./config";
import type { CodeRecord, Deps, Env, Session } from "./types";

const COOKIE = "ask_session";
const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Codes are compared without case or surrounding spaces. Only this hash is stored. */
export async function hashCode(code: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(`ask-code|${code.trim().toUpperCase()}`)));
}

const codeKey = (hash: string) => `code:${hash}`;

function usable(record: CodeRecord, deps: Deps): boolean {
  return !record.revoked && (!record.expiresAt || record.expiresAt > deps.now().toISOString());
}

/** Letters and digits that are hard to mix up when read aloud or typed on a phone. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export async function createCode(
  env: Env,
  deps: Deps,
  input: { label: string; note?: string; expiresAt?: string; code?: string; variant?: string },
): Promise<{ code: string; record: CodeRecord }> {
  const code = input.code?.trim() || newCode();
  const hash = await hashCode(code);
  const record: CodeRecord = {
    id: hash.slice(0, 12),
    label: input.label,
    note: input.note ?? "",
    variant: input.variant || undefined,
    createdAt: deps.now().toISOString(),
    expiresAt: input.expiresAt,
    revoked: false,
    uses: 0,
  };
  await env.STORE.put(codeKey(hash), JSON.stringify(record));
  // A direct pointer from the short id to the record, so a code can be revoked
  // the moment it exists. Listing keys can lag a few seconds behind a write.
  await env.STORE.put(`codeid:${record.id}`, codeKey(hash));
  return { code, record };
}

export async function listCodes(env: Env): Promise<{ key: string; record: CodeRecord }[]> {
  const { keys } = await env.STORE.list({ prefix: "code:" });
  const all = [];
  for (const key of keys) {
    const raw = await env.STORE.get(key.name);
    if (raw) all.push({ key: key.name, record: JSON.parse(raw) as CodeRecord });
  }
  return all.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

/** Finds a code's storage key and record by its short id. */
async function findCode(env: Env, id: string): Promise<{ key: string; record: CodeRecord } | null> {
  // The pointer first. Codes made before it existed are found by listing.
  const key = (await env.STORE.get(`codeid:${id}`)) ?? (await listCodes(env)).find((c) => c.record.id === id)?.key;
  const raw = key ? await env.STORE.get(key) : null;
  return key && raw ? { key, record: JSON.parse(raw) as CodeRecord } : null;
}

export async function revokeCode(env: Env, id: string): Promise<CodeRecord | null> {
  const found = await findCode(env, id);
  if (!found) return null;
  const { key, record } = found;
  record.revoked = true;
  // A revoked code's link goes with it.
  if (record.linkKey) await env.STORE.delete(record.linkKey);
  delete record.linkKey;
  delete record.linkName;
  await env.STORE.put(key, JSON.stringify(record));
  return record;
}

// ------------------------------------------------------------------ personal links

/**
 * A personal link is a second way to enter an existing code: a short address
 * such as /acme-k7x2q9wd. It gives the same session as typing the code.
 *
 * The readable part comes from the code's label. The random part is what
 * keeps strangers out, so it is made here and never chosen by hand: a link
 * that is only a company name could be guessed by anyone who knows where the
 * owner applied. Like a code, the link is stored only as a hash.
 */
const LINK_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const LINK_RANDOM = 10;
const LINK_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{10}$/;

async function hashLink(slug: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(`ask-link|${slug.trim().toLowerCase()}`)));
}

function linkName(label: string): string {
  const name = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  return name || "visit";
}

/** Makes a link for a code, replacing any link it already had. The slug is returned once and stored nowhere. */
export async function createLink(env: Env, deps: Deps, id: string): Promise<{ slug: string; record: CodeRecord } | null> {
  const found = await findCode(env, id);
  if (!found || !usable(found.record, deps)) return null;
  const { key, record } = found;
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_RANDOM));
  const name = linkName(record.label);
  const slug = `${name}-${[...bytes].map((b) => LINK_ALPHABET[b % LINK_ALPHABET.length]).join("")}`;
  if (record.linkKey) await env.STORE.delete(record.linkKey);
  record.linkKey = `link:${await hashLink(slug)}`;
  record.linkName = name;
  await env.STORE.put(record.linkKey, key);
  await env.STORE.put(key, JSON.stringify(record));
  return { slug, record };
}

/** Checks an opened link. On success it counts the use, exactly as a typed code does. */
export async function redeemLink(env: Env, deps: Deps, slug: string): Promise<{ hash: string; record: CodeRecord } | null> {
  const clean = slug.trim().toLowerCase();
  if (clean.length > 80 || !LINK_SHAPE.test(clean)) return null;
  const linkKey = `link:${await hashLink(clean)}`;
  const key = await env.STORE.get(linkKey);
  const raw = key ? await env.STORE.get(key) : null;
  if (!key || !raw) return null;
  const record = JSON.parse(raw) as CodeRecord;
  // The record must still point back at this link: a replaced link stops working.
  if (record.linkKey !== linkKey || !usable(record, deps)) return null;
  record.uses++;
  record.lastUsedAt = deps.now().toISOString();
  await env.STORE.put(key, JSON.stringify(record));
  return { hash: key.slice("code:".length), record };
}

/** Checks a typed code. On success counts the use and returns the record. */
export async function redeem(env: Env, deps: Deps, code: string): Promise<{ hash: string; record: CodeRecord } | null> {
  if (!code || code.length > 80) return null;
  const hash = await hashCode(code);
  const raw = await env.STORE.get(codeKey(hash));
  if (!raw) return null;
  const record = JSON.parse(raw) as CodeRecord;
  if (!usable(record, deps)) return null;
  record.uses++;
  record.lastUsedAt = deps.now().toISOString();
  await env.STORE.put(codeKey(hash), JSON.stringify(record));
  return { hash, record };
}

// ------------------------------------------------------------------ sessions

function secret(request: Request, env: Env): string | null {
  return env.SESSION_SECRET || (isLocal(request) ? "local-dev-session-secret" : null);
}

async function sign(text: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, encoder.encode(text)));
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The cookie holds a session id, the code's hash and an expiry, signed so it can't be edited. */
export async function sessionCookie(request: Request, env: Env, deps: Deps, hash: string): Promise<string | null> {
  const key = secret(request, env);
  if (!key) return null;
  const maxAge = settings(env).sessionDays * 86_400;
  const expires = Math.floor(deps.now().getTime() / 1000) + maxAge;
  const payload = `${crypto.randomUUID()}.${hash}.${expires}`;
  const value = `${payload}.${await sign(payload, key)}`;
  // Always Secure on a real host. Plain http on your own machine can't use
  // Secure cookies in every browser, so it is left off there only.
  const secure = isLocal(request) ? "" : " Secure;";
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly;${secure} SameSite=Strict`;
}

export const clearCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/**
 * Returns the session if the cookie is genuine, not expired, and its code is
 * still valid. The code is looked up on every request, so revoking a code
 * ends the sessions opened with it at once.
 */
export async function readSession(request: Request, env: Env, deps: Deps): Promise<Session | null> {
  const key = secret(request, env);
  if (!key) return null;
  const cookie = (request.headers.get("Cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return null;
  const parts = cookie.slice(COOKIE.length + 1).split(".");
  if (parts.length !== 4) return null;
  const [sid, hash, expires, signature] = parts;
  if (!same(signature, await sign(`${sid}.${hash}.${expires}`, key))) return null;
  if (Number(expires) * 1000 < deps.now().getTime()) return null;
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const raw = await env.STORE.get(codeKey(hash));
  if (!raw) return null;
  const record = JSON.parse(raw) as CodeRecord;
  return usable(record, deps) ? { sid, code: record } : null;
}
