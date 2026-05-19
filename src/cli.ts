#!/usr/bin/env node
import { writeResult } from "./io.js";
import { convertPage, openLink, resolveLink } from "./index.js";
import { intOption, option, required } from "./cli-utils.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "convert") {
      const url = required(args[0], "Usage: llm-page convert <url> --out <dir>");
      const out = option(args, "--out") ?? "out";
      const pageId = option(args, "--page-id") ?? "P1";
      const result = await convertPage(url, cliConvertOptions(args, pageId));
      await writeResult(result, out);
      console.log(`pageId=${result.page.pageId}`);
      console.log(`links=${result.page.stats.linkCount}`);
      console.log(`out=${out}`);
      return;
    }

    if (command === "resolve") {
      const pageId = required(args[0], "Usage: llm-page resolve <page-id> <link-id> --state <dir>");
      const linkId = required(args[1], "Usage: llm-page resolve <page-id> <link-id> --state <dir>");
      const state = option(args, "--state") ?? ".";
      const link = await resolveLink(state, pageId, linkId);
      console.log(link.url);
      return;
    }

    if (command === "open") {
      const pageId = required(args[0], "Usage: llm-page open <page-id> <link-id> --state <dir> --out <dir>");
      const linkId = required(args[1], "Usage: llm-page open <page-id> <link-id> --state <dir> --out <dir>");
      const state = option(args, "--state") ?? ".";
      const out = option(args, "--out") ?? "out";
      const nextPageId = option(args, "--page-id") ?? "P1";
      const result = await openLink(state, pageId, linkId, cliConvertOptions(args, nextPageId));
      await writeResult(result, out);
      console.log(`pageId=${result.page.pageId}`);
      console.log(`links=${result.page.stats.linkCount}`);
      console.log(`out=${out}`);
      return;
    }

    printHelp();
    process.exitCode = command ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function cliConvertOptions(args: string[], pageId: string) {
  return {
    pageId,
    scroll: !args.includes("--no-scroll"),
    maxScrolls: intOption(args, "--max-scrolls"),
    scrollWaitMs: intOption(args, "--scroll-wait-ms"),
    stopAfterStableRounds: intOption(args, "--stable-rounds"),
    stealth: args.includes("--stealth"),
  };
}

function printHelp(): void {
  console.log(`llm-page

Commands:
  convert <url> --out <dir> [--page-id P1] [--no-scroll] [--max-scrolls 15] [--stealth]
  resolve <page-id> <link-id> --state <dir>
  open <page-id> <link-id> --state <dir> --out <dir> [--page-id P1] [--no-scroll] [--max-scrolls 15] [--stealth]
`);
}

await main();
