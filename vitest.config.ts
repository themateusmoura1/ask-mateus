import { defineConfig } from "vitest/config";

/** The harness files are Markdown. Wrangler bundles them as text; this does the same for tests. */
export default defineConfig({
  plugins: [
    {
      name: "markdown-as-text",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
