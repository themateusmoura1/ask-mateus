/**
 * The humanizer pass. Every reply the model writes goes through it before the
 * visitor sees it. Two parts, both plain code:
 *
 * - tidy() fixes what can be fixed safely without a model: dashes, a staged
 *   opener, a sign-off, exclamation marks, stray formatting.
 * - tells() lists what is left that reads as machine-written. When it finds
 *   something, the caller asks the model for one rewrite and checks it again.
 */

const OPENER =
  /^\s*(?:(?:that'?s )?(?:a )?(?:great|good|excellent|interesting|fantastic) question|certainly|absolutely|of course|sure(?: thing)?|happy to help|glad you asked)\s*[!.,:]+\s*/i;
const SIGN_OFF =
  /\s*(?:let me know if[^.!?]*|i hope (?:this|that) helps[^.!?]*|feel free to (?:ask|reach)[^.!?]*|is there anything else[^.!?]*|happy to (?:share|tell you) more[^.!?]*)[.!?]*\s*$/i;

export interface Tidied {
  text: string;
  /** What was changed, in words for the trace. */
  fixed: string[];
}

export function tidy(input: string): Tidied {
  const fixed: string[] = [];
  let text = input;
  const swap = (pattern: RegExp, to: string, what: string) => {
    const next = text.replace(pattern, to);
    if (next !== text) fixed.push(what);
    text = next;
  };

  swap(/\*\*|__|^#{1,6}\s+|`/gm, "", "formatting");
  swap(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2", "dashes");
  swap(/\s*[—–]\s*|\s+--\s+/g, ", ", "dashes");
  swap(OPENER, "", "a staged opener");
  swap(SIGN_OFF, "", "a sign-off");
  swap(/!+/g, ".", "exclamation marks");
  text = text.replace(/,\s*([.,])/g, "$1").replace(/\.{2,}/g, ".").replace(/[ \t]{2,}/g, " ").trim();
  if (text && /^[a-zà-ÿ]/.test(text)) text = text[0].toUpperCase() + text.slice(1);
  return { text, fixed: [...new Set(fixed)] };
}

const TELLS: [RegExp, string][] = [
  [/\bnot (?:just|only|merely|simply)\b/i, "a not-just contrast"],
  [/\bit(?:'s| is|’s) not\b[^.]{1,60}[,;]\s*it(?:'s| is|’s)\b/i, "a not-X-but-Y contrast"],
  [/\b(?:at its core|the real question|what really matters|in today'?s|when it comes to|it'?s worth noting|it is worth noting|here'?s the thing)\b/i, "a stock phrase"],
  [/\b(?:testament|pivotal|crucial|delve|tapestry|showcas\w+|underscor\w+|leverag\w+|seamless\w*|cutting[- ]edge|world[- ]class|game[- ]chang\w+|passionate|robust|landscape|spearhead\w*|meticulous\w*|innovative|impressive)\b/i, "an inflated word"],
  [/\bplays? an? (?:key|crucial|vital|pivotal|important) role\b/i, "inflated importance"],
  [/\b(?:could|might|may) (?:potentially|possibly|arguably)\b/i, "stacked hedges"],
  [/[—–]/, "a dash"],
];

export function tells(text: string): string[] {
  return TELLS.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
}

/** A rewrite may reword. It may not add a number the first version did not have, or grow much. */
export function safeRewrite(before: string, after: string): boolean {
  if (!after.trim()) return false;
  if (after.length > Math.max(before.length * 1.25, before.length + 60)) return false;
  const numbers = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const had = numbers(before);
  for (const n of numbers(after)) if (!had.has(n)) return false;
  return true;
}
