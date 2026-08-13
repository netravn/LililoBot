export class ToolRegistry {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this.tools = new Map();
  }

  register(tool) {
    if (!tool?.name || typeof tool.execute !== "function") {
      throw new Error("tool requires a name and execute function");
    }
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  definitions(context) {
    return [...this.tools.values()]
      .filter((tool) => allowed(tool, context))
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
      }));
  }

  async execute(name, args, context) {
    const tool = this.tools.get(name);
    if (!tool || !allowed(tool, context)) throw new ToolExecutionError("tool_not_allowed", `当前会话无权使用 ${name}`);
    validateArguments(args, tool.parameters);
    const startedAt = Date.now();
    this.logger?.info("tool", `started name=${name} actor=${actor(context)}`);
    try {
      const result = await tool.execute(args, context);
      this.logger?.info("tool", `completed name=${name} duration_ms=${Date.now() - startedAt}`);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
      this.logger?.warn("tool", `failed name=${name} duration_ms=${Date.now() - startedAt}`, error);
      if (error instanceof ToolExecutionError) throw error;
      throw new ToolExecutionError("tool_failed", `${name} 执行失败`);
    }
  }
}

export class ToolExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

function actor(context = {}) {
  return [context.channel, context.kind, context.senderId].filter(Boolean).join(":") || "unknown";
}

function allowed(tool, context = {}) {
  const scopes = tool.scopes ?? ["local"];
  if (scopes.includes("all")) return true;
  if (scopes.includes("local") && ["web", "cli"].includes(context.channel)) return true;
  return scopes.includes("qq-private-admin")
    && context.channel === "qq"
    && context.kind === "private"
    && context.isAdmin === true;
}

function validateArguments(value, schema = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolExecutionError("invalid_arguments", "工具参数必须是对象");
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) throw new ToolExecutionError("invalid_arguments", `缺少参数 ${key}`);
  }
  for (const [key, item] of Object.entries(value)) {
    const rule = properties[key];
    if (!rule) throw new ToolExecutionError("invalid_arguments", `未知参数 ${key}`);
    if (rule.type === "string" && typeof item !== "string") throw new ToolExecutionError("invalid_arguments", `${key} 必须是字符串`);
    if (rule.type === "boolean" && typeof item !== "boolean") throw new ToolExecutionError("invalid_arguments", `${key} 必须是布尔值`);
    if (rule.type === "integer" && !Number.isInteger(item)) throw new ToolExecutionError("invalid_arguments", `${key} 必须是整数`);
    if (typeof item === "string" && rule.maxLength && item.length > rule.maxLength) {
      throw new ToolExecutionError("invalid_arguments", `${key} 过长`);
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(item)) throw new ToolExecutionError("invalid_arguments", `${key} 取值无效`);
  }
}
