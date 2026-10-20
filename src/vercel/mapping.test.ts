import { describe, test, expect } from "vitest";
import {
  guessMimeType,
  serializeDataOrUrl,
  toModelMessageDataOrUrl,
  serializeMessage,
  serializeResponseMessages,
  toModelMessage,
  serializeContent,
  toModelMessageContent,
  toUIFilePart,
  serializeWarnings,
} from "./mapping.js";
import { api } from "../component/_generated/api.js";
import type { AgentComponent, ActionCtx } from "./client/types.js";
import { vMessage, vToolResultPart } from "../validators.js";
import fs from "fs";
import path from "path";
import type { SerializedContent } from "./mapping.js";
import { validate } from "convex-helpers/validators";
import type {
  FilePart,
  ModelMessage,
  StepResult,
  ToolResultPart,
  ToolSet,
  CallWarning,
} from "ai";
import type { Infer } from "convex/values";
import { mockModel } from "./client/mockModel.js";

const testAssetsDir = path.join(__dirname, "../../test-assets");
const testFiles = [
  "book.svg",
  "bump.jpeg",
  "stack.png",
  "favicon.ico",
  "convex-logo.svg",
  "stack-light@3x.webp",
];

function fileToArrayBuffer(filePath: string): ArrayBuffer {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("mapping", () => {
  test("serializes every AI SDK 7 warning discriminant", () => {
    const warnings: CallWarning[] = [
      { type: "unsupported", feature: "feature", details: "details" },
      { type: "compatibility", feature: "feature", details: "details" },
      {
        type: "deprecated",
        setting: "setting",
        message: "message",
      },
      { type: "other", message: "message" },
    ];

    expect(serializeWarnings(warnings)).toEqual(warnings);
  });

  test("infers correct mimeType for all test-assets", () => {
    const expected: { [key: string]: string } = {
      "book.svg": "image/svg+xml", // <svg
      "bump.jpeg": "image/jpeg",
      "stack.png": "image/png",
      "favicon.ico": "application/octet-stream", // fallback for ico
      "convex-logo.svg": "image/svg+xml", // <?xm
      "stack-light@3x.webp": "image/webp",
      "cat.gif": "image/gif",
    };
    for (const file of testFiles) {
      const ab = fileToArrayBuffer(path.join(testAssetsDir, file));
      const mime = guessMimeType(ab);
      expect(mime).toBe(expected[file]);
    }
  });

  test("turns Uint8Array into ArrayBuffer and round-trips", () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5]);
    // serializeDataOrUrl should return the same ArrayBuffer
    const ser = serializeDataOrUrl(arr);
    expect(ser).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(ser as ArrayBuffer)).toEqual(arr);
    // toModelMessageDataOrUrl should return the same ArrayBuffer
    const deser = toModelMessageDataOrUrl(ser);
    expect(deser).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(deser as ArrayBuffer)).toEqual(arr);
  });

  test("round-trip serialize/deserialize message", async () => {
    const message = {
      role: "user" as const,
      content: "hello world",
      providerOptions: {},
    };
    // Fake ctx and component
    const ctx = {
      runAction: async () => undefined,
      runMutation: async () => undefined,
      storage: {
        store: async () => "storageId",
        getUrl: async () => "https://example.com/file",
        delete: async () => undefined,
      },
    } as unknown as ActionCtx;
    const component = api as unknown as AgentComponent;
    const { message: ser } = await serializeMessage(ctx, component, message);
    // Use is for type validation
    expect(validate(vMessage, ser)).toBeTruthy();
    const round = toModelMessage(ser);
    expect(round).toEqual(message);
  });

  test("tool output round-trips", async () => {
    const toolResult = {
      type: "tool-result" as const,
      toolCallId: "tool-call-id",
      toolName: "tool-name",
      output: {
        type: "text",
        value: "hello world",
      },
    } satisfies ToolResultPart;
    const [result] = toModelMessageContent([toolResult]);
    expect(result).toMatchObject(toolResult);
    const {
      content: [roundtrip],
    } = await serializeContent({} as ActionCtx, {} as AgentComponent, [
      result as ToolResultPart,
    ]);
    expect(roundtrip).toMatchObject(toolResult);
  });

  test("tool results get normalized to output", async () => {
    const toolResult = {
      type: "tool-result" as const,
      toolCallId: "tool-call-id",
      toolName: "tool-name",
      result: "hello world",
    } satisfies Infer<typeof vToolResultPart>;
    const expected = {
      type: "tool-result",
      toolCallId: "tool-call-id",
      toolName: "tool-name",
      output: {
        type: "text",
        value: "hello world",
      },
    };
    const [deserialized] = toModelMessageContent([toolResult]);
    expect(deserialized).toMatchObject(expected);
    const {
      content: [serialized],
    } = await serializeContent({} as ActionCtx, {} as AgentComponent, [
      toolResult,
    ]);
    expect(serialized).toMatchObject(expected);
  });

  test("legacy result JSON with a type field is not treated as SDK output", async () => {
    const weather = { type: "weather", temperature: 72 };
    const toolResult = {
      type: "tool-result" as const,
      toolCallId: "tool-call-id",
      toolName: "weather",
      result: weather,
    } satisfies Infer<typeof vToolResultPart>;
    const expected = { type: "json", value: weather };

    const [deserialized] = toModelMessageContent([
      toolResult,
    ]) as ToolResultPart[];
    expect(deserialized.output).toEqual(expected);
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      [toolResult],
    );
    expect((content[0] as Infer<typeof vToolResultPart>).output).toEqual(
      expected,
    );
  });

  test.each([
    [
      "tagged data",
      {
        type: "file",
        data: { type: "data", data: new Uint8Array([1, 2]) },
        mediaType: "application/octet-stream",
      },
      { type: "data" },
    ],
    [
      "tagged URL",
      {
        type: "file",
        data: { type: "url", url: new URL("https://example.com/file") },
        mediaType: "application/pdf",
      },
      { type: "url", url: new URL("https://example.com/file") },
    ],
    [
      "tagged text",
      {
        type: "file",
        data: { type: "text", text: "hello" },
        mediaType: "text/plain",
      },
      { type: "text", text: "hello" },
    ],
    [
      "tagged reference",
      {
        type: "file",
        data: { type: "reference", reference: { openai: "file-1" } },
        mediaType: "application/pdf",
      },
      { type: "reference", reference: { openai: "file-1" } },
    ],
    [
      "legacy file-data",
      {
        type: "file-data",
        data: "AQI=",
        mediaType: "application/octet-stream",
      },
      { type: "data", data: "AQI=" },
    ],
    [
      "legacy file-url",
      {
        type: "file-url",
        url: "https://example.com/file",
        mediaType: "application/pdf",
      },
      { type: "url", url: new URL("https://example.com/file") },
    ],
    [
      "legacy file ID",
      { type: "file-id", fileId: "file-1" },
      { type: "file-id", fileId: "file-1" },
    ],
    [
      "provider-keyed legacy file ID",
      { type: "file-id", fileId: { openai: "file-1" } },
      { type: "reference", reference: { openai: "file-1" } },
    ],
    [
      "legacy file reference",
      { type: "file-reference", providerReference: { openai: "file-1" } },
      { type: "reference", reference: { openai: "file-1" } },
    ],
    [
      "legacy image data",
      { type: "image-data", data: "AQI=", mediaType: "image/png" },
      { type: "data", data: "AQI=" },
    ],
    [
      "legacy image URL",
      { type: "image-url", url: "https://example.com/image" },
      { type: "url", url: new URL("https://example.com/image") },
    ],
    [
      "legacy image ID",
      { type: "image-file-id", fileId: "image-1" },
      { type: "image-file-id", fileId: "image-1" },
    ],
    [
      "provider-keyed legacy image ID",
      { type: "image-file-id", fileId: { openai: "image-1" } },
      { type: "reference", reference: { openai: "image-1" } },
    ],
    [
      "legacy image reference",
      {
        type: "image-file-reference",
        providerReference: { openai: "image-1" },
      },
      { type: "reference", reference: { openai: "image-1" } },
    ],
  ])("round-trips AI SDK 7 tool-result %s", async (_name, value, expected) => {
    const result = {
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "lookup",
      output: { type: "content", value: [value] },
    } as ToolResultPart;
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      [result],
    );
    const [restored] = toModelMessageContent(content) as ToolResultPart[];
    const restoredPart = (restored.output as { value: unknown[] }).value[0]!;
    if ("fileId" in expected) {
      expect(restoredPart).toMatchObject(expected);
    } else {
      expect((restoredPart as { data: unknown }).data).toMatchObject(expected);
    }
  });

  test("deserializes persisted legacy media tool output to a canonical file", () => {
    const [restored] = toModelMessageContent([
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "render",
        output: {
          type: "content",
          value: [{ type: "media", data: "AQI=", mediaType: "image/png" }],
        },
      },
    ]) as ToolResultPart[];
    expect(restored.output).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          data: { type: "data", data: "AQI=" },
          mediaType: "image/png",
        },
      ],
    });
  });

  test("reasoning files persist tagged data and URLs, and reject missing data", async () => {
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      [
        {
          type: "reasoning-file",
          data: { type: "url", url: new URL("https://example.com/reasoning") },
          mediaType: "text/plain",
        },
        {
          type: "reasoning-file",
          data: { type: "data", data: new Uint8Array([1, 2]) },
          mediaType: "application/octet-stream",
        },
        { type: "custom", kind: "provider.annotation" },
      ] as ModelMessage["content"],
    );
    expect(content).toMatchObject([
      { type: "reasoning-file", url: "https://example.com/reasoning" },
      { type: "reasoning-file", data: expect.any(ArrayBuffer) },
      { type: "custom", kind: "provider.annotation" },
    ]);
    expect(toModelMessageContent(content)).toMatchObject([
      {
        type: "reasoning-file",
        data: { type: "url", url: new URL("https://example.com/reasoning") },
      },
      {
        type: "reasoning-file",
        data: { type: "data", data: expect.any(ArrayBuffer) },
      },
      { type: "custom", kind: "provider.annotation" },
    ]);
    expect(
      (await serializeContent({} as ActionCtx, {} as AgentComponent, content))
        .content,
    ).toEqual(content);
    expect(() =>
      toModelMessageContent([
        { type: "reasoning-file", mediaType: "text/plain" },
      ] as SerializedContent),
    ).toThrow("reasoning-file requires data or url");
  });

  test("reserializing persisted provider fields preserves them", async () => {
    const content: SerializedContent = [
      { type: "reasoning", text: "private", signature: "signed" },
      {
        type: "tool-result",
        toolCallId: "provider-call",
        toolName: "search",
        providerExecuted: true,
        output: { type: "text", value: "found" },
      },
    ];
    await expect(
      serializeContent({} as ActionCtx, {} as AgentComponent, content),
    ).resolves.toEqual({ content, fileIds: undefined });
  });

  test.each([
    [
      "ArrayBuffer",
      {
        type: "file",
        data: new Uint8Array([1, 2]).buffer,
        mediaType: "application/octet-stream",
      },
      { url: "data:application/octet-stream;base64,AQI=" },
    ],
    [
      "tagged data",
      {
        type: "file",
        data: { type: "data", data: new Uint8Array([1, 2]) },
        mediaType: "application/octet-stream",
      },
      { url: "data:application/octet-stream;base64,AQI=" },
    ],
    [
      "provider reference",
      {
        type: "file",
        data: { type: "reference", reference: { openai: "file-1" } },
        mediaType: "application/pdf",
      },
      { url: "", providerReference: { openai: "file-1" } },
    ],
  ])("renders file UI part for %s", (_name, part, expected) => {
    expect(toUIFilePart(part as FilePart)).toMatchObject(expected);
  });

  test("saving files returns fileIds when too big", async () => {
    // Make a big file
    const bigArr = new Uint8Array(1024 * 65).fill(1);
    const ab = bigArr.buffer.slice(
      bigArr.byteOffset,
      bigArr.byteOffset + bigArr.byteLength,
    );
    let called = false;
    const ctx = {
      runAction: async () => undefined,
      runMutation: async (_fn: unknown, _args: unknown) => {
        called = true;
        return { fileId: "file-123", storageId: "storage-123" };
      },
      storage: {
        store: async () => "storageId",
        getUrl: async () => "https://example.com/file",
        delete: async () => undefined,
      },
    } as unknown as ActionCtx;
    const component = api as unknown as AgentComponent;
    const content = [
      {
        type: "file" as const,
        data: ab,
        filename: "bigfile.bin",
        mimeType: "application/octet-stream",
        providerOptions: {},
      },
    ];
    const { content: ser, fileIds } = await serializeContent(
      ctx,
      component,
      content,
    );
    expect(called).toBe(true);
    expect(fileIds).toEqual(["file-123"]);
    // Should have replaced data with a URL
    const serArr = ser as SerializedContent;
    expect(typeof (serArr as { data: unknown }[])[0].data).toBe("string");
    expect((serArr as { data: unknown }[])[0].data as string).toMatch(
      /^https?:\/\//,
    );
  });

  test("materializes oversized canonical tool-result files", async () => {
    const bytes = new Uint8Array(1024 * 65).fill(1);
    const ctx = {
      runAction: async () => undefined,
      runMutation: async () => ({
        fileId: "file-123",
        storageId: "storage-123",
      }),
      storage: {
        getUrl: async () => "https://example.com/file",
      },
    } as unknown as ActionCtx;
    const result = {
      type: "tool-result" as const,
      toolCallId: "call-1",
      toolName: "render",
      output: {
        type: "content" as const,
        value: [
          {
            type: "file" as const,
            data: { type: "data" as const, data: bytes },
            mediaType: "application/octet-stream",
            filename: "result.bin",
          },
        ],
      },
    } satisfies ToolResultPart;

    const { content, fileIds } = await serializeContent(
      ctx,
      api as unknown as AgentComponent,
      [result],
    );

    expect(fileIds).toEqual(["file-123"]);
    expect(content).toMatchObject([
      {
        type: "tool-result",
        output: {
          type: "content",
          value: [
            {
              type: "file",
              data: { type: "url", url: "https://example.com/file" },
            },
          ],
        },
      },
    ]);

    const opaque = { attachment: "data:application/octet-stream,opaque" };
    await expect(
      serializeContent(ctx, api as unknown as AgentComponent, [
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "render",
          result: opaque,
        } satisfies Infer<typeof vToolResultPart>,
      ]),
    ).resolves.toMatchObject({
      content: [{ output: { type: "json", value: opaque } }],
    });
  });

  test("materializes oversized canonical tool-result text files", async () => {
    const ctx = {
      runAction: async () => undefined,
      runMutation: async () => ({
        fileId: "file-123",
        storageId: "storage-123",
      }),
      storage: {
        getUrl: async () => "https://example.com/file",
      },
    } as unknown as ActionCtx;
    const result = {
      type: "tool-result" as const,
      toolCallId: "call-1",
      toolName: "render",
      output: {
        type: "content" as const,
        value: [
          {
            type: "file" as const,
            data: { type: "text" as const, text: "x".repeat(1024 * 65) },
            mediaType: "text/plain",
            filename: "result.txt",
          },
        ],
      },
    } satisfies ToolResultPart;

    const { content, fileIds } = await serializeContent(
      ctx,
      api as unknown as AgentComponent,
      [result],
    );

    expect(fileIds).toEqual(["file-123"]);
    expect(content).toMatchObject([
      {
        type: "tool-result",
        output: {
          type: "content",
          value: [
            {
              type: "file",
              data: { type: "url", url: "https://example.com/file" },
            },
          ],
        },
      },
    ]);
  });

  test("sanity: fileIds are not returned for small files", async () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5]);
    const ab = arr.buffer.slice(
      arr.byteOffset,
      arr.byteOffset + arr.byteLength,
    );
    const ctx = {
      runAction: async () => undefined,
      runMutation: async () => ({
        fileId: "file-123",
        storageId: "storage-123",
      }),
      storage: {
        store: async () => "storageId",
        getUrl: async () => "https://example.com/file",
        delete: async () => undefined,
      },
    } as unknown as ActionCtx;
    const component = api as unknown as AgentComponent;
    const content = [
      {
        type: "file" as const,
        data: ab,
        filename: "smallfile.bin",
        mimeType: "application/octet-stream",
        providerOptions: {},
      },
    ];
    const { fileIds } = await serializeContent(ctx, component, content);
    expect(fileIds).toBeUndefined();
  });

  test("tool-approval-request is preserved after serialization", async () => {
    const approvalRequest = {
      type: "tool-approval-request" as const,
      approvalId: "approval-123",
      toolCallId: "tool-call-456",
    };
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      [approvalRequest],
    );
    expect(content).toHaveLength(1);
    expect((content as unknown[])[0]).toMatchObject(approvalRequest);
    expect(toModelMessageContent(content)).toMatchObject([approvalRequest]);
  });

  test("tool-approval-response with approved: true is preserved", async () => {
    const approvalResponse = {
      type: "tool-approval-response" as const,
      approvalId: "approval-123",
      approved: true,
      reason: "User approved",
    };
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      [approvalResponse],
    );
    expect(content).toHaveLength(1);
    expect((content as unknown[])[0]).toMatchObject(approvalResponse);
  });

  test("tool-approval-response with approved: false is preserved", async () => {
    const approvalResponse = {
      type: "tool-approval-response" as const,
      approvalId: "approval-123",
      approved: false,
      reason: "User denied",
      providerExecuted: false,
    };
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      [approvalResponse],
    );
    expect(content).toHaveLength(1);
    expect((content as unknown[])[0]).toMatchObject(approvalResponse);
  });

  test("stored reasoning-file URLs survive serialization", async () => {
    const reasoningFile: SerializedContent = [
      {
        type: "reasoning-file",
        url: "https://example.com/reasoning",
        mediaType: "text/plain",
      },
    ];
    const { content } = await serializeContent(
      {} as ActionCtx,
      {} as AgentComponent,
      reasoningFile,
    );
    expect(content).toEqual(reasoningFile);
  });

  describe("serializeResponseMessages", () => {
    const ctx = {
      runAction: async () => undefined,
      runMutation: async () => undefined,
      storage: {
        store: async () => "storageId",
        getUrl: async () => "https://example.com/file",
        delete: async () => undefined,
      },
    } as unknown as ActionCtx;
    const component = api as unknown as AgentComponent;

    const step0Messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "search",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];
    const step1Messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "thinking" }] },
    ];
    const step2Messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "search",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "search",
            output: { type: "text", value: "done" },
          },
        ],
      },
    ];

    const makeStep = (messages: ModelMessage[]): StepResult<ToolSet> =>
      ({
        content: [],
        text: "",
        reasoning: [],
        reasoningText: undefined,
        files: [],
        sources: [],
        toolCalls: [],
        staticToolCalls: [],
        dynamicToolCalls: [],
        toolResults: [],
        staticToolResults: [],
        dynamicToolResults: [],
        finishReason: "stop",
        rawFinishReason: undefined,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: undefined,
        request: {},
        response: {
          id: "resp",
          timestamp: new Date(),
          modelId: "test",
          messages,
        },
        providerMetadata: undefined,
      }) as unknown as StepResult<ToolSet>;

    const contentTypes = (msg: { content: unknown }): string[] => {
      const c = msg.content;
      if (!Array.isArray(c)) return ["text"];
      return c.map((p: { type?: string }) => p.type ?? "?");
    };

    test("explicitly provided empty response messages stay empty", async () => {
      const res = await serializeResponseMessages(
        ctx,
        component,
        makeStep([]),
        undefined,
        [],
      );
      expect(res.messages).toEqual([]);
    });

    test("serializes all response messages for a step", async () => {
      const res = await serializeResponseMessages(
        ctx,
        component,
        makeStep(step0Messages),
        undefined,
        step0Messages,
      );
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0].message.role).toBe("assistant");
      expect(contentTypes(res.messages[0].message)).toEqual(["tool-call"]);
      expect(res.messages[1].message.role).toBe("tool");
      expect(contentTypes(res.messages[1].message)).toEqual(["tool-result"]);
    });

    test("serializes the text response from a later step", async () => {
      const res = await serializeResponseMessages(
        ctx,
        component,
        makeStep(step1Messages),
        undefined,
        step1Messages,
      );
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].message.role).toBe("assistant");
      expect(contentTypes(res.messages[0].message)).toEqual(["text"]);
    });

    test("persists the model that generated an SDK 7 step over the fallback", async () => {
      const routedModel = mockModel({
        provider: "routed-provider",
        modelId: "routed-model",
      });
      const step = {
        ...makeStep(step1Messages),
        model: routedModel,
      } as StepResult<ToolSet>;

      const res = await serializeResponseMessages(
        ctx,
        component,
        step,
        { provider: "fallback-provider", model: "fallback-model" },
        step1Messages,
      );

      expect(res.messages[0]).toMatchObject({
        model: "routed-model",
        provider: "routed-provider",
      });
    });

    test("serializes a tool-call and tool-result from the same step", async () => {
      const res = await serializeResponseMessages(
        ctx,
        component,
        makeStep(step2Messages),
        undefined,
        step2Messages,
      );
      expect(res.messages).toHaveLength(2);
      expect(res.messages[0].message.role).toBe("assistant");
      expect(contentTypes(res.messages[0].message)).toEqual(["tool-call"]);
      expect(res.messages[1].message.role).toBe("tool");
      expect(contentTypes(res.messages[1].message)).toEqual(["tool-result"]);
    });

    test("preserves text, a tool call, and its result from one step", async () => {
      const stepMessages: ModelMessage[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Let me check..." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c3",
              toolName: "search",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c3",
              toolName: "search",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ];
      const res = await serializeResponseMessages(
        ctx,
        component,
        makeStep(stepMessages),
        undefined,
        stepMessages,
      );
      expect(res.messages).toHaveLength(3);
      expect(res.messages[0].message.role).toBe("assistant");
      expect(contentTypes(res.messages[0].message)).toEqual(["text"]);
      expect(res.messages[1].message.role).toBe("assistant");
      expect(contentTypes(res.messages[1].message)).toEqual(["tool-call"]);
      expect(res.messages[2].message.role).toBe("tool");
      expect(contentTypes(res.messages[2].message)).toEqual(["tool-result"]);
    });
  });
});
