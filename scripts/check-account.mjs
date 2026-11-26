// Makes sure anything that touches Cloudflare goes to the right account.
//
// The account ids are not in this repo. They come from a git-ignored file,
// .deploy.local.json (see .deploy.local.example.json), or from two
// environment variables:
//
//   CF_ALLOWED_ACCOUNT_ID    the one account this project may use
//   CF_BLOCKED_ACCOUNT_IDS   comma-separated accounts it must never use
//
// `npm run deploy`, `npm run cf -- ...` and the remote knowledge push all call
// this first and stop if the check fails.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = /^[0-9a-f]{32}$/;

/** Reads the pin from the environment first, then from the local file. */
export function loadPin(env = process.env, file = join(root, ".deploy.local.json")) {
  let fromFile = {};
  if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, "utf8"));
  const allowed = (env.CF_ALLOWED_ACCOUNT_ID || fromFile.allowedAccountId || "").trim().toLowerCase();
  const blockedRaw = env.CF_BLOCKED_ACCOUNT_IDS ? env.CF_BLOCKED_ACCOUNT_IDS.split(",") : (fromFile.blockedAccountIds ?? []);
  const blocked = blockedRaw.map((id) => String(id).trim().toLowerCase()).filter(Boolean);
  return { allowed, blocked };
}

/**
 * Decides whether it is safe to go on.
 *
 * @param {string} whoami the text `wrangler whoami` printed
 * @param {{ allowed: string, blocked: string[] }} pin
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} reasons to stop. Empty means go.
 */
export function accountProblems(whoami, pin, env = {}) {
  const problems = [];
  if (!ID.test(pin.allowed)) {
    return ["No allowed account is pinned. Copy .deploy.local.example.json to .deploy.local.json and fill it in."];
  }
  if (pin.blocked.includes(pin.allowed)) problems.push("The allowed account is also on the blocked list.");

  const signedIn = [...new Set((whoami.toLowerCase().match(/\b[0-9a-f]{32}\b/g) ?? []))];
  if (signedIn.length === 0) problems.push("Wrangler is not signed in, or `wrangler whoami` listed no account.");
  else if (!signedIn.includes(pin.allowed)) problems.push("Wrangler is signed in, but not to the allowed account.");

  // Stricter than "the target is right": if this login can reach a blocked
  // account at all, stop. One wrong flag should not be enough to deploy there.
  if (signedIn.some((id) => pin.blocked.includes(id))) problems.push("This Wrangler login can reach a blocked account. Sign in to the allowed account only.");

  // An account id or token already in the environment would override the pin.
  const forced = (env.CLOUDFLARE_ACCOUNT_ID || "").trim().toLowerCase();
  if (forced && forced !== pin.allowed) problems.push("CLOUDFLARE_ACCOUNT_ID is set to a different account. Unset it.");
  return problems;
}

function wrangler(args, options = {}) {
  const windows = process.platform === "win32";
  return execFileSync(windows ? "cmd.exe" : "npx", windows ? ["/c", "npx", "wrangler", ...args] : ["wrangler", ...args], { cwd: root, ...options });
}

/** Runs the check for real. Returns the pinned account id, or exits. */
export function requireAccount() {
  const pin = loadPin();
  let whoami = "";
  try {
    whoami = wrangler(["whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    whoami = String(error.stdout ?? "");
  }
  const problems = accountProblems(whoami, pin, process.env);
  if (problems.length) {
    console.error("Stopped before touching Cloudflare:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`account check passed (…${pin.allowed.slice(-4)})`);
  return pin.allowed;
}

/** Runs a wrangler command against the pinned account and nothing else. */
export function runPinned(args) {
  const account = requireAccount();
  wrangler(args, { stdio: "inherit", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } });
}

// `node scripts/check-account.mjs`            just the check
// `node scripts/check-account.mjs deploy`     the check, then `wrangler deploy` pinned
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length) runPinned(args);
  else requireAccount();
}
