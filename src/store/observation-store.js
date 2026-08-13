import fs from "node:fs/promises";
import path from "node:path";

function safeGroupId(groupId) {
  const value = String(groupId ?? "");
  if (!/^\d{1,20}$/.test(value)) throw new Error("invalid group id");
  return value;
}

async function readJsonLines(file) {
  try {
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export class ObservationStore {
  constructor(directory) {
    this.directory = directory;
    this.messagesDir = path.join(directory, "messages");
    this.summariesDir = path.join(directory, "summaries");
    this.writeQueues = new Map();
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.messagesDir, { recursive: true }),
      fs.mkdir(this.summariesDir, { recursive: true }),
    ]);
  }

  enqueue(key, operation) {
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.writeQueues.set(key, current);
    return current.finally(() => {
      if (this.writeQueues.get(key) === current) this.writeQueues.delete(key);
    });
  }

  async appendMessage(entry) {
    const groupId = safeGroupId(entry.groupId);
    const day = new Date(entry.timestamp).toISOString().slice(0, 10);
    const directory = path.join(this.messagesDir, groupId);
    const file = path.join(directory, `${day}.jsonl`);
    return this.enqueue(`message:${groupId}`, async () => {
      await fs.mkdir(directory, { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      const metadataFile = path.join(directory, "meta.json");
      let metadata = { messageCount: 0, lastMessageAt: null };
      try { metadata = JSON.parse(await fs.readFile(metadataFile, "utf8")); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      metadata.messageCount = Number(metadata.messageCount ?? 0) + 1;
      metadata.lastMessageAt = entry.timestamp;
      const temporary = `${metadataFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
      await fs.rename(temporary, metadataFile);
    });
  }

  async messageFiles(groupId) {
    const directory = path.join(this.messagesDir, safeGroupId(groupId));
    try {
      return (await fs.readdir(directory))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .map((name) => path.join(directory, name));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async messages(groupId, { since = 0, limit = 500, newest = false } = {}) {
    const entries = [];
    for (const file of await this.messageFiles(groupId)) {
      for (const entry of await readJsonLines(file)) {
        if (Date.parse(entry.timestamp) > since) entries.push(entry);
      }
    }
    entries.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
    return newest ? entries.slice(-limit) : entries.slice(0, limit);
  }

  summaryFile(groupId) {
    return path.join(this.summariesDir, `${safeGroupId(groupId)}.jsonl`);
  }

  async appendSummary(summary) {
    const groupId = safeGroupId(summary.groupId);
    return this.enqueue(`summary:${groupId}`, () =>
      fs.appendFile(this.summaryFile(groupId), `${JSON.stringify(summary)}\n`, { mode: 0o600 }),
    );
  }

  async summaries(groupId, limit = 20) {
    const entries = await readJsonLines(this.summaryFile(groupId));
    return entries.slice(-limit).reverse();
  }

  async latestSummary(groupId) {
    return (await this.summaries(groupId, 1))[0] ?? null;
  }

  async groupIds() {
    await this.init();
    const entries = await fs.readdir(this.messagesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{1,20}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async groupStats() {
    const result = [];
    for (const groupId of await this.groupIds()) {
      let metadata = null;
      try {
        metadata = JSON.parse(await fs.readFile(path.join(this.messagesDir, groupId, "meta.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!metadata) {
        const messages = await this.messages(groupId, { limit: Number.MAX_SAFE_INTEGER });
        metadata = { messageCount: messages.length, lastMessageAt: messages.at(-1)?.timestamp ?? null };
      }
      const latest = await this.latestSummary(groupId);
      result.push({
        groupId,
        messageCount: Number(metadata.messageCount ?? 0),
        lastMessageAt: metadata.lastMessageAt ?? null,
        lastSummaryAt: latest?.createdAt ?? null,
      });
    }
    return result.sort((left, right) => String(right.lastMessageAt).localeCompare(String(left.lastMessageAt)));
  }

  async cleanup(retentionDays, now = Date.now()) {
    const cutoffDay = new Date(now - retentionDays * 86_400_000).toISOString().slice(0, 10);
    let deleted = 0;
    for (const groupId of await this.groupIds()) {
      for (const file of await this.messageFiles(groupId)) {
        if (path.basename(file, ".jsonl") < cutoffDay) {
          await fs.unlink(file);
          deleted += 1;
        }
      }
    }
    return deleted;
  }
}
