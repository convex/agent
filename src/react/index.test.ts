// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useStreamingText } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("useStreamingText decodes characters split across chunks", async () => {
  const bytes = new TextEncoder().encode("héllo 😀");
  const chunks = [bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)];
  vi.stubGlobal("fetch", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });
    return new Response(body);
  });
  const { result } = renderHook(() =>
    useStreamingText("https://example.com/stream", "thread"),
  );
  await act(() => result.current[1]("hi"));
  expect(result.current[0]).toEqual({
    text: "héllo 😀",
    loading: false,
    error: null,
  });
});
