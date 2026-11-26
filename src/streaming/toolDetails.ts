import type { Infer } from "convex/values";
import type { vToolCallPart } from "../validators.js";

/**
 * What the AI SDK shows on a tool's UI part but leaves out of the model
 * messages that are saved: the tool's title and metadata, and whether the part
 * is a `dynamic-tool`. A saved call keeps all three and its result keeps
 * `dynamic`, so a result on another page reloads as the same part.
 */
export type ToolDetails = Pick<
  Infer<typeof vToolCallPart>,
  "title" | "toolMetadata" | "dynamic"
>;

export function callDetails(part: object): ToolDetails {
  const { title, toolMetadata, dynamic } = part as ToolDetails;
  return {
    ...(title != null ? { title } : {}),
    ...(toolMetadata != null ? { toolMetadata } : {}),
    ...(dynamic ? { dynamic } : {}),
  };
}

export function resultDetails(part: object): ToolDetails {
  return (part as ToolDetails).dynamic ? { dynamic: true } : {};
}

/** The details of a tool's UI part, as they are saved. */
export function toolPartDetails(part: { type: string }): ToolDetails {
  return callDetails({ ...part, dynamic: part.type === "dynamic-tool" });
}

/** The type and details of the UI part for a saved call or result. */
export function toolPartFields(toolName: string, part: object) {
  const { title, toolMetadata, dynamic } = part as ToolDetails;
  return {
    ...(dynamic
      ? { type: "dynamic-tool" as const, toolName }
      : { type: `tool-${toolName}` as const }),
    ...(title != null ? { title } : {}),
    ...(toolMetadata != null ? { toolMetadata } : {}),
  };
}
