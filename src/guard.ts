import { anyOf, fixed, type Pick } from "./config";
import { CANARY } from "./prompt";
import type { Bundle, Draft, Kind, Note, Reply } from "./types";

const KINDS: Kind[] = ["answer", "unknown", "off_limits", "contact", "smalltalk"];
const MAX_ANSWER_CHARS = 900;
const MAX_SMALLTALK_CHARS = 200;
const MAX_SOURCES = 4;

export interface Checked {
  reply: Reply;
  /** Set when the reply looked like a dump of the notes or the instructions. */
  leakBlocked: boolean;
}

function parse(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Draft>;
    if (!KINDS.includes(value.kind as Kind)) return null;
    if (typeof value.answer !== "string" || !Array.isArray(value.sources)) return null;
    return { kind: value.kind as Kind, answer: value.answer, sources: value.sources.filter((s) => typeof s === "string") };
  } catch {
    return null;
  }
}

/** Removes links to any host that is not already a source or a listed link. */
function stripForeignLinks(text: string, bundle: Bundle): string {
  const allowed = new Set<string>();
  for (const url of [...bundle.notes.map((n) => n.url), ...bundle.site.links.map((l) => l.url)]) {
    try {
      allowed.add(new URL(url).hostname.replace(/^www\./, ""));
    } catch {
      /* a note with a bad url simply allows nothing */
    }
  }
  return text.replace(/\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi, (link) => {
    try {
      const host = new URL(link.startsWith("http") ? link : `https://${link}`).hostname.replace(/^www\./, "");
      return allowed.has(host) ? link : "[link removed]";
    } catch {
      return "[link removed]";
    }
  });
}

function clip(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * True when a reply looks like the notes or the instructions being read out:
 * the instruction marker, the prompt's own tags, note file names, or a roll
 * call of note ids.
 */
function looksLikeDump(text: string, notes: Note[]): boolean {
  if (text.includes(CANARY)) return true;
  if (/<\/?\s*(note|notes|visitor_message)\b/i.test(text)) return true;
  if (/\b[\w-]+\.md\b/i.test(text)) return true;
  const lower = text.toLowerCase();
  // Note ids are file names like "quote-intake-agent". They don't occur in normal prose.
  const named = notes.filter((n) => n.id.includes("-") && lower.includes(n.id.toLowerCase())).length;
  return named >= 2;
}

/**
 * The model's output is a suggestion. This function decides what the visitor
 * sees, and it is plain code:
 *
 * - an answer must cite at least one real note, or it becomes "I don't know"
 * - refusals and the contact offer use the site's own wording, which the model cannot edit
 * - a reply that reads like a dump of the notes or instructions is refused
 * - anything that fails to parse is treated as "I don't know"
 */
export function enforce(raw: string | null, bundle: Bundle, declined = false, pick: Pick = anyOf): Checked {
  const words = fixed(bundle.site);
  const say = (kind: "unknown" | "off_limits", leakBlocked = false): Checked => ({
    reply: { kind, text: pick(words[kind]), sources: [], openContact: kind === "unknown" },
    leakBlocked,
  });

  if (declined) return say("off_limits");
  const draft = parse(raw);
  if (!draft) return say("unknown");

  switch (draft.kind) {
    case "unknown":
    case "off_limits":
      return say(draft.kind);

    case "contact": {
      const note = bundle.notes.find((n) => n.id === "contact");
      return {
        reply: {
          kind: "contact",
          text: words.contact,
          sources: note ? [{ id: note.id, title: note.title, source: note.source, url: note.url }] : [],
          openContact: true,
        },
        leakBlocked: false,
      };
    }

    case "smalltalk": {
      if (looksLikeDump(draft.answer, bundle.notes)) return say("off_limits", true);
      const text = clip(stripForeignLinks(draft.answer, bundle), MAX_SMALLTALK_CHARS);
      return text ? { reply: { kind: "smalltalk", text, sources: [], openContact: false }, leakBlocked: false } : say("unknown");
    }

    case "answer": {
      if (looksLikeDump(draft.answer, bundle.notes)) return say("off_limits", true);
      const seen = new Set<string>();
      const shown = new Set<string>();
      const sources = [];
      for (const id of draft.sources) {
        const note = bundle.notes.find((n) => n.id === id);
        // Two notes with the same source line and link would show as the same chip twice.
        const chip = note ? `${note.source}|${note.url}` : "";
        if (note && !seen.has(id) && !shown.has(chip)) {
          seen.add(id);
          shown.add(chip);
          sources.push({ id: note.id, title: note.title, source: note.source, url: note.url });
        }
      }
      const text = clip(stripForeignLinks(draft.answer, bundle), MAX_ANSWER_CHARS);
      if (sources.length === 0 || !text) return say("unknown");
      return { reply: { kind: "answer", text, sources: sources.slice(0, MAX_SOURCES), openContact: false }, leakBlocked: false };
    }
  }
}
