import { inspect } from "node:util";

function render(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  return inspect(value, { depth: 4, breakLength: 120 });
}

export class Logger {
  constructor(limit = 500) {
    this.limit = limit;
    this.entries = [];
    this.listeners = new Set();
    this.nextId = 1;
  }

  write(level, scope, ...values) {
    const entry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level,
      scope,
      message: values.map(render).join(" "),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    const output = `[${scope}] ${entry.message}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(output);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  info(scope, ...values) {
    return this.write("info", scope, ...values);
  }

  warn(scope, ...values) {
    return this.write("warn", scope, ...values);
  }

  error(scope, ...values) {
    return this.write("error", scope, ...values);
  }

  recent(limit = 200) {
    return this.entries.slice(-Math.max(1, Math.min(limit, this.limit)));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
