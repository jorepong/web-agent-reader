import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConvertResult, ElementRegistry, LinkRegistry } from "./types.js";

export async function writeResult(result: ConvertResult, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outDir, "page.md"), result.markdown, "utf8"),
    writeFile(path.join(outDir, "page.json"), `${JSON.stringify(result.page, null, 2)}\n`, "utf8"),
    writeFile(path.join(outDir, "links.json"), `${JSON.stringify(result.links, null, 2)}\n`, "utf8"),
    writeFile(path.join(outDir, "elements.json"), `${JSON.stringify(result.elements, null, 2)}\n`, "utf8"),
  ]);
}

export async function readLinkRegistry(stateDir: string): Promise<LinkRegistry> {
  const raw = await readFile(path.join(stateDir, "links.json"), "utf8");
  return JSON.parse(raw) as LinkRegistry;
}

export async function readElementRegistry(stateDir: string): Promise<ElementRegistry> {
  const raw = await readFile(path.join(stateDir, "elements.json"), "utf8");
  return JSON.parse(raw) as ElementRegistry;
}
