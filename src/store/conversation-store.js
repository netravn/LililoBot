import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class ConversationStore {
  constructor(directory, maxHistoryTurns) {
    this.directory = directory;
    this.maxMessages = maxHistoryTurns * 2;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  fileFor(key) {
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }

  async get(key) {
    try {
      const record = JSON.parse(await fs.readFile(this.fileFor(key), "utf8"));
      return Array.isArray(record.messages) ? record.messages : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async append(key, entries) {
    const messages = [...(await this.get(key)), ...entries].slice(-this.maxMessages);
    const target = this.fileFor(key);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ key, messages }, null, 2), { mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async reset(key) {
    try {
      await fs.unlink(this.fileFor(key));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  validateId(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid session id");
    return path.join(this.directory, `${id}.json`);
  }

  async list() {
    await this.init();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      try {
        const file = path.join(this.directory, entry.name);
        const [record, stat] = await Promise.all([
          fs.readFile(file, "utf8").then(JSON.parse),
          fs.stat(file),
        ]);
        sessions.push({
          id: entry.name.slice(0, -5),
          key: String(record.key ?? ""),
          messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
          updatedAt: stat.mtime.toISOString(),
        });
      } catch {
        // Ignore incomplete files left behind by an interrupted write.
      }
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getById(id) {
    const record = JSON.parse(await fs.readFile(this.validateId(id), "utf8"));
    return {
      id,
      key: String(record.key ?? ""),
      messages: Array.isArray(record.messages) ? record.messages : [],
    };
  }

  async resetById(id) {
    try {
      await fs.unlink(this.validateId(id));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
}
