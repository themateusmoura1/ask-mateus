import Anthropic from "@anthropic-ai/sdk";
import type { Deps, Env } from "./types";

/**
 * How the Worker reaches the model providers.
 *
 * The intended setup holds no provider key in the Worker at all. Claude and
 * OpenAI calls go to Cloudflare AI Gateway, which keeps the provider keys and
 * adds them itself. The Worker proves who it is to the gateway with one
 * token, read from Cloudflare Secrets Store.
 *
 * A key set directly on the Worker still works, for local testing.
 */

export interface Gateway {
  /** https://gateway.ai.cloudflare.com/v1/<account>/<gateway>, with no provider on the end. */
  base: string;
  token: string;
}

const providersInGateway = (env: Env) => (env.GATEWAY_PROVIDERS ?? "").split(",").map((p) => p.trim().toLowerCase());

/** True when the gateway is set up and says it holds a key for this provider. */
export function viaGateway(env: Env, provider: "anthropic" | "openai"): boolean {
  return Boolean(env.AI_GATEWAY_URL && env.AI_GATEWAY_TOKEN && providersInGateway(env).includes(provider));
}

export const hasClaude = (env: Env) => Boolean(env.ANTHROPIC_API_KEY) || viaGateway(env, "anthropic");
export const hasOpenAI = (env: Env) => Boolean(env.OPENAI_API_KEY) || viaGateway(env, "openai");

/** The gateway address and token, or null when there is no gateway. The token may live in Secrets Store. */
export async function gateway(env: Env): Promise<Gateway | null> {
  if (!env.AI_GATEWAY_URL || !env.AI_GATEWAY_TOKEN) return null;
  try {
    const token = typeof env.AI_GATEWAY_TOKEN === "string" ? env.AI_GATEWAY_TOKEN : await env.AI_GATEWAY_TOKEN.get();
    if (!token) return null;
    return { base: env.AI_GATEWAY_URL.replace(/\/(anthropic|openai)\/?$/, "").replace(/\/$/, ""), token };
  } catch (error) {
    console.error("could not read the gateway token", error);
    return null;
  }
}

/**
 * A Claude client. Through the gateway with a stored key, the SDK's own
 * credential headers are removed so the gateway supplies the real key.
 */
export async function claude(env: Env, deps: Deps, metadata: Record<string, string>): Promise<{ client: Anthropic; through: boolean } | null> {
  const base = { fetch: deps.fetch, maxRetries: 1, timeout: 45_000 };
  const gw = env.AI_GATEWAY_URL ? await gateway(env) : null;

  if (gw && (viaGateway(env, "anthropic") || env.ANTHROPIC_API_KEY)) {
    const own = env.ANTHROPIC_API_KEY;
    const client = new Anthropic({
      ...base,
      // The SDK needs something here. With a key stored in the gateway, this value is never sent.
      apiKey: own || "held-by-the-gateway",
      baseURL: `${gw.base}/anthropic`,
      defaultHeaders: {
        "cf-aig-authorization": `Bearer ${gw.token}`,
        "cf-aig-metadata": JSON.stringify(metadata),
        // The gateway reads a provider key only from x-api-key. With no key of our own, send none.
        "x-api-key": own ?? null,
        Authorization: null,
      },
    });
    return { client, through: true };
  }
  if (env.ANTHROPIC_API_KEY) return { client: new Anthropic({ ...base, apiKey: env.ANTHROPIC_API_KEY }), through: false };
  return null;
}

/** One call to OpenAI, through the gateway when it holds the key, otherwise direct. */
export async function openai(env: Env, deps: Deps, path: "/embeddings" | "/audio/speech", body: unknown): Promise<Response> {
  const gw = viaGateway(env, "openai") || (env.AI_GATEWAY_URL && env.OPENAI_API_KEY) ? await gateway(env) : null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  let url = `https://api.openai.com/v1${path}`;
  if (gw) {
    url = `${gw.base}/openai${path}`;
    headers["cf-aig-authorization"] = `Bearer ${gw.token}`;
    // With the key stored in the gateway, no provider header is sent at all.
    if (env.OPENAI_API_KEY) headers.authorization = `Bearer ${env.OPENAI_API_KEY}`;
  } else {
    headers.authorization = `Bearer ${env.OPENAI_API_KEY}`;
  }
  return deps.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}
