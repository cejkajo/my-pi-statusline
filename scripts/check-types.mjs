import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const ignoredDirectories = new Set([".git", "node_modules"]);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".tmp-")) continue;
      files.push(...await collect(join(directory, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const rootPath = fileURLToPath(root);
const files = await collect(rootPath);
let failed = false;
for (const file of files.sort()) {
  try {
    stripTypeScriptTypes(await readFile(file, "utf8"), { mode: "strip" });
  } catch (error) {
    failed = true;
    console.error(`TypeScript syntax check failed: ${relative(rootPath, file)}`);
    console.error(error);
  }
}

if (failed) process.exitCode = 1;
else console.log(`Checked ${files.length} TypeScript files`);
