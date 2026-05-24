#!/usr/bin/env node
// llm-search-v2 호환 CLI. 내부 실행은 통합 CLI 러너에 위임한다.
import { runSearchCli } from "../cli-runner.js";

await runSearchCli("v2");
