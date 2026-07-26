(function exposeProtocolCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WessProtocolCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProtocolCore() {
  function conversationId(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
      const url = new URL(rawUrl);
      const match = /^\/c\/([^/?#]+)/.exec(url.pathname);
      if (!match) return null;
      const id = decodeURIComponent(match[1]);
      // ChatGPT briefly uses /c/WEB:<uuid> while a new conversation is being
      // canonicalized. It is a transition marker, not a durable conversation id.
      if (!id || /^WEB:/i.test(id)) return null;
      return id;
    } catch (_) {
      return null;
    }
  }

  function isStreamEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.message && value.message.content) return true;
    if (value.v && value.v.message && value.v.message.content) return true;
    if (
      value.o !== undefined ||
      value.p !== undefined ||
      value.v !== undefined ||
      value.op !== undefined ||
      (
        value.path !== undefined &&
        (value.value !== undefined || typeof value.delta === 'string')
      )
    ) return true;
    return [
      'stream_handoff',
      'message_stream_complete',
      'conversation-turn-complete',
      'turn_exchange_stream_complete',
      'stream_complete',
    ].includes(value.type);
  }

  // ChatGPT's WebSocket transport wraps stream events in changing layers such as
  // arrays, {payload:{payload:...}}, and JSON/SSE strings. Flatten only the
  // transport envelope and return the actual stream events in arrival order.
  function streamEvents(value) {
    const events = [];
    const seen = new Set();

    function visit(current, depth) {
      if (current == null || depth > 16) return;
      if (typeof current === 'string') {
        const text = current.trim();
        if (!text) return;
        if (text === '[DONE]') {
          events.push(text);
          return;
        }
        if (text.split(/\r?\n/).some((line) => line.trim().startsWith('data:'))) {
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) visit(trimmed.slice(5).trim(), depth + 1);
          }
          return;
        }
        if (text[0] === '{' || text[0] === '[') {
          try {
            visit(JSON.parse(text), depth + 1);
          } catch (_) {}
        }
        return;
      }
      if (typeof current !== 'object') return;
      if (seen.has(current)) return;
      seen.add(current);
      if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1);
        return;
      }
      if (isStreamEvent(current)) {
        events.push(current);
        return;
      }

      if (typeof current.body === 'string') {
        let body = current.body;
        try {
          if (typeof globalThis.atob === 'function') body = globalThis.atob(body);
        } catch (_) {}
        visit(body, depth + 1);
      }

      // Transport envelopes have changed names several times. Walk every field
      // instead of maintaining an allowlist that silently loses new wrappers.
      for (const key of Object.keys(current)) {
        if (key !== 'body') visit(current[key], depth + 1);
      }
    }

    visit(value, 0);
    return events;
  }

  return { conversationId, streamEvents };
});
