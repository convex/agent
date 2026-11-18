import { expect, test, vi } from "vitest";

// A client on another framework imports the stream helpers from the root
// entry, so the root must load in an app that has no React.
for (const name of ["react", "convex/react"]) {
  vi.doMock(name, () => {
    throw new Error(`the root entry imported ${name}`);
  });
}

test("the root entry exports the stream helpers without loading React", async () => {
  const agent = await import("./index.js");
  for (const name of [
    "applyUIMessageChunksIncremental",
    "blankUIMessage",
    "combineUIMessages",
    "deriveUIMessagesFromDeltas",
    "emptyIncrementalStreamState",
    "getParts",
    "statusFromStreamStatus",
  ] as const) {
    expect(agent[name], name).toBeTypeOf("function");
  }
});
