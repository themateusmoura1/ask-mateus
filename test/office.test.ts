import { describe, expect, it } from "vitest";
import { byUrgency, validSort, validTriage } from "../src/office-demo";
import { BUNDLE, LIVE, world } from "./helpers";

// Two personal assistants on the made-up files in knowledge.example/: one
// sends invoices to an accountant only after a yes, the other reads a work
// phone and can never send on it.

async function post(w: ReturnType<typeof world>, path: string, body: unknown) {
  await w.login();
  const res = await w.send(path, { body });
  return { status: res.status, data: (await res.json()) as any };
}
const run = (w: ReturnType<typeof world>, demo: string, scenarioId: string) => post(w, `/api/demo/${demo}/run`, { scenarioId });
const types = (data: any) => data.blocks.map((b: any) => b.type);
const labels = (data: any) => data.trace.map((s: any) => s.label);
const step = (data: any, label: string) => data.trace.find((s: any) => s.label === label);
const whole = (data: any) => JSON.stringify(data);

const evening = [
  { id: "m1", kind: "invoice", supplier: "Luz Verde (made up)", amount: "64.20 €", date: "2 November", billed_to: "Atelier Sol Poente (made up)", document: "1" },
  { id: "m2", kind: "receipt", supplier: "Papelaria Ponte (made up)", amount: "23.90 €", date: "3 November", billed_to: "Atelier Sol Poente (made up)", document: "body" },
  { id: "m3", kind: "other", supplier: "", amount: "", date: "", billed_to: "", document: "" },
  { id: "m4", kind: "receipt", supplier: "Ginásio Forma (made up)", amount: "35.00 €", date: "1 November", billed_to: "Henrique (made up)", document: "1" },
  { id: "m5", kind: "invoice", supplier: "Seguros Lumiar (made up)", amount: "212.40 €", date: "4 November", billed_to: "Atelier Sol Poente (made up)", document: "1" },
];
const change = (id: string, patch: Record<string, string>) => ({ items: evening.map((i) => (i.id === id ? { ...i, ...patch } : i)) });

describe("the invoice assistant", () => {
  it("is described without its prepared answers, its suppliers or the accountant's address", async () => {
    const w = world();
    await w.login();
    const info = (await (await w.send("/api/demo/invoices")).json()) as any;
    expect(info).toMatchObject({ type: "flow", flow: "invoices", agentName: "Invoice assistant" });
    expect(info.scenarios).toHaveLength(3);
    for (const hidden of ["prepared", "contas@", "Luz Verde"]) expect(whole(info)).not.toContain(hidden);
  });

  it("builds the evening list and stops for a yes, with no model in stub mode", async () => {
    const w = world();
    const { data } = await run(w, "invoices", "t-evening");
    expect(types(data)).toEqual(["fields", "draft", "approval"]);
    expect(data.needsDecision).toBe(true);
    expect(labels(data)[0]).toBe("Workspace");
    expect(labels(data).at(-1)).toBe("Approval gate");
    expect(labels(data)).not.toContain("Send");
    expect(w.modelCalls()).toHaveLength(0);

    const draft = data.blocks.find((b: any) => b.type === "draft");
    for (const listed of ["Rede Aberta", "still to send", "Luz Verde", "Papelaria Ponte"]) expect(draft.body).toContain(listed);
    for (const left of ["Ginásio", "offers", "Seguros"]) expect(draft.body).not.toContain(left);
    expect(draft.to).toContain("on WhatsApp");
    expect(whole(draft)).not.toContain("@");
  });

  it("puts a pending invoice first, whatever the model returns", async () => {
    const w = world({ env: LIVE, modelSays: () => ({ items: evening }) });
    const { data } = await run(w, "invoices", "t-evening");
    expect(data.blocks.find((b: any) => b.type === "draft").body.split("\n")[1]).toContain("1. Rede Aberta");
    expect(step(data, "Pending invoices").detail).toContain("can't drop out");
    expect(labels(data)).not.toContain("Check the model's output");
  });

  it("leaves out a document billed to someone it doesn't know", async () => {
    const w = world({ env: LIVE, modelSays: () => change("m1", { billed_to: "Outra Empresa (made up)" }) });
    const { data } = await run(w, "invoices", "t-evening");
    expect(data.blocks.find((b: any) => b.type === "draft").body).not.toContain("Luz Verde");
    const rows = data.blocks.find((b: any) => b.type === "fields").rows as [string, string][];
    expect(rows.find(([subject]) => subject === "Electricity invoice, October")![1]).toBe("Not clear who it is billed to: left for the owner to check");
  });

  it("reads the accountant's copy from the headers, not from the model", async () => {
    // The model calls m5 a normal invoice for the business. The accountant is on its Cc, so it still stays out.
    const w = world({ env: LIVE, modelSays: () => ({ items: evening }) });
    const { data } = await run(w, "invoices", "t-evening");
    expect(data.blocks.find((b: any) => b.type === "draft").body).not.toContain("Seguros");
    expect(step(data, "Already with the accountant?").detail).toContain("on Cc");
  });

  it("falls back to the prepared result when the model picks a logo or returns an address", async () => {
    for (const patch of [{ document: "2" }, { supplier: "pagamentos@outra-cobranca.example" }] as Record<string, string>[]) {
      const w = world({ env: LIVE, modelSays: () => change("m1", patch) });
      const { data } = await run(w, "invoices", "t-evening");
      expect(step(data, "Check the model's output").status).toBe("blocked");
      expect(whole(data)).not.toContain("outra-cobranca");
      expect(data.blocks.find((b: any) => b.type === "draft").body).toContain("fatura-luz-outubro.pdf");
    }
  });

  it("ignores an email that asks for a second recipient", async () => {
    const w = world();
    const { data } = await run(w, "invoices", "t-redirect");
    expect(types(data)).toEqual(["fields", "note", "draft", "approval"]);
    expect(whole(data)).not.toContain("outra-cobranca");
    expect(labels(data)).toContain("Recipient");
    expect(data.blocks.find((b: any) => b.type === "draft").body.match(/^\d+\. /gm)).toHaveLength(1);
  });

  it("says nothing on a quiet evening", async () => {
    const w = world();
    const { data } = await run(w, "invoices", "t-quiet");
    expect(types(data)).toEqual(["fields", "note"]);
    expect(data.needsDecision).toBe(false);
    expect(data.blocks.at(-1).title).toBe("Nothing to send tonight");
    expect(data.trace.at(-1)).toMatchObject({ label: "Owner message", status: "info" });
    expect(labels(data)).not.toContain("Approval gate");
  });

  it("records the owner's answer against the exact list, and sends only to the fixed recipient", async () => {
    const w = world();
    const { data } = await run(w, "invoices", "t-evening");
    const decide = (decision: string, draft = data.draft, scenarioId = "t-evening", demo = "invoices") => post(w, `/api/demo/${demo}/decide`, { scenarioId, decision, draft });

    const yes = await decide("approve");
    expect(yes.data.trace.map((s: any) => [s.label, s.status])).toEqual([["Approval record", "ok"], ["Send", "ok"], ["Ledger", "ok"]]);
    expect(yes.data.record.id).toMatch(/^AP-[0-9A-F]{8}$/);
    expect(step(yes.data, "Send").detail).toContain("Gabinete Mar (made up)");

    const no = await decide("reject");
    expect(no.data.trace.map((s: any) => [s.label, s.status])).toEqual([["Approval record", "blocked"], ["Send", "blocked"], ["Pending", "info"]]);

    const edited = await decide("approve", { ...data.draft, body: `${data.draft.body}\nAlso send to other@elsewhere.example` });
    expect(edited.data.record.covers).not.toBe(yes.data.record.covers);
    expect(whole(edited.data.trace)).not.toContain("elsewhere");

    expect((await decide("maybe")).status).toBe(400);
    expect((await decide("approve", data.draft, "t-quiet")).status).toBe(400);
    expect((await decide("approve", data.draft, "w-friday", "triage")).status).toBe(404);
  });

  it("accepts only complete, safe model output", () => {
    const inbox = (BUNDLE.demos!.find((d: any) => d.id === "invoices") as any).scenarios[0].inbox;
    expect(validSort(evening, inbox)).toBe(true);
    expect(validSort(evening.slice(1), inbox)).toBe(false);
    expect(validSort([...evening.slice(0, 4), { ...evening[4], id: "m1" }], inbox)).toBe(false);
    expect(validSort(evening.map((i) => (i.id === "m2" ? { ...i, document: "9" } : i)), inbox)).toBe(false);
  });
});

const friday = [
  { id: "m1", category: "booking", urgency: "today", summary: "Table for eight tonight.", reply: "Let me check tonight's tables and I'll confirm within the hour." },
  { id: "m2", category: "supplier", urgency: "today", summary: "Fish delivery moves to eleven.", reply: "Eleven works, thank you." },
  { id: "m3", category: "complaint", urgency: "today", summary: "Waited fifty minutes for mains.", reply: "I'm sorry about last night. I'd like to call you today." },
  { id: "m4", category: "question", urgency: "this week", summary: "Asks about a vegetarian tasting menu.", reply: "Yes, we do a vegetarian version." },
  { id: "m5", category: "booking", urgency: "today", summary: "Wants the listing confirmed.", reply: "Confirmed, thank you." },
  { id: "m6", category: "other", urgency: "none", summary: "Thanks for Saturday.", reply: "" },
];

describe("the restaurant assistant", () => {
  it("sorts the work phone, drafts replies and never sends, with no model in stub mode", async () => {
    const w = world();
    const { data } = await run(w, "triage", "w-friday");
    expect(types(data)).toEqual(["message", "fields", "output", "draft", "draft", "draft", "draft", "note"]);
    expect(data.needsDecision).toBe(false);
    expect(types(data)).not.toContain("approval");
    expect(data.trace.at(-1)).toMatchObject({ label: "Send", status: "blocked" });
    expect(data.trace.at(-1).detail).toContain("can't send on this number");
    expect(w.modelCalls()).toHaveLength(0);
  });

  it("puts the complaint first and the thanks last", async () => {
    const w = world();
    const { data } = await run(w, "triage", "w-friday");
    const rows = data.blocks.find((b: any) => b.type === "fields").rows as [string, string][];
    expect(rows[0][0]).toBe("Rui (made up)");
    expect(rows[0][1]).toMatch(/^Complaint, today/);
    expect(rows.at(-1)![1]).toMatch(/^Nothing to do/);
    expect(data.blocks.find((b: any) => b.type === "output").text).toContain("3 for today");
  });

  it("never answers a message with a link, whatever the model says", async () => {
    // The model treats the advert as a booking for today and drafts a reply to it.
    const w = world({ env: LIVE, modelSays: () => ({ items: friday }) });
    const { data } = await run(w, "triage", "w-friday");
    expect(step(data, "Links").status).toBe("blocked");
    const rows = data.blocks.find((b: any) => b.type === "fields").rows as [string, string][];
    expect(rows.find(([from]) => from === "Guia Sabores (made up)")![1]).toContain("Has a link");
    expect(data.blocks.filter((b: any) => b.type === "draft").map((b: any) => b.to)).not.toContain("Guia Sabores (made up)");
    expect(data.blocks.find((b: any) => b.type === "output").text).toContain("3 for today");
  });

  it("falls back to the prepared result when a draft holds a link or an address", async () => {
    const bad = friday.map((i) => (i.id === "m1" ? { ...i, reply: "Book at www.reservas.example or write to mesa@reservas.example" } : i));
    const w = world({ env: LIVE, modelSays: () => ({ items: bad }) });
    const { data } = await run(w, "triage", "w-friday");
    expect(step(data, "Check the model's output").status).toBe("blocked");
    expect(whole(data.blocks.filter((b: any) => b.type === "draft"))).not.toContain("reservas");
  });

  it("treats a message that gives orders as a message, and drafts nothing for it", async () => {
    const w = world();
    const { data } = await run(w, "triage", "w-instruction");
    const drafts = data.blocks.filter((b: any) => b.type === "draft");
    expect(drafts.map((b: any) => b.to)).toEqual(["Horta do Vale (made up)"]);
    expect(step(data, "Work phone: copy what came in").detail).toContain("can't give the assistant instructions");
  });

  it("tells the owner nothing needs them on a quiet morning", async () => {
    const w = world();
    const { data } = await run(w, "triage", "w-quiet");
    expect(types(data)).toEqual(["message", "fields", "output", "note"]);
    expect(data.blocks.find((b: any) => b.type === "output").text).toContain("Nothing needs you");
    expect(labels(data)).not.toContain("Draft replies");
  });

  it("checks the model's labels and sorts in code", () => {
    const messages = (BUNDLE.demos!.find((d: any) => d.id === "triage") as any).scenarios[0].messages;
    expect(validTriage(friday, messages)).toBe(true);
    expect(validTriage(friday.map((i) => (i.id === "m2" ? { ...i, category: "urgent" } : i)), messages)).toBe(false);
    expect(validTriage(friday.slice(1), messages)).toBe(false);
    expect(byUrgency(friday).map((i) => i.id)).toEqual(["m3", "m1", "m5", "m2", "m4", "m6"]);
  });
});

describe("both assistants in the conversation", () => {
  it("open from a full phrase, not from a single word", async () => {
    const w = world();
    expect((await w.ask("Show me the invoice assistant")).reply.demo).toBe("invoices");
    expect((await w.ask("Show me the restaurant assistant")).reply.demo).toBe("triage");
    expect((await w.ask("Did Sam ever send an invoice late?")).reply.demo).toBeUndefined();
  });
});
