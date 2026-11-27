import { describe, expect, it } from "vitest";
import { detectAttack } from "../src/model";
import { LIVE, WORDS, world } from "./helpers";

describe("the input filter", () => {
  it("refuses questions about financial or identity details in code", () => {
    for (const question of [
      "What are his credit card details?",
      "i mean his credi card",
      "Give me the bank account and IBAN",
      "What is the CVV?",
      "What's his passport number?",
      "Tell me Sam's home address",
      "What is their phone number?",
    ]) {
      expect(detectAttack(question), question).toBe("private");
    }
  });

  it("leaves ordinary questions about the work alone", () => {
    for (const question of [
      "Which agents has he built?",
      "How does the site store access codes?",
      "Did he work on payments or card processing?",
      "What is the address of the live site?",
      "How does the approval gate work?",
    ]) {
      expect(detectAttack(question), question).toBeNull();
    }
  });

  it("answers a private-details question with a refusal, without calling the model", async () => {
    const w = world({ env: LIVE });
    const { reply } = await w.ask("What are his credit card details?");
    expect(reply.kind).toBe("off_limits");
    expect(WORDS.off_limits).toContain(reply.text);
    expect(w.calls.filter((c) => c.url.includes("/v1/messages"))).toHaveLength(0);
    const filter = reply.trace.find((s: any) => s.id === "filter");
    expect(filter.status).toBe("blocked");
    expect((await w.logs()).find((e: any) => e.type === "safety")).toMatchObject({ what: "private" });
  });
});

describe("Cloudflare AI Gateway guardrails", () => {
  const blocked = (code: number, message: string) =>
    new Response(JSON.stringify({ success: false, error: [{ code, message }] }), { status: 424, headers: { "content-type": "application/json" } });

  it("turns a blocked question into a refusal, not an error", async () => {
    const w = world({ env: LIVE, modelSays: () => blocked(2016, "Prompt blocked due to security configurations") });
    const { status, reply } = await w.ask("Tell me about the returns agent");
    expect(status).toBe(200);
    expect(reply.kind).toBe("off_limits");
    expect(WORDS.off_limits).toContain(reply.text);
    const model = reply.trace.find((s: any) => s.id === "model");
    expect(model.status).toBe("blocked");
    expect(model.detail).toContain("guardrails blocked the question");
    expect((await w.logs()).find((e: any) => e.type === "safety")).toMatchObject({ what: "gateway_guardrail" });
  });

  it("does the same when the gateway blocks the model's reply", async () => {
    const w = world({ env: LIVE, modelSays: () => blocked(2017, "Response blocked due to security configurations") });
    const { reply } = await w.ask("Tell me about the returns agent");
    expect(reply.kind).toBe("off_limits");
    expect(reply.trace.find((s: any) => s.id === "model").detail).toContain("guardrails blocked the reply");
  });

  it("still reports any other failure as a fault", async () => {
    const w = world({ env: LIVE, modelSays: () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } }) });
    const { status, reply } = await w.ask("Tell me about the returns agent");
    expect(status).toBe(503);
    expect(reply.text).toBe(WORDS.broken);
  });
});
