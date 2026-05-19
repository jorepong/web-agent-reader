// OpenAI SDK의 얇은 래퍼. 두 가지 책임만 추가:
//   1. 모든 LLM 호출을 디버그 로거에 자동 기록 (callId로 요청-응답 쌍 매칭)
//   2. 토큰 사용량 추출 및 반환
// 멀티턴 대화 상태는 여기서 관리하지 않음 — 호출부가 messages 배열을 직접 관리.
import OpenAI from "openai";
import type { DebugLogger } from "./logger.js";
import type { LLMMessage, TokenUsage } from "./types.js";

export class OpenAIClient {
  private client: OpenAI;
  private model: string;
  private logger: DebugLogger;

  constructor(model: string, logger: DebugLogger) {
    this.client = new OpenAI();
    this.model = model;
    this.logger = logger;
  }

  // jsonResponse=true: 모델에 JSON 객체 응답을 강제. 호출부의 프롬프트에 "JSON"이 포함돼 있어야 함.
  // 기본 false — 검색 쿼리 생성처럼 plain text를 반환하는 호출과 호환 유지.
  async complete(
    agentId: string,
    messages: LLMMessage[],
    options: { jsonResponse?: boolean } = {}
  ): Promise<{ text: string; tokenUsage: TokenUsage }> {
    // callId: 같은 에이전트가 여러 번 LLM을 호출할 때 로그에서 요청-응답 쌍을 구분하기 위한 식별자
    const callId = crypto.randomUUID();

    await this.logger.log("llm_request", agentId, { callId, messages });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      // 일부 최신 추론 모델은 temperature를 기본값(1)으로만 허용하므로 명시 전달하지 않음
      reasoning_effort: "high",
      ...(options.jsonResponse ? { response_format: { type: "json_object" as const } } : {}),
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
