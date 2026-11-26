import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STACK } from "../src/stack";
import { LIVE, world } from "./helpers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const source = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts") && f !== "stack.ts").map((f) => read(join("src", f))).join("\n");

// Every kind of Cloudflare resource a Worker can be bound to in wrangler.jsonc.
const BINDING_KEYS = ["assets", "kv_namespaces", "durable_objects", "d1_databases", "r2_buckets", "queues", "workflows", "ai", "vectorize", "hyperdrive", "analytics_engine_datasets", "browser", "services", "send_email", "secrets_store_secrets"];

describe("what this runs on", () => {
  it("every entry is really used: its proof is found in the code or the config", () => {
    for (const item of STACK) expect(read(item.proof.file), `${item.name}: ${item.proof.pattern}`).toContain(item.proof.pattern);
  });

  it("every Cloudflare resource bound in the config is on the list, and nothing unbound is claimed", () => {
    const config = read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, "");
    const bound = BINDING_KEYS.filter((key) => new RegExp(`"${key}"\\s*:`).test(config));
    const listed = STACK.map((s) => s.binding).filter(Boolean);
    expect(listed.sort()).toEqual(bound.sort());
  });

  it("every outside host the code calls is on the list, and no listed host is unused", () => {
    const called = [...new Set([...source.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map((m) => m[1]))]
      // The SDK's default host is not written in this code, and these are not services.
      .filter((host) => !["room", "ask.test", "example.com"].includes(host));
    const listed = STACK.map((s) => s.host).filter((h): h is string => Boolean(h));
    for (const host of called) expect(listed, `the code calls ${host}`).toContain(host);
    for (const host of listed.filter((h) => h !== "api.anthropic.com")) expect(called, `${host} is listed`).toContain(host);
  });

  it("the README repeats the same list, word for word", () => {
    const readme = read("README.md");
    expect(readme).toContain("## What this runs on");
    for (const item of STACK) {
      expect(readme, item.name).toContain(item.name);
      expect(readme, `${item.name}: what`).toContain(item.what);
      expect(readme, `${item.name}: why`).toContain(item.why);
    }
  });

  it("the page gets only what is switched on in this deployment", async () => {
    const bare = world();
    await bare.login();
    const off = ((await (await bare.send("/api/config")).json()) as any).stack.map((s: any) => s.id);
    expect(off).toEqual(["workers", "assets", "kv", "durable-objects", "secrets"]);

    const full = world({ env: { ...LIVE, AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/x/y/anthropic", OPENAI_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" } });
    await full.login();
    const on = ((await (await full.send("/api/config")).json()) as any).stack;
    expect(on.map((s: any) => s.id)).toEqual(["workers", "assets", "kv", "durable-objects", "secrets", "ai-gateway", "claude", "openai", "telegram"]);

    const openai = world({ env: { OPENAI_API_KEY: "k" } });
    await openai.login();
    expect(((await (await openai.send("/api/config")).json()) as any).stack.map((s: any) => s.id)).toContain("openai");
    expect(on.find((s: any) => s.id === "claude").where).toBe("outside");
    // Only the name, where it runs and one line. No reasons, proofs or hosts.
    expect(Object.keys(on[0]).sort()).toEqual(["id", "name", "what", "where"]);
  });
});
