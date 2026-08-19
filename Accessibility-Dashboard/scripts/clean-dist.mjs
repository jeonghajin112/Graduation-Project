import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(projectRoot, "dist");

if (dirname(distDirectory) !== projectRoot) {
  throw new Error(`Refusing to clean an unexpected build directory: ${distDirectory}`);
}

function removeEntry(entryPath) {
  const stats = lstatSync(entryPath);

  if (stats.isSymbolicLink()) {
    unlinkSync(entryPath);
    return;
  }

  if (stats.isDirectory()) {
    for (const childName of readdirSync(entryPath)) {
      removeEntry(join(entryPath, childName));
    }
    rmdirSync(entryPath);
    return;
  }

  unlinkSync(entryPath);
}

if (existsSync(distDirectory)) {
  for (const childName of readdirSync(distDirectory)) {
    if (childName !== ".git") {
      removeEntry(join(distDirectory, childName));
    }
  }

  if (readdirSync(distDirectory).length === 0) {
    rmdirSync(distDirectory);
  }
}
