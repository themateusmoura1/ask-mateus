import { settings } from "./config";
import { takeVoiceChars } from "./limits";
import { logEvent } from "./log";
import { openai } from "./providers";
import type { Deps, Env, Session } from "./types";

const TEN_MINUTES = 600;

/**
 * The browser never sends text to be spoken. The Worker stores each reply it
 * wrote under a random id for ten minutes, and /api/speak/:id reads it back.
 * So the voice can only ever speak the assistant's own answers.
 */
export async function rememberForSpeech(env: Env, text: string): Promise<string | undefined> {
  if (!settings(env).voice) return undefined;
  const id = crypto.randomUUID();
  await env.STORE.put(`say:${id}`, text, { expirationTtl: TEN_MINUTES });
  return id;
}

/** Speaks a stored reply with OpenAI text to speech. */
export async function speak(env: Env, deps: Deps, session: Session, id: string): Promise<Response> {
  const cfg = settings(env);
  if (!cfg.voice || !/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const text = await env.STORE.get(`say:${id}`);
  if (!text) return new Response("Not found", { status: 404 });
  if (!(await takeVoiceChars(env, deps, text.length))) {
    await logEvent(env, deps, { type: "safety", what: "voice_cap", sid: session.sid, label: session.code.label });
    return new Response("Voice budget used for today", { status: 429 });
  }

  const res = await openai(env, deps, "/audio/speech", { model: cfg.ttsModel, voice: cfg.ttsVoice, input: text, response_format: "mp3" });
  if (!res.ok || !res.body) {
    // The provider's own reason is logged for the owner. The visitor's page falls back to the browser's voice.
    const reason = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    await logEvent(env, deps, { type: "error", where: "voice", message: `OpenAI speech returned ${res.status}. ${reason}` });
    return new Response("Voice is unavailable right now", { status: 502 });
  }
  await logEvent(env, deps, { type: "voice", sid: session.sid, codeId: session.code.id, label: session.code.label, chars: text.length });
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
