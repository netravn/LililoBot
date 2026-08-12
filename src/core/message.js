const CQ_ENTITY = new Map([
  ["&#44;", ","],
  ["&#91;", "["],
  ["&#93;", "]"],
  ["&amp;", "&"],
]);

function decodeCq(value) {
  let result = String(value ?? "");
  for (const [encoded, decoded] of CQ_ENTITY) result = result.replaceAll(encoded, decoded);
  return result;
}

function parseCqString(message) {
  const segments = [];
  const pattern = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let cursor = 0;
  for (const match of message.matchAll(pattern)) {
    if (match.index > cursor) {
      segments.push({ type: "text", data: { text: decodeCq(message.slice(cursor, match.index)) } });
    }
    const data = {};
    for (const field of match[2].replace(/^,/, "").split(",").filter(Boolean)) {
      const separator = field.indexOf("=");
      if (separator > 0) data[field.slice(0, separator)] = decodeCq(field.slice(separator + 1));
    }
    segments.push({ type: match[1], data });
    cursor = match.index + match[0].length;
  }
  if (cursor < message.length) {
    segments.push({ type: "text", data: { text: decodeCq(message.slice(cursor)) } });
  }
  return segments;
}

export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment && typeof segment.type === "string")
      .map((segment) => ({ type: segment.type, data: segment.data ?? {} }));
  }
  return parseCqString(String(message ?? ""));
}

export function parseInboundMessage(event) {
  if (event?.post_type !== "message") return null;
  if (!['private', 'group'].includes(event.message_type)) return null;

  const segments = normalizeSegments(event.message);
  const text = segments
    .filter((segment) => segment.type === "text")
    .map((segment) => String(segment.data.text ?? ""))
    .join("")
    .trim();
  const mentions = segments
    .filter((segment) => segment.type === "at")
    .map((segment) => String(segment.data.qq ?? ""));
  const reply = segments.find((segment) => segment.type === "reply");
  const images = segments
    .filter((segment) => segment.type === "image")
    .map((segment) => segment.data.url || segment.data.file)
    .filter(Boolean);

  const selfId = String(event.self_id ?? "");
  const senderId = String(event.user_id ?? event.sender?.user_id ?? "");
  const conversationId =
    event.message_type === "group" ? String(event.group_id ?? "") : senderId;
  if (!selfId || !senderId || !conversationId) return null;

  return {
    selfId,
    senderId,
    senderName: String(event.sender?.card || event.sender?.nickname || senderId),
    messageId: String(event.message_id ?? ""),
    kind: event.message_type,
    conversationId,
    text,
    mentions,
    replyTo: reply ? String(reply.data.id ?? "") : null,
    images,
    raw: event,
  };
}

export function sessionKey(message) {
  return `onebot:${message.selfId}:${message.kind}:${message.conversationId}`;
}
