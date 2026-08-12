export class OpenAiClient {
  constructor(config) {
    this.config = config;
  }

  async chat(systemPrompt, history, userContent) {
    if (!this.config.apiKey) throw new Error("OPENAI_API_KEY or config.llm.apiKey is required");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: this.config.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: userContent },
          ],
        }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 500)}`);
      const data = JSON.parse(body);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("LLM response did not contain assistant text");
      }
      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
}
