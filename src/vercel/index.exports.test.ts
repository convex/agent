import { expect, test, vi } from "vitest";

// A client on another framework imports deriveUIMessagesFromDeltas from the
// root entry, so the root must load in an app that has no React.
for (const name of ["react", "convex/react"]) {
  vi.doMock(name, () => {
    throw new Error(`the root entry imported ${name}`);
  });
}

test("the root entry exports deriveUIMessagesFromDeltas without loading React", async () => {
  const agent = await import("./index.js");
  const deltas = await import("./deltas.js");

  expect(agent.deriveUIMessagesFromDeltas).toBe(
    deltas.deriveUIMessagesFromDeltas,
  );
});
