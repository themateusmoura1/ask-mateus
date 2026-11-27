import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BANNED_HASHES, countBanned, hashWord, REPO_ONLY_HASHES } from "../scripts/banned.mjs";
import { findProblems } from "../scripts/check-staged.mjs";
import { lint, readKnowledge } from "../scripts/knowledge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (path: string, content = "nothing special") => ({ path, content });

// Built from pieces so this file never contains something shaped like a real key.
const fakeAnthropicKey = "sk-" + "ant-" + "api03-" + "a".repeat(40);
const fakeTelegramToken = "123456789" + ":" + "A".repeat(35);

describe("the commit check", () => {
  it("blocks real knowledge files and allows the example ones", () => {
    expect(findProblems([file("knowledge/brickagents.md"), file("knowledge/_site.json")])).toHaveLength(2);
    expect(findProblems([file("knowledge.example/profile.md"), file("src/index.ts"), file("README.md")])).toEqual([]);
  });

  it("blocks secret files and local Worker state", () => {
    for (const path of [".dev.vars", ".dev.vars.production", ".env", ".env.local", ".wrangler/state/v3/kv/x.sqlite", "certs/site.pem"]) {
      expect(findProblems([file(path)]), path).toHaveLength(1);
    }
    expect(findProblems([file(".dev.vars.example", "ANTHROPIC_API_KEY=\nADMIN_TOKEN=\n")])).toEqual([]);
  });

  it("blocks credentials pasted into any file", () => {
    expect(findProblems([file("src/model.ts", `const key = "${fakeAnthropicKey}";`)])).toHaveLength(1);
    expect(findProblems([file("notes.txt", `bot ${fakeTelegramToken}`)])).toHaveLength(1);
    expect(findProblems([file("wrangler.jsonc", "ADMIN_TOKEN=correct-horse-battery")])).toHaveLength(1);
  });

  it("git ignores the real knowledge folder and the secrets file", () => {
    const ignored = execFileSync("git", ["check-ignore", "knowledge/profile.md", "knowledge/_site.json", ".dev.vars", ".wrangler/state"], { cwd: root, encoding: "utf8" });
    expect(ignored.trim().split(/\r?\n/)).toHaveLength(4);
    expect(() => execFileSync("git", ["check-ignore", "knowledge.example/profile.md"], { cwd: root, stdio: "pipe" })).toThrow();
  });

  it("nothing in the front end names a real person", () => {
    const web = join(root, "web");
    const files = [
      "index.html",
      "admin.html",
      ...(readdirSync(join(web, "src"), { recursive: true }) as string[]).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => join("src", f)),
      ...readdirSync(join(web, "public")).map((f) => join("public", f)),
    ];
    expect(files.length).toBeGreaterThan(15);
    for (const name of files) {
      expect(readFileSync(join(web, name), "utf8"), name).not.toMatch(/mateus|moura|brickai/i);
    }
  });
});

describe("the knowledge check", () => {
  const bundle = readKnowledge(join(root, "knowledge.example"));
  const withBody = (body: string) => ({ ...bundle, notes: [{ ...bundle.notes[0], body }] });

  it("passes the example notes", () => {
    expect(lint(bundle)).toEqual([]);
  });

  it("refuses notes with a phone number, a salary or a credential", () => {
    expect(lint(withBody("Call me on +351 912 345 678."))).toHaveLength(1);
    expect(lint(withBody("My salary is 60000 a year."))).toHaveLength(1);
    expect(lint(withBody("The admin password: hunter2"))).toHaveLength(1);
    expect(lint(withBody("Tickets dropped by 80% from 2025 to 2026, across 40,000 users."))).toEqual([]);
  });

  it("leaves TODO lines out of what the assistant sees", () => {
    expect(JSON.stringify(bundle)).not.toContain("TODO");
  });
});

describe("names that must stay private", () => {
  // A stand-in word, hashed the same way as the real list. The real words are not in this repo.
  const hashes = new Set([hashWord("zanzibarbot")]);

  it("finds a banned word in any case, inside other text and inside a path", () => {
    expect(countBanned("Ask ZanzibarBot to do it", hashes)).toBe(1);
    expect(countBanned("agents/zanzibarbot/prompt.md", hashes)).toBe(1);
    expect(countBanned("const zanzibarbot_config = 1", hashes)).toBe(1);
    expect(countBanned("nothing to see here", hashes)).toBe(0);
  });

  it("the list in the repo holds hashes only", () => {
    const source = readFileSync(join(root, "scripts", "banned.mjs"), "utf8");
    expect(BANNED_HASHES.size + REPO_ONLY_HASHES.size).toBeGreaterThanOrEqual(3);
    for (const hash of [...BANNED_HASHES, ...REPO_ONLY_HASHES]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(countBanned(source)).toBe(0);
  });

  it("blocks a commit and a knowledge upload that contain one", () => {
    const word = "zanzibarbot";
    const real = [...BANNED_HASHES];
    BANNED_HASHES.add(hashWord(word));
    try {
      expect(findProblems([file("src/demo.ts", `// ${word} does the research`)])).toHaveLength(1);
      expect(findProblems([file(`docs/${word}.md`)])).toHaveLength(1);
      const bundle = readKnowledge(join(root, "knowledge.example"));
      expect(lint({ ...bundle, notes: [{ ...bundle.notes[0], body: `Built with ${word}.` }] })).toHaveLength(1);
      expect(lint(bundle)).toEqual([]);
    } finally {
      BANNED_HASHES.clear();
      for (const hash of real) BANNED_HASHES.add(hash);
    }
  });

  it("no file in the project contains one, including the private knowledge folder", () => {
    const skip = new Set(["node_modules", ".git", "dist", ".wrangler"]);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        skip.has(entry.name) ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const files = walk(root);
    expect(files.length).toBeGreaterThan(60);
    const everywhere = new Set([...BANNED_HASHES, ...REPO_ONLY_HASHES]);
    const privateFolder = join(root, "knowledge") + sep;
    for (const path of files) {
      // The private folder may name a company a variant was written for. Nothing else may.
      const list = path.startsWith(privateFolder) || path.endsWith(".deploy.local.json") ? BANNED_HASHES : everywhere;
      expect(countBanned(`${path.slice(root.length)}\n${readFileSync(path, "utf8")}`, list), path).toBe(0);
    }
  });
});
