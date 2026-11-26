import { describe, expect, it } from "vitest";
import { ADMIN, asAdmin, world } from "./helpers";

const form = { name: "Ana Recruiter", email: "ana@example.com", reason: "We have a DevRel role and would like to talk." };
const NOTIFY = { TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_CHAT_ID: "42", ...ADMIN };
const stored = (w: ReturnType<typeof world>) => w.memory.keys().filter((k) => k.startsWith("req:"));

describe("approval gate", () => {
  it("stores the request as pending and tells the owner, not the visitor", async () => {
    const w = world({ env: NOTIFY, code: { label: "Northwind" } });
    await w.login();
    const res = await w.send("/api/contact", { body: { ...form, questions: ["What has Sam built?"] } });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.message).toContain("Nothing is sent automatically");

    expect(stored(w)).toHaveLength(1);
    expect(JSON.parse((await w.env.STORE.get(stored(w)[0]))!)).toMatchObject({ status: "pending", email: "ana@example.com", label: "Northwind" });

    // One outbound call, to the owner's Telegram chat. Nothing addressed to the visitor.
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].url).toContain("api.telegram.org");
    expect(w.calls[0].body.chat_id).toBe("42");
    expect(w.calls[0].body.text).toContain("Nothing has been sent to them");
    expect(w.calls[0].body.parse_mode).toBeUndefined();
  });

  it("needs an access code to leave a request at all", async () => {
    const w = world({ env: NOTIFY });
    expect((await w.send("/api/contact", { body: form })).status).toBe(401);
    expect(stored(w)).toHaveLength(0);
  });

  it("gives the visitor no way to read or approve a request", async () => {
    const w = world({ env: NOTIFY });
    await w.login();
    await w.send("/api/contact", { body: form });
    expect((await w.send("/api/admin/requests")).status).toBe(401);
    expect((await w.send("/api/admin/requests", { headers: { Authorization: "Bearer guess" } })).status).toBe(401);
  });

  it("lets the owner approve and mark as sent, and neither sends anything", async () => {
    const w = world({ env: NOTIFY });
    await w.login();
    await w.send("/api/contact", { body: form });
    const list = (await (await w.send("/api/admin/requests", { headers: asAdmin })).json()) as any;
    const id = list.requests[0].id;
    expect(list.requests[0].status).toBe("pending");
    expect(list.requests[0].draftReply).toContain("Hi Ana,");

    const before = w.calls.length;
    for (const decision of ["approved", "sent"]) {
      const res = await w.send(`/api/admin/requests/${id}`, { body: { decision }, headers: asAdmin });
      expect(((await res.json()) as any).request.status).toBe(decision);
    }
    expect(w.calls.length).toBe(before);

    const states = (await w.logs()).filter((e) => e.type === "contact").map((e: any) => e.state);
    expect(states).toEqual(["pending", "approved", "sent"]);
  });

  it("rejects bad input and caps requests per visitor", async () => {
    const w = world({ env: { VISITOR_DAILY_CONTACT_REQUESTS: "2" } });
    await w.login();
    expect((await w.send("/api/contact", { body: { ...form, email: "not-an-email" } })).status).toBe(400);
    expect((await w.send("/api/contact", { body: { ...form, reason: "hi" } })).status).toBe(400);
    expect((await w.send("/api/contact", { body: form })).status).toBe(200);
    expect((await w.send("/api/contact", { body: form })).status).toBe(200);
    expect((await w.send("/api/contact", { body: form })).status).toBe(429);
  });

  it("drops form-filling bots quietly", async () => {
    const w = world({ env: NOTIFY });
    await w.login();
    const res = await w.send("/api/contact", { body: { ...form, website: "https://spam.example" } });
    expect(res.status).toBe(200);
    expect(stored(w)).toHaveLength(0);
    expect(w.calls).toEqual([]);
  });

  it("the chat can only offer the form, in fixed words", async () => {
    const { reply } = await world().ask("Can I book a call?");
    expect(reply.kind).toBe("contact");
    expect(reply.openContact).toBe(true);
    expect(reply.text).toContain("I can't book a call or promise anything myself");
  });
});
