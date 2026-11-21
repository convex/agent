import { getDocumentSize } from "convex/values";
import { extractText } from "./shared.js";
import type { Message } from "./validators.js";
import type { Doc } from "./component/_generated/dataModel.js";

/**
 * The message without the text the row's `text` holds, and the length of each
 * text part's text, so that `text`, cut at those lengths and the single spaces
 * `extractText` joins them with, gives each part's text back. A message whose
 * row holds no text, or that wouldn't shrink, is stored whole.
 */
export function leaveOutText(
  message: Message,
  text: string | undefined,
): { message: Message; textLengths?: number[] } {
  if (!text || text !== extractText(message)) {
    return { message, textLengths: undefined };
  }
  const textLengths: number[] = [];
  const content =
    typeof message.content === "string"
      ? ""
      : message.content.map((part) => {
          if (part.type !== "text") {
            return part;
          }
          textLengths.push(part.text.length);
          return { ...part, text: "" };
        });
  if (typeof message.content === "string") {
    textLengths.push(text.length);
  }
  const leftOut = { message: { ...message, content } as Message, textLengths };
  return getDocumentSize(leftOut) < getDocumentSize({ message })
    ? leftOut
    : { message, textLengths: undefined };
}

function changed(row: Doc<"messages">) {
  return new Error(
    `Message ${row._id}'s text no longer matches its stored message`,
  );
}

function putBackText(
  row: Doc<"messages">,
  message: Message,
  textLengths: number[],
): Message {
  const text = row.text ?? "";
  if (typeof message.content === "string") {
    if (textLengths[0] !== text.length) {
      throw changed(row);
    }
    return { ...message, content: text } as Message;
  }
  let start = 0;
  let next = 0;
  const content = message.content.map((part) => {
    if (part.type !== "text") {
      return part;
    }
    const length = textLengths[next++];
    if (!length) {
      return part;
    }
    const partText = text.slice(start, start + length);
    start += length + 1;
    return { ...part, text: partText };
  });
  if (next !== textLengths.length || start !== text.length + 1) {
    throw changed(row);
  }
  return { ...message, content } as Message;
}

/** The row with its message whole, as it was saved. */
export function withText(row: Doc<"messages">): Doc<"messages"> {
  const { textLengths, ...doc } = row;
  return row.message && textLengths
    ? { ...doc, message: putBackText(row, row.message, textLengths) }
    : doc;
}
