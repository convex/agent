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
