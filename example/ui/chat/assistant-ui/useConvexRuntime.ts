import {
  MessageNotSentError,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  optimisticallySendMessage,
  useUIMessages,
} from "@convex-dev/agent/react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { convertMessage, pendingApprovalIds } from "./convertMessage";

export function useConvexRuntime(threadId: string) {
  const { results, status, loadMore } = useUIMessages(
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
  const abortStream = useMutation(api.chat.streamAbort.abortStreamByOrder);
  const latest = results.findLast((message) => message.role === "assistant");

  return useExternalStoreRuntime({
    messages: results,
    convertMessage,
    isLoading: status === "LoadingFirstPage",
    isDisabled: status === "LoadingFirstPage",
    isSendDisabled: pendingApprovalIds(latest).length > 0,
    isRunning: latest?.status === "pending" || latest?.status === "streaming",
    hasEarlier: status === "CanLoadMore",
    onLoadEarlier: async () => loadMore(10),
    onNew: async ({ content: [part, ...rest] }) => {
      if (part?.type !== "text" || rest.length) {
        throw new MessageNotSentError("This example accepts text only.");
      }
      try {
        await sendMessage({ threadId, prompt: part.text });
      } catch (cause) {
        throw new MessageNotSentError(String(cause));
      }
    },
    onRespondToToolApproval: async ({ approvalId, approved, reason }) => {
      await submitApproval({ threadId, approvalId, approved, reason });
    },
    ...(latest?.status === "streaming"
      ? {
          onCancel: async () => {
            await abortStream({ threadId, order: latest.order });
          },
        }
      : {}),
  });
}
