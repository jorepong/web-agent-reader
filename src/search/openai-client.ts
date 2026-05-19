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
    const callId = crypto.randomUUID();

    await this.logger.log("llm_request", agentId, { callId, messages });

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0,
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
