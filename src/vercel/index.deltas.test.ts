import type { UIMessageChunk } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { StreamDelta, StreamMessage } from "../validators.js";

// A client on another framework imports these from the root entry, so the root
// must load in an app that has no React.
for (const name of ["react", "convex/react"]) {
  vi.doMock(name, () => {
    throw new Error(`the root entry imported ${name}`);
  });
}

const agent = await import("./index.js");

const stream = (
  streamId: string,
  order: number,
  format: StreamMessage["format"] = "UIMessageChunk",
): StreamMessage => ({
  streamId,
  order,
  stepOrder: 0,
  status: "streaming",
  format,
});

const delta = (
  streamId: string,
  start: number,
  parts: UIMessageChunk[],
): StreamDelta => ({ streamId, start, end: start + parts.length, parts });

test("the root entry exports what the streaming hooks are built on", () => {
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

describe("deriveUIMessagesFromDeltas", () => {
  test("turns the deltas of each stream into a UIMessage, in order", async () => {
    const messages = await agent.deriveUIMessagesFromDeltas(
      "thread",
      [stream("later", 2), stream("earlier", 1)],
      [
        delta("later", 0, [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "second" },
        ]),
        // Deltas arrive in any order: this one continues the one after it.
        delta("earlier", 2, [{ type: "text-delta", id: "t", delta: " one" }]),
        delta("earlier", 0, [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "the first" },
        ]),
      ],
    );

    expect(
      messages.map(({ id, order, text, status }) => ({
        id,
        order,
        text,
        status,
      })),
    ).toEqual([
      {
        id: "stream:earlier",
        order: 1,
        text: "the first one",
        status: "streaming",
      },
      { id: "stream:later", order: 2, text: "second", status: "streaming" },
    ]);
  });

  test("rejects a stream in another format", async () => {
    await expect(
      agent.deriveUIMessagesFromDeltas(
        "thread",
        [stream("s", 1, "TextStreamPart")],
        [],
      ),
    ).rejects.toThrow('unsupported stream format "TextStreamPart"');
  });
});
