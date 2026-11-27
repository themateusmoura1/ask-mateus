import doctrine from "../harness/DOCTRINE.md";
import identity from "../harness/IDENTITY.md";
import soul from "../harness/SOUL.md";
import humanizer from "../harness/skills/humanizer.md";
import type { Site } from "./types";

/**
 * The assistant's harness: who it is, how it talks, its rules and its one
 * skill. The files live in harness/ so they can be read and edited without
 * touching code. They hold no facts about the owner: those come from the notes.
 */
const fill = (text: string, site: Site) =>
  text.replaceAll("{{name}}", site.name).replaceAll("{{firstName}}", site.firstName).replaceAll("{{pronoun}}", site.pronoun).trim();

export function harness(site: Site): string {
  return [soul, identity, doctrine, humanizer].map((file) => fill(file, site)).join("\n\n");
}

export function humanizerSkill(site: Site): string {
  return fill(humanizer, site);
}

export const HARNESS_FILES = ["SOUL.md", "IDENTITY.md", "DOCTRINE.md", "skills/humanizer.md"];
