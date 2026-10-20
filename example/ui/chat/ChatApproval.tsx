import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  optimisticallySendMessage,
  useUIMessages,
  type UIMessage,
} from "@convex-dev/agent/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useDemoThread } from "@/hooks/use-demo-thread";
import type { ToolUIPart } from "ai";

export default function ChatApproval() {
  const { threadId, resetThread } = useDemoThread("Tool Approval Example");

  return (
    <>
      <header className="sticky top-0 h-16 z-10 bg-white/80 backdrop-blur-xs p-4 flex justify-between items-center border-b">
        <h1 className="text-xl font-semibold accent-text">
          Tool Approval Example
        </h1>
      </header>
      <div className="h-[calc(100vh-8rem)] flex flex-col bg-gray-50">
        {threadId ? (
          <Chat threadId={threadId} reset={() => void resetThread()} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Loading...
          </div>
        )}
      </div>
    </>
  );
}

function Chat({ threadId, reset }: { threadId: string; reset: () => void }) {
  const {
    results: messages,
    status,
    loadMore,
  } = useUIMessages(
    api.chat.approval.listThreadMessages,
    { threadId },
    { initialNumItems: 10, stream: true },
  );

  const sendMessage = useMutation(
    api.chat.approval.sendMessage,
  ).withOptimisticUpdate(
    optimisticallySendMessage(api.chat.approval.listThreadMessages),
  );

  const submitApproval = useMutation(api.chat.approval.submitApproval);
  const hasPendingApprovals = messages.some((m) =>
    m.parts.some(
      (p) =>
        p.type.startsWith("tool-") &&
        (p as ToolUIPart).state === "approval-requested",
    ),
  );

  const [prompt, setPrompt] = useState(
    "Delete the file important.txt and transfer $500 to account savings-123",
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function onSendClicked() {
    if (prompt.trim() === "") return;
    void sendMessage({ threadId, prompt }).catch(() => setPrompt(prompt));
    setPrompt("");
  }

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full">
      <div className="flex-1 overflow-y-auto p-6">
        {messages.length > 0 ? (
          <div className="flex flex-col gap-4">
            {status === "CanLoadMore" && (
              <button onClick={() => loadMore(4)}>Load more</button>
            )}
            {messages.map((m) => (
              <Message
                key={m.key}
                message={m}
                threadId={threadId}
                onApproval={submitApproval}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            Try asking the agent to delete a file, transfer money, or check a
            balance.
          </div>
        )}
      </div>

      <div className="border-t bg-white p-6">
        <form
          className="flex gap-2 items-center max-w-2xl mx-auto"
          onSubmit={(e) => {
            e.preventDefault();
            onSendClicked();
          }}
        >
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="flex-1 px-4 py-2 rounded-lg border border-gray-300 focus:outline-hidden focus:ring-2 focus:ring-blue-400 bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={
              hasPendingApprovals
                ? "Respond to pending approvals first..."
                : "Ask the agent to do something..."
            }
            disabled={hasPendingApprovals}
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition font-semibold disabled:opacity-50"
            disabled={!prompt.trim() || hasPendingApprovals}
          >
            Send
          </button>
          {messages.length > 0 && (
            <button
              className="px-4 py-2 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 transition font-medium"
              onClick={() => {
                reset();
                setPrompt(
                  "Delete the file important.txt and transfer $500 to account savings-123",
                );
              }}
              type="button"
            >
              Reset
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function Message({
  message,
  threadId,
  onApproval,
}: {
  message: UIMessage;
  threadId: string;
  onApproval: (args: {
    threadId: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
  }) => Promise<unknown>;
}) {
  const isUser = message.role === "user";

  // Find tool parts that need approval
  const toolParts = message.parts.filter((p): p is ToolUIPart =>
    p.type.startsWith("tool-"),
  );

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "rounded-lg px-4 py-2 max-w-lg shadow-xs",
          isUser ? "bg-blue-100 text-blue-900" : "bg-gray-200 text-gray-800",
          {
            "bg-green-100": message.status === "streaming",
            "bg-red-100": message.status === "failed",
          },
        )}
      >
        {toolParts.map((tool) => (
          <ToolCallDisplay
            key={tool.toolCallId}
            tool={tool}
            threadId={threadId}
            onApproval={onApproval}
          />
        ))}
        {message.text && (
          <div className="whitespace-pre-wrap">{message.text}</div>
        )}
        {!message.text && toolParts.length === 0 && "..."}
      </div>
    </div>
  );
}

function ToolCallDisplay({
  tool,
  threadId,
  onApproval,
}: {
  tool: ToolUIPart;
  threadId: string;
  onApproval: (args: {
    threadId: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
  }) => Promise<unknown>;
}) {
  const [denialReason, setDenialReason] = useState("");
  const [showReasonInput, setShowReasonInput] = useState(false);
  const toolName = tool.type.replace("tool-", "");
  const approvalId = getToolApprovalId(tool);
  const approvalReason = getToolApprovalReason(tool);

  return (
    <div className="mb-2 p-2 rounded-sm bg-white/50 border border-gray-300 text-sm">
      <div className="font-mono text-xs text-gray-500 mb-1">
        {toolName}({JSON.stringify(tool.input)})
      </div>

      {tool.state === "approval-requested" && approvalId && (
        <div className="mt-2">
          <div className="text-amber-700 font-medium mb-2">
            Approval required
          </div>
          {showReasonInput ? (
            <div className="flex gap-2 items-center mb-2">
              <input
                type="text"
                value={denialReason}
                onChange={(e) => setDenialReason(e.target.value)}
                placeholder="Reason for denial..."
                className="flex-1 px-2 py-1 text-sm rounded-sm border border-gray-300"
              />
              <button
                className="px-3 py-1 rounded-sm bg-red-500 text-white text-sm hover:bg-red-600"
                onClick={() => {
                  void onApproval({
                    threadId,
                    approvalId,
                    approved: false,
                    reason: denialReason || undefined,
                  });
                }}
              >
                Deny
              </button>
              <button
                className="text-xs text-gray-500 hover:underline"
                onClick={() => setShowReasonInput(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded-sm bg-green-600 text-white text-sm hover:bg-green-700"
                onClick={() => {
                  void onApproval({
                    threadId,
                    approvalId,
                    approved: true,
                  });
                }}
              >
                Approve
              </button>
              <button
                className="px-3 py-1 rounded-sm bg-red-500 text-white text-sm hover:bg-red-600"
                onClick={() => setShowReasonInput(true)}
              >
                Deny
              </button>
            </div>
          )}
        </div>
      )}

      {tool.state === "approval-responded" && (
        <div className="text-green-700 text-xs">Approved - executing...</div>
      )}

      {tool.state === "output-denied" && (
        <div className="text-red-600 text-xs">
          Denied
          {approvalReason && `: ${approvalReason}`}
        </div>
      )}

      {tool.state === "output-available" && (
        <div className="text-green-700 text-xs mt-1">
          Result: {JSON.stringify("output" in tool ? tool.output : undefined)}
        </div>
      )}

      {tool.state === "output-error" && (
        <div className="text-red-600 text-xs mt-1">
          Error: {"errorText" in tool ? tool.errorText : "Unknown error"}
        </div>
      )}

      {(tool.state === "input-available" ||
        tool.state === "input-streaming") && (
        <div className="text-gray-500 text-xs">Processing...</div>
      )}
    </div>
  );
}

function getToolApprovalId(tool: ToolUIPart): string | undefined {
  if (tool.state !== "approval-requested" || !("approval" in tool)) {
    return undefined;
  }
  const approval = tool.approval as { id?: unknown } | undefined;
  return typeof approval?.id === "string" ? approval.id : undefined;
}

function getToolApprovalReason(tool: ToolUIPart): string | undefined {
  if (
    (tool.state !== "output-denied" && tool.state !== "approval-requested") ||
    !("approval" in tool)
  ) {
    return undefined;
  }
  const approval = tool.approval as { reason?: unknown } | undefined;
  return typeof approval?.reason === "string" ? approval.reason : undefined;
}
