export function decideTrigger(message, config) {
  if (message.senderId === message.selfId) return { accepted: false, reason: "self-message" };

  if (message.kind === "private") {
    if (!config.qq.allowPrivate) return { accepted: false, reason: "private-disabled" };
    const allowed = config.qq.privateAllowlist;
    if (allowed.length > 0 && !allowed.includes(message.senderId)) {
      return { accepted: false, reason: "private-not-allowed" };
    }
    return { accepted: true, content: message.text, reason: "private" };
  }

  if (!config.qq.allowedGroups.includes(message.conversationId)) {
    return { accepted: false, reason: "group-not-allowed" };
  }

  const mentioned = message.mentions.includes(message.selfId);
  const keyword = config.qq.groupKeywords.find((item) => message.text.startsWith(item));
  if (!mentioned && !keyword) return { accepted: false, reason: "group-not-triggered" };

  const content = keyword ? message.text.slice(keyword.length).trim() : message.text.trim();
  return { accepted: true, content, reason: mentioned ? "mention" : "keyword" };
}
