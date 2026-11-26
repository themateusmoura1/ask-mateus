import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountProblems, loadPin } from "../scripts/check-account.mjs";
import { findProblems } from "../scripts/check-staged.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Made-up ids. The real ones live only in the git-ignored .deploy.local.json.
const PERSONAL = "a".repeat(32);
const EMPLOYER = "b".repeat(32);
const OTHER = "c".repeat(32);
const pin = { allowed: PERSONAL, blocked: [EMPLOYER] };

const whoami = (...accounts: [string, string][]) =>
  ["Getting User settings...", "You are logged in with an OAuth Token, associated with the email someone@example.com.", "| Account Name | Account ID |", ...accounts.map(([name, id]) => `| ${name} | ${id} |`)].join("\n");

describe("the Cloudflare account check", () => {
  it("passes when wrangler is signed in to the allowed account only", () => {
    expect(accountProblems(whoami(["Personal", PERSONAL]), pin)).toEqual([]);
  });

  it("refuses when wrangler is signed in to the blocked account", () => {
    expect(accountProblems(whoami(["Employer", EMPLOYER]), pin)).toHaveLength(2);
  });

  it("refuses when the login can reach both accounts", () => {
    const problems = accountProblems(whoami(["Personal", PERSONAL], ["Employer", EMPLOYER]), pin);
    expect(problems).toEqual(["This Wrangler login can reach a blocked account. Sign in to the allowed account only."]);
  });

  it("refuses an account that is neither allowed nor blocked", () => {
    expect(accountProblems(whoami(["Someone else", OTHER]), pin)).toEqual(["Wrangler is signed in, but not to the allowed account."]);
  });

  it("refuses when wrangler is not signed in", () => {
    expect(accountProblems("You are not authenticated. Please run `wrangler login`.", pin)).toHaveLength(1);
  });

  it("refuses when nothing is pinned", () => {
    expect(accountProblems(whoami(["Personal", PERSONAL]), { allowed: "", blocked: [] })).toHaveLength(1);
  });

  it("refuses when an environment variable points wrangler somewhere else", () => {
    expect(accountProblems(whoami(["Personal", PERSONAL]), pin, { CLOUDFLARE_ACCOUNT_ID: EMPLOYER })).toHaveLength(1);
    expect(accountProblems(whoami(["Personal", PERSONAL]), pin, { CLOUDFLARE_ACCOUNT_ID: PERSONAL })).toEqual([]);
  });

  it("reads the pin from the environment or from the local file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pin-")), "pin.json");
    writeFileSync(file, JSON.stringify({ allowedAccountId: PERSONAL.toUpperCase(), blockedAccountIds: [EMPLOYER] }));
    expect(loadPin({}, file)).toEqual(pin);
    expect(loadPin({ CF_ALLOWED_ACCOUNT_ID: OTHER, CF_BLOCKED_ACCOUNT_IDS: `${EMPLOYER}, ${PERSONAL}` }, file)).toEqual({ allowed: OTHER, blocked: [EMPLOYER, PERSONAL] });
    expect(loadPin({}, join(tmpdir(), "does-not-exist.json"))).toEqual({ allowed: "", blocked: [] });
  });

  it("deploying goes through the check", () => {
    const scripts = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"], { cwd: root, encoding: "utf8" })).scripts;
    expect(scripts.deploy).toBe("node scripts/check-account.mjs deploy");
    expect(Object.values(scripts).join("\n")).not.toMatch(/(^|[^.\w])wrangler deploy/);
  });

  it("keeps the account ids out of the repo", () => {
    expect(execFileSync("git", ["check-ignore", ".deploy.local.json"], { cwd: root, encoding: "utf8" }).trim()).toBe(".deploy.local.json");
    expect(findProblems([{ path: ".deploy.local.json", content: "{}" }])).toHaveLength(1);
    expect(findProblems([{ path: "wrangler.jsonc", content: `"account_id": "${PERSONAL}"` }], [PERSONAL, EMPLOYER])).toHaveLength(1);
    expect(findProblems([{ path: "README.md", content: "no ids here" }], [PERSONAL, EMPLOYER])).toEqual([]);
  });
});
