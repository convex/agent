import { describe, expect, test } from "vitest";
import { resolveStreams } from "./assemble.js";

const row = (position: string, status = "success") => {
  const [order, stepOrder] = position.split("/").map(Number);
  return { order, stepOrder, status, position };
};

const live = (id: string, position: string) => {
  const [order, stepOrder] = position.split("/").map(Number);
  return { id, order, stepOrder, live: true, value: id };
};

const ended = (id: string, position: string) => {
  const [order, stepOrder] = position.split("/").map(Number);
  return { id, order, stepOrder, live: false, value: id };
};

describe("resolveStreams", () => {
  test.each([
    {
      name: "rows pass through when there are no streams",
      rows: [row("1/0"), row("1/1")],
      streams: [],
      kept: ["1/0", "1/1"],
      shown: [],
    },
    {
      name: "a live stream replaces every row from its start, whatever their status",
      rows: [
        row("1/0"),
        row("1/1"),
        row("1/2", "failed"),
        row("1/3", "pending"),
      ],
      streams: [live("a", "1/1")],
      kept: ["1/0"],
      shown: ["a"],
    },
    {
      name: "of two live streams the latest started wins",
      rows: [row("1/0"), row("1/1", "pending"), row("1/2", "pending")],
      streams: [live("first", "1/1"), live("retry", "1/2")],
      kept: ["1/0", "1/1"],
      shown: ["retry"],
    },
    {
      name: "an ended stream with a saved row at or after its start is hidden",
      rows: [row("1/0"), row("1/2")],
      streams: [ended("f", "1/1")],
      kept: ["1/0", "1/2"],
      shown: [],
    },
    {
      name: "an ended stream with no saved row from its start is shown",
      rows: [row("1/0")],
      streams: [ended("f", "1/1")],
      kept: ["1/0"],
      shown: ["f"],
    },
    {
      name: "an ended stream starting inside the live stream's range is hidden",
      rows: [row("1/0")],
      streams: [live("a", "1/1"), ended("f", "1/2")],
      kept: ["1/0"],
      shown: ["a"],
    },
    {
      name: "a live stream wins over an ended stream at the same step",
      rows: [row("1/0")],
      streams: [ended("b", "1/1"), live("a", "1/1")],
      kept: ["1/0"],
      shown: ["a"],
    },
    {
      name: "two ended streams at the same step resolve to the greatest id",
      rows: [row("1/0")],
      streams: [ended("b", "1/1"), ended("a", "1/1")],
      kept: ["1/0"],
      shown: ["b"],
    },
    {
      name: "a pending row does not hide an ended stream, which replaces it",
      rows: [row("1/0"), row("1/1", "pending")],
      streams: [ended("f", "1/1")],
      kept: ["1/0"],
      shown: ["f"],
    },
    {
      name: "orders are resolved independently",
      rows: [row("1/0"), row("1/1"), row("2/0"), row("2/1")],
      streams: [ended("f", "1/1"), live("a", "2/1")],
      kept: ["1/0", "1/1", "2/0"],
      shown: ["a"],
    },
  ])("$name", ({ rows, streams, kept, shown }) => {
    const resolved = resolveStreams(rows, streams);
    expect(resolved.rows.map((r) => r.position)).toEqual(kept);
    expect(resolved.streams).toEqual(shown);
  });
});
