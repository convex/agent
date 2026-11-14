// @vitest-environment node
import { build, type Metafile } from "esbuild";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

// Runs against the built package, so `npm run build` must come first.
const root = fileURLToPath(new URL("../../", import.meta.url));
const distDir = fileURLToPath(
  new URL("../../dist/component/", import.meta.url),
);
const srcDir = fileURLToPath(new URL("./", import.meta.url));

// The files the Convex CLI treats as function entry points (convex 1.46
// bundler/index.js entryPoints()).
function convexEntryPoints(dir: string, extension: ".js" | ".ts"): string[] {
  const found: string[] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(path.join(dir, sub), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(sub, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_generated" && sub === "") continue;
        if (existsSync(path.join(dir, rel, "convex.config.ts"))) continue;
        walk(rel);
        continue;
      }
      const base = entry.name;
      if (!base.endsWith(extension)) continue;
      if (base.startsWith(".") || base.startsWith("#") || base.includes(" ")) {
        continue;
      }
      if (base === `schema${extension}`) continue;
      if ((base.match(/\./g) ?? []).length > 1) continue;
      found.push(rel);
    }
  };
  walk("");
  return found.sort();
}

const importSpecifiers = (source: string) =>
  [
    ...source.matchAll(
      /(?:^|[\s;])(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
    ),
  ].map((match) => match[1] ?? match[2] ?? match[3]);

// A stale dist passes every check below, so each built entry point must be
// newer than every file its source map says it was built from.
beforeAll(() => {
  if (!existsSync(distDir)) {
    throw new Error(`${distDir} is missing: run \`npm run build\` first`);
  }
  const stale = convexEntryPoints(distDir, ".js").flatMap((entry) => {
    const built = path.join(distDir, entry);
    const map = `${built}.map`;
    if (!existsSync(map)) return [`${entry} has no source map`];
    const { sources } = JSON.parse(readFileSync(map, "utf8")) as {
      sources: string[];
    };
    const builtAt = statSync(built).mtimeMs;
    return sources
      .map((source) => path.resolve(path.dirname(map), source))
      .filter(
        (source) => !existsSync(source) || statSync(source).mtimeMs > builtAt,
      )
      .map((source) => `${entry} is older than ${path.relative(root, source)}`);
  });
  if (stale.length > 0) {
    throw new Error(
      `dist/component is stale: run \`npm run build\`\n${stale.join("\n")}`,
    );
  }
});

describe("built component modules", () => {
  let entries: string[];
  beforeAll(() => {
    entries = convexEntryPoints(distDir, ".js");
  });

  test("each function module imports only convex", () => {
    const foreign = Object.fromEntries(
      entries.map((entry) => [
        entry,
        importSpecifiers(readFileSync(path.join(distDir, entry), "utf8"))
          .filter((spec) => !/^convex(\/|$)/.test(spec))
          .sort(),
      ]),
    );
    expect(foreign).toEqual(
      Object.fromEntries(entries.map((entry) => [entry, []])),
    );
  });

  test("the Convex CLI's bundle loads one runtime chunk per function module", async () => {
    // Options from the Convex CLI's innerEsbuild (convex 1.46
    // bundler/debugBundle.js). Each module a function loads costs a component
    // call about 1.3 ms on Convex cloud, so the count per entry is pinned.
    const result = await build({
      entryPoints: entries.map((entry) => path.join(distDir, entry)),
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "esnext",
      outdir: "out",
      outbase: distDir,
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
    const outputs: Metafile["outputs"] = result.metafile.outputs;
    const chunksOf = (output: string) => {
      const seen = new Set<string>();
      const visit = (file: string) => {
        for (const imported of outputs[file].imports) {
          if (imported.kind !== "import-statement" || seen.has(imported.path)) {
            continue;
          }
          seen.add(imported.path);
          visit(imported.path);
        }
      };
      visit(output);
      return [...seen];
    };
    const byEntry = Object.fromEntries(
      Object.entries(outputs)
        .filter(([, output]) => output.entryPoint)
        .map(([file]) => [path.posix.relative("out", file), chunksOf(file)]),
    );
    expect(
      Object.fromEntries(
        Object.entries(byEntry).map(([entry, chunks]) => [
          entry,
          chunks.length,
        ]),
      ),
    ).toEqual({
      "apiKeys.js": 1,
      "files.js": 1,
      "messages.js": 1,
      "streams.js": 1,
      "threads.js": 1,
      "users.js": 1,
      "vector/index.js": 1,
      "vector/tables.js": 1,
    });
    const chunkSources = new Set(
      Object.values(byEntry)
        .flat()
        .flatMap((chunk) => Object.keys(outputs[chunk].inputs)),
    );
    expect(
      [...chunkSources].filter(
        (input) => !/node_modules\/convex\//.test(input),
      ),
    ).toEqual([]);
  });
});

type Registered = {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  isPublic?: boolean;
  isInternal?: boolean;
  exportArgs: () => string;
  exportReturns: () => string;
};

function describeExport(value: unknown) {
  if (typeof value === "function" && "exportArgs" in value) {
    const fn = value as unknown as Registered;
    return {
      kind: fn.isQuery ? "query" : fn.isMutation ? "mutation" : "action",
      visibility: fn.isPublic ? "public" : fn.isInternal ? "internal" : "?",
      args: fn.exportArgs(),
      returns: fn.exportReturns(),
    };
  }
  return {
    type: typeof value,
    value: JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === "function" ? `[function ${inner.name}]` : inner,
    ),
  };
}

describe("built component modules match their source", () => {
  test.each(convexEntryPoints(srcDir, ".ts"))("%s", async (entry) => {
    const source = (await import(
      /* @vite-ignore */ path.join(srcDir, entry)
    )) as Record<string, unknown>;
    const built = (await import(
      /* @vite-ignore */ path.join(distDir, entry.replace(/\.ts$/, ".js"))
    )) as Record<string, unknown>;
    const describeModule = (module: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(module)
          .sort()
          .map((name) => [name, describeExport(module[name])]),
      );
    expect(describeModule(built)).toEqual(describeModule(source));
  });
});
