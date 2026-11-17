// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
// esbuild is the copy the Convex CLI bundles with.
import {
  build,
  type Metafile,
} from "../node_modules/convex/node_modules/esbuild/lib/main.js";
import { expect, test } from "vitest";

// Bundles src/component the way the Convex CLI bundles a component
// (convex 1.46.0 entryPoints() and innerEsbuild, splitting on), so a plain
// entry's chunk graph is what the server loads per call (~1.3 ms per chunk).
const dir = path.resolve(__dirname, "component");

function entryPoints() {
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory())
          return existsSync(path.join(p, "convex.config.ts")) ? [] : walk(p);
        return [p];
      });
  return walk(dir).filter((p) => {
    const rel = path.relative(dir, p);
    const base = path.basename(p);
    if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) return false;
    if (rel.startsWith("_generated/") || base.startsWith(".")) return false;
    if (base === "schema.ts") return false;
    if ((base.match(/\./g) || []).length > 1) return false;
    const text = readFileSync(p, "utf8");
    if (!/^\s{0,100}(import|export)/m.test(text)) return false;
    return !/^\s*("|')use node("|');?\s*$/m.test(text);
  });
}

async function graphs() {
  const res = await build({
    entryPoints: entryPoints(),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "esnext",
    outdir: "out",
    outbase: dir,
    conditions: ["convex", "module"],
    write: false,
    splitting: true,
    chunkNames: "_deps/[hash]",
    treeShaking: true,
    minifySyntax: true,
    minifyIdentifiers: true,
    keepNames: true,
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    logLevel: "silent",
  });
  const outs = (res.metafile as Metafile).outputs;
  const graph = (f: string) => {
    const seen = new Set<string>();
    const go = (x: string) => {
      for (const i of outs[x]?.imports ?? [])
        if (i.kind === "import-statement" && !seen.has(i.path)) {
          seen.add(i.path);
          go(i.path);
        }
    };
    go(f);
    return [...seen];
  };
  return Object.fromEntries(
    Object.keys(outs)
      .filter((f) => f.endsWith(".js") && outs[f].entryPoint)
      .map((f) => {
        const files = [f, ...graph(f)];
        const sources = files.flatMap((o) =>
          Object.entries(outs[o].inputs)
            .filter(([, v]) => v.bytesInOutput > 0)
            .map(([inp]) => path.relative(dir, path.resolve(inp))),
        );
        return [
          f.replace(/^out\//, "").replace(/\.js$/, ""),
          { chunks: files.length - 1, sources },
        ];
      }),
  );
}

// Main's graph (97580c2d, #449): every function an app calls without a
// pendingMessageId loads only these.
const PLAIN_CHUNKS: Record<string, number> = {
  apiKeys: 2,
  files: 5,
  messages: 9,
  streams: 7,
  threads: 9,
  users: 9,
  "vector/index": 6,
  "vector/tables": 2,
};
const DURABLE = /(^|\/)(turns|turn[A-Z]\w*|toolJournal|durable)[^/]*\.ts$/;

test("plain entries load the same number of chunks as main", async () => {
  const g = await graphs();
  expect(
    Object.fromEntries(Object.keys(PLAIN_CHUNKS).map((e) => [e, g[e]?.chunks])),
  ).toStrictEqual(PLAIN_CHUNKS);
}, 60_000);

test("no plain entry reaches durable code", async () => {
  const g = await graphs();
  const reached = Object.fromEntries(
    Object.keys(PLAIN_CHUNKS).map((e) => [
      e,
      (g[e]?.sources ?? []).filter((s) => DURABLE.test(s)),
    ]),
  );
  expect(reached).toStrictEqual(
    Object.fromEntries(Object.keys(PLAIN_CHUNKS).map((e) => [e, []])),
  );
}, 60_000);
