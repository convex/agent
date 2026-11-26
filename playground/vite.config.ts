import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  envDir: "../",
  plugins: [react(), tailwindcss()],
  resolve: {
    // @convex-dev/agent is linked from the repo root, which has its own
    // node_modules; one copy of each keeps hooks and the Convex client shared.
    dedupe: ["react", "react-dom", "convex"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: process.env.VITE_BASE || "/",
}));
