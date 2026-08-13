import os from "node:os";
import { safeGet } from "./network.js";
import { ToolExecutionError } from "./registry.js";

export function registerBuiltins(registry, config) {
  registry.register({
    name: "get_system_status",
    description: "读取莉莉洛所在主机的基础运行状态，不包含文件内容和秘密信息。",
    scopes: ["local", "qq-private-admin"],
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({
      platform: os.platform(),
      architecture: os.arch(),
      uptimeSeconds: Math.floor(os.uptime()),
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg().map((item) => Number(item.toFixed(2))),
      memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
      nodeVersion: process.version,
    }),
  });

  if (config.search?.enabled && config.search.baseUrl) registry.register(searchTool(config.search));
  if (config.fetch?.enabled) registry.register(fetchTool(config.fetch));
}

function searchTool(config) {
  return {
    name: "web_search",
    description: "搜索互联网，返回带网址的搜索结果。需要最新或外部信息时使用。",
    scopes: ["all"],
    parameters: {
      type: "object",
      properties: { query: { type: "string", maxLength: 300 } },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async ({ query }) => {
      const endpoint = new URL("/search", config.baseUrl);
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("language", config.language ?? "zh-CN");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(endpoint, { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new ToolExecutionError("search_http_error", `搜索服务返回 HTTP ${response.status}`);
        const data = await response.json();
        return (data.results ?? []).slice(0, config.maxResults).map((item) => ({
          title: String(item.title ?? "").slice(0, 300),
          url: String(item.url ?? "").slice(0, 2000),
          snippet: String(item.content ?? "").replace(/\s+/g, " ").slice(0, 800),
        }));
      } catch (error) {
        if (error?.name === "AbortError") throw new ToolExecutionError("search_timeout", "搜索超时");
        throw error;
      } finally { clearTimeout(timer); }
    },
  };
}

function fetchTool(config) {
  return {
    name: "web_fetch",
    description: "读取一个公开 HTTP(S) 网页的正文。不能访问本机、内网或非标准端口。",
    scopes: ["all"],
    parameters: {
      type: "object",
      properties: { url: { type: "string", maxLength: 2000 } },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async ({ url }) => {
      const page = await safeGet(url, config);
      const text = page.contentType.includes("html") ? htmlToText(page.body) : page.body;
      return { url: page.url, content: text.slice(0, config.maxTextChars) };
    },
  };
}

function htmlToText(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
}
