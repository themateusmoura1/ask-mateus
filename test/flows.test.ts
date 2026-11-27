import { describe, expect, it } from "vitest";
import { LIVE, world } from "./helpers";

// The four "one agent, one job" demos: a company assistant that hands work
// over, a support agent, a client agent with an approval gate, and a builder
// with a separate reviewer. All run on the made-up files in knowledge.example/.

async function post(w: ReturnType<typeof world>, path: string, body: unknown) {
  await w.login();
  const res = await w.send(path, { body });
  return { status: res.status, data: (await res.json()) as any };
}

const run = (w: ReturnType<typeof world>, demo: string, scenarioId: string) => post(w, `/api/demo/${demo}/run`, { scenarioId });
const types = (data: any) => data.blocks.map((b: any) => b.type);
const labels = (data: any) => data.trace.map((s: any) => s.label);

describe("the page can list the agents", () => {
  it("puts the demos in the order their files ask for", async () => {
    const w = world();
    await w.login();
    const config = (await (await w.send("/api/config")).json()) as any;
    expect(config.demos.map((d: any) => d.id)).toEqual(["returns", "intake", "desk", "data", "support", "review"]);
  });

  it("describes an agent without giving away prepared answers", async () => {
    const w = world();
    await w.login();
    const info = (await (await w.send("/api/demo/support")).json()) as any;
    expect(info).toMatchObject({ type: "flow", flow: "support", agentName: "Support agent" });
    expect(info.scenarios).toHaveLength(3);
    expect(JSON.stringify(info)).not.toContain("prepared");
    expect(JSON.stringify(info)).not.toContain("inside the lid");
  });

  it("needs a session and a listed input", async () => {
    const w = world();
    expect((await w.send("/api/demo/support/run", { body: { scenarioId: "q-code" }, cookie: null })).status).toBe(401);
    expect((await run(w, "support", "nope")).status).toBe(400);
  });
});

describe("every block arrives with the step it belongs to", () => {
  it("never places a block after the end of the trace", async () => {
    const w = world();
    for (const [demo, scenario] of [["desk", "q-delivery"], ["desk", "t-invoice"], ["support", "q-refund"], ["intake", "e-complete"], ["review", "t-upload"]]) {
      const { data } = await run(w, demo, scenario);
      expect(data.blocks.length).toBeGreaterThan(1);
      for (const block of data.blocks) expect(block.after).toBeLessThanOrEqual(data.trace.length);
      expect(data.trace.every((s: any) => s.label && s.detail)).toBe(true);
    }
  });
});

describe("the support agent", () => {
  it("answers from an article and shows it, with no model in stub mode", async () => {
    const w = world();
    const { data } = await run(w, "support", "q-code");
    const answer = data.blocks.find((b: any) => b.type === "answer");
    expect(answer.source.title).toBe("Where to find and use your game code");
    expect(answer.text).toContain("lid of the box");
    expect(w.modelCalls()).toHaveLength(0);
  });

  it("hands over to a person when no article covers the question", async () => {
    const { data } = await run(world(), "support", "q-refund");
    expect(types(data)).toEqual(["message", "handover", "note"]);
    expect(data.blocks.at(-1).title).toBe("Handed to a person");
    expect(data.trace.some((s: any) => s.status === "blocked")).toBe(true);
  });

  it("uses the model's answer only when it names a real article", async () => {
    const good = world({ env: LIVE, modelSays: () => ({ page: "delivery", answer: "UK orders arrive in 2 to 4 working days." }) });
    const yes = await run(good, "support", "q-code");
    expect(yes.data.blocks.find((b: any) => b.type === "answer").source.title).toBe("Delivery times");
    expect(good.modelCalls()).toHaveLength(1);

    const invented = world({ env: LIVE, modelSays: () => ({ page: "refunds", answer: "We refund within a day." }) });
    const no = await run(invented, "support", "q-refund");
    expect(types(no.data)).toContain("handover");
    expect(JSON.stringify(no.data.blocks)).not.toContain("within a day");
  });

  it("drops an answer that carries a link", async () => {
    const w = world({ env: LIVE, modelSays: () => ({ page: "game-code", answer: "See https://evil.example for your code." }) });
    const { data } = await run(w, "support", "q-code");
    expect(JSON.stringify(data.blocks)).not.toContain("evil.example");
    expect(types(data)).toContain("handover");
  });
});

describe("the company assistant", () => {
  it("answers a question from an approved page", async () => {
    const { data } = await run(world(), "desk", "q-delivery");
    expect(data.blocks.find((b: any) => b.type === "answer").source.title).toBe("Delivery times");
  });

  it("does not answer what only a private chat would know", async () => {
    const { data } = await run(world(), "desk", "q-private");
    expect(types(data)).toEqual(["message", "note"]);
    expect(data.blocks[1].text).toContain("does not become company knowledge");
    expect(labels(data).some((l: string) => l.includes("search the company knowledge base"))).toBe(true);
  });

  it("hands a colleague's task over with a receipt, and does not do it", async () => {
    const { data } = await run(world(), "desk", "t-invoice");
    expect(types(data)).toEqual(["message", "handover", "fields", "note"]);
    const receipt = Object.fromEntries(data.blocks[2].rows);
    expect(receipt.Reference).toMatch(/^HO-[0-9A-F]{8}$/);
    expect(receipt.Status).toBe("Accepted");
    expect(receipt.To).toBe("Inês's personal agent");
    const permissions = data.trace.find((s: any) => s.label.includes("check its own permissions"));
    expect(permissions.detail).toContain("May not: send anything without Inês");
  });

  it("writes the hand-over note with the model when there is one", async () => {
    const w = world({ env: LIVE, modelSays: () => ({ title: "Resend the showroom invoice", summary: "The customer did not get the PDF." }) });
    const { data } = await run(w, "desk", "t-invoice");
    expect(Object.fromEntries(data.blocks[2].rows).Title).toBe("Resend the showroom invoice");
  });
});

describe("the client agent and its approval gate", () => {
  it("records the job, drafts a reply to the sender and stops", async () => {
    const { data } = await run(world(), "intake", "e-complete");
    expect(types(data)).toEqual(["message", "fields", "note", "draft", "approval"]);
    expect(data.needsDecision).toBe(true);
    const draft = data.blocks.find((b: any) => b.type === "draft");
    expect(draft.to).toBe("compras@hotel-miradouro.example");
    expect(labels(data)[0]).toBe("Workspace");
    expect(labels(data).at(-1)).toBe("Approval gate");
    expect(labels(data)).not.toContain("Send");
  });

  it("marks what the email did not say", async () => {
    const { data } = await run(world(), "intake", "e-missing");
    const rows = Object.fromEntries(data.blocks.find((b: any) => b.type === "fields").rows);
    expect(rows.Quantity).toBe("not given");
    expect(rows["Needed by"]).toBe("not given");
  });

  it("clears a send only on approval, and records which words were approved", async () => {
    const w = world();
    const { data } = await run(w, "intake", "e-complete");
    const yes = await post(w, "/api/demo/intake/decide", { scenarioId: "e-complete", decision: "approve", draft: data.draft });
    expect(yes.data.record.id).toMatch(/^AP-[0-9A-F]{8}$/);
    expect(yes.data.trace.map((s: any) => [s.label, s.status])).toEqual([["Approval record", "ok"], ["Send", "ok"]]);

    const no = await post(w, "/api/demo/intake/decide", { scenarioId: "e-complete", decision: "reject", draft: data.draft });
    expect(no.data.trace.map((s: any) => s.status)).toEqual(["blocked", "blocked"]);

    const edited = await post(w, "/api/demo/intake/decide", { scenarioId: "e-complete", decision: "approve", draft: { ...data.draft, body: data.draft.body + " And a discount." } });
    expect(edited.data.record.covers).not.toBe(yes.data.record.covers);
    expect((await post(w, "/api/demo/intake/decide", { scenarioId: "e-complete", decision: "maybe", draft: data.draft })).status).toBe(400);
    expect((await post(w, "/api/demo/support/decide", { scenarioId: "q-code", decision: "approve", draft: data.draft })).status).toBe(404);
  });

  it("uses the model's details and reply, and never lets it pick the recipient", async () => {
    const said = { fields: { customer: "Hotel Miradouro", request: "Bedside tables", quantity: "40", deadline: "15 March", site: "Braga" }, reply_subject: "We have your request", reply_body: "We have your request for 40 bedside tables and a person will come back to you." };
    const w = world({ env: LIVE, modelSays: () => said });
    const { data } = await run(w, "intake", "e-complete");
    expect(data.draft.subject).toBe("We have your request");
    expect(data.blocks.find((b: any) => b.type === "draft").to).toBe("compras@hotel-miradouro.example");
  });

  it("falls back to the prepared reply when the model's reply carries an address", async () => {
    const said = { fields: { customer: "x", request: "x", quantity: "x", deadline: "x", site: "x" }, reply_subject: "Hi", reply_body: "Please write to sales@elsewhere.example instead of replying here, thank you." };
    const { data } = await run(world({ env: LIVE, modelSays: () => said }), "intake", "e-complete");
    expect(data.draft.body).not.toContain("elsewhere.example");
    expect(data.trace.some((s: any) => s.label === "Check the model's output" && s.status === "blocked")).toBe(true);
  });
});

describe("the builder and the reviewer", () => {
  it("sends corrections back and finishes only after a passing review", async () => {
    const { data } = await run(world(), "review", "t-upload");
    expect(types(data)).toEqual(["message", "output", "checklist", "handover", "output", "checklist", "note"]);
    const [first, second] = data.blocks.filter((b: any) => b.type === "checklist");
    expect(first.items.filter((i: any) => !i.pass)).toHaveLength(3);
    expect(second.items.every((i: any) => i.pass)).toBe(true);
    expect(data.blocks.at(-1).title).toBe("Done");
  });

  it("gives the reviewer the work and the list, and nothing about how it was built", async () => {
    const seen: any[] = [];
    const w = world({
      env: LIVE,
      modelSays: (body) => {
        seen.push(body);
        const reviewing = String(body.system).includes("reviewer agent");
        const second = seen.filter((b) => String(b.system).includes("reviewer agent")).length > 1;
        if (!reviewing) return { output: seen.length === 1 ? "Upload failed! Error 413." : "This photo is too big. Choose a smaller one." };
        return { items: [0, 1, 2, 3, 4].map((i) => ({ pass: second || i !== 1, note: second || i !== 1 ? "" : "Remove the exclamation mark." })) };
      },
    });
    const { data } = await run(w, "review", "t-upload");
    expect(seen).toHaveLength(4);
    const [build, review, fix] = seen;
    expect(String(build.system)).not.toContain("exclamation");
    expect(JSON.stringify(build.messages)).not.toContain("exclamation");
    expect(String(review.system)).toContain("No exclamation marks");
    expect(JSON.stringify(review.messages)).toContain("Upload failed! Error 413.");
    expect(JSON.stringify(fix.messages)).toContain("Remove the exclamation mark.");
    expect(data.blocks.filter((b: any) => b.type === "output").map((b: any) => b.text)).toEqual(["Upload failed! Error 413.", "This photo is too big. Choose a smaller one."]);
    expect(data.blocks.at(-1).title).toBe("Done");
  });

  it("says so when the first version already passes", async () => {
    const w = world({ env: LIVE, modelSays: (body) => (String(body.system).includes("reviewer agent") ? { items: [0, 1, 2, 3, 4].map(() => ({ pass: true, note: "" })) } : { output: "This photo is too big. Choose a smaller one." }) });
    const { data } = await run(w, "review", "t-upload");
    expect(data.blocks.at(-1).title).toBe("Passed first time");
    expect(w.modelCalls()).toHaveLength(2);
  });
});

describe("the demos keep to the same limits as everything else", () => {
  it("stops calling the model once the daily budget is spent", async () => {
    const w = world({ env: { ...LIVE, DAILY_SPEND_CAP_USD: "0.0000001" }, modelSays: () => ({ page: "game-code", answer: "On the card." }) });
    await run(w, "support", "q-code");
    const calls = w.modelCalls().length;
    const again = await run(w, "support", "q-code");
    expect(w.modelCalls().length).toBe(calls);
    expect(again.data.trace.find((s: any) => s.label.startsWith("Model")).detail).toContain("daily budget");
  });

  it("opens from the conversation with the owner's fixed words", async () => {
    const { reply } = await world().ask("Show me the support agent");
    expect(reply.demo).toBe("support");
  });
});

describe("the reviewer's countable checks", () => {
  it("counts words in code, so a text under the limit can't fail on length", async () => {
    const { countable } = await import("../src/flow-demo");
    const short = "This photo is over the 10 MB limit. Choose a smaller photo, or reduce its size, and try again.";
    expect(countable("At most 25 words", short)).toEqual({ pass: true, note: "" });
    const long = Array.from({ length: 26 }, () => "word").join(" ");
    expect(countable("At most 25 words", long)).toEqual({ pass: false, note: "26 words. The limit is 25." });
  });

  it("finds exclamation marks and the quoted banned words", async () => {
    const { countable } = await import("../src/flow-demo");
    const label = "No exclamation marks, and no 'please' or 'sorry'";
    expect(countable(label, "Choose a smaller photo.")).toEqual({ pass: true, note: "" });
    expect(countable(label, "Sorry! Please try again.")?.pass).toBe(false);
    expect(countable(label, "Pleased to help.")?.pass).toBe(true);
  });

  it("leaves judgement items to the reviewer", async () => {
    const { countable } = await import("../src/flow-demo");
    expect(countable("Does not blame the person", "anything")).toBeNull();
  });
});

