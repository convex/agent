import { describe, expect, it } from "vitest";
import {
  createPersistedUIMessageChunkState,
  reducePersistedUIMessageChunks,
} from "./persistedUIMessageChunks.js";

describe("reducePersistedUIMessageChunks", () => {
  it("carries durable reducer state across persisted batches", () => {
    const first = reducePersistedUIMessageChunks(
      createPersistedUIMessageChunkState(),
      [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "partial" },
        { type: "tool-input-start", toolCallId: "tool-1", toolName: "lookup" },
        {
          type: "tool-input-delta",
          toolCallId: "tool-1",
          inputTextDelta: '{"query":',
        },
      ],
    );
    const second = reducePersistedUIMessageChunks(first.state, [
      { type: "text-delta", id: "text-1", delta: " answer" },
      { type: "text-end", id: "text-1" },
      {
        type: "tool-input-delta",
        toolCallId: "tool-1",
        inputTextDelta: '"ok"}',
      },
    ]);

    expect(second.state.parts).toMatchObject([
      { type: "text", text: "partial answer", state: "done" },
      { type: "tool-lookup", toolCallId: "tool-1", state: "input-streaming" },
    ]);
    expect(second.state.toolInputText.get("tool-1")).toBe('{"query":"ok"}');
    expect(second.touchedToolCallIds).toEqual(["tool-1"]);
  });

  it("accepts metadata-only lifecycle chunks without materializing parts", () => {
    const reduced = reducePersistedUIMessageChunks(
      createPersistedUIMessageChunkState(),
      [
        { type: "start", messageMetadata: { source: "start" } },
        { type: "message-metadata", messageMetadata: { source: "update" } },
        { type: "finish", messageMetadata: { source: "finish" } },
      ],
    );

    expect(reduced.state.parts).toEqual([]);
  });

  it("accepts the UIMessageChunk superset with replacement metadata", () => {
    const reduced = reducePersistedUIMessageChunks(
      createPersistedUIMessageChunkState(),
      [
        { type: "custom", kind: "openai.annotation" },
        {
          type: "reasoning-file",
          url: "https://example.com/reasoning.pdf",
          mediaType: "application/pdf",
        },
        {
          type: "text-start",
          id: "text-1",
          providerMetadata: {
            openai: { phase: "start", stale: true },
            anthropic: { stale: true },
          },
        },
        {
          type: "text-delta",
          id: "text-1",
          delta: "answer",
          providerMetadata: { anthropic: { phase: "delta" } },
        },
        { type: "text-end", id: "text-1" },
        {
          type: "tool-input-start",
          toolCallId: "call-1",
          toolName: "lookup",
          title: "Old title",
          providerMetadata: { openai: { phase: "call" } },
        },
        {
          type: "tool-input-error",
          toolCallId: "call-1",
          toolName: "lookup",
          input: "bad",
          errorText: "invalid",
          title: "New title",
          providerMetadata: { openai: { phase: "result" } },
        },
      ],
    );

    expect(reduced.state.parts).toStrictEqual([
      {
        type: "custom",
        kind: "openai.annotation",
        providerMetadata: undefined,
      },
      {
        type: "reasoning-file",
        url: "https://example.com/reasoning.pdf",
        mediaType: "application/pdf",
        providerMetadata: undefined,
      },
      {
        type: "text",
        text: "answer",
        state: "done",
        providerMetadata: { anthropic: { phase: "delta" } },
      },
      {
        type: "tool-lookup",
        toolName: undefined,
        toolCallId: "call-1",
        state: "output-error",
        input: undefined,
        rawInput: "bad",
        errorText: "invalid",
        providerExecuted: undefined,
        callProviderMetadata: { openai: { phase: "call" } },
        resultProviderMetadata: { openai: { phase: "result" } },
        title: "New title",
        toolMetadata: undefined,
      },
    ]);
  });

  it("clears a preliminary tool output when its final result is an error", () => {
    const reduced = reducePersistedUIMessageChunks(
      createPersistedUIMessageChunkState(),
      [
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "lookup",
          input: {},
        },
        {
          type: "tool-output-available",
          toolCallId: "call-1",
          output: { partial: true },
          preliminary: true,
        },
        {
          type: "tool-output-error",
          toolCallId: "call-1",
          errorText: "final failure",
        },
      ],
    );

    expect(reduced.state.parts).toMatchObject([
      {
        type: "tool-lookup",
        state: "output-error",
        errorText: "final failure",
      },
    ]);
    const part = reduced.state.parts[0] as {
      output?: unknown;
      preliminary?: boolean;
    };
    expect(part.output).toBeUndefined();
    expect(part.preliminary).toBeUndefined();
  });

  it("requires boolean approval responses and skips results of earlier tool calls", () => {
    const approvalPrefix = [
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "lookup",
        input: {},
      },
      {
        type: "tool-approval-request",
        toolCallId: "call-1",
        approvalId: "approval-1",
      },
    ];
    expect(() =>
      reducePersistedUIMessageChunks(createPersistedUIMessageChunkState(), [
        ...approvalPrefix,
        {
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: "yes",
        },
      ]),
    ).toThrow("field approved must be a boolean");

    const orphaned = reducePersistedUIMessageChunks(
      createPersistedUIMessageChunkState(),
      [
        { type: "tool-output-available", toolCallId: "approved", output: 1 },
        { type: "tool-output-denied", toolCallId: "denied" },
        { type: "text-start", id: "after" },
      ],
    );
    expect(orphaned.state.parts).toEqual([
      expect.objectContaining({ type: "text" }),
    ]);
  });
});
