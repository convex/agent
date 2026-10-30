import { describe, expect, it } from "vitest";
import type { MessageDoc } from "../validators.js";
import type { UIMessage } from "./UIMessages.js";
import { fromUIMessages, toUIMessages } from "./UIMessages.js";

// Helper to create a base message doc
function baseMessageDoc<T = unknown>(
  overrides: Partial<MessageDoc & { streaming?: boolean; metadata?: T }> = {},
): MessageDoc & { streaming?: boolean; metadata?: T } {
  return {
    _id: "msg1",
    _creationTime: Date.now(),
    order: 0,
    stepOrder: 0,
    status: "success",
    threadId: "thread1",
    tool: false,
    ...overrides,
  };
}

describe("fromUIMessages round-trip tests", () => {
  it("preserves essential data for simple user message", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "user",
          content: "Hello world!",
        },
        text: "Hello world!",
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].role).toBe("user");
    expect(uiMessages[0].text).toBe("Hello world!");

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].text).toBe("Hello world!");
    expect(backToMessageDocs[0].threadId).toBe("thread1");

    // Content gets normalized to array format
    expect(Array.isArray(backToMessageDocs[0].message?.content)).toBe(true);
    if (Array.isArray(backToMessageDocs[0].message?.content)) {
      expect(backToMessageDocs[0].message.content[0]).toMatchObject({
        type: "text",
        text: "Hello world!",
      });
    }
  });

  it("preserves essential data for assistant message", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "assistant",
          content: "Hi there! How can I help?",
        },
        text: "Hi there! How can I help?",
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].role).toBe("assistant");
    expect(uiMessages[0].text).toBe("Hi there! How can I help?");

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].text).toBe("Hi there! How can I help?");
  });

  it("preserves system messages correctly", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "system",
          content: "You are a helpful assistant.",
        },
        text: "You are a helpful assistant.",
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].role).toBe("system");
    expect(uiMessages[0].text).toBe("You are a helpful assistant.");

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].text).toBe("You are a helpful assistant.");
    expect(backToMessageDocs[0].message?.role).toBe("system");

    // System content stays as string
    expect(backToMessageDocs[0].message?.content).toBe(
      "You are a helpful assistant.",
    );
  });

  it("preserves reasoning in assistant messages", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Let me think about this...",
            },
            {
              type: "text",
              text: "Here's my response.",
            },
          ],
        },
        text: "Here's my response.",
        reasoning: "Let me think about this...",
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].text).toBe("Here's my response.");

    // Check that reasoning parts are preserved in UI message
    const reasoningParts = uiMessages[0].parts.filter(
      (part) => part.type === "reasoning",
    );
    expect(reasoningParts).toHaveLength(1);
    expect(reasoningParts[0]).toMatchObject({
      type: "reasoning",
      text: "Let me think about this...",
    });

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].text).toBe("Here's my response.");
    expect(backToMessageDocs[0].reasoning).toBe("Let me think about this...");
  });

  it("derives multipart reasoning like publicMessage (#418)", async () => {
    const parts = [
      { type: "reasoning" as const, text: "foo" },
      { type: "reasoning" as const, text: "bar" },
    ];
    const [doc] = await fromUIMessages(
      [{ id: "m", role: "assistant", parts }] as unknown as UIMessage[],
      { threadId: "thread1" },
    );
    expect(doc.reasoning).toBe("foobar");
    expect(doc.reasoningDetails).toMatchObject(parts);
  });

  it("handles tool calls and groups them correctly", async () => {
    // Tool calls get grouped into single UI message but expanded back to multiple message docs
    const originalMessages = [
      baseMessageDoc({
        _id: "msg1",
        order: 1,
        stepOrder: 1,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "calculator",
              toolCallId: "call1",
              input: { operation: "add", a: 2, b: 3 },
              args: { operation: "add", a: 2, b: 3 },
            },
          ],
        },
        tool: true,
      }),
      baseMessageDoc({
        _id: "msg2",
        order: 1,
        stepOrder: 2,
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call1",
              toolName: "calculator",
              output: {
                type: "json",
                value: { result: 5 },
              },
            },
          ],
        },
        tool: true,
      }),
    ];
    const toTest = [originalMessages, [...originalMessages].reverse()];
    for (const messages of toTest) {
      const uiMessages = toUIMessages(messages);
      const backToMessageDocs = await fromUIMessages(uiMessages, {
        threadId: "thread1",
      });

      // Should be grouped into single UI message
      expect(uiMessages).toHaveLength(1);
      const uiMessage = uiMessages[0];
      expect(uiMessage.role).toBe("assistant");
      expect(uiMessage.id).toBe("msg1");

      // Check tool parts exist
      const toolParts = uiMessage.parts.filter(
        (part) => part.type === "tool-calculator",
      );
      expect(toolParts).toHaveLength(1);
      expect(toolParts[0]).toMatchObject({
        type: "tool-calculator",
        toolCallId: "call1",
        state: "output-available",
        input: { operation: "add", a: 2, b: 3 },
        output: { result: 5 },
      });

      // Should expand back to multiple message docs
      expect(backToMessageDocs.length).toBeGreaterThanOrEqual(1);

      // Check that tool information is preserved
      const toolMessages = backToMessageDocs.filter((msg) => msg.tool);
      expect(toolMessages.length).toBeGreaterThan(0);
      expect(toolMessages[0].stepOrder).toBe(1);
      expect(toolMessages[1].stepOrder).toBe(2);
    }
  });

  it("preserves file attachments in user messages", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "What's in this image?",
            },
            {
              type: "file",
              mimeType: "image/png",
              data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          ],
        },
        text: "What's in this image?",
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].role).toBe("user");
    expect(uiMessages[0].text).toBe("What's in this image?");

    // Check file parts exist in UI message
    const fileParts = uiMessages[0].parts.filter(
      (part) => part.type === "file",
    );
    expect(fileParts).toHaveLength(1);

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].text).toBe("What's in this image?");

    // Check file content is preserved
    const content = backToMessageDocs[0].message?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const fileContent = content.find((c) => c.type === "file");
      expect(fileContent).toBeDefined();
      expect(fileContent).toMatchObject({
        type: "file",
        mediaType: "image/png",
      });
    }
  });

  it("preserves sources correctly", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I found some relevant sources.",
            },
          ],
        },
        text: "I found some relevant sources.",
        sources: [
          {
            type: "source",
            sourceType: "url",
            id: "source1",
            url: "https://example.com",
            title: "Example Source",
          },
          {
            type: "source",
            sourceType: "document",
            id: "source2",
            mediaType: "application/pdf",
            title: "Document Source",
            filename: "document.pdf",
          },
        ],
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);

    // Check source parts exist in UI message
    const sourceParts = uiMessages[0].parts.filter(
      (part) => part.type === "source-url" || part.type === "source-document",
    );
    expect(sourceParts).toHaveLength(2);
    expect(sourceParts).toContainEqual({
      type: "source-document",
      sourceId: "source2",
      mediaType: "application/pdf",
      title: "Document Source",
      filename: "document.pdf",
    });

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].sources).toHaveLength(2);
    expect(backToMessageDocs[0].sources![0]).toMatchObject({
      type: "source",
      sourceType: "url",
      id: "source1",
      url: "https://example.com",
      title: "Example Source",
    });
    expect(backToMessageDocs[0].sources![1]).toMatchObject({
      type: "source",
      sourceType: "document",
      id: "source2",
      mediaType: "application/pdf",
      title: "Document Source",
      filename: "document.pdf",
    });
  });

  it("preserves metadata when provided", async () => {
    const testMetadata = {
      customField: "customValue",
      timestamp: Date.now(),
    };

    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "user",
          content: "Test message",
        },
        text: "Test message",
        metadata: testMetadata,
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].metadata).toEqual(testMetadata);

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].metadata).toEqual(testMetadata);
  });

  it("handles streaming status correctly", async () => {
    const originalMessages = [
      baseMessageDoc({
        message: {
          role: "assistant",
          content: "Streaming response...",
        },
        text: "Streaming response...",
        streaming: true,
        status: "pending",
      }),
    ];

    const uiMessages = toUIMessages(originalMessages);
    const backToMessageDocs = await fromUIMessages(uiMessages, {
      threadId: "thread1",
    });

    expect(uiMessages).toHaveLength(1);
    expect(uiMessages[0].status).toBe("streaming");

    expect(backToMessageDocs).toHaveLength(1);
    expect(backToMessageDocs[0].streaming).toBe(true);
    expect(backToMessageDocs[0].status).toBe("pending");
  });
});

describe("fromUIMessages functionality tests", () => {
  it("handles empty messages array", async () => {
    const uiMessages: UIMessage[] = [];
    const result = await fromUIMessages(uiMessages, { threadId: "thread1" });
    expect(result).toHaveLength(0);
  });

  it("correctly assigns thread ID", async () => {
    const uiMessage: UIMessage = {
      id: "test-id",
      _creationTime: Date.now(),
      order: 0,
      stepOrder: 0,
      status: "success",
      key: "test-key",
      text: "Hello",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    };

    const result = await fromUIMessages([uiMessage], {
      threadId: "custom-thread-id",
    });
    expect(result).toHaveLength(1);
    expect(result[0].threadId).toBe("custom-thread-id");
  });

  it("correctly determines tool status", async () => {
    const toolUIMessage: UIMessage = {
      id: "tool-id",
      _creationTime: Date.now(),
      order: 0,
      stepOrder: 0,
      status: "success",
      key: "tool-key",
      text: "",
      role: "assistant",
      parts: [
        {
          type: "tool-calculator",
          toolCallId: "call1",
          input: { a: 1, b: 2 },
          state: "output-available",
          output: { result: 3 },
        },
      ],
    };

    const result = await fromUIMessages([toolUIMessage], {
      threadId: "thread1",
    });
    expect(result.length).toBeGreaterThan(0);

    // Should have tool messages
    const toolMessages = result.filter((msg) => msg.tool);
    expect(toolMessages.length).toBeGreaterThan(0);
  });

  it("handles tool calls without responses", async () => {
    const toolUIMessage: UIMessage = {
      id: "tool-id",
      _creationTime: Date.now(),
      order: 0,
      stepOrder: 0,
      status: "success",
      key: "tool-key",
      text: "",
      role: "assistant",
      parts: [
        { type: "text", text: "Tool call" },
        {
          type: "tool-calculator",
          toolCallId: "call1",
          input: { a: 1, b: 2 },
          state: "input-available",
        },
      ],
    };

    const result = await fromUIMessages([toolUIMessage], {
      threadId: "thread1",
    });
    expect(result.length).toBeGreaterThan(0);

    // Should have tool messages
    const toolMessages = result.filter((msg) => msg.tool);
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0].message?.role).toBe("assistant");
    expect(toolMessages[0].message?.content[0]).toMatchObject({
      type: "text",
      text: "Tool call",
    });
    expect(toolMessages[0].message?.content[1]).toMatchObject({
      args: { a: 1, b: 2 },
      toolCallId: "call1",
      toolName: "calculator",
      type: "tool-call",
    });
  });
});
