// OpenAI SDK의 얇은 래퍼. 두 가지 책임만 추가:
//   1. 모든 LLM 호출을 디버그 로거에 자동 기록 (callId로 요청-응답 쌍 매칭)
//   2. 토큰 사용량 추출 및 반환
// 멀티턴 대화 상태는 여기서 관리하지 않음 — 호출부가 messages 배열을 직접 관리.
import OpenAI from "openai";
import type { DebugLogger } from "./logger.js";
import type { LLMMessage, TokenUsage } from "./types.js";

type ReasoningEffort = "low" | "medium" | "high";

export class OpenAIClient {
  private client: OpenAI;
  private model: string;
  private logger: DebugLogger;

  constructor(model: string, logger: DebugLogger) {
    this.client = new OpenAI();
    this.model = model;
    this.logger = logger;
  }

  // responseSchema: OpenAI Structured Outputs로 응답 형식 강제 (json_schema strict 모드).
  //   - 응답이 스키마를 만족하지 못하면 API가 거부 → 파싱 실패 거의 0
  //   - 호출부는 응답 텍스트를 그냥 JSON.parse 해도 안전 (스키마 검증 완료)
  // 미제공 시: plain text 응답 (예: 최종 답변 합성).
  async complete(
    agentId: string,
    messages: LLMMessage[],
    options: { responseSchema?: { name: string; schema: unknown }; reasoningEffort?: ReasoningEffort } = {}
  ): Promise<{ text: string; tokenUsage: TokenUsage }> {
    // callId: 같은 에이전트가 여러 번 LLM을 호출할 때 로그에서 요청-응답 쌍을 구분하기 위한 식별자
    const callId = crypto.randomUUID();

    const requestMessages = messages.map((message) => ({ ...message }));
    await this.logger.log("llm_request", agentId, {
      callId,
      messages: requestMessages,
      responseSchemaName: options.responseSchema?.name ?? null,
      structuredOutputs: Boolean(options.responseSchema),
      reasoningEffort: options.reasoningEffort ?? "high",
    });

    const responseFormat = options.responseSchema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: options.responseSchema.name,
              schema: options.responseSchema.schema as Record<string, unknown>,
              strict: true,
            },
          },
        }
      : {};

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      // 일부 최신 추론 모델은 temperature를 기본값(1)으로만 허용하므로 명시 전달하지 않음
      reasoning_effort: options.reasoningEffort ?? "high",
      ...responseFormat,
    });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error(`LLM returned empty content (finish_reason: ${response.choices[0]?.finish_reason})`);

    const tokenUsage: TokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    await this.logger.log("llm_response", agentId, { callId, response: text, tokenUsage });

    return { text, tokenUsage };
  }
}
