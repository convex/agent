import type { UIMessage } from "@convex-dev/agent/react";
import { describe, expect, it } from "vitest";
import { convertMessage } from "./convertMessage";

const message: UIMessage = {
  id: "stream-id",
  key: "thread-1-0",
  role: "assistant",
  parts: [{ type: "text", text: "Once upon a time" }],
  text: "Once upon a time",
  status: "streaming",
  order: 1,
  stepOrder: 0,
  _creationTime: 1_700_000_000_000,
};

describe("convertMessage", () => {
  it("keeps the same runtime ID when a streamed message is persisted", () => {
    const streaming = convertMessage(message);
    const saved = convertMessage({
      ...message,
      id: "database-id",
      status: "success",
    });
    expect(streaming.id).toBe(message.key);
    expect(saved.id).toBe(streaming.id);
    expect(streaming.status).toEqual({ type: "running" });
    expect(saved.status).toEqual({ type: "complete", reason: "stop" });
    expect(saved.createdAt).toEqual(new Date(message._creationTime));
  });

  it("preserves ordered text, reasoning, and tool results", () => {
    expect(
      convertMessage({
        ...message,
        status: "success",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "I need two characters." },
          {
            type: "tool-getCharacterNames",
            toolCallId: "call-1",
            state: "output-available",
            input: { count: 2 },
            output: ["Alice", "Bob"],
          },
          { type: "text", text: "Alice met Bob." },
        ],
      }).content,
    ).toEqual([
      { type: "reasoning", text: "I need two characters." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "getCharacterNames",
        argsText: '{"count":2}',
        result: ["Alice", "Bob"],
      },
      { type: "text", text: "Alice met Bob." },
    ]);
  });

  it("represents a tool call while its input is still streaming", () => {
    expect(
      convertMessage({
        ...message,
        parts: [
          {
            type: "dynamic-tool",
            toolName: "getCharacterNames",
            toolCallId: "call-1",
            state: "input-streaming",
          },
        ],
      }).content,
    ).toEqual([
      {
        type: "tool-call",
        toolName: "getCharacterNames",
        toolCallId: "call-1",
        argsText: "{}",
      },
    ]);
  });

  it("exposes tool failures and incomplete assistant responses", () => {
    const result = convertMessage({
      ...message,
      status: "failed",
      parts: [
        {
          type: "tool-getCharacterNames",
          toolCallId: "call-1",
          state: "output-error",
          input: {},
          errorText: "Tool unavailable",
        },
      ],
    });
    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolName: "getCharacterNames",
        toolCallId: "call-1",
        argsText: "{}",
        result: "Tool unavailable",
        isError: true,
      },
    ]);
    expect(result.status).toEqual({ type: "incomplete", reason: "error" });
  });

  it("keeps pending assistant messages running", () => {
    expect(
      convertMessage({ ...message, status: "pending", parts: [] }).status,
    ).toEqual({ type: "running" });
  });

  it("does not assign assistant status to a user message", () => {
    const result = convertMessage({
      ...message,
      role: "user",
      status: "success",
    });
    expect(result.role).toBe("user");
    expect(result.content).toEqual(message.parts);
    expect(result.status).toBeUndefined();
  });
  it("maps each approval state to assistant-ui's approval gate", () => {
    const input = { filename: "important.txt" };
    const call = {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "deleteFile",
      argsText: '{"filename":"important.txt"}',
    };
    const result = convertMessage({
      ...message,
      status: "success",
      parts: [
        {
          type: "tool-deleteFile",
          toolCallId: "call-1",
          state: "approval-requested",
          input,
          approval: { id: "approval-1" },
        },
      ],
    });
    expect(result.status).toEqual({
      type: "requires-action",
      reason: "tool-calls",
    });
    expect(result.content).toEqual([
      { ...call, approval: { id: "approval-1" } },
    ]);

    expect(
      convertMessage({
        ...message,
        status: "success",
        parts: [
          {
            type: "tool-deleteFile",
            toolCallId: "call-1",
            state: "approval-responded",
            input,
            approval: { id: "approval-1", approved: true },
          },
        ],
      }),
    ).toMatchObject({
      status: { type: "complete" },
      content: [{ ...call, approval: { id: "approval-1", approved: true } }],
    });

    expect(
      convertMessage({
        ...message,
        status: "success",
        parts: [
          {
            type: "tool-deleteFile",
            toolCallId: "call-1",
            state: "output-available",
            input,
            output: "Deleted",
            approval: { id: "approval-1", approved: true },
          },
        ],
      }).content,
    ).toEqual([
      {
        ...call,
        approval: { id: "approval-1", approved: true },
        result: "Deleted",
      },
    ]);
  });

  it("reports a denied tool call as an error carrying the reason", () => {
    const denied = (reason?: string) =>
      convertMessage({
        ...message,
        status: "success",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "deleteFile",
            toolCallId: "call-1",
            state: "output-denied",
            input: {},
            approval: { id: "approval-1", approved: false, reason },
          },
        ],
      }).content;
    expect(denied("Keep that file")).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "deleteFile",
        argsText: "{}",
        approval: {
          id: "approval-1",
          approved: false,
          reason: "Keep that file",
        },
        result: { error: "Keep that file" },
        isError: true,
      },
    ]);
    expect(denied()).toMatchObject([
      { result: { error: "Tool approval denied" }, isError: true },
    ]);
  });

  it("maps sources, files, and data parts, and drops parts with no equivalent", () => {
    expect(
      convertMessage({
        ...message,
        status: "success",
        parts: [
          { type: "step-start" },
          {
            type: "source-url",
            sourceId: "s-1",
            url: "https://docs.convex.dev",
            title: "Docs",
          },
          {
            type: "source-document",
            sourceId: "s-2",
            mediaType: "application/pdf",
            title: "Spec",
          },
          {
            type: "file",
            mediaType: "image/png",
            url: "https://example.com/a.png",
          },
          {
            type: "file",
            mediaType: "text/plain",
            url: "https://example.com/a.txt",
            filename: "a.txt",
          },
          { type: "data-progress", data: { done: 1 } },
          { type: "custom", kind: "provider.thing" },
          {
            type: "reasoning-file",
            mediaType: "image/png",
            url: "https://example.com/r.png",
          },
        ],
      }).content,
    ).toEqual([
      {
        type: "source",
        sourceType: "url",
        id: "s-1",
        url: "https://docs.convex.dev",
        title: "Docs",
      },
      {
        type: "source",
        sourceType: "document",
        id: "s-2",
        mediaType: "application/pdf",
        title: "Spec",
      },
      { type: "image", image: "https://example.com/a.png" },
      {
        type: "file",
        data: "https://example.com/a.txt",
        mimeType: "text/plain",
        filename: "a.txt",
      },
      { type: "data-progress", data: { done: 1 } },
    ]);
  });
});
