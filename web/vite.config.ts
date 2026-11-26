import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Two pages: the assistant and the owner's admin page. The build goes to
// ../dist, which is the folder the Worker serves.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(__dirname, "index.html"), admin: path.resolve(__dirname, "admin.html") } },
  },
});
