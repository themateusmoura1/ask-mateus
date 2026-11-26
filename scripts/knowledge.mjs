// Reads a knowledge folder and uploads it to the Worker's private KV.
// The notes are never bundled into the Worker or the public files.
//
//   npm run knowledge:push              local dev storage
//   npm run knowledge:push -- --remote  the deployed Worker's storage
//
// It uses knowledge/ (your real notes, git-ignored) when that folder exists,
// and knowledge.example/ (a made-up person) when it doesn't.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countBanned } from "./banned.mjs";
import { requireAccount } from "./check-account.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseNote(dir, file) {
  const raw = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing the --- header block`);
  const meta = {};
  for (const line of match[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of ["title", "source", "url"]) {
    if (!meta[key]) throw new Error(`${file}: header needs "${key}"`);
  }
  return {
    id: file.replace(/\.md$/, ""),
    title: meta.title,
    source: meta.source,
    url: meta.url,
    keywords: (meta.keywords ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean),
    // Lines starting with "TODO" are notes to yourself, not facts for visitors.
    body: match[2].split("\n").filter((l) => !/^\s*(<!--|TODO)/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/**
 * Visitors can get the assistant to repeat anything in the notes, so the
 * notes must be safe to publish. This catches the obvious slips.
 */
export function lint(bundle) {
  const problems = [];
  // Everything that would be uploaded: the site settings, the notes and the demos.
  if (countBanned(JSON.stringify(bundle))) problems.push("the knowledge contains a name that must stay private (see scripts/banned.mjs)");
  for (const note of bundle.notes) {
    if (/(?<![\w.-])\+?\d[\d ().-]{8,}\d(?![\w%])/.test(note.body)) problems.push(`${note.id}: looks like it contains a phone number`);
    if (/\b(salary|salaries|compensation|day rate|per hour)\b[^.\n]{0,40}\d/i.test(note.body)) problems.push(`${note.id}: looks like it states a salary or rate`);
    if (/\b(password|api[_ ]?key|secret|token)\s*[:=]/i.test(note.body)) problems.push(`${note.id}: looks like it contains a credential`);
  }
  // Demos run on made-up cases only. A real-looking address is a mistake.
  for (const demo of bundle.demos ?? []) {
    const everyCase = [...(demo.cases ?? []), ...(demo.researchRun?.cases ?? []), ...Object.values(demo.variants ?? {}).flatMap((v) => v.cases ?? []), ...(demo.scenarios ?? []), ...(demo.pages ?? [])];
    for (const item of everyCase) {
      const text = JSON.stringify(item);
      for (const found of text.match(/[^\s"@<>]+@[^\s"@<>\\]+/g) ?? []) {
        const address = found.replace(/[.,;:)]+$/, "");
        if (!/\.(example|test|invalid)$/i.test(address) && !/@example\.(com|org|net)$/i.test(address)) {
          problems.push(`demo ${demo.id}, case ${item.id}: "${address}" is not a made-up address. Use a .example domain.`);
        }
      }
      if (/(?<![\w.-])\+?\d[\d ().-]{8,}\d(?![\w%])/.test(text)) problems.push(`demo ${demo.id}, case ${item.id}: looks like it contains a phone number`);
    }
  }
  return problems;
}

/** Demo files are JSON in a demos/ folder. Keys starting with "_" are notes to yourself. */
function readDemos(dir) {
  const folder = join(dir, "demos");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const demo = JSON.parse(readFileSync(join(folder, f), "utf8"));
      for (const key of Object.keys(demo)) if (key.startsWith("_")) delete demo[key];
      const needed =
        demo.type === "flow"
          ? ["id", "title", "starter", "triggers", "intro", "disclaimer", "flow", "agentName", "role", "company", "scenarios"]
          : demo.type === "data"
          ? ["id", "title", "starter", "triggers", "intro", "disclaimer", "agentName", "company", "currency", "table", "examples", "rows"]
          : ["id", "title", "starter", "triggers", "intro", "disclaimer", "agents", "researcher", "sender", "criteria", "paths", "gates", "handoff", "approval", "sendRules", "cases"];
      for (const key of needed) {
        if (demo[key] === undefined) throw new Error(`demos/${f} needs "${key}"`);
      }
      return demo;
    });
}

export function readKnowledge(dir) {
  const site = JSON.parse(readFileSync(join(dir, "_site.json"), "utf8"));
  for (const key of ["title", "name", "firstName", "pronoun", "opening", "openingFor", "starters", "links"]) {
    if (site[key] === undefined) throw new Error(`_site.json needs "${key}"`);
  }
  const notes = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort().map((f) => parseNote(dir, f));
  return { site, notes, demos: readDemos(dir) };
}

export function knowledgeDir() {
  const real = join(root, "knowledge");
  return existsSync(join(real, "_site.json")) ? real : join(root, "knowledge.example");
}

/** Must match hashCode() in src/gate.ts. */
export function hashCode(code) {
  return createHash("sha256").update(`ask-code|${code.trim().toUpperCase()}`).digest("hex");
}

function kvPut(key, file, where, account) {
  const args = ["wrangler", "kv", "key", "put", key, "--binding", "STORE", "--path", file, where];
  const windows = process.platform === "win32";
  execFileSync(windows ? "cmd.exe" : "npx", windows ? ["/c", "npx", ...args] : args, {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    // A remote upload is pinned to the one allowed Cloudflare account.
    env: account ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } : process.env,
  });
}

function main() {
  const remote = process.argv.includes("--remote");
  const where = remote ? "--remote" : "--local";
  const dir = knowledgeDir();
  const example = dir.endsWith("knowledge.example");
  const bundle = readKnowledge(dir);

  const problems = lint(bundle);
  if (problems.length) {
    console.error("These notes are not safe to publish:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  if (remote && example) {
    console.error("Refusing to upload the example notes to the deployed Worker. Create knowledge/ first.");
    process.exit(1);
  }

  // Local uploads never leave this machine. A remote one checks the account first.
  const account = remote ? requireAccount() : undefined;

  const tmp = join(root, ".wrangler", "tmp-knowledge");
  mkdirSync(tmp, { recursive: true });
  const bundleFile = join(tmp, "bundle.json");
  writeFileSync(bundleFile, JSON.stringify(bundle));
  kvPut("kb:bundle", bundleFile, where, account);
  console.log(`knowledge: ${bundle.notes.length} notes about ${bundle.site.name} from ${example ? "knowledge.example/" : "knowledge/"} -> ${remote ? "deployed" : "local"} KV`);

  // Local only: a demo access code so the gate can be tried straight away.
  if (!remote) {
    const codeFile = join(tmp, "demo-code.json");
    const hash = hashCode("DEMO");
    writeFileSync(
      codeFile,
      JSON.stringify({ id: hash.slice(0, 12), label: "Demo visitor", note: "", createdAt: new Date().toISOString(), revoked: false, uses: 0 }),
    );
    kvPut(`code:${hash}`, codeFile, where);
    console.log('access code for local use: "demo"');
    // One more local code per demo variant, so each can be previewed.
    for (const [key, variant] of Object.entries(Object.assign({}, ...(bundle.demos ?? []).map((d) => d.variants ?? {})))) {
      const variantHash = hashCode(`demo-${key}`);
      const variantFile = join(tmp, `demo-code-${key}.json`);
      writeFileSync(variantFile, JSON.stringify({ id: variantHash.slice(0, 12), label: variant.label, note: "", variant: key, createdAt: new Date().toISOString(), revoked: false, uses: 0 }));
      kvPut(`code:${variantHash}`, variantFile, where);
      console.log(`access code for the "${key}" variant: "demo-${key}"`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
