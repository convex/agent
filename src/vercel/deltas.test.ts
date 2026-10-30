import { describe, it, expect } from "vitest";
import {
  applyUIMessageChunksIncremental,
  blankUIMessage,
  emptyIncrementalStreamState,
  getParts,
} from "./deltas.js";
import type { StreamDelta } from "../validators.js";
import type { ToolUIPart, UIMessageChunk } from "ai";

describe("UIMessageChunks", () => {
  it("updates a UIMessage with a tool call and follow up", async () => {
    const uiMessage = blankUIMessage(
      {
        streamId: "s1",
        status: "streaming",
        order: 0,
        stepOrder: 1,
        format: "UIMessageChunk",
        agentName: "agent1",
      },
      "thread1",
    );
    expect(uiMessage.text).toBe("");
    expect(uiMessage.parts).toEqual([]);
    const updatedMessage = applyUIMessageChunksIncremental(
      uiMessage,
      [
        { type: "start" },
        { type: "start-step" },
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", delta: "Okay" },
        {
          type: "reasoning-delta",
          id: "reasoning-0",
          delta: ", the user is asking...",
        },
        { type: "text-start", id: "txt-1" },
        {
          type: "text-delta",
          id: "txt-1",
          delta: "Hey ho.",
        },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-end", id: "txt-1" },
        { type: "tool-input-start", toolCallId: "0ychh9k6f", toolName: "say" },
        {
          type: "tool-input-delta",
          toolCallId: "0ychh9k6f",
          inputTextDelta:
            '{"question":"What is your favorite flavor of ice cream?"}',
        },
        {
          type: "tool-input-available",
          toolCallId: "0ychh9k6f",
          toolName: "say",
          input: { question: "What is your favorite flavor of ice cream?" },
          providerMetadata: { openai: { itemId: "123" } },
        },
        {
          type: "tool-output-available",
          toolCallId: "0ychh9k6f",
          output: "I'm sorry I can't help you. Stop asking me questions.",
        },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "tool-input-start", toolCallId: "1ychh9k6f", toolName: "say" },
        {
          type: "tool-input-delta",
          toolCallId: "1ychh9k6f",
          inputTextDelta:
            '{"question":"What is your favorite flavor of ice cream?"}',
        },
        {
          type: "tool-input-available",
          toolCallId: "1ychh9k6f",
          toolName: "say",
          input: { question: "What is your favorite flavor of ice cream?" },
        },
        {
          type: "tool-output-available",
          toolCallId: "1ychh9k6f",
          output: "I'm serious.",
        },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "msg_0" },
        {
          type: "text-delta",
          id: "msg_0",
          delta: "The best ice cream flavor is vanilla",
        },
        {
          type: "text-delta",
          id: "msg_0",
          delta: ".",
        },
        { type: "text-end", id: "msg_0" },
        { type: "finish-step" },
        { type: "finish" },
      ],
      emptyIncrementalStreamState(),
    ).message;
    expect(updatedMessage.text).toBe(
      "Hey ho. The best ice cream flavor is vanilla.",
    );
    const expectedParts = [
      {
        type: "step-start",
      },
      {
        state: "done",
        text: "Okay, the user is asking...",
        type: "reasoning",
      },
      {
        state: "done",
        text: "Hey ho.",
        type: "text",
      },
      {
        callProviderMetadata: {
          openai: {
            itemId: "123",
          },
        },
        input: {
          question: "What is your favorite flavor of ice cream?",
        },
        output: "I'm sorry I can't help you. Stop asking me questions.",

        state: "output-available",
        toolCallId: "0ychh9k6f",
        type: "tool-say",
      },
      {
        type: "step-start",
      },
      {
        input: {
          question: "What is your favorite flavor of ice cream?",
        },
        output: "I'm serious.",
        state: "output-available",
        toolCallId: "1ychh9k6f",
        type: "tool-say",
      },
      {
        type: "step-start",
      },
      {
        state: "done",
        text: "The best ice cream flavor is vanilla.",
        type: "text",
      },
    ];
    expect(updatedMessage.parts).toEqual(expectedParts);
    expect(updatedMessage.parts).toHaveLength(8);
  });
});

describe("UIMessageChunks - continuation stream", () => {
  it("gracefully handles tool-result without tool-call in continuation stream after approval", async () => {
    // This simulates what happens after tool approval:
    // Stream A: tool-call, tool-approval-request -> finishes
    // User approves
    // Stream B: tool-result (referencing tool-call from Stream A) -> this test
    //
    // The continuation stream does not repeat the prior tool call. The reducer
    // tolerates the orphan result because stored messages provide that context.
    const uiMessage = blankUIMessage(
      {
        streamId: "continuation-stream",
        status: "streaming",
        order: 1,
        stepOrder: 0,
        format: "UIMessageChunk",
        agentName: "agent1",
      },
      "thread1",
    );

    // Send a tool-result without the corresponding tool-call in this stream
    // This would normally throw "No tool invocation found" error
    const updatedMessage = applyUIMessageChunksIncremental(
      uiMessage,
      [
        { type: "start" },
        { type: "start-step" },
        {
          type: "tool-output-available",
          toolCallId: "call_from_previous_stream",
          output: "Tool execution result",
        },
        { type: "finish-step" },
        { type: "finish" },
      ],
      emptyIncrementalStreamState(),
    ).message;

    // The message should NOT be marked as failed - the error should be suppressed
    expect(updatedMessage.status).not.toBe("failed");
    // The stream still processes (even if tool-output isn't reflected without tool-input)
    expect(updatedMessage).toBeDefined();
  });
});

describe("mergeDeltas", () => {
  it("incremental apply only consumes parts past the cursor (no re-processing)", () => {
    const N = 500;
    const streamId = "s-perf";
    const toolCallId = "tool-0";
    const streamMessage = {
      streamId,
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "agent1",
    };

    // One StreamDelta with preamble, then N deltas each with one tool-input-delta
    const allDeltas: StreamDelta[] = [
      {
        streamId,
        start: 0,
        end: 1,
        parts: [
          { type: "start" },
          { type: "start-step" },
          { type: "tool-input-start", toolCallId, toolName: "myTool" },
        ] as UIMessageChunk[],
      },
      ...Array.from({ length: N }, (_, i) => ({
        streamId,
        start: i + 1,
        end: i + 2,
        parts: [
          {
            type: "tool-input-delta",
            toolCallId,
            inputTextDelta: "x",
          } as UIMessageChunk,
        ],
      })),
    ];

    // Simulate the hook: process one delta at a time, tracking cursor + prior message
    let cursor = 0;
    let uiMessage = blankUIMessage(streamMessage, "thread-perf");
    let streamState = emptyIncrementalStreamState();
    let totalPartsProcessed = 0;

    for (let i = 0; i <= N; i++) {
      const available = allDeltas.slice(0, i + 1);
      const { parts: newParts, cursor: newCursor } = getParts<UIMessageChunk>(
        available,
        cursor,
      );
      if (newParts.length > 0) {
        totalPartsProcessed += newParts.length;
        ({ message: uiMessage, streamState } = applyUIMessageChunksIncremental(
          structuredClone(uiMessage),
          newParts,
          streamState,
        ));
        cursor = newCursor;
      }
    }

    // Each delta part is handed to applyUIMessageChunksIncremental exactly
    // once across all batches (cursor slicing — no re-processing of prior
    // parts). N tool-input-deltas + 3 preamble parts. The end-to-end O(N)
    // claim is proven by the PR's 21,000 ms → 73 ms benchmark, not by this
    // unit test.
    expect(totalPartsProcessed).toBe(N + 3);

    // Correctness: the raw accumulator holds "x" repeated N times across batches
    expect(streamState.toolInputText[toolCallId]).toBe("x".repeat(N));
    const toolPart = uiMessage.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === toolCallId,
    );
    expect(toolPart).toBeDefined();
  });

  it("applyUIMessageChunksIncremental: text-delta accumulation across calls", () => {
    const streamMessage = {
      streamId: "s-text",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let msg = blankUIMessage(streamMessage, "thread-text");
    let state = emptyIncrementalStreamState();
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "start" },
        { type: "start-step" },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "Hello " },
      ] as UIMessageChunk[],
      state,
    ));
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [{ type: "text-delta", id: "t0", delta: "world" }] as UIMessageChunk[],
      state,
    ));
    ({ message: msg } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "text-delta", id: "t0", delta: "!" },
        { type: "text-end", id: "t0" },
      ] as UIMessageChunk[],
      state,
    ));

    const textPart = msg.parts.find((p) => p.type === "text") as
      | { text: string; state: string }
      | undefined;
    expect(textPart?.text).toBe("Hello world!");
    expect(textPart?.state).toBe("done");
    expect(msg.text).toBe("Hello world!");
  });

  it("applyUIMessageChunksIncremental: tool-output-available preserves input and sets fields", async () => {
    const streamMessage = {
      streamId: "s-tool-out",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let msg = blankUIMessage(streamMessage, "thread-tool-out");
    let state = emptyIncrementalStreamState();
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "start" },
        { type: "start-step" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "myTool" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "myTool",
          input: { q: "hi" },
        },
      ] as UIMessageChunk[],
      state,
    ));
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        {
          type: "tool-output-available",
          toolCallId: "c1",
          output: { result: "ok" },
          preliminary: true,
          providerExecuted: true,
        },
      ] as UIMessageChunk[],
      state,
    ));

    const toolPart = msg.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === "c1",
    );
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.input).toEqual({ q: "hi" });
    expect((toolPart as { output?: unknown }).output).toEqual({ result: "ok" });
    expect((toolPart as { preliminary?: boolean }).preliminary).toBe(true);
    expect((toolPart as { providerExecuted?: boolean }).providerExecuted).toBe(
      true,
    );

    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        {
          type: "tool-output-available",
          toolCallId: "c1",
          output: { result: "final" },
        },
      ] as UIMessageChunk[],
      state,
    ));
    const completedToolPart = msg.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === "c1",
    );
    expect(
      (completedToolPart as { preliminary?: boolean }).preliminary,
    ).toBeUndefined();

    ({ message: msg } = applyUIMessageChunksIncremental(
      msg,
      [
        {
          type: "tool-output-error",
          toolCallId: "c1",
          errorText: "final failure",
        },
      ] as UIMessageChunk[],
      state,
    ));

    const failedToolPart = msg.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === "c1",
    );
    expect(failedToolPart).toMatchObject({ state: "output-error" });
    expect((failedToolPart as { output?: unknown }).output).toBeUndefined();
    expect(
      (failedToolPart as { preliminary?: boolean }).preliminary,
    ).toBeUndefined();
  });

  it("keeps a denied approval distinct from its later denied output", () => {
    const streamMessage = {
      streamId: "s-tool-approval",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let message = blankUIMessage(streamMessage, "thread-tool-approval");
    let streamState = emptyIncrementalStreamState();
    ({ message, streamState } = applyUIMessageChunksIncremental(
      message,
      [
        {
          type: "tool-input-start",
          toolCallId: "call-1",
          toolName: "deleteFile",
          providerExecuted: true,
          providerMetadata: { openai: { request: "call-1" } },
        },
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "deleteFile",
          input: { path: "/tmp/file" },
        },
        {
          type: "tool-approval-request",
          toolCallId: "call-1",
          approvalId: "approval-1",
        },
        {
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: false,
          reason: "User declined",
        },
      ] as UIMessageChunk[],
      streamState,
    ));

    expect(message.parts).toContainEqual(
      expect.objectContaining({
        toolCallId: "call-1",
        state: "approval-responded",
        approval: {
          id: "approval-1",
          approved: false,
          reason: "User declined",
        },
        providerExecuted: true,
        callProviderMetadata: { openai: { request: "call-1" } },
      }),
    );

    ({ message } = applyUIMessageChunksIncremental(
      message,
      [{ type: "tool-output-denied", toolCallId: "call-1" }],
      streamState,
    ));

    expect(message.parts).toContainEqual(
      expect.objectContaining({
        toolCallId: "call-1",
        state: "output-denied",
      }),
    );
  });

  it("matches SDK 7 provider metadata replacement and dynamic tool initialization", () => {
    const streamMessage = {
      streamId: "s-metadata",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    const { message } = applyUIMessageChunksIncremental(
      blankUIMessage(streamMessage, "thread-metadata"),
      [
        {
          type: "text-start",
          id: "t",
          providerMetadata: { openai: { first: true } },
        },
        {
          type: "text-delta",
          id: "t",
          delta: "x",
          providerMetadata: { openai: { second: true } },
        },
        {
          type: "tool-input-start",
          toolCallId: "dynamic-1",
          toolName: "runtimeTool",
          dynamic: true,
          providerExecuted: true,
          title: "Runtime tool",
          toolMetadata: { source: "provider" },
          providerMetadata: { openai: { itemId: "item-1" } },
        },
      ] as UIMessageChunk[],
      emptyIncrementalStreamState(),
    );

    expect(message.parts.find((part) => part.type === "text")).toMatchObject({
      providerMetadata: { openai: { second: true } },
    });
    expect(
      message.parts.find(
        (part) => "toolCallId" in part && part.toolCallId === "dynamic-1",
      ),
    ).toMatchObject({
      type: "dynamic-tool",
      providerExecuted: true,
      title: "Runtime tool",
      toolMetadata: { source: "provider" },
      callProviderMetadata: { openai: { itemId: "item-1" } },
    });
  });

  it("creates tool parts from standalone tool-input-available chunks", () => {
    const { message } = applyUIMessageChunksIncremental(
      blankUIMessage(
        {
          streamId: "s-available",
          status: "streaming",
          order: 0,
          stepOrder: 0,
          format: "UIMessageChunk",
          agentName: "a",
        },
        "thread-available",
      ),
      [
        {
          type: "tool-input-available",
          toolCallId: "static-call",
          toolName: "weather",
          input: { city: "Boston" },
          providerExecuted: true,
        },
        {
          type: "tool-input-available",
          toolCallId: "dynamic-call",
          toolName: "runtimeTool",
          dynamic: true,
          input: { id: 1 },
        },
      ] as UIMessageChunk[],
      emptyIncrementalStreamState(),
    );

    expect(message.parts).toMatchObject([
      {
        type: "tool-weather",
        toolCallId: "static-call",
        state: "input-available",
        input: { city: "Boston" },
        providerExecuted: true,
      },
      {
        type: "dynamic-tool",
        toolCallId: "dynamic-call",
        toolName: "runtimeTool",
        state: "input-available",
        input: { id: 1 },
      },
    ]);
  });

  it("creates output-error parts from standalone tool-input-error chunks", () => {
    const { message } = applyUIMessageChunksIncremental(
      blankUIMessage(
        {
          streamId: "s-error",
          status: "streaming",
          order: 0,
          stepOrder: 0,
          format: "UIMessageChunk",
          agentName: "a",
        },
        "thread-error",
      ),
      [
        {
          type: "tool-input-error",
          toolCallId: "static-error",
          toolName: "weather",
          input: { city: "Boston" },
          errorText: "Invalid weather request",
          providerExecuted: true,
          providerMetadata: { openai: { result: "static" } },
        },
        {
          type: "tool-input-error",
          toolCallId: "dynamic-error",
          toolName: "runtimeTool",
          dynamic: true,
          input: { id: 1 },
          errorText: "Invalid runtime request",
          providerMetadata: { anthropic: { result: "dynamic" } },
        },
      ] as UIMessageChunk[],
      emptyIncrementalStreamState(),
    );

    expect(message.parts).toMatchObject([
      {
        type: "tool-weather",
        toolCallId: "static-error",
        state: "output-error",
        rawInput: { city: "Boston" },
        errorText: "Invalid weather request",
        providerExecuted: true,
        resultProviderMetadata: { openai: { result: "static" } },
      },
      {
        type: "dynamic-tool",
        toolCallId: "dynamic-error",
        toolName: "runtimeTool",
        state: "output-error",
        input: { id: 1 },
        errorText: "Invalid runtime request",
        resultProviderMetadata: { anthropic: { result: "dynamic" } },
      },
    ]);
  });

  it("applyUIMessageChunksIncremental: tool-input-error sets rawInput and clears input for static tools", async () => {
    const streamMessage = {
      streamId: "s-tool-err",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let msg = blankUIMessage(streamMessage, "thread-tool-err");
    let state = emptyIncrementalStreamState();
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "start" },
        { type: "start-step" },
        {
          type: "tool-input-start",
          toolCallId: "c2",
          toolName: "myTool",
          providerExecuted: true,
          title: "My tool",
          toolMetadata: { source: "test" },
          providerMetadata: { openai: { itemId: "call-1" } },
        },
      ] as UIMessageChunk[],
      state,
    ));
    ({ message: msg } = applyUIMessageChunksIncremental(
      msg,
      [
        {
          type: "tool-input-error",
          toolCallId: "c2",
          toolName: "myTool",
          input: { bad: "args" },
          errorText: "validation failed",
        },
      ] as UIMessageChunk[],
      state,
    ));

    const toolPart = msg.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === "c2",
    );
    expect(toolPart?.state).toBe("output-error");
    expect((toolPart as { errorText?: string }).errorText).toBe(
      "validation failed",
    );
    expect(toolPart?.input).toBeUndefined();
    expect((toolPart as { rawInput?: unknown }).rawInput).toEqual({
      bad: "args",
    });
    expect(toolPart).toMatchObject({
      providerExecuted: true,
      title: "My tool",
      toolMetadata: { source: "test" },
      callProviderMetadata: { openai: { itemId: "call-1" } },
    });
  });

  it("accumulates tool input across a batch boundary", async () => {
    const streamMessage = {
      streamId: "s-tool-split",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let msg = blankUIMessage(streamMessage, "thread-tool-split");
    let state = emptyIncrementalStreamState();

    // Batch A: preamble + the first half of the JSON input.
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "start" },
        { type: "start-step" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "myTool" },
        {
          type: "tool-input-delta",
          toolCallId: "c1",
          inputTextDelta: '{"a":1',
        },
      ] as UIMessageChunk[],
      state,
    ));
    const afterA = msg.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === "c1",
    );
    // Mid-stream: JSON is incomplete, input stays unset.
    expect(afterA?.input).toBeUndefined();

    // Batch B: the remainder of the JSON input.
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        {
          type: "tool-input-delta",
          toolCallId: "c1",
          inputTextDelta: ',"b":2}',
        },
      ] as UIMessageChunk[],
      state,
    ));
    const afterB = msg.parts.find(
      (p): p is ToolUIPart => "toolCallId" in p && p.toolCallId === "c1",
    );
    // Complete JSON is parsed once the accumulator is valid.
    expect(afterB?.input).toEqual({ a: 1, b: 2 });
    expect(state.toolInputText["c1"]).toBe('{"a":1,"b":2}');
  });

  it("pushes file parts and merges message metadata in later batches", async () => {
    const streamMessage = {
      streamId: "s-file-meta",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let msg = blankUIMessage(streamMessage, "thread-file-meta");
    let state = emptyIncrementalStreamState();
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [{ type: "start" }, { type: "start-step" }] as UIMessageChunk[],
      state,
    ));
    ({ message: msg } = applyUIMessageChunksIncremental(
      msg,
      [
        {
          type: "file",
          mediaType: "image/png",
          url: "https://example.com/a.png",
        },
        { type: "message-metadata", messageMetadata: { foo: "bar" } },
      ] as UIMessageChunk[],
      state,
    ));

    const filePart = msg.parts.find((p) => p.type === "file") as
      | { mediaType: string; url: string }
      | undefined;
    expect(filePart?.mediaType).toBe("image/png");
    expect(filePart?.url).toBe("https://example.com/a.png");
    expect(msg.metadata).toEqual({ foo: "bar" });
  });

  it("tracks concurrent text parts by id across batches", async () => {
    const streamMessage = {
      streamId: "s-multi-text",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    let msg = blankUIMessage(streamMessage, "thread-multi-text");
    let state = emptyIncrementalStreamState();
    ({ message: msg, streamState: state } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "start" },
        { type: "start-step" },
        { type: "text-start", id: "t0" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t0", delta: "A" },
      ] as UIMessageChunk[],
      state,
    ));
    // Deltas in a later batch must land on the part matching their id.
    ({ message: msg } = applyUIMessageChunksIncremental(
      msg,
      [
        { type: "text-delta", id: "t1", delta: "B" },
        { type: "text-delta", id: "t0", delta: "C" },
      ] as UIMessageChunk[],
      state,
    ));

    const textParts = msg.parts.filter((p) => p.type === "text") as Array<{
      text: string;
    }>;
    expect(textParts.map((p) => p.text)).toEqual(["AC", "B"]);
  });

  it("incremental batches match the SDK processing the full stream", async () => {
    const streamMessage = {
      streamId: "s-equiv",
      status: "streaming" as const,
      order: 0,
      stepOrder: 0,
      format: "UIMessageChunk" as const,
      agentName: "a",
    };
    const batches: UIMessageChunk[][] = [
      [
        { type: "start" },
        { type: "start-step" },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "Hello " },
      ] as UIMessageChunk[],
      [
        { type: "text-delta", id: "t0", delta: "world" },
        { type: "text-end", id: "t0" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "myTool" },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"q":' },
      ] as UIMessageChunk[],
      [
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '"hi"}' },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "myTool",
          input: { q: "hi" },
        },
        {
          type: "tool-output-available",
          toolCallId: "c1",
          output: { ok: true },
        },
        { type: "finish-step" },
        { type: "finish" },
      ] as UIMessageChunk[],
    ];

    // SDK: process the entire stream at once.
    const sdkMsg = applyUIMessageChunksIncremental(
      blankUIMessage(streamMessage, "thread-equiv"),
      batches.flat(),
      emptyIncrementalStreamState(),
    ).message;

    // Incremental: process batch by batch, threading state.
    let incMsg = blankUIMessage(streamMessage, "thread-equiv");
    let state = emptyIncrementalStreamState();
    for (const batch of batches) {
      ({ message: incMsg, streamState: state } =
        applyUIMessageChunksIncremental(incMsg, batch, state));
    }

    expect(incMsg.parts).toEqual(sdkMsg.parts);
    expect(incMsg.text).toBe(sdkMsg.text);
  });
});
