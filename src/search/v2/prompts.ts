// Researcher v2 프롬프트와 응답 스키마.
// v1의 검증된 가드(grounding, list/history, partial 후속, done.reason 그라운딩 등)를 적응해 가져왔다.
// v1 prompts.ts를 import하지 않는 이유: v2가 독립적으로 진화할 수 있어야 함.
//
// 통합 변화점:
//   - 단일 에이전트(리서처)가 root와 child 모두를 표현
//   - 출력은 자연어 (자식이든 root든) — JSON 구조화 응답 아님
//   - search/paginate/delegate/delegate_parallel/done 행동을 호출 상태별로 허용
//   - 자식에 보내는 호출과 root 호출 모두 같은 인터페이스
import type { LLMMessage } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schemas (OpenAI Structured Outputs / json_schema strict 모드)
//
// 루트 스키마는 type:"object"여야 하며 anyOf 루트는 거부됨.
// 따라서 5종 행동을 { decision: <anyOf 5종> } 형태로 감싼다 (v1과 동일 패턴).
// ─────────────────────────────────────────────────────────────────────────────

const actionSearch = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search"] },
    engine: { type: "string", enum: ["google", "naver", "bing"] },
    query: { type: "string", description: "간결한 검색 쿼리" },
    rationale: { type: "string", description: "이 검색 엔진과 쿼리를 선택한 이유" },
  },
  required: ["action", "engine", "query", "rationale"],
  additionalProperties: false,
} as const;

const actionPaginate = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["paginate"] },
    page: { type: "integer", minimum: 1, description: "이동할 검색 결과 페이지 번호. 1부터 시작" },
    rationale: { type: "string" },
  },
  required: ["action", "page", "rationale"],
  additionalProperties: false,
} as const;

const actionReadSections = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["read_sections"] },
    sectionIds: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
      description: "현재 페이지 섹션 목록에 있는 섹션 ID. 예: S12",
    },
    rationale: { type: "string", description: "답변 전에 이 추가 섹션들이 필요한 이유" },
  },
  required: ["action", "sectionIds", "rationale"],
  additionalProperties: false,
} as const;

const nullSelector = { type: "null", enum: [null] } as const;

function targetIdProperty(candidateIds: string[]) {
  return {
    type: "string",
    enum: candidateIds,
    description:
      candidateIds.length > 0
        ? `현재 표면에 표시된 후보 ID 하나를 대괄호 없이 정확히 사용하세요. 예: [C12]가 아니라 C12.`
        : "현재 사용할 수 있는 후보 ID가 없습니다.",
  } as const;
}

const linkIdProperty = {
  type: "string",
  description: "폐기 예정 필드입니다. targetId를 사용하세요. 이전 형식의 [L*] 링크를 명시적으로 사용해야 할 때만 씁니다.",
} as const;

const startUrlProperty = {
  type: "string",
  description: "현재 후보 ID로 표현할 수 없는, 이전 보고에 나온 명시적 시작 URL",
} as const;

function delegateSelectorVariants(candidateIds: string[], includeAction: boolean) {
  const baseProperties = includeAction
    ? { action: { type: "string", enum: ["delegate"] }, task: { type: "string", description: "하위 리서처에게 전달할 자연어 하위 목표" } }
    : { task: { type: "string" } };
  const required = includeAction
    ? ["action", "task", "targetId", "linkId", "startUrl", "rationale"]
    : ["task", "targetId", "linkId", "startUrl", "rationale"];
  const variants: object[] = [
    {
      type: "object",
      properties: {
        ...baseProperties,
        targetId: nullSelector,
        linkId: nullSelector,
        startUrl: startUrlProperty,
        rationale: { type: "string" },
      },
      required,
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...baseProperties,
        targetId: nullSelector,
        linkId: nullSelector,
        startUrl: nullSelector,
        rationale: { type: "string", description: "작업만 위임하는 이유" },
      },
      required,
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...baseProperties,
        targetId: nullSelector,
        linkId: linkIdProperty,
        startUrl: nullSelector,
        rationale: { type: "string" },
      },
      required,
      additionalProperties: false,
    },
  ];

  if (candidateIds.length > 0) {
    variants.unshift({
      type: "object",
      properties: {
        ...baseProperties,
        targetId: targetIdProperty(candidateIds),
        linkId: nullSelector,
        startUrl: nullSelector,
        rationale: { type: "string" },
      },
      required,
      additionalProperties: false,
    });
  }

  return variants;
}

function buildActionDelegate(candidateIds: string[] = []) {
  return { anyOf: delegateSelectorVariants(candidateIds, true) } as const;
}

function buildActionDelegateParallel(maxParallel: number, candidateIds: string[] = []) {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["delegate_parallel"] },
      branches: {
        type: "array",
        minItems: 2,
        maxItems: maxParallel,
        items: { anyOf: delegateSelectorVariants(candidateIds, false) },
      },
      rationale: { type: "string", description: "이 분기들이 서로 독립적인 이유" },
    },
    required: ["action", "branches", "rationale"],
    additionalProperties: false,
  } as const;
}

function delegateActions(maxParallel: number, candidateIds: string[] = []) {
  const single = buildActionDelegate(candidateIds);
  return maxParallel >= 2 ? [single, buildActionDelegateParallel(maxParallel, candidateIds)] : [single];
}

// done의 answer는 자연어 답변 (외부/부모 모두에게 동일한 형태).
// 템플릿 강제(ANSWER/SOURCES/COVERAGE/GAPS)는 프롬프트로 안내하고 스키마에서는 string만 강제.
const actionDone = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["done"] },
    answer: {
      type: "string",
      description:
        "템플릿 형식(ANSWER / SOURCES / COVERAGE / GAPS 섹션)을 따르는 최종 자연어 답변.",
    },
  },
  required: ["action", "answer"],
  additionalProperties: false,
} as const;

export function buildSectionSelectionSchema() {
  return {
    name: "researcher_page_section_selection",
    strict: true,
    schema: {
      type: "object",
      properties: {
        selection: {
          type: "object",
          properties: {
            readWholePage: {
              type: "boolean",
              description: "이 목표를 위해 전체 페이지가 필요할 때만 true로 설정하세요.",
            },
            sectionIds: {
              type: "array",
              minItems: 0,
              maxItems: 8,
              items: { type: "string" },
              description: "읽을 섹션 ID. 예: S3. 필요하면 여러 ID를 사용하세요.",
            },
            rationale: { type: "string" },
          },
          required: ["readWholePage", "sectionIds", "rationale"],
          additionalProperties: false,
        },
      },
      required: ["selection"],
      additionalProperties: false,
    },
  } as const;
}

// 루트는 직접 검색/페이지 열람을 하지 않는다. 자연어 작업을 하위 리서처에게 위임하거나,
// 이미 충분한 보고가 쌓였을 때만 done 한다.
export function buildRootSchema(maxParallel: number, candidateIds: string[] = []) {
  return {
    name: "researcher_action_root",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [...delegateActions(maxParallel, candidateIds), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

export function buildRootInitialDelegateSchema(maxParallel: number, candidateIds: string[] = []) {
  return {
    name: "researcher_action_root_initial_delegate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: delegateActions(maxParallel, candidateIds) },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 페이지 없는 서브 리서처의 첫 행동 — 자기 조사 맥락을 만들기 위해 search부터 시작.
export function buildSubInitialSchema() {
  return {
    name: "researcher_action_sub_initial",
    strict: true,
    schema: {
      type: "object",
      properties: { decision: actionSearch },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 일반 — 검색/페이지네이션/위임/완료 가능.
export function buildFullActionSchema(maxParallel: number, candidateIds: string[] = [], canReadSections = false) {
  const localActions = canReadSections ? [actionReadSections] : [];
  return {
    name: "researcher_action",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: {
          anyOf: [actionSearch, actionPaginate, ...localActions, ...delegateActions(maxParallel, candidateIds), actionDone],
        },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 페이지네이션 불가 — 현재 표면이 SERP가 아닐 때 사용.
export function buildNoPaginateSchema(maxParallel: number, candidateIds: string[] = [], canReadSections = false) {
  const localActions = canReadSections ? [actionReadSections] : [];
  return {
    name: "researcher_action_no_paginate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [actionSearch, ...localActions, ...delegateActions(maxParallel, candidateIds), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 위임 불가 (깊이 한도 또는 budget 소진) — delegate/delegate_parallel 제외.
export function buildNoDelegateSchema(canPaginate: boolean, canReadSections = false) {
  const localActions = canReadSections ? [actionReadSections] : [];
  return {
    name: "researcher_action_no_delegate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: canPaginate ? [actionSearch, actionPaginate, ...localActions, actionDone] : [actionSearch, ...localActions, actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 검색도 불가 — 현재 표면에서 위임과 완료만.
export function buildNoSearchSchema(maxParallel: number, candidateIds: string[] = [], canReadSections = false) {
  const localActions = canReadSections ? [actionReadSections] : [];
  return {
    name: "researcher_action_no_search",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [...localActions, ...delegateActions(maxParallel, candidateIds), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 시작 페이지를 받은 서브 리서처의 첫 행동 — 페이지를 분석하고 done 또는 하위 위임만 가능.
// 첫 라운드 search는 스키마로 차단한다.
export function buildStartPageFirstSchema(maxParallel: number, candidateIds: string[] = [], canReadSections = false) {
  const localActions = canReadSections ? [actionReadSections] : [];
  return {
    name: "researcher_action_start_page_first",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [...localActions, ...delegateActions(maxParallel, candidateIds), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

export function buildReadSectionsOrDoneSchema() {
  return {
    name: "researcher_action_read_sections_only",
    strict: true,
    schema: {
      type: "object",
      properties: { decision: { anyOf: [actionReadSections, actionDone] } },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 모든 행동 불가 — done만 강제.
export function buildDoneOnlySchema() {
  return {
    name: "researcher_action_done_only",
    strict: true,
    schema: {
      type: "object",
      properties: { decision: actionDone },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// 프롬프트
// ─────────────────────────────────────────────────────────────────────────────

// 자연어 답변 템플릿 — 모든 리서처의 출력 형태.
// 부모 리서처의 LLM과 외부 호출자가 동일한 형식으로 파싱 가능.
const ANSWER_TEMPLATE = `최종 \`done.answer\`는 반드시 아래 템플릿을 그대로 따라야 합니다. 섹션 순서도 유지하세요.

ANSWER:
<목표에 직접 답하는 간결한 자연어 답변. 출처는 문장 안에 "(source: https://...)" 형식으로 인용하세요.>

SOURCES:
- <url 1>
- <url 2>
(검색 결과 스니펫만 사용했고 페이지를 검증하지 않았다면 "SERP only — pages not verified"만 적고 URL은 생략하세요.)

COVERAGE: <complete | partial | none>

GAPS:
- <부족한 정보 1>
- <부족한 정보 2>

NEXT_CANDIDATES:
- <url 또는 짧은 후보 설명> — <도움이 될 수 있는 이유>
(후속 후보가 없으면 한 줄로 "(none)"만 쓰세요.)`;

// 모든 리서처가 공유하는 시스템 프롬프트의 본문 (정책 가드).
// 특정 질문 유형보다 답변 계약, 오류 모드, 증거 수준을 기준으로 행동을 고른다.
const POLICY_GUARDS = `판단 정책 — 특정 키워드가 아니라 답변 품질과 증거 수준을 기준으로 행동하세요.

답변 계약을 먼저 정하세요:
- 사용자가 요구하는 답의 형태를 파악하세요. 단일 사실인지, 여러 항목의 수집인지, 비교/순위인지, 시간 범위가 있는지, 최신성이 중요한지, 포함/제외 기준이 애매한지 판단하세요.
- 답변이 틀릴 수 있는 주요 방식을 식별하세요. 누락, 오분류, 오래된 정보, 동명이인/명칭 변경, 단위/날짜 오류, 출처의 요약 왜곡, 서로 다른 출처 간 충돌 등이 있을 수 있습니다.
- 현재 증거가 답변의 주장 수준을 감당하는지 평가하세요. 강한 단정, 포괄적 목록, 정확한 날짜/수치, 역할/소속 판단은 그에 맞는 원문 근거가 필요합니다.

조사 행동 원칙:
- 검색 결과는 후보 발견과 방향 설정에 유용하지만, 그 자체만으로 강한 결론을 확정하지 마세요. 중요한 주장은 가능하면 질문의 답변 계약에 잘 맞는 원문 페이지나 전문 출처의 본문 읽기로 뒷받침하세요.
- 출처의 가치는 도메인의 공식성만으로 판단하지 마세요. 사용자가 요구하는 답의 종류에 맞는 정보를 실제로 제공하는지가 더 중요합니다. 예를 들어 과거 로스터, 이적, 경기 기록, 버전 변화처럼 축적 데이터가 필요한 질문에서는 현재 홈페이지보다 전문 DB, 기록 페이지, 아카이브가 더 적합할 수 있습니다.
- 현재 불확실성을 가장 많이 줄이는 행동을 선택하세요. 후보 원문을 읽어야 하면 delegate, 같은 긴 페이지의 다른 부분이 필요하면 read_sections, 후보군 자체가 빈약하면 search, 같은 질의의 결과군을 더 훑는 것이 유의미하면 paginate를 선택하세요.
- 하위 보고의 GAPS는 그대로 수행할 체크리스트가 아닙니다. 그 gap이 최종 답변을 바꾸거나 중요한 한계를 줄일 가능성이 있을 때 후속 행동으로 다루세요.
- 같은 정보가 반복될 가능성이 큰 출처를 여러 번 읽지 마세요. 서로 다른 관점, 원천, 기간, 정의, 데이터 출처를 확인할 때 병렬 위임의 가치가 큽니다.

검색 엔진과 쿼리 전략(search를 선택할 때):
- "google": 넓은 영어권/글로벌 웹. 대부분의 주제에서 기본값입니다.
- "naver": 한국 웹. 법률, 규정, 국내 언론, 한국어 출처에 적합합니다.
- "bing": 보조 범용 웹. google 결과가 반복되거나 포화된 듯할 때 유용합니다.
- 같은 목적의 검색이 성과를 내지 못하면 페이지네이션보다 검색어 재작성을 먼저 고려하세요. 핵심어를 바꾸고, 연도/관할/전문 용어 같은 한정어를 추가하거나, 한국어와 영어를 전환하세요.
- 동일한 (engine, query, page) 조합을 반복하지 마세요.

delegate와 delegate_parallel:
- 후보가 깊은 읽기, 독립 검증, 별도 출처군 조사를 필요로 할 때 위임하세요.
- 검색어 재작성, SERP 페이지네이션, 후보 선별은 자신의 컨텍스트에서 처리하세요.
- 2-__MAX_PARALLEL__개의 분기가 서로 다른 불확실성이나 독립 출처를 다룰 때 delegate_parallel을 사용하세요.
- 같은 1차 출처의 중복이나 표현만 다른 후보를 병렬로 보내지 마세요.

done 판단:
- 현재까지 확보한 증거가 답변 계약을 충족하고, 남은 불확실성이 결론을 실질적으로 바꿀 가능성이 낮다면 done을 선택하세요.
- 충분한 증거가 없지만 더 조사해도 핵심 결론을 개선하기 어렵다고 판단되면, COVERAGE를 partial 또는 none으로 두고 한계를 분명히 밝힌 채 done을 선택하세요.
- 학습 데이터나 일반 상식으로 빈칸을 채우기 위해 done을 선택하지 마세요. 이 루프에서 관찰한 증거만 사용하세요.

답변 근거 규칙:
- 답변은 이 대화에 등장한 정보(검색 스니펫, 하위 보고, 직접 읽은 페이지 내용)에만 근거해야 합니다. 사전 지식으로 보충하지 마세요.
- 확인된 사실, 불확실한 후보, 제외/미확인 항목을 구분하세요. 특히 포함 기준이 애매하거나 출처마다 다르게 표현되는 경우 이 구분이 답변 품질의 핵심입니다.
- 방문한 페이지에 세부 정보(정확한 날짜, 전체 범위, 역할, 수치 등)가 없다면 추론하지 말고 GAPS에 부족하다고 적으세요.
- 인용하는 출처 URL은 위 행동 결과에 실제로 등장한 URL이어야 합니다.`;

function policyGuards(maxParallel: number): string {
  return POLICY_GUARDS.replace("__MAX_PARALLEL__", String(maxParallel));
}

function runtimeContextBlock(currentDateTime?: string): string {
  return currentDateTime
    ? `\n\n런타임 컨텍스트:\n- 현재 날짜와 시각: ${currentDateTime}`
    : "";
}

// 리서처 시스템 프롬프트 — root와 child 통합.
// startUrl 유무에 따라 첫 user 메시지가 달라질 뿐, 시스템 프롬프트는 동일.
export function buildResearcherSystemPrompt(maxParallel: number): string {
  return `당신은 리서처입니다. 자연어로 입력을 받고 자연어로 답하는 재귀형 조사 에이전트입니다.

당신은 자연어 목표를 받고 자연어 답변을 생성합니다. 필요하면 자신과 같은 하위 리서처를 병렬 또는 직렬로 호출해 특정 URL이나 하위 목표를 조사하게 할 수 있습니다. 하위 리서처의 인터페이스도 당신과 같습니다. 자연어 작업과 선택적 시작 URL을 주면, 하위 리서처는 당신이 따라야 하는 것과 같은 템플릿의 자연어 답변을 반환합니다.

당신은 에이전틱 루프로 동작합니다. 각 라운드마다 정확히 하나의 행동을 선택하세요. 시스템은 그 행동을 실행하고 결과를 이 대화에 추가합니다. 목표에 답할 충분한 정보가 모이거나, 추가 검색이 분명히 비생산적일 때까지 계속하세요.

사용 가능한 행동(라운드별 제약을 받으며, 스키마는 현재 가능한 행동만 허용합니다):

1. search — 새 검색 엔진 결과 페이지(SERP)를 가져옵니다. 하위 리서처에서만 사용할 수 있고 루트는 사용할 수 없습니다.
2. paginate — 현재 SERP의 다른 페이지로 이동합니다.
3. read_sections — 현재 페이지에서 이미 읽은 섹션이 충분하지 않을 때 같은 페이지의 추가 섹션을 읽습니다.
4. delegate — 자연어 작업으로 하위 리서처를 호출합니다. 현재 표면의 targetId나 이전 보고에 나온 명시적 startUrl을 선택적으로 제공할 수 있습니다.
5. delegate_parallel — 서로 독립적인 작업에 대해 2-${maxParallel}개의 하위 리서처를 병렬 호출합니다.
6. done — 최종 자연어 답변으로 종료합니다.

${policyGuards(maxParallel)}

${ANSWER_TEMPLATE}

중요:
- delegate/delegate_parallel의 targetId는 위에 표시된 최신 SERP 또는 페이지 결과의 후보 ID여야 합니다. 예: [C12]처럼 보인다면 값은 C12입니다. ID를 만들지 말고, 이전 SERP의 오래된 후보 ID를 사용하지 마세요.
- linkId는 폐기 예정입니다. 현재 메시지에 이전 형식의 [L*] ID가 명시적으로 보이지 않으면 null로 두세요.
- read_sections는 섹션 목록이 표시된 현재 페이지에만 사용합니다. S12처럼 표시된 섹션 ID를 정확히 사용하세요.
- delegate/delegate_parallel의 startUrl은 이전 하위 보고에 나온 명시적 URL일 수 있습니다. 하위 리서처가 직접 출처를 찾아야 하면 null을 사용하세요.
- delegate/delegate_parallel의 task는 하위 리서처에게 전달되는 자연어 입력입니다. 원래 사용자 목표를 기준으로 자기완결적인 작업이어야 합니다.
- done을 반환하면 이 분기는 잠깁니다. 다시 방문하거나 확장하거나 수정할 수 없습니다. 먼저 검증 게이트를 만족했는지 확인하세요.`;
}

// 루트 전용 초기 메시지. 루트는 직접 검색/페이지 열람을 하지 않고, 하위 리서처의 자연어
// 보고만 보고 최종 판단을 내린다.
export function buildRootCoordinatorMessages(goal: string, maxParallel: number, currentDateTime?: string): LLMMessage[] {
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `목표: ${goal}
${runtimeContextBlock(currentDateTime)}

당신은 루트 리서처입니다. 직접 검색하거나 페이지를 열거나 읽지 않습니다. 자연어 조사 작업을 하위 리서처에게 위임하고, 그 보고들을 비교한 뒤 충분하다고 판단되면 최종 답변을 반환하세요.

첫 행동은 보통 delegate 또는 delegate_parallel이어야 합니다. 이미 제공된 하위 보고만으로 요청에 답할 수 있을 때만 done을 사용하세요.`,
    },
  ];
}

// 페이지 없는 서브 리서처의 초기 메시지. 이 호출은 루트가 자연어 작업만 넘긴 경우다.
export function buildSubResearcherInitialMessages(goal: string, parentGoal: string, maxParallel: number, currentDateTime?: string): LLMMessage[] {
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `목표: ${goal}
원래 사용자 질문: ${parentGoal}
${runtimeContextBlock(currentDateTime)}

당신은 시작 URL이 없는 하위 리서처입니다. 직접 조사 컨텍스트를 만드세요. 검색하고, 검색어를 재작성하고, 필요하면 SERP를 페이지네이션하고, 후보를 선별하세요. 어떤 페이지를 깊게 읽을지 고를 때는 출처 원칙을 참고해, 목표의 답변 계약에 가장 잘 맞는 페이지를 선택하세요. 긴 페이지 본문을 자신의 컨텍스트로 직접 끌어오기보다, 특정 후보 페이지의 깊은 읽기는 하위 리서처에게 위임하세요.`,
    },
  ];
}

// startUrl이 주어진 child researcher의 초기 user 메시지.
// 페이지 본문은 첫 user 메시지에 포함되어 LLM이 즉시 분석 가능.
//
// 중요: 시작 페이지가 주어진 자식은 *반드시 그 페이지를 먼저 분석*해야 한다.
// 부모는 이 페이지가 goal을 해결할 수 있다고 판단해서 자식을 디스패치했다.
// 첫 행동으로 search를 선택하는 것은 부모의 판단을 무시하고 새 탐색을 시작하는
// 것이므로 비효율적. 따라서 첫 행동을 done/delegate로 제한한다.
export function buildChildInitialMessages(
  goal: string,
  parentGoal: string,
  startUrl: string,
  pageMarkdown: string,
  maxParallel: number,
  candidateStatus: string,
  sectionOutline?: string,
  currentDateTime?: string
): LLMMessage[] {
  const statusBlock = candidateStatus
    ? `\n\n표시된 [C*] 링크의 후보 상태:\n${candidateStatus}\n"이미 방문함"으로 표시된 후보는 위임하지 마세요. 방문하지 않은 후보를 고르거나, 허용된다면 나중에 검색하거나, done을 선택하세요.`
    : "";
  const sectionBlock = sectionOutline
    ? `\n\n현재 페이지 섹션 목록:\n${sectionOutline}\n제공된 페이지 내용이 부족하다면 검색하거나 다른 곳으로 위임하기 전에, 이 목록의 추가 섹션 ID로 read_sections를 선택하세요.`
    : "";
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `목표: ${goal}
원래 사용자 질문: ${parentGoal}
시작 URL: ${startUrl}
${runtimeContextBlock(currentDateTime)}

당신은 하위 리서처입니다. 시작 URL은 이미 방문되었고, 그 내용은 아래에 제공됩니다.
아래 페이지를 이 분기의 검증된 페이지 읽기로 취급하세요. 이 페이지의 사실을 사용한다면 SOURCES와 문장 내 출처 인용에 시작 URL을 포함하세요.

첫 행동은 반드시 이 페이지를 분석하는 것이어야 합니다.
- 이 페이지가 목표에 답할 충분한 정보를 직접 포함한다면 즉시 done을 선택하고 답변을 작성하세요.
- 이 페이지가 직접 답을 포함하지 않지만 관련 링크 페이지를 포함한다면(본문의 [C*] 후보 ID를 보세요), delegate 또는 delegate_parallel로 해당 페이지를 하위 리서처에게 보내세요.
- 이 페이지가 목표에 직접 답하지 못하고, 보이는 링크들도 같은 성격의 빈 페이지/일반 탐색 페이지/현재 정보 페이지만 반복한다면 내부 탐색을 오래 끌지 마세요. COVERAGE를 none 또는 partial로 두고, 왜 이 시작 URL이 부족한지와 부모가 시도할 더 적합한 출처 유형을 GAPS 또는 NEXT_CANDIDATES에 적어 done하세요.
- 첫 행동으로 search를 선택하지 마세요. 부모 리서처는 이 페이지와 여기서 연결되는 페이지가 적절한 시작점이라고 판단해 당신을 이곳에 보냈습니다. 이 페이지와 링크들이 답으로 이어질 수 없다고 확인한 뒤에만 search를 고려하세요.

페이지 내용:
${pageMarkdown}${sectionBlock}${statusBlock}`,
    },
  ];
}

export function buildSectionSelectionMessages(
  goal: string,
  parentGoal: string,
  startUrl: string,
  outline: string,
  totalChars: number,
  maxParallel: number,
  currentDateTime?: string
): LLMMessage[] {
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `목표: ${goal}
원래 사용자 질문: ${parentGoal}
시작 URL: ${startUrl}
${runtimeContextBlock(currentDateTime)}

시작 페이지가 큽니다(${totalChars}자). 먼저 읽을 섹션을 선택하세요. 이 섹션 선택 단계는 같은 페이지 읽기 작업의 일부입니다.

목표에 답할 가능성이 높은 최소 섹션 집합을 선택하세요. 여러 섹션을 선택할 수 있습니다. 목록에 구체적인 하위 섹션이 보이면 큰 상위 섹션보다 하위 섹션을 우선하세요. 목표가 정말 전체 페이지를 필요로 하거나 섹션 지정이 위험할 때만 readWholePage=true를 선택하세요.

링크, 메뉴, 페이지네이션, 사이트 탐색을 찾아야 하는 작업일 때만 navigation/header/footer 섹션을 포함하세요.

섹션 목록:
${outline}`,
    },
  ];
}

// search/paginate 결과를 messages에 append.
export function buildSerpResultMessage(
  engine: string,
  query: string,
  page: number,
  serpSnippets: string,
  budgetSummary: string,
  candidateStatus: string
): LLMMessage {
  const body = serpSnippets.trim() || "(이 페이지에서 사용할 만한 결과를 찾지 못했습니다)";
  const statusBlock = candidateStatus
    ? `\n\n표시된 [C*] 링크의 후보 상태:\n${candidateStatus}\n"이미 방문함"으로 표시된 후보는 위임하지 마세요. 방문하지 않은 후보를 선택하거나, 검색어를 재작성하거나, 유용하면 페이지네이션하거나, done을 선택하세요.`
    : "";
  return {
    role: "user",
    content: `[SERP — engine=${engine}, query="${query}", page=${page}]
${body}${statusBlock}

(${budgetSummary})

다음 행동을 선택하세요.`,
  };
}

export function buildPageSectionReadResultMessage(
  startUrl: string,
  selectedIds: string[],
  sectionMarkdown: string,
  sectionOutline: string,
  budgetSummary: string,
  candidateStatus: string
): LLMMessage {
  const statusBlock = candidateStatus
    ? `\n\n표시된 [C*] 링크의 후보 상태:\n${candidateStatus}\n"이미 방문함"으로 표시된 후보는 위임하지 마세요. 방문하지 않은 후보를 선택하거나, 필요하면 섹션을 더 읽거나, 허용된다면 나중에 검색하거나, done을 선택하세요.`
    : "";
  return {
    role: "user",
    content: `[추가 페이지 섹션 — ${startUrl}]
선택됨: ${selectedIds.length ? selectedIds.join(", ") : "(fallback)"}

${sectionMarkdown}

현재 페이지 섹션 목록:
${sectionOutline}${statusBlock}

(${budgetSummary})

다음 행동을 선택하세요.`,
  };
}

// 단일 delegate 자식 답변을 messages에 append.
// 자식 답변은 이미 ANSWER/SOURCES/COVERAGE/GAPS 템플릿 형식의 자연어이므로 그대로 첨부.
export function buildDelegateResultMessage(childLabel: string, childAnswer: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[하위 리서처 결과 — ${childLabel}]
${childAnswer}

(${budgetSummary})

하위 보고의 GAPS가 최종 답변을 바꾸거나 중요한 한계를 줄일 가능성이 있는지 판단하세요. 그렇다면 목표가 분명한 후속 행동을 선택하고, 그렇지 않다면 확인된 사실과 남은 불확실성을 구분해 done할 수 있습니다. 다음 행동을 선택하세요.`,
  };
}

// 병렬 delegate 자식들의 답변을 한꺼번에 messages에 append.
export function buildParallelDelegateResultMessage(
  children: Array<{ label: string; answer: string }>,
  budgetSummary: string
): LLMMessage {
  const body = children
    .map((c, i) => `[${i + 1}] ${c.label}\n${c.answer}`)
    .join("\n\n---\n\n");
  return {
    role: "user",
    content: `[병렬 하위 리서처 — ${children.length}개 분기]
${body}

(${budgetSummary})

각 하위 보고의 GAPS가 최종 답변을 바꾸거나 중요한 한계를 줄일 가능성이 있는지 판단하세요. 그렇다면 목표가 분명한 후속 행동을 선택하고, 그렇지 않다면 확인된 사실과 남은 불확실성을 구분해 done할 수 있습니다. 다음 행동을 선택하세요.`,
  };
}

// 거부 / 안내 메시지 (잘못된 입력 / 한도 소진 등).
export function buildResearcherErrorMessage(detail: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[행동을 실행할 수 없음] ${detail}

(${budgetSummary})

다른 행동을 선택하세요.`,
  };
}

// 한도 임박 경고. round나 budget이 얼마 남지 않았을 때 주입.
export function buildBudgetWarningMessage(detail: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[예산 알림] ${detail}

(${budgetSummary})

마무리를 우선하세요. 지금까지 확보한 정보로 목표에 답하거나, done 전에 마지막으로 목표가 분명한 행동 하나만 수행하세요.`,
  };
}

// 한도 도달로 더 이상 행동을 못 할 때, 강제로 done 합성을 유도하는 메시지.
// LLM에 done-only 스키마와 함께 보내, 누적된 messages 만으로 최선의 답변을 생성하게 한다.
export function buildForcedSynthesisMessage(reason: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[한도 도달 — 지금 합성하세요] ${reason}. 더 이상 search 또는 delegate 행동을 수행할 수 없습니다.

이 대화에 이미 등장한 정보(SERP 스니펫, 하위 보고, 직접 읽은 페이지 내용)만 사용해 최종 답변을 합성하세요. ANSWER / SOURCES / COVERAGE / GAPS 템플릿을 따르세요. 수집한 정보에 따라 COVERAGE를 정직하게 설정하고, 해결되지 않은 항목은 GAPS에 적으세요. 거절하지 마세요. 정보가 불완전하더라도 지금 가진 정보로 가능한 최선의 부분 답변을 반환하세요.

(${budgetSummary})`,
  };
}
