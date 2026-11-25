import { describe, expect, it } from "vitest";
import { mergeUIMessages, type UIMessageLike } from "./useUIMessages.js";

type TestUIMessage = UIMessageLike & { id: string; text: string };

function message(
  id: string,
  position: string,
  status: TestUIMessage["status"],
  text: string,
): TestUIMessage {
  const [order, stepOrder] = position.split("/").map(Number);
  return {
    id,
    key: `thread-${order}-${stepOrder}`,
    order,
    stepOrder,
    status,
    role: "assistant",
    parts: [{ type: "text", text }],
    text,
    _creationTime: 0,
  } as TestUIMessage;
}

describe("mergeUIMessages", () => {
  it("combines saved steps with the live stream that replaces the rest", () => {
    const result = mergeUIMessages(
      [
        message("saved-1", "1/1", "success", "7"),
        message("saved-2", "1/2", "success", "8"),
      ],
      [message("stream-2", "1/2", "streaming", "8")],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "saved-1",
      stepOrder: 1,
      status: "streaming",
      text: "7 8",
      parts: [
        { type: "text", text: "7" },
        { type: "text", text: "8" },
      ],
    });
  });

  it("keeps a restarted reply apart from the attempt it failed", () => {
    const failed = message("first", "1/1", "failed", "partial 1 words");
    const streaming = mergeUIMessages(
      [failed, message("pending", "1/2", "pending", "")],
      [message("stream-2", "1/2", "streaming", "reply")],
    );
    const saved = mergeUIMessages(
      [failed, message("second", "1/2", "success", "reply 2")],
      [],
    );
    expect(streaming.map((m) => [m.id, m.status, m.text])).toEqual([
      ["first", "failed", "partial 1 words"],
      ["stream-2", "streaming", "reply"],
    ]);
    expect(saved.map((m) => [m.id, m.status, m.text])).toEqual([
      ["first", "failed", "partial 1 words"],
      ["second", "success", "reply 2"],
    ]);
  });

  it("drops an empty failed attempt when the reply restarts", () => {
    const failed = message("first", "1/1", "failed", "");
    const streaming = mergeUIMessages(
      [failed, message("pending", "1/2", "pending", "")],
      [message("stream-2", "1/2", "streaming", "reply")],
    );
    const saved = mergeUIMessages(
      [failed, message("second", "1/2", "success", "reply 2")],
      [],
    );
    expect(streaming.map((m) => [m.id, m.status, m.text])).toEqual([
      ["stream-2", "streaming", "reply"],
    ]);
    expect(saved.map((m) => [m.id, m.status, m.text])).toEqual([
      ["second", "success", "reply 2"],
    ]);
  });

  it("keeps two failed attempts in a row apart", () => {
    const result = mergeUIMessages(
      [
        message("first", "1/1", "failed", "partial 1"),
        message("second", "1/2", "failed", "partial 2"),
        message("third", "1/3", "success", "reply 3"),
      ],
      [],
    );
    expect(result.map((m) => [m.id, m.status, m.text])).toEqual([
      ["first", "failed", "partial 1"],
      ["second", "failed", "partial 2"],
      ["third", "success", "reply 3"],
    ]);
  });

  it("keeps a tool result with the failed call it answers", () => {
    const toolStep = (
      id: string,
      position: string,
      status: TestUIMessage["status"],
      part: Record<string, unknown>,
    ): TestUIMessage => ({
      ...message(id, position, status, ""),
      parts: [
        { type: "tool-myTool", toolCallId: "call1", input: "hi", ...part },
      ] as unknown as TestUIMessage["parts"],
    });
    const result = mergeUIMessages(
      [
        toolStep("first", "1/1", "failed", { state: "input-available" }),
        toolStep("result", "1/2", "success", {
          state: "output-available",
          output: "42",
        }),
        message("third", "1/3", "success", "reply 3"),
      ],
      [],
    );
    expect(result.map((m) => [m.id, m.status, m.text])).toEqual([
      ["first", "failed", ""],
      ["third", "success", "reply 3"],
    ]);
    expect(result[0].parts).toEqual([
      {
        type: "tool-myTool",
        toolCallId: "call1",
        input: "hi",
        state: "output-available",
        output: "42",
      },
    ]);
  });

  it("returns messages in order whatever order they arrive in", () => {
    const result = mergeUIMessages(
      [
        message("saved-3", "3/0", "success", "c"),
        message("saved-1b", "1/1", "success", "a2"),
        message("saved-1a", "1/0", "success", "a1"),
      ],
      [message("stream-2", "2/0", "streaming", "b")],
    );
    expect(result.map((m) => m.id)).toEqual([
      "saved-1a",
      "stream-2",
      "saved-3",
    ]);
    expect(result[0].text).toBe("a1 a2");
  });
});
