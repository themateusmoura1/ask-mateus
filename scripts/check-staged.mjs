// Fails a commit that would put real notes or secrets in the repo.
// Runs as the pre-commit hook (see .githooks/pre-commit) and from the tests.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BANNED_HASHES, countBanned, REPO_ONLY_HASHES } from "./banned.mjs";
import { loadPin } from "./check-account.mjs";

/** Paths that must never be committed. knowledge.example/ is fine. */
const FORBIDDEN_PATHS = [
  [/^knowledge\//, "real knowledge files are private. Only knowledge.example/ belongs in the repo."],
  [/(^|\/)\.dev\.vars(\.(?!example$).*)?$/, "local secrets file"],
  [/(^|\/)\.env(\..*)?$/, "environment file"],
  [/(^|\/)\.deploy\.local\.json$/, "local Cloudflare account pin"],
  [/(^|\/)\.wrangler\//, "local Worker state, which holds the uploaded notes, codes and logs"],
  [/\.(pem|key|p12)$/, "key file"],
];

/** Shapes of real credentials. */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/, "an OpenAI API key"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "a Telegram bot token"],
  [/\bre_[A-Za-z0-9]{20,}\b/, "a Resend API key"],
  [/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]{32}\//, "an AI Gateway address with a Cloudflare account id"],
  [/^\s*(ANTHROPIC_API_KEY|OPENAI_API_KEY|AI_GATEWAY_URL|AI_GATEWAY_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|RESEND_API_KEY|ADMIN_TOKEN|SESSION_SECRET|VISITOR_SALT)[ \t]*=[ \t]*["']?[^\s"'#]{8,}/m, "a filled-in secret"],
];

/**
 * @param {{ path: string, content: string }[]} files staged files
 * @returns {string[]} one line per problem, empty when the commit is fine
 */
export function findProblems(files, accountIds = []) {
  const problems = [];
  for (const { path, content } of files) {
    const clean = path.replace(/\\/g, "/");
    // Internal names on the banned list must not appear in a file or in its path.
    if (countBanned(`${clean}\n${content}`, new Set([...BANNED_HASHES, ...REPO_ONLY_HASHES]))) problems.push(`${clean}: contains a name that must stay private (see scripts/banned.mjs)`);
    // Cloudflare account ids from the local pin must not appear in any file.
    if (accountIds.some((id) => id && content.toLowerCase().includes(id))) problems.push(`${clean}: contains a Cloudflare account id`);
    for (const [pattern, why] of FORBIDDEN_PATHS) {
      if (pattern.test(clean)) problems.push(`${clean}: ${why}`);
    }
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(content)) problems.push(`${clean}: contains what looks like ${what}`);
    }
  }
  return problems;
}

function staged() {
  const names = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return names.map((path) => {
    let content = "";
    try {
      content = execFileSync("git", ["show", `:${path}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    } catch {
      /* binary or unreadable: the path check still applies */
    }
    return { path, content };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pin = loadPin();
  const problems = findProblems(staged(), [pin.allowed, ...pin.blocked]);
  if (problems.length) {
    console.error("Commit blocked. These must not go into the repo:\n  " + problems.join("\n  "));
    process.exit(1);
  }
}
