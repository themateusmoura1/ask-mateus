import { beforeEach, describe, expect, it } from "vitest";
import { accessIdentity, forgetAccessKeys } from "../src/access";
import type { Deps, Env } from "../src/types";
import { world } from "./helpers";

const DOMAIN = "example-team.cloudflareaccess.com";
const AUD = "aud-tag-for-tests";
const NOW = new Date("2026-11-27T12:00:00Z");

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A stand-in for Access: one key pair, a certs endpoint and tokens signed with it. */
async function fakeAccess() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "key-1" };
  let certCalls = 0;
  const deps: Deps = {
    now: () => NOW,
    fetch: (async (url: string) => {
      certCalls++;
      expect(String(url)).toBe(`https://${DOMAIN}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  };
  const token = async (claims: Record<string, unknown> = {}, key: CryptoKey = pair.privateKey) => {
    const seconds = NOW.getTime() / 1000;
    const head = b64url(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }));
    const body = b64url(JSON.stringify({ aud: [AUD], iss: `https://${DOMAIN}`, exp: seconds + 600, iat: seconds, email: "owner@example.com", ...claims }));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(signature)}`;
  };
  return { deps, token, calls: () => certCalls };
}

const env = { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD } as Env;
const withToken = (token?: string) => new Request("https://site.example/api/admin/codes", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

describe("Cloudflare Access on the admin page", () => {
  beforeEach(() => forgetAccessKeys());

  it("accepts a token signed by Access for this application", async () => {
    const access = await fakeAccess();
    expect(await accessIdentity(withToken(await access.token()), env, access.deps)).toBe("owner@example.com");
  });

  it("fetches the signing keys once and reuses them", async () => {
    const access = await fakeAccess();
    await accessIdentity(withToken(await access.token()), env, access.deps);
    await accessIdentity(withToken(await access.token()), env, access.deps);
    expect(access.calls()).toBe(1);
  });

  it("rejects a request with no token", async () => {
    const access = await fakeAccess();
    expect(await accessIdentity(withToken(), env, access.deps)).toBeNull();
    expect(access.calls()).toBe(0);
  });

  it("rejects a token for another application, another team, or one that has expired", async () => {
    const access = await fakeAccess();
    const seconds = NOW.getTime() / 1000;
    for (const claims of [{ aud: ["someone-else"] }, { iss: "https://other-team.cloudflareaccess.com" }, { exp: seconds - 1 }]) {
      expect(await accessIdentity(withToken(await access.token(claims)), env, access.deps), JSON.stringify(claims)).toBeNull();
    }
  });

  it("rejects a token signed with a different key", async () => {
    const access = await fakeAccess();
    const other = await fakeAccess();
    const forged = await other.token();
    expect(await accessIdentity(withToken(forged), env, access.deps)).toBeNull();
  });

  it("rejects a token whose claims were edited after signing", async () => {
    const access = await fakeAccess();
    const [head, , signature] = (await access.token()).split(".");
    const seconds = NOW.getTime() / 1000;
    const edited = b64url(JSON.stringify({ aud: [AUD], iss: `https://${DOMAIN}`, exp: seconds + 99999, email: "intruder@example.com" }));
    expect(await accessIdentity(withToken(`${head}.${edited}.${signature}`), env, access.deps)).toBeNull();
  });

  it("closes the admin routes to a correct admin token that did not come through Access", async () => {
    const w = world({ env: { ADMIN_TOKEN: "test-admin-token", ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD } });
    const res = await w.send("/api/admin/codes", { headers: { Authorization: "Bearer test-admin-token" } });
    expect(res.status).toBe(403);
  });

  it("leaves the admin routes as they were when Access is not set up", async () => {
    const w = world({ env: { ADMIN_TOKEN: "test-admin-token" } });
    const res = await w.send("/api/admin/codes", { headers: { Authorization: "Bearer test-admin-token" } });
    expect(res.status).toBe(200);
  });
});
