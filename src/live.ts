import { settings } from "./config";
import type { Env } from "./types";

/**
 * Real-time events for one visitor session.
 *
 * Each session gets its own Durable Object, named after the session id. The
 * visitor's browser holds one WebSocket to it. The Worker posts events to it
 * (the steps behind an answer, a change in a contact request) and it passes
 * them on. A visitor can only ever reach the room for their own session.
 */

/** One step behind an answer, shown live next to the assistant. */
export interface TraceStep {
  id: string;
  label: string;
  status: "running" | "ok" | "blocked" | "info";
  detail: string;
  /** Milliseconds since the question arrived. */
  ms: number;
}

export type LiveEvent =
  | { type: "trace"; turn: string; step: TraceStep }
  | { type: "request"; id: string; state: "pending" | "approved" | "sent" | "declined" };

/** Sends an event to a session's room. Never fails the request it belongs to. */
export async function emit(env: Env, sid: string, event: LiveEvent): Promise<void> {
  if (!env.LIVE) return;
  try {
    const room = env.LIVE.get(env.LIVE.idFromName(sid));
    await room.fetch("https://room/emit", { method: "POST", body: JSON.stringify(event) });
  } catch (error) {
    console.error("live event failed", error);
  }
}

/** Hands the visitor's WebSocket request to their session's room. */
export function connect(env: Env, sid: string, request: Request): Promise<Response> | Response {
  if (!env.LIVE) return new Response("Live updates are not configured", { status: 501 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  return env.LIVE.get(env.LIVE.idFromName(sid)).fetch(request);
}

const LAST_REQUEST = "last-request";

export class SessionRoom {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/emit" && request.method === "POST") {
      const raw = await request.text();
      const event = JSON.parse(raw) as LiveEvent;
      if (event.type === "request") {
        // Remembered so a visitor who reloads still sees where their request stands.
        // It holds an id and a state, nothing personal, and is deleted after the retention period.
        await this.state.storage.put(LAST_REQUEST, raw);
        await this.state.storage.setAlarm(Date.now() + settings(this.env).retentionDays * 86_400_000);
      }
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(raw);
        } catch {
          /* that tab has gone */
        }
      }
      return new Response("ok");
    }

    const pair = new WebSocketPair();
    // Hibernation: the room costs nothing while the visitor is just listening.
    this.state.acceptWebSocket(pair[1]);
    const last = await this.state.storage.get<string>(LAST_REQUEST);
    if (last) pair[1].send(last);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(): void {
    // The browser only listens. Anything it sends is ignored.
  }

  webSocketClose(socket: WebSocket): void {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
