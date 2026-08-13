import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ToolExecutionError } from "./registry.js";

export async function safeGet(rawUrl, { timeoutMs = 10000, maxBytes = 512000, redirects = 3 } = {}) {
  const url = parsePublicUrl(rawUrl);
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new ToolExecutionError("unsafe_url", "拒绝访问本机或内网地址");
  }
  const selected = addresses[0];
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: { "user-agent": "LililoBot/0.1 (+web-fetch)" },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    }, async (response) => {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
        response.resume();
        if (redirects <= 0) return reject(new ToolExecutionError("too_many_redirects", "网页跳转次数过多"));
        try { resolve(await safeGet(new URL(location, url).href, { timeoutMs, maxBytes, redirects: redirects - 1 })); }
        catch (error) { reject(error); }
        return;
      }
      if ((response.statusCode ?? 500) >= 400) {
        response.resume();
        return reject(new ToolExecutionError("fetch_http_error", `网页返回 HTTP ${response.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          return reject(new ToolExecutionError("response_too_large", "网页内容超过读取上限"));
        }
        chunks.push(chunk);
      }
      resolve({
        url: url.href,
        contentType: String(response.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new ToolExecutionError("fetch_timeout", "网页读取超时")));
    request.on("error", reject);
  });
}

function parsePublicUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new ToolExecutionError("invalid_url", "网址格式无效"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ToolExecutionError("invalid_url", "只允许无账号信息的 HTTP(S) 网址");
  }
  if (url.port && !["80", "443"].includes(url.port)) throw new ToolExecutionError("unsafe_url", "不允许访问非标准端口");
  return url;
}

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe8")
    || normalized.startsWith("fe9") || normalized.startsWith("fea")
    || normalized.startsWith("feb") || normalized.startsWith("ff")
    || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}
