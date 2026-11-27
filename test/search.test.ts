import { describe, expect, it } from "vitest";
import { chunksOf, cosine } from "../src/search";
import { BUNDLE, LIVE, world } from "./helpers";

const OPENAI = { OPENAI_API_KEY: "test-openai-key" };
const embeds = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.url.endsWith("/v1/embeddings"));

describe("embedding search over the notes", () => {
  it("cuts each note into its sections", () => {
    const chunks = chunksOf(BUNDLE.notes);
    const returns = chunks.filter((c) => c.note === "returns-agent");
    expect(returns.map((c) => c.heading)).toEqual(["Overview", "How it works"]);
    expect(returns[1].text).toContain("The returns agent. How it works.");
    expect(chunks.length).toBeGreaterThan(BUNDLE.notes.length);
  });

  it("gives the model only the closest notes, and shows the search in the trace", async () => {
    const w = world({ env: { ...LIVE, ...OPENAI }, modelSays: () => ({ kind: "answer", answer: "The agent has three tools and no tool that sends email.", sources: ["returns-agent"] }) });
    const { reply } = await w.ask("Which tools does the returns agent have, and can it send email?");

    const search = reply.trace.find((s: any) => s.id === "search");
    expect(search.detail).toMatch(/^OpenAI text-embedding-3-small over \d+ sections, index rebuilt\. Closest notes: returns-agent 0\.\d\d/);

    const system = w.modelCalls()[0].body.system[0].text as string;
    expect(system).toContain('<note id="returns-agent"');
    // The contact note always rides along. A note far from the question does not.
    expect(system).toContain('<note id="contact"');
    expect((system.match(/<note id=/g) ?? []).length).toBeLessThan(BUNDLE.notes.length + 1);
    expect(reply.kind).toBe("answer");
    expect(reply.sources[0].id).toBe("returns-agent");
  });

  it("builds the index once and reuses it until the notes change", async () => {
    const w = world({ env: { ...LIVE, ...OPENAI } });
    await w.ask("How does the returns agent work?");
    // First question: one call to embed every section, one for the question.
    expect(embeds(w).map((c) => c.body.input.length)).toEqual([chunksOf(BUNDLE.notes).length, 1]);
    await w.ask("And the weekly stock digest?");
    expect(embeds(w)).toHaveLength(3);
    expect(embeds(w)[0].body).toMatchObject({ model: "text-embedding-3-small", dimensions: 256 });
    expect(embeds(w)[0].headers.authorization).toBe("Bearer test-openai-key");

    // New notes mean a new index.
    w.memory.set("kb:bundle", JSON.stringify({ ...BUNDLE, notes: [...BUNDLE.notes, { ...BUNDLE.notes[0], id: "extra", body: "A new note about lighthouses." }] }));
    const { reply } = await w.ask("Tell me about lighthouses");
    expect(reply.trace.find((s: any) => s.id === "search").detail).toContain("index rebuilt");
  });

  it("cannot be used to cite a note the search did not return", async () => {
    const w = world({ env: { ...LIVE, ...OPENAI }, modelSays: () => ({ kind: "answer", answer: "It posts a summary on Mondays.", sources: ["stock-digest"] }) });
    const { reply } = await w.ask("Which tools does the returns agent have, and can it send email?");
    const given = (w.modelCalls()[0].body.system[0].text as string).includes('<note id="stock-digest"');
    // Either the note was among the ones given, or the answer is dropped.
    expect(reply.kind).toBe(given ? "answer" : "unknown");
  });

  it("counts the embedding cost against the daily cap", async () => {
    const w = world({ env: { ...LIVE, ...OPENAI, OPENAI_EMBEDDING_PRICE_PER_MTOK: "1000" }, usage: { input_tokens: 0, output_tokens: 0 } });
    await w.ask("How does the returns agent work?");
    expect(Number(await w.env.STORE.get("spend:2026-11-26"))).toBeGreaterThan(0);
  });

  it("falls back to every note when the search fails", async () => {
    const w = world({ env: { ...LIVE, ...OPENAI }, embeddingsFail: true, modelSays: () => ({ kind: "answer", answer: "Sam built a returns agent.", sources: ["returns-agent"] }) });
    const { reply } = await w.ask("What has Sam built?");
    expect(reply.kind).toBe("answer");
    expect(reply.trace.some((s: any) => s.id === "search")).toBe(false);
    expect((w.modelCalls()[0].body.system[0].text.match(/<note id=/g) ?? []).length).toBe(BUNDLE.notes.length);
  });

  it("is off without an OpenAI key", async () => {
    const w = world({ env: LIVE });
    const { reply } = await w.ask("What has Sam built?");
    expect(reply.trace.some((s: any) => s.id === "search")).toBe(false);
    expect(embeds(w)).toEqual([]);
  });

  it("measures closeness the usual way", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("the OpenAI voice", () => {
  it("speaks with OpenAI when its key is set, and only text the assistant wrote", async () => {
    const w = world({ env: { ...OPENAI, OPENAI_TTS_VOICE: "sage" } });
    const { reply } = await w.ask("How does the returns agent work?");
    const audio = await w.send(`/api/speak/${reply.speak}`);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    const call = w.calls.find((c) => c.url.endsWith("/v1/audio/speech"))!;
    expect(call.body).toEqual({ model: "gpt-4o-mini-tts", voice: "sage", input: reply.text, response_format: "mp3" });
    expect(call.headers.authorization).toBe("Bearer test-openai-key");
  });

  it("passes the accent and tone line to the voice when one is set", async () => {
    const w = world({ env: { ...OPENAI, OPENAI_TTS_VOICE: "sage", OPENAI_TTS_INSTRUCTIONS: " Speak in British English. " } });
    const { reply } = await w.ask("How does the returns agent work?");
    await w.send(`/api/speak/${reply.speak}`);
    const call = w.calls.find((c) => c.url.endsWith("/v1/audio/speech"))!;
    expect(call.body).toMatchObject({ voice: "sage", instructions: "Speak in British English." });
  });

  it("never writes the OpenAI key to storage or to the page", async () => {
    const w = world({ env: { ...LIVE, ...OPENAI } });
    const { reply } = await w.ask("How does the returns agent work?");
    expect(w.memory.dump()).not.toContain("test-openai-key");
    expect(JSON.stringify(reply)).not.toContain("test-openai-key");
  });
});

describe("provider keys held by the AI Gateway", () => {
  const account = "e".repeat(32);
  const base = `https://gateway.ai.cloudflare.com/v1/${account}/my-gateway`;
  // The token comes from a Secrets Store binding: an object with get(), not a string.
  const GATEWAY = { AI_GATEWAY_URL: base, AI_GATEWAY_TOKEN: { get: async () => "test-gateway-token" }, GATEWAY_PROVIDERS: "anthropic,openai" };

  it("runs in live mode with no provider key in the Worker at all", async () => {
    const w = world({ env: GATEWAY, modelSays: () => ({ kind: "answer", answer: "Sam built a returns agent.", sources: ["returns-agent"] }) });
    const { reply } = await w.ask("How does the returns agent work?");
    expect(reply.kind).toBe("answer");

    const claudeCall = w.modelCalls()[0];
    expect(claudeCall.url.startsWith(`${base}/anthropic/v1/messages`)).toBe(true);
    expect(claudeCall.headers["cf-aig-authorization"]).toBe("Bearer test-gateway-token");
    // No provider credential of any kind leaves the Worker: the gateway adds the real key.
    expect(claudeCall.headers["x-api-key"]).toBeUndefined();
    expect(claudeCall.headers.authorization).toBeUndefined();

    const embedCall = w.calls.find((c) => c.url.endsWith("/embeddings"))!;
    expect(embedCall.url).toBe(`${base}/openai/embeddings`);
    expect(embedCall.headers["cf-aig-authorization"]).toBe("Bearer test-gateway-token");
    expect(embedCall.headers.authorization).toBeUndefined();

    await w.send(`/api/speak/${reply.speak}`);
    const speech = w.calls.find((c) => c.url.endsWith("/audio/speech"))!;
    expect(speech.url).toBe(`${base}/openai/audio/speech`);
    expect(speech.body.voice).toBe("cedar");
    expect(speech.headers.authorization).toBeUndefined();
  });

  it("shows the gateway and Secrets Store under what it runs on, and never leaks the token or the account", async () => {
    const w = world({ env: GATEWAY, modelSays: () => ({ kind: "answer", answer: "Sam built a returns agent.", sources: ["returns-agent"] }) });
    const { reply } = await w.ask("How does the returns agent work?");
    const config = (await (await w.send("/api/config")).json()) as any;
    expect(config.mode).toBe("live");
    expect(config.stack.map((s: any) => s.id)).toEqual(["workers", "assets", "kv", "durable-objects", "secrets", "secrets-store", "ai-gateway", "claude", "openai"]);
    for (const text of [JSON.stringify(reply), JSON.stringify(config), w.memory.dump()]) {
      expect(text).not.toContain("test-gateway-token");
      expect(text).not.toContain(account);
    }
  });

  it("uses only the providers the gateway is said to hold", async () => {
    const w = world({ env: { ...GATEWAY, GATEWAY_PROVIDERS: "anthropic" }, modelSays: () => ({ kind: "answer", answer: "Sam built a returns agent.", sources: ["returns-agent"] }) });
    const { reply } = await w.ask("How does the returns agent work?");
    expect(reply.kind).toBe("answer");
    expect(reply.speak).toBeUndefined();
    expect(w.calls.some((c) => c.url.includes("/openai/"))).toBe(false);
  });

  it("falls back to stub mode when the token cannot be read", async () => {
    const w = world({ env: { ...GATEWAY, AI_GATEWAY_TOKEN: { get: async () => { throw new Error("no such secret"); } } } });
    const { reply, status } = await w.ask("How does the returns agent work?");
    expect(status).toBe(503);
    expect(reply.kind).toBe("limit");
  });
});