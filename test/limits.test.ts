import { describe, expect, it } from "vitest";
import { LIVE, WORDS, world } from "./helpers";

const Q = "How does the returns agent work?";

describe("abuse limits, behind the gate", () => {
  it("stops a visitor at the daily message cap without touching other visitors", async () => {
    const w = world({ env: { VISITOR_DAILY_MESSAGES: "3" } });
    for (let i = 0; i < 3; i++) expect((await w.ask(Q)).status).toBe(200);
    const blocked = await w.ask(Q);
    expect(blocked.status).toBe(429);
    expect(blocked.reply.text).toBe(WORDS.visitorLimit);
    expect((await w.ask(Q, { ip: "198.51.100.9" })).status).toBe(200);
    expect((await w.logs()).some((e) => e.type === "safety" && e.what === "visitor_limit")).toBe(true);
  });

  it("never stores the visitor's IP address", async () => {
    const w = world();
    await w.ask(Q, { ip: "203.0.113.77" });
    await w.send("/api/contact", { body: { name: "Ana", email: "ana@example.com", reason: "A reason that is long enough." }, ip: "203.0.113.77" });
    expect(w.memory.dump()).not.toContain("203.0.113.77");
  });

  it("rejects messages over the length limit before calling the model", async () => {
    const w = world({ env: { ...LIVE, MAX_MESSAGE_CHARS: "50" } });
    const { reply } = await w.ask("x".repeat(51));
    expect(reply.text).toBe(WORDS.tooLong);
    expect(w.modelCalls()).toEqual([]);
  });

  it("stops calling the model once the daily spend cap is reached", async () => {
    // 2000 input and 200 output tokens at $4 and $20 per million is $0.012 a call.
    const w = world({ env: { ...LIVE, DAILY_SPEND_CAP_USD: "0.02" }, modelSays: () => ({ kind: "smalltalk", answer: "Hello.", sources: [] }) });
    expect((await w.ask("hi", { ip: "1.1.1.1" })).status).toBe(200);
    expect((await w.ask("hi", { ip: "1.1.1.2" })).status).toBe(200);
    const closed = await w.ask("hi", { ip: "1.1.1.3" });
    expect(closed.status).toBe(429);
    expect(closed.reply.text).toBe(WORDS.budgetLimit);
    expect(w.modelCalls()).toHaveLength(2);
    expect(Number(await w.env.STORE.get("spend:2026-11-26"))).toBe(24000);
    expect((await w.logs()).some((e) => e.type === "safety" && e.what === "spend_cap")).toBe(true);
  });

  it("refuses POSTs from another website", async () => {
    const w = world();
    await w.login();
    const res = await w.send("/api/chat", { body: { message: "hi" }, headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("only speaks text the assistant wrote, and only when a voice key exists", async () => {
    const off = world();
    expect((await off.ask(Q)).reply.speak).toBeUndefined();
    expect((await off.send("/api/speak/00000000-0000-4000-8000-000000000000")).status).toBe(404);

    const on = world({ env: { OPENAI_API_KEY: "test-voice-key" } });
    const { reply } = await on.ask(Q);
    const audio = await on.send(`/api/speak/${reply.speak}`);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    const call = on.calls.find((c) => c.url.endsWith("/audio/speech"))!;
    expect(call.body.input).toBe(reply.text);
    expect(call.body.voice).toBe("cedar");
    expect((await on.send("/api/speak/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    // No session, no voice.
    expect((await on.send(`/api/speak/${reply.speak}`, { cookie: null })).status).toBe(401);
  });
});
