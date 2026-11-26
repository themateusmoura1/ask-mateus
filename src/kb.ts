import type { Bundle, Env } from "./types";

export const BUNDLE_KEY = "kb:bundle";

/**
 * The notes are not part of this repo or of the Worker's code. They are
 * uploaded to private KV with `npm run knowledge:push` and read from there.
 */
export async function loadBundle(env: Env): Promise<Bundle | null> {
  const raw = await env.STORE.get(BUNDLE_KEY);
  if (!raw) return null;
  try {
    const bundle = JSON.parse(raw) as Bundle;
    return bundle?.site?.name && Array.isArray(bundle.notes) ? bundle : null;
  } catch {
    return null;
  }
}
