import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: {
      deps: {
        // Lets tests mock convex/react underneath usePaginatedQuery.
        inline: ["convex-helpers"],
      },
    },
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
