// Rewrites each module the Convex CLI loads as a function entry point in
// dist/component as one self-contained file that imports only `convex`.
//
// The CLI bundles a component with code splitting, so a module that shares
// code with other entry points loads as itself plus a chunk per distinct set
// of entry points reaching that code: messages.js loads ten modules. Convex
// cloud charges a component call about 1.3 ms per loaded module, so the hot
// mutations spent more time loading modules than running.
//
// Bundles are built from src, not from tsc's output: an incremental tsc run
// skips unchanged files, so a bundle of dist could inline stale copies.
import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src", "component");
const outDir = path.join(root, "dist", "component");

// The Convex CLI's entry point rules (convex bundler/index.js entryPoints()).
function entryPoints(dir, extension) {
  const found = [];
  const walk = (sub) => {
    for (const entry of readdirSync(path.join(dir, sub), {
      withFileTypes: true,
    })) {
      const rel = path.join(sub, entry.name);
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

const sources = entryPoints(sourceDir, ".ts");
if (sources.length === 0) {
  throw new Error(`No Convex entry points found in ${sourceDir}`);
}

await build({
  entryPoints: sources.map((entry) => path.join(sourceDir, entry)),
  outdir: outDir,
  outbase: sourceDir,
  allowOverwrite: true,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "esnext",
  mainFields: ["module", "main"],
  conditions: ["convex", "module"],
  external: ["convex", "convex/*"],
  sourcemap: "linked",
  sourcesContent: false,
  logLevel: "warning",
});

// Neither tsc nor esbuild deletes the output of a removed source file, and
// Convex would still deploy it.
const bundled = new Set(sources.map((entry) => entry.replace(/\.ts$/, ".js")));
const orphaned = entryPoints(outDir, ".js").filter(
  (entry) => !bundled.has(entry),
);
if (orphaned.length > 0) {
  throw new Error(
    `dist/component has Convex entry points with no source in src/component ` +
      `(run \`npm run build:clean\`):\n` +
      orphaned.join("\n"),
  );
}

const importSpecifier =
  /(?:^|[\s;])(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const unbundled = entryPoints(outDir, ".js").flatMap((entry) =>
  [...readFileSync(path.join(outDir, entry), "utf8").matchAll(importSpecifier)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((spec) => !/^convex(\/|$)/.test(spec))
    .map((spec) => `${entry} imports ${spec}`),
);
if (unbundled.length > 0) {
  throw new Error(
    `dist/component has Convex entry points that are not self-contained:\n` +
      unbundled.join("\n"),
  );
}
