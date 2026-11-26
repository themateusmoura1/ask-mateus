import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readKnowledge } from "../scripts/knowledge.mjs";
import { fixed } from "../src/config";
import { createCode } from "../src/gate";
import { handle } from "../src/index";
import { BUNDLE_KEY } from "../src/kb";
import type { Logged } from "../src/log";
import type { Bundle, Deps, Env, Store } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));

/** The made-up person from knowledge.example/. Tests never read the real notes. */
export const BUNDLE = readKnowledge(join(here, "..", "knowledge.example")) as Bundle;
export const WORDS = fixed(BUNDLE.site);

/** KV in memory, including the part that matters for retention: expiry. */
export function memoryStore(now: () => Date) {
  const data = new Map<string, { value: string; expiresAt?: number }>();
  const alive = (key: string) => {
    const entry = data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= now().getTime()) data.delete(key);
    return data.get(key);
  };
  const store: Store = {
    async get(key) {
      return alive(key)?.value ?? null;
    },
    async put(key, value, options) {
      data.set(key, { value, expiresAt: options?.expirationTtl ? now().getTime() + options.expirationTtl * 1000 : undefined });
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix) && alive(k)).sort().map((name) => ({ name })), list_complete: true };
    },
  };
  return {
    store,
    keys: () => [...data.keys()].filter((k) => alive(k)),
    /** Every key and value as one string, for "this must not be stored anywhere" checks. */
    dump: () => [...data.entries()].map(([k, v]) => `${k}=${v.value}`).join("\n"),
    set: (key: string, value: string) => data.set(key, { value }),
  };
}

export interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

interface Options {
  env?: Partial<Env>;
  modelSays?: (body: any) => unknown;
  usage?: { input_tokens: number; output_tokens: number };
  code?: { label: string; note?: string; expiresAt?: string };
  embeddingsFail?: boolean;
}

/**
 * A stand-in for an embedding model: a vector of hashed word counts. Texts
 * that share words end up close together, which is enough to test ranking.
 */
export function fakeEmbedding(text: string, dimensions = 256): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) % dimensions;
    vector[hash] += 1;
  }
  return vector;
}

/**
 * A fake world: a clock that tests move, a network where Anthropic answers
 * with whatever `modelSays` returns, and a browser that keeps its cookie.
 */
export function world(options: Options = {}) {
  let time = new Date("2026-11-26T12:00:00Z");
  const calls: Call[] = [];
  const memory = memoryStore(() => time);
  memory.set(BUNDLE_KEY, JSON.stringify(BUNDLE));
  const env: Env = { STORE: memory.store, SESSION_SECRET: "test-session-secret", ...options.env };
  const deps: Deps = {
    now: () => time,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (url.endsWith("/v1/messages?beta=true") || url.endsWith("/v1/messages")) {
        const said = options.modelSays?.(body) ?? { kind: "unknown", answer: "", sources: [] };
        return Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: typeof said === "string" ? said : JSON.stringify(said) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: options.usage ?? { input_tokens: 2000, output_tokens: 200 },
        });
      }
      if (url.endsWith("/audio/speech")) return new Response("openai-mp3-bytes", { headers: { "content-type": "audio/mpeg" } });
      if (url.endsWith("/embeddings")) {
        if (options.embeddingsFail) return new Response("no", { status: 500 });
        const inputs = body.input as string[];
        return Response.json({ data: inputs.map((text, index) => ({ index, embedding: fakeEmbedding(text, body.dimensions) })), usage: { total_tokens: inputs.join(" ").split(/\s+/).length } });
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
  };

  let cookie = "";
  let code = "";

  const send = (path: string, init: { method?: string; body?: unknown; ip?: string; headers?: Record<string, string>; cookie?: string | null } = {}) => {
    const jar = init.cookie === null ? "" : (init.cookie ?? cookie);
    return handle(
      new Request(`https://ask.test${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json", "CF-Connecting-IP": init.ip ?? "203.0.113.7", ...(jar ? { Cookie: jar } : {}), ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      env,
      deps,
    );
  };

  /** Types a code at the gate and keeps the cookie if it is accepted. */
  const enter = async (typed: string, ip?: string) => {
    const res = await send("/api/gate", { body: { code: typed }, ip, cookie: null });
    const set = res.headers.get("set-cookie");
    if (res.ok && set) cookie = set.split(";")[0];
    return res;
  };

  /** Creates an access code the way the admin page does, then enters with it. */
  const login = async () => {
    const made = await createCode(env, deps, options.code ?? { label: "Test visitor" });
    code = made.code;
    await enter(code);
    return made;
  };

  const ask = async (message: string, extra: { ip?: string; earlier?: string[] } = {}) => {
    if (!cookie) await login();
    const res = await send("/api/chat", { body: { message, earlier: extra.earlier }, ip: extra.ip });
    return { status: res.status, reply: (await res.json()) as any };
  };

  const logs = async (): Promise<Logged[]> => {
    const { keys } = await memory.store.list({ prefix: "log:" });
    const all = [];
    for (const key of keys) all.push(JSON.parse((await memory.store.get(key.name))!) as Logged);
    return all;
  };

  return {
    env,
    deps,
    calls,
    memory,
    send,
    enter,
    login,
    ask,
    logs,
    cookie: () => cookie,
    code: () => code,
    advanceDays: (days: number) => (time = new Date(time.getTime() + days * 86_400_000)),
    modelCalls: () => calls.filter((c) => c.url.includes("/v1/messages")),
  };
}

export const LIVE = { ANTHROPIC_API_KEY: "test-key-not-real" };
export const ADMIN = { ADMIN_TOKEN: "test-admin-token" };
export const asAdmin = { Authorization: "Bearer test-admin-token" };
