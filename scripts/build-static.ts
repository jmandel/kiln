#!/usr/bin/env bun
/**
 * Static build:
 * - bun build index.html viewer.html --outdir dist
 * - copy ./examples -> dist/examples
 * - generate dist/examples/index.json containing inline examples
 */

import { $ } from "bun";
import { mkdir, cp, readdir, readFile, writeFile, stat } from "fs/promises";
import { resolve, join, basename } from "path";

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true }).catch(() => {});
}

async function buildHtml() {
  console.log("🧱 bundling html -> dist");
  await $`bun build index.html viewer.html --outdir dist`;
}

async function copyExamples() {
  const src = resolve("examples");
  const dst = resolve("dist", "examples");
  await ensureDir(dst);
  console.log("📦 copying examples -> dist/examples");
  await cp(src, dst, { recursive: true });
}

async function generateExamplesIndex() {
  const dir = resolve("examples");
  const outDir = resolve("dist", "examples");
  const outFile = join(outDir, "index.json");
  console.log("🧾 generating examples/index.json");

  const items: Array<{ name: string; file: string; content: any }> = [];

  const list = await readdir(dir);
  for (const f of list) {
    if (!f.toLowerCase().endsWith(".json")) continue;
    const p = join(dir, f);
    const st = await stat(p);
    if (!st.isFile()) continue;
    try {
      const text = await readFile(p, "utf8");
      const json = JSON.parse(text);
      items.push({ name: basename(f, ".json"), file: `examples/${f}`, content: json });
    } catch (e) {
      console.warn("Skipping invalid JSON:", f, e);
    }
  }

  await writeFile(outFile, JSON.stringify({ examples: items }, null, 2));
}

async function main() {
  await ensureDir(resolve("dist"));
  await buildHtml();
  await copyExamples();
  await generateExamplesIndex();
  console.log("✅ static build ready in ./dist");
}

main().catch(err => { console.error(err); process.exit(1); });

