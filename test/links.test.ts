import { describe, expect, it } from "vitest";
import { world } from "./helpers";

const ADMIN = { ADMIN_TOKEN: "test-admin-token" };
const asAdmin = { Authorization: "Bearer test-admin-token" };

/** Makes a code through the admin API, then a personal link for it. */
async function codeWithLink(w: ReturnType<typeof world>, label = "Acme Ltd") {
  const made = (await (await w.send("/api/admin/codes", { body: { label }, headers: asAdmin })).json()) as any;
  const res = await w.send(`/api/admin/codes/${made.record.id}/link`, { body: {}, headers: asAdmin });
  const linked = (await res.json()) as any;
  return { code: made.code as string, id: made.record.id as string, link: linked.link as string, slug: String(linked.link).split("/").pop()!, status: res.status };
}

const open = (w: ReturnType<typeof world>, slug: string, ip?: string) => w.send("/api/gate", { body: { link: slug }, cookie: null, ip });

describe("personal links", () => {
  it("makes a link with a readable name and ten random characters", async () => {
    const w = world({ env: ADMIN });
    const a = await codeWithLink(w);
    const b = await codeWithLink(w, "Another Co");
    expect(a.status).toBe(200);
    expect(a.link).toMatch(/^https:\/\/ask\.test\/acme-ltd-[a-z0-9]{10}$/);
    expect(a.slug.slice(-10)).not.toBe(b.slug.slice(-10));
  });

  it("opens the same session a typed code would", async () => {
    const w = world({ env: ADMIN });
    const { slug } = await codeWithLink(w);
    const res = await open(w, slug);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const config = (await (await w.send("/api/config", { cookie })).json()) as any;
    expect(config.opening).toContain("Acme Ltd");
  });

  it("keeps the code working next to the link", async () => {
    const w = world({ env: ADMIN });
    const { code, slug } = await codeWithLink(w);
    expect((await w.enter(code)).status).toBe(200);
    expect((await open(w, slug)).status).toBe(200);
  });

  it("refuses a name with no random part, a wrong random part, and other shapes", async () => {
    const w = world({ env: ADMIN });
    const { slug } = await codeWithLink(w);
    const wrong = slug.slice(0, -1) + (slug.endsWith("a") ? "b" : "a");
    for (const [i, tried] of ["acme-ltd", "acme", wrong, "../admin", "acme-ltd-" + "z".repeat(10)].entries()) {
      expect((await open(w, tried, `198.51.100.${i + 1}`)).status, tried).toBe(401);
    }
  });

  it("stores only a hash of the link", async () => {
    const w = world({ env: ADMIN });
    const { slug } = await codeWithLink(w);
    expect(w.memory.dump()).not.toContain(slug);
    expect(w.memory.dump()).not.toContain(slug.slice(-10));
  });

  it("dies with its code: revoked or expired", async () => {
    const w = world({ env: ADMIN });
    const { slug, id } = await codeWithLink(w);
    await w.send(`/api/admin/codes/${id}/revoke`, { body: {}, headers: asAdmin });
    expect((await open(w, slug)).status).toBe(401);
    // A revoked code can't get a new link either.
    expect((await w.send(`/api/admin/codes/${id}/link`, { body: {}, headers: asAdmin })).status).toBe(404);

    const made = (await (await w.send("/api/admin/codes", { body: { label: "Short", expiresAt: "2026-11-28" }, headers: asAdmin })).json()) as any;
    const linked = (await (await w.send(`/api/admin/codes/${made.record.id}/link`, { body: {}, headers: asAdmin })).json()) as any;
    w.advanceDays(5);
    expect((await open(w, String(linked.link).split("/").pop()!)).status).toBe(401);
  });

  it("replacing a link stops the old one", async () => {
    const w = world({ env: ADMIN });
    const first = await codeWithLink(w);
    const again = (await (await w.send(`/api/admin/codes/${first.id}/link`, { body: {}, headers: asAdmin })).json()) as any;
    expect((await open(w, first.slug)).status).toBe(401);
    expect((await open(w, String(again.link).split("/").pop()!, "198.51.100.9")).status).toBe(200);
  });

  it("counts wrong links against the same daily limit as wrong codes", async () => {
    const w = world({ env: ADMIN });
    const { slug } = await codeWithLink(w);
    for (let i = 0; i < 8; i++) await open(w, "acme-ltd-" + "q".repeat(9) + (i % 9));
    // Even the right link is refused once the limit is reached.
    expect((await open(w, slug)).status).toBe(429);
  });

  it("needs the admin token to make one", async () => {
    const w = world({ env: ADMIN });
    const { id } = await codeWithLink(w);
    expect((await w.send(`/api/admin/codes/${id}/link`, { body: {} })).status).toBe(401);
  });
});
