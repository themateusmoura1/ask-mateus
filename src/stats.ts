import { settings } from "./config";
import { readLogs, type Logged } from "./log";
import type { Deps, Env, Note } from "./types";

export const LIVE_NOTE_ID = "live-stats";

/**
 * True when a question is about the assistant's own activity: usage, cost,
 * limits, blocked attempts. Only then are the logs read, because reading them
 * costs storage calls that most questions don't need.
 */
export function wantsStats(question: string): boolean {
  return /\b(cost|costs|spend|spent|spending|budget|usage|stats|statistics|numbers|metrics|logs?|how (many|much|often|busy)|blocked|attacks?|attempts?|injections?|refused|unanswered|so far|today|this week|traffic|visitors?|conversations)\b/i.test(
    question,
  );
}

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Builds a note from the site's own logs, read at the moment of the question.
 *
 * It holds counts and totals only. It never includes what other visitors
 * asked, who they were, or which access codes exist: those belong to the
 * owner's admin page, not to another visitor.
 */
export function summariseForVisitors(events: Logged[], env: Env, deps: Deps): string {
  const cfg = settings(env);
  const now = deps.now();
  const today = now.toISOString().slice(0, 10);
  const count = { messages: 0, answered: 0, unknown: 0, refused: 0, cost: 0, conversations: new Set<string>(), blocked: 0, limits: 0, wrongCodes: 0 };
  const day = { messages: 0, answered: 0, unknown: 0, refused: 0, cost: 0, blocked: 0 };

  for (const e of events) {
    const isToday = e.at.slice(0, 10) === today;
    if (e.type === "turn") {
      count.messages++;
      count.cost += e.costMicroUsd;
      count.conversations.add(e.sid);
      if (e.outcome === "answered") count.answered++;
      if (e.outcome === "unknown") count.unknown++;
      if (e.outcome === "refused") count.refused++;
      if (isToday) {
        day.messages++;
        day.cost += e.costMicroUsd;
        if (e.outcome === "answered") day.answered++;
        if (e.outcome === "unknown") day.unknown++;
        if (e.outcome === "refused") day.refused++;
      }
    } else if (e.type === "safety") {
      if (e.what === "injection" || e.what === "dump" || e.what === "leak_blocked") {
        count.blocked++;
        if (isToday) day.blocked++;
      } else {
        count.limits++;
      }
    } else if (e.type === "access" && !e.ok) {
      count.wrongCodes++;
    }
  }

  const average = count.messages ? money(Math.round(count.cost / count.messages)) : "$0.0000";
  const mode = cfg.live ? `Answers are written by ${cfg.model}.` : "The site is in stub mode: no model is called, so answers cost nothing.";

  return [
    `These numbers were read from this site's own logs at ${now.toISOString().slice(11, 16)} UTC on ${today}.`,
    `Today the assistant has handled ${plural(day.messages, "message")}: ${day.answered} answered from the notes, ${day.unknown} where the notes had no answer, and ${day.refused} refused. Model spend today is ${money(day.cost)} of a $${cfg.dailySpendCapUsd.toFixed(2)} daily cap. ${plural(day.blocked, "attempt")} to change its rules or print its notes ${day.blocked === 1 ? "was" : "were"} blocked today.`,
    `In the last 7 days it handled ${plural(count.messages, "message")} across ${plural(count.conversations.size, "conversation")}: ${count.answered} answered, ${count.unknown} not in the notes, ${count.refused} refused. Total model spend was ${money(count.cost)}, an average of ${average} per message. ${plural(count.blocked, "attempt")} to change its rules or print its notes ${count.blocked === 1 ? "was" : "were"} blocked, limits stopped a request ${plural(count.limits, "time")}, and ${plural(count.wrongCodes, "wrong access code")} ${count.wrongCodes === 1 ? "was" : "were"} tried.`,
    `${mode} Each visitor can send ${cfg.visitorDailyMessages} messages a day. Logs are kept for ${cfg.retentionDays} days and then deleted.`,
  ].join("\n\n");
}

export async function liveNote(env: Env, deps: Deps, siteUrl: string): Promise<{ note: Note; records: number }> {
  const events = await readLogs(env, deps, 7);
  return {
    records: events.length,
    note: {
      id: LIVE_NOTE_ID,
      title: "Live numbers from this site",
      source: "This site's own logs, read just now",
      url: siteUrl,
      keywords: ["cost", "costs", "spend", "spent", "budget", "usage", "stats", "numbers", "logs", "many", "much", "blocked", "attacks", "attempts", "today", "week", "messages", "questions", "conversations", "handled"],
      body: summariseForVisitors(events, env, deps),
    },
  };
}
