import type { Deps, Env } from "./types";

/**
 * Cloudflare Access in front of the admin page. Access itself runs at
 * Cloudflare's edge and asks the owner to sign in before a request reaches
 * this Worker. This file is the second half: the Worker checks the signed
 * token Access adds to each request, so the admin routes stay closed even if
 * the Access application is removed or a request finds another way in.
 *
 * It is off until both settings are present:
 *   ACCESS_TEAM_DOMAIN  for example "your-team.cloudflareaccess.com"
 *   ACCESS_AUD          the application's audience tag
 */

interface Jwk extends JsonWebKey {
  kid?: string;
}

let cached: { domain: string; at: number; keys: Jwk[] } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

export function accessOn(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function signingKeys(domain: string, deps: Deps, fresh: boolean): Promise<Jwk[]> {
  const now = deps.now().getTime();
  if (!fresh && cached && cached.domain === domain && now - cached.at < KEY_TTL_MS) return cached.keys;
  const res = await deps.fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access keys returned ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  cached = { domain, at: now, keys: body.keys ?? [] };
  return cached.keys;
}

/** The signed-in person's email when the request carries a valid Access token, otherwise null. */
export async function accessIdentity(request: Request, env: Env, deps: Deps): Promise<string | null> {
  const domain = (env.ACCESS_TEAM_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!domain || !env.ACCESS_AUD || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    const header = decode(parts[0]) as { alg?: string; kid?: string };
    const claims = decode(parts[1]) as { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; common_name?: string };
    if (header.alg !== "RS256" || !header.kid) return null;

    const seconds = deps.now().getTime() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${domain}`) return null;
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return null;

    // Access rotates its keys. An unknown key id gets one fresh look.
    let jwk = (await signingKeys(domain, deps, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await signingKeys(domain, deps, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    return claims.email || claims.common_name || "service";
  } catch {
    return null;
  }
}

/** For tests. */
export function forgetAccessKeys(): void {
  cached = null;
}
