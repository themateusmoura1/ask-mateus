// Words that must never appear in a commit or in uploaded knowledge, for
// example internal project names. The words themselves are not written here.
// Only a hash of each one is, so this file gives nothing away.
//
// To add one, run:
//   node scripts/banned.mjs hash <word>
// and paste the result into the list below.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const BANNED_HASHES = new Set([
  "a0109aec66f8ad23b567ded2dfcfba794088ab55674db5a7436a955504432ded",
]);

/**
 * Names that are fine in the private notes but must not appear in the repo,
 * for example a company a private demo variant was written for.
 */
export const REPO_ONLY_HASHES = new Set(["c043da3d7ebc59f7a015bbf0c7178c8bf917892eff31c4b7a9ec1beb41ea2c12", "3e834ed051928c430d4e70e89413bc6052323e9b8b187990fe5dd3653a98dcac"]);

export function hashWord(word) {
  return createHash("sha256").update(`banned|${word.trim().toLowerCase()}`).digest("hex");
}

/**
 * Counts the banned words in a piece of text. It checks every run of letters,
 * in any case, so a name is caught inside camelCase or a file path too.
 *
 * @returns {number} how many distinct banned words were found
 */
export function countBanned(text, hashes = BANNED_HASHES) {
  if (!hashes.size) return 0;
  const seen = new Set();
  let found = 0;
  for (const run of String(text).toLowerCase().match(/\p{L}{4,}/gu) ?? []) {
    if (seen.has(run)) continue;
    seen.add(run);
    if (hashes.has(hashWord(run))) found++;
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "hash") {
  console.log(hashWord(process.argv[3] ?? ""));
}
