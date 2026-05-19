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

  async complete(agentId: string, messages: LLMMessage[]): Promise<{ text: string; tokenUsage: TokenUsage }> {
    // callId: 같은 에이전트가 여러 번 LLM을 호출할 때 로그에서 요청-응답 쌍을 구분하기 위한 식별자
    const callId = crypto.randomUUID();

    await this.logger.log("llm_request", agentId, { callId, messages });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0, // 에이전트 판단의 일관성·재현성 확보
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
