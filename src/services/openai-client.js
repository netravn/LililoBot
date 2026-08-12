export class OpenAiClient {
  constructor(config) {
    this.config = config;
  }

  async chat(systemPrompt, history, userContent) {
    if (!this.config.apiKey) {
      throw new ModelRequestError("model_not_configured", 503, "模型 API Key 尚未配置");
    }
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
      if (!response.ok) {
        const detail = providerMessage(body);
        if (response.status === 401 || response.status === 403) {
          throw new ModelRequestError("model_authentication_failed", 401, "API Key 无效或无权使用该模型", detail);
        }
        if (response.status === 429) {
          throw new ModelRequestError("model_rate_limited", 429, "模型服务暂时繁忙，请稍后再试", detail);
        }
        throw new ModelRequestError("model_upstream_failed", 502, `模型服务请求失败（HTTP ${response.status}）`, detail);
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new ModelRequestError("model_invalid_response", 502, "模型服务返回了无法解析的数据");
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new ModelRequestError("model_empty_response", 502, "模型没有返回可用文本");
      }
      return content.trim();
    } catch (error) {
      if (error instanceof ModelRequestError) throw error;
      if (error?.name === "AbortError") {
        throw new ModelRequestError("model_timeout", 504, "模型响应超时，请稍后再试");
      }
      throw new ModelRequestError("model_connection_failed", 502, "无法连接模型服务");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ModelRequestError extends Error {
  constructor(code, statusCode, message, detail = "") {
    super(message);
    this.name = "ModelRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function providerMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message ?? parsed?.message ?? "").slice(0, 300);
  } catch {
    return "";
  }
}
