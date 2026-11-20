import { expect, expectTypeOf, test, vi } from "vitest";
import type { IncrementalStreamState } from "./index.js";

// A client on another framework imports the stream helpers from the root
// entry, so the root must load in an app that has no React.
for (const name of ["react", "convex/react"]) {
  vi.doMock(name, () => {
    throw new Error(`the root entry imported ${name}`);
  });
}

test("the root entry exports the stream helpers without loading React", async () => {
  const agent = await import("./index.js");
  const deltas = await import("./deltas.js");
  const { combineUIMessages } = await import("./UIMessages.js");

  expect(agent.combineUIMessages).toBe(combineUIMessages);
  for (const name of [
    "applyUIMessageChunksIncremental",
    "blankUIMessage",
    "deriveUIMessagesFromDeltas",
    "emptyIncrementalStreamState",
    "getParts",
    "statusFromStreamStatus",
  ] as const) {
    expect(agent[name], name).toBe(deltas[name]);
  }
  expectTypeOf(
    agent.emptyIncrementalStreamState,
  ).returns.toEqualTypeOf<IncrementalStreamState>();
});

test("getParts reads deltas in order and leaves the caller's array as it was", async () => {
  const { getParts } = await import("./index.js");
  const deltas = [
    { streamId: "s", start: 1, end: 2, parts: ["b"] },
    { streamId: "s", start: 0, end: 1, parts: ["a"] },
  ];

  expect(getParts(deltas)).toEqual({ parts: ["a", "b"], cursor: 2 });
  expect(deltas.map((delta) => delta.start)).toEqual([1, 0]);
});
