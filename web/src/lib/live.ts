import { useEffect, useRef, useState } from "react";

export interface TraceStep {
  id: string;
  label: string;
  status: "running" | "ok" | "blocked" | "info";
  detail: string;
  ms: number;
}

export type RequestState = "pending" | "approved" | "sent" | "declined";

export type LiveEvent = { type: "trace"; turn: string; step: TraceStep } | { type: "request"; id: string; state: RequestState };

/**
 * One WebSocket to this visitor's own room on the server. It carries the
 * steps behind each answer as they happen, and the owner's decision on a
 * contact request. If it drops it reconnects, waiting a little longer each
 * time. The page works without it: every reply also carries its own trace.
 */
export function useLive(onEvent: (event: LiveEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let closed = false;

    const open = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (message) => {
        try {
          handler.current(JSON.parse(String(message.data)) as LiveEvent);
        } catch {
          /* not for us */
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt++;
        // Stop trying after a while: the server may not have live updates at all.
        if (attempt <= 6) timer = window.setTimeout(open, Math.min(1000 * 2 ** attempt, 20_000));
      };
    };
    open();

    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return connected;
}

/** Adds a step to the list, or replaces the step with the same id. */
export function upsert(steps: TraceStep[], step: TraceStep): TraceStep[] {
  const at = steps.findIndex((s) => s.id === step.id);
  if (at < 0) return [...steps, step];
  const next = steps.slice();
  next[at] = step;
  return next;
}
