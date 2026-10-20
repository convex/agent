import { AssistantRuntimeProvider, AuiIf } from "@assistant-ui/react";
import { useState } from "react";
import { useDemoThread } from "../hooks/use-demo-thread";
import { Thread } from "./assistant-ui/Thread";
import { useConvexRuntime } from "./assistant-ui/useConvexRuntime";

export default function ChatAssistantUI() {
  const { threadId, resetThread } = useDemoThread("assistant-ui Chat Example");
  return threadId ? (
    <Conversation
      key={threadId}
      threadId={threadId}
      resetThread={resetThread}
    />
  ) : (
    <p role="status" className="p-8 text-center">
      Loading conversation…
    </p>
  );
}

function Conversation({
  threadId,
  resetThread,
}: {
  threadId: string;
  resetThread: () => Promise<void>;
}) {
  const runtime = useConvexRuntime(threadId);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [newThreadError, setNewThreadError] = useState<string>();

  const handleNewThread = async () => {
    setNewThreadError(undefined);
    setIsCreatingThread(true);
    try {
      await resetThread();
    } catch (cause) {
      setNewThreadError(
        cause instanceof Error
          ? cause.message
          : "Unable to create a new conversation.",
      );
    } finally {
      setIsCreatingThread(false);
    }
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-col bg-white">
        <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Approval Agent
            </h1>
            <p className="text-sm text-slate-500">
              Convex Agent + assistant-ui
            </p>
          </div>
          <AuiIf condition={(s) => !s.thread.isRunning}>
            <button
              type="button"
              onClick={() => void handleNewThread()}
              disabled={isCreatingThread}
              aria-busy={isCreatingThread}
              className="rounded-lg border px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
            >
              New conversation
            </button>
          </AuiIf>
        </header>
        {newThreadError && (
          <p
            role="alert"
            className="mx-auto w-full max-w-3xl px-4 py-3 text-sm text-red-700"
          >
            {newThreadError}
          </p>
        )}
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}
