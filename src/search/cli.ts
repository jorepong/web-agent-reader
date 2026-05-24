#!/usr/bin/env node
// llm-search 통합 CLI.
// --v1/--v2 또는 실행 파일명(llm-search-v1/llm-search-v2)이 설정 파일보다 우선한다.
import { detectForcedVersionFromBin, runSearchCli } from "./cli-runner.js";

await runSearchCli(detectForcedVersionFromBin());
