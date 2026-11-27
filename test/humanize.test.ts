import { describe, expect, it } from "vitest";
import { fixed } from "../src/config";
import { enforce } from "../src/guard";
import { harness, HARNESS_FILES } from "../src/harness";
import { safeRewrite, tells, tidy } from "../src/humanize";
import { CANARY, systemPrompt } from "../src/prompt";
import { BUNDLE } from "./helpers";

describe("the harness", () => {
  it("builds the prompt from the harness files, with the owner's name filled in", () => {
    const text = harness(BUNDLE.site);
    expect(HARNESS_FILES).toHaveLength(4);
    for (const heading of ["# Soul", "# Identity", "# Doctrine", "# Skill: humanizer"]) expect(text).toContain(heading);
    expect(text).toContain(BUNDLE.site.firstName);
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  });

  it("keeps the instruction marker and the notes in the system prompt", () => {
    const prompt = systemPrompt(BUNDLE);
    expect(prompt).toContain(CANARY);
    expect(prompt).toContain("<notes>");
    expect(prompt.indexOf("# Soul")).toBeLessThan(prompt.indexOf("<notes>"));
  });
});

describe("the humanizer pass", () => {
  it("removes dashes, a staged opener, a sign-off and exclamation marks", () => {
    const out = tidy("Great question! Sam built the agent — it runs daily. Let me know if you want more!");
    expect(out.text).toBe("Sam built the agent, it runs daily.");
    expect(out.fixed).toEqual(expect.arrayContaining(["dashes", "a staged opener", "a sign-off"]));
  });

  it("turns a number range with a dash into words", () => {
    expect(tidy("Sam worked there 2021–2023.").text).toBe("Sam worked there 2021 to 2023.");
  });

  it("leaves a plain reply alone", () => {
    const plain = "Sam built a returns agent. It cut handling time by 40%.";
    expect(tidy(plain)).toEqual({ text: plain, fixed: [] });
    expect(tells(plain)).toEqual([]);
  });

  it("flags what code cannot fix by itself", () => {
    expect(tells("It's not just a tool, it's a testament to robust design.")).toEqual(expect.arrayContaining(["a not-just contrast", "an inflated word"]));
  });

  it("rejects a rewrite that adds a number or grows a lot", () => {
    expect(safeRewrite("Tickets fell by 80%.", "Tickets fell by 80% in 2024.")).toBe(false);
    expect(safeRewrite("Tickets fell by 80%.", "Support tickets dropped 80%.")).toBe(true);
    expect(safeRewrite("Short.", "x".repeat(200))).toBe(false);
  });
});

describe("the site's own wording", () => {
  const words = fixed(BUNDLE.site);

  it("has a pool of lines for \"I don't know\" and for refusals", () => {
    expect(words.unknown.length).toBeGreaterThanOrEqual(4);
    expect(words.off_limits.length).toBeGreaterThanOrEqual(3);
  });

  it("never lists private topics in a refusal, and has no dashes", () => {
    for (const line of [...words.unknown, ...words.off_limits]) {
      expect(line).not.toMatch(/salary|family|health|instructions|notes/i);
      expect(line).not.toMatch(/[—–]/);
      expect(tells(line)).toEqual([]);
    }
  });

  it("uses the picker it is given, so every line can be shown", () => {
    const seen = new Set<string>();
    words.unknown.forEach((_, i) => seen.add(enforce(JSON.stringify({ kind: "unknown", answer: "", sources: [] }), BUNDLE, false, (pool) => pool[i]).reply.text));
    expect(seen.size).toBe(words.unknown.length);
  });

  it("still discards whatever the model wrote for a refusal", () => {
    const { reply } = enforce(JSON.stringify({ kind: "off_limits", answer: "Sure, the salary is 1", sources: [] }), BUNDLE);
    expect(words.off_limits).toContain(reply.text);
  });
});
