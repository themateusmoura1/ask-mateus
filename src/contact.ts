import { settings } from "./config";
import type { Deps, Env, Site } from "./types";

export type RequestState = "pending" | "approved" | "sent" | "declined";

export interface ContactRequest {
  id: string;
  createdAt: string;
  status: RequestState;
  decidedAt?: string;
  /** The label of the access code the visitor came in with. */
  label: string;
  /** The visitor's session, so their open page can be told when this is decided. */
  sid: string;
  name: string;
  email: string;
  reason: string;
  /** The visitor's last few questions, for context. */
  questions: string[];
  /** A reply for the owner to edit and send. The Worker never sends it. */
  draftReply: string;
}

export interface ContactInput {
  name?: unknown;
  email?: unknown;
  reason?: unknown;
  questions?: unknown;
  /** Hidden field. People leave it empty, form-filling bots do not. */
  website?: unknown;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim().slice(0, max) : "";
}

export function validate(input: ContactInput): { ok: true; name: string; email: string; reason: string; questions: string[] } | { ok: false; error: string } {
  const name = text(input.name, 80);
  const email = text(input.email, 160);
  const reason = text(input.reason, 1000);
  if (name.length < 2) return { ok: false, error: "Please add your name." };
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) return { ok: false, error: "That email address doesn't look right." };
  if (reason.length < 10) return { ok: false, error: "Please say in a sentence why you'd like to talk." };
  const questions = Array.isArray(input.questions)
    ? input.questions.map((q) => text(q, 300)).filter(Boolean).slice(-5)
    : [];
  return { ok: true, name, email, reason, questions };
}

function draftReply(name: string, site: Site): string {
  const first = name.split(/\s+/)[0];
  return `Hi ${first},\n\nThanks for getting in touch through my site. Happy to talk. What days work for you next week?\n\n${site.firstName}`;
}

const ttl = (env: Env) => settings(env).retentionDays * 86_400;

export async function createRequest(
  env: Env,
  deps: Deps,
  site: Site,
  who: { label: string; sid: string },
  fields: { name: string; email: string; reason: string; questions: string[] },
): Promise<ContactRequest> {
  const request: ContactRequest = {
    id: crypto.randomUUID(),
    createdAt: deps.now().toISOString(),
    status: "pending",
    label: who.label,
    sid: who.sid,
    ...fields,
    draftReply: draftReply(fields.name, site),
  };
  await env.STORE.put(`req:${request.id}`, JSON.stringify(request), { expirationTtl: ttl(env) });
  return request;
}

export async function listRequests(env: Env): Promise<ContactRequest[]> {
  const { keys } = await env.STORE.list({ prefix: "req:" });
  const all: ContactRequest[] = [];
  for (const key of keys) {
    const raw = await env.STORE.get(key.name);
    if (raw) all.push(JSON.parse(raw) as ContactRequest);
  }
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * pending -> approved or declined, approved -> sent. "sent" is the owner
 * recording that they emailed the visitor themselves. Nothing here sends mail.
 */
export async function decide(env: Env, deps: Deps, id: string, state: RequestState): Promise<ContactRequest | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const raw = await env.STORE.get(`req:${id}`);
  if (!raw) return null;
  const request = JSON.parse(raw) as ContactRequest;
  request.status = state;
  request.decidedAt = deps.now().toISOString();
  await env.STORE.put(`req:${id}`, JSON.stringify(request), { expirationTtl: ttl(env) });
  return request;
}

/**
 * Tells the owner a request is waiting. Plain text only, so nothing the
 * visitor typed is read as formatting. A failed notification never fails the
 * request: it is already stored and shows up on the admin page.
 */
export async function notify(env: Env, deps: Deps, site: Site, request: ContactRequest, origin: string): Promise<string[]> {
  const body =
    `New request on ${site.title}\n\n` +
    `From: ${request.name} <${request.email}>\n` +
    `Came in with: ${request.label}\n` +
    `Why: ${request.reason}\n` +
    (request.questions.length ? `They asked the assistant: ${request.questions.join(" | ")}\n` : "") +
    `\nNothing has been sent to them. Approve or decline: ${env.SITE_URL || origin}/admin.html`;

  const sent: string[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const res = await deps.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: body,
          disable_web_page_preview: true,
          // Approve and Decline buttons, when the webhook that receives the tap is set up.
          ...(env.TELEGRAM_WEBHOOK_SECRET
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "Approve", callback_data: `approved:${request.id}` },
                      { text: "Decline", callback_data: `declined:${request.id}` },
                    ],
                  ],
                },
              }
            : {}),
        }),
      });
      if (res.ok) sent.push("telegram");
    } catch {
      /* stored anyway */
    }
  }
  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL_TO && env.NOTIFY_EMAIL_FROM) {
    try {
      const res = await deps.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: env.NOTIFY_EMAIL_FROM,
          to: [env.NOTIFY_EMAIL_TO],
          subject: `${site.title}: request from ${request.name}`,
          text: body,
        }),
      });
      if (res.ok) sent.push("email");
    } catch {
      /* stored anyway */
    }
  }
  return sent;
}
