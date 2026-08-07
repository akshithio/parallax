// Runs in the PAGE (MAIN) world so it can wrap the page's own fetch. It does two things:
//  1. Tees the ChatGPT conversation SSE stream and parses the assistant message
//     deltas, posting the RAW model text (no HTML rendering, never truncated) out.
//  2. Relays stream diagnostics while a Nix-authored turn is active.
// Model and intelligence selection are handled and verified against ChatGPT's live
// picker by content.js before a turn is sent.
(function () {
  if (window.__nixNetHooked) return;
  window.__nixNetHooked = true;

  // ARMED ONLY DURING A NIX TURN. Everything below — teeing response streams,
  // is inert unless the desktop is actually mid-send in this tab. When you use
  // ChatGPT yourself, the page runs completely untouched:
  // its own fetches are returned unwrapped and nothing is cloned or parsed. Keeping
  // the hooks live at all times meant any bug in them (see parseStream's buffer
  // note) could break a conversation Nix wasn't even involved in.
  let armed = false;
  let activeSink = null;

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input || '');
    } catch {
      return '';
    }
  }

  function methodOf(args) {
    try {
      if (args[1] && typeof args[1].method === 'string') return args[1].method.toUpperCase();
      if (args[0] && typeof args[0].method === 'string') return args[0].method.toUpperCase();
    } catch {}
    return 'GET';
  }

  function post(turnId, text, done, completion) {
    try {
      if (done) console.log('[Nix] net response complete, chars:', String(text || '').length);
      window.postMessage({
        __nix_net: true,
        source: 'network',
        turnId,
        text,
        done: !!done,
        completion: completion || '',
      }, '*');
    } catch {}
  }

  function postMetric(metric) {
    try {
      window.postMessage({ __nix_net_metric: true, metric }, '*');
    } catch {}
  }

  function postRequest(turnId, url) {
    try {
      window.postMessage({
        __nix_net_request: true,
        turnId,
        url: short(url),
      }, '*');
    } catch {}
  }

  // Relay diagnostics to the desktop terminal (via content.js). The response path
  // is network-only, so its request, transport, frame count, parse misses, and
  // completion state must all be observable.
  function short(u) {
    return String(u || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 70);
  }

  function postDebug(msg) {
    try {
      console.log('[Nix][net]', msg);
      window.postMessage({ __nix_net_debug: true, sample: msg }, '*');
    } catch {}
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d) return;
    if (d.__nix_arm === true) {
      armed = !!d.armed;
      if (armed) {
        activeSink = createSink(String(d.turnId || ''));
      } else {
        activeSink = null;
      }
      try {
        window.postMessage({
          __nix_net_arm_ready: true,
          armed,
          turnId: String(d.turnId || ''),
        }, '*');
      } catch {}
      postDebug(armed ? 'armed — intercepting this turn' : 'disarmed — page runs untouched');
    }
  });

  function isConversationRequest(url) {
    try {
      const path = new URL(url, window.location.href).pathname;
      return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';
    } catch {
      return false;
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const sink = armed ? activeSink : null;
    const p = origFetch.apply(this, args);
    try {
      const url = urlOf(args[0]);
      if (
        sink &&
        methodOf(args) === 'POST' &&
        isConversationRequest(url)
      ) {
        postRequest(sink.turnId, url);
      }
      // Tee EVERY event-stream, whatever its URL. ChatGPT now hands the answer
      // off to a SEPARATE "resume_sse_endpoint": the /f/conversation POST just
      // returns a stream_handoff ticket and closes. Matching the answer by URL
      // is therefore wrong by construction — the content-type is the only
      // reliable signal, and a stray SSE just parses to nothing.
      p.then((resp) => {
        try {
          if (!sink) return; // not our turn — never clone the page's stream
          const ct = resp.headers.get('content-type') || '';
          if (resp.body && ct.includes('text/event-stream')) {
            postDebug(`tee ${methodOf(args)} ${short(url)}`);
            parseStream(resp.clone(), sink);
          }
        } catch {}
      }).catch(() => {});
    } catch {}
    return p;
  };

  // We read a CLONE of ChatGPT's own response. A clone is a tee of one stream, and
  // Chrome buffers whatever the slower branch hasn't taken — so abandoning our
  // branch mid-stream (which is what an early `return` did on [DONE]) fills that
  // buffer and back-pressures the ORIGINAL. That stalls ChatGPT's own response:
  // the site's answer stops mid-word and ITS stop button never turns back into
  // send. Every exit path here therefore cancels the reader, which drops the buffer
  // immediately and leaves the page's own stream untouched.
  async function parseStream(resp, sink) {
    if (!sink) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const sourceState = { handoff: false };
    // Once the sink says "done" we STOP FEEDING it but keep pulling the reader to
    // EOF, discarding the rest. We must never stop reading early: a clone is a tee
    // of ChatGPT's own stream, and Chrome back-pressures the source when the slower
    // branch stops draining — so abandoning ours mid-stream stalls the PAGE's
    // response (its answer freezes and its stop button never resets). Draining to
    // the end keeps our branch empty and the page's stream flowing freely.
    let drained = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (drained) continue; // still pulling to relieve back-pressure, but ignoring
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          if (sink.feed(trimmed.slice(5).trim(), 'fetch', sourceState)) {
            drained = true;
            break;
          }
        }
      }
    } catch (e) {
      sink.sourceError('fetch', `stream error: ${e && e.message}`);
      return;
    }
    if (!drained) sink.sourceEnded('fetch', 'stream ended', sourceState);
  }

  // ChatGPT's answer can arrive over a resume SSE endpoint opened with EventSource
  // rather than fetch ("resume_sse_endpoint" in the stream_handoff frame). Hook it
  // so the transport choice can't hide the reply from us again.
  try {
    const OrigES = window.EventSource;
    if (OrigES && !window.__nixESHooked) {
      window.__nixESHooked = true;
      const Wrapped = function (url, cfg) {
        const es = new OrigES(url, cfg);
        try {
          let turnId = '';
          let sourceState = { handoff: false };
          es.addEventListener('message', (e) => {
            try {
              const sink = armed ? activeSink : null;
              if (!sink) return;
              if (turnId !== sink.turnId) {
                turnId = sink.turnId;
                sourceState = { handoff: false };
                postDebug(`EventSource ${short(String(url))}`);
              }
              sink.feed(String(e.data || '').trim(), 'eventsource', sourceState);
            } catch {}
          });
          es.addEventListener('error', () => {
            try {
              const sink = armed ? activeSink : null;
              if (sink && sink.turnId === turnId) {
                sink.sourceEnded('eventsource', 'EventSource closed', sourceState);
              }
            } catch {}
          });
        } catch {}
        return es;
      };
      Wrapped.prototype = OrigES.prototype;
      Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSED = 2;
      window.EventSource = Wrapped;
    }
  } catch {}

  // ChatGPT can also carry the resume stream over a WebSocket, which wraps the SSE
  // bytes in a JSON envelope ({..., body: <base64>}). Neither fetch nor EventSource
  // sees that, which is why the answer stayed invisible after the handoff frame.
  function feedWsPayload(sink, raw, sourceState) {
    sink.observeFrame('websocket');
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      sink.feed(raw, 'websocket', sourceState, false);
      return;
    }
    // The socket is shared by every live ChatGPT topic in the tab. Stream data
    // belongs to the exact handoff topic. ChatGPT publishes the final
    // conversation-turn-complete notification on the shared "conversations"
    // topic, so admit only a completion whose conversation id matches this sink.
    const topic = sink.resumeTopic;
    if (!topic) return;
    const matching = [];
    collectTopicEnvelopes(env, topic, matching);
    const shared = [];
    collectTopicEnvelopes(env, 'conversations', shared);
    if (!matching.length && !shared.length) return;

    const decoder = globalThis.NixProtocolCore?.streamEvents;
    if (typeof decoder !== 'function') {
      sink.sourceError('websocket', 'stream decoder is unavailable');
      return;
    }
    const events = [
      ...matching.flatMap((value) => decoder(value)),
      ...shared
        .flatMap((value) => decoder(value))
        .filter((event) => sink.acceptsSharedCompletion(event)),
    ];
    if (!events.length) {
      if (matching.length) sink.miss('websocket', matching);
      return;
    }
    for (const event of events) {
      sink.feed(
        typeof event === 'string' ? event : JSON.stringify(event),
        'websocket',
        sourceState,
        false,
      );
    }
  }

  function collectTopicEnvelopes(value, topic, output, depth = 0) {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) collectTopicEnvelopes(item, topic, output, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.topic_id === topic) {
      output.push(value);
      return;
    }
    if (value.reply && value.reply.topic_id === topic) {
      output.push(value.reply);
      return;
    }
    for (const child of Object.values(value)) {
      collectTopicEnvelopes(child, topic, output, depth + 1);
    }
  }

  try {
    const OrigWS = window.WebSocket;
    if (OrigWS && !window.__nixWSHooked) {
      window.__nixWSHooked = true;
      const WrappedWS = function (url, protocols) {
        const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
        try {
          let turnId = '';
          let sourceState = { handoff: false };
          let sampled = 0;
          ws.addEventListener('message', (e) => {
            try {
              const sink = armed ? activeSink : null;
              if (!sink) return;
              if (turnId !== sink.turnId) {
                turnId = sink.turnId;
                sourceState = { handoff: false };
                sampled = 0;
                postDebug(`WebSocket ${short(String(url))}`);
              }
              const data = typeof e.data === 'string' ? e.data : '';
              if (!data) return;
              if (sampled < 2) { postDebug(`ws frame: ${data.slice(0, 180)}`); sampled++; }
              feedWsPayload(sink, data.trim(), sourceState);
            } catch {}
          });
        } catch {}
        return ws;
      };
      WrappedWS.prototype = OrigWS.prototype;
      WrappedWS.CONNECTING = 0; WrappedWS.OPEN = 1; WrappedWS.CLOSING = 2; WrappedWS.CLOSED = 3;
      window.WebSocket = WrappedWS;
    }
  } catch {}

  // One parser per Nix turn. Fetch, EventSource, and WebSocket frames all feed the
  // same sink so a handoff can change transports without changing answer state.
  function createSink(turnId) {
    // null = we haven't identified the current message yet. Deliberately NOT false:
    // appends must still be accepted while unknown. Requiring a recognized header
    // before capturing meant that any change to ChatGPT's header shape silently
    // discarded the entire reply.
    let capturing = null; // null = unknown, true = answer, false = reasoning/tool
    let text = '';
    let lastPath = '';
    let dbgCount = 0; // samples the first few raw SSE payloads so the format can be mapped
    let finished = false;
    let firstTextAt = null;
    let expectedConversation = '';
    let expectedExchange = '';
    let expectedTopic = '';
    const startedAt = Date.now();
    const transports = new Set();
    const counts = {
      frames: 0,
      decodedEvents: 0,
      parseMisses: 0,
      handoffs: 0,
      messageBoundaries: 0,
      textUpdates: 0,
      sourceErrors: 0,
    };

    const partsRe = /(?:^|[/.])content[/.]parts[/.]\d+$/;
    const messageBoundaryTypes = new Set([
      'message_stream_complete',
    ]);
    const turnCompletionTypes = new Set([
      'conversation-turn-complete',
      'turn_exchange_stream_complete',
      'stream_complete',
    ]);
    // Assistant messages that are NOT the answer. Everything else is treated as the
    // reply — allowlisting the answer shape is what made this brittle.
    const NON_ANSWER = new Set([
      'thoughts', 'reasoning_recap', 'code', 'execution_output',
      'tether_browsing_display', 'tether_quote', 'system_error', 'model_editable_context',
    ]);

    function pathText(path) {
      if (Array.isArray(path)) return `/${path.join('/')}`;
      return typeof path === 'string' ? path : '';
    }

    function publishText() {
      if (!text) return;
      if (firstTextAt === null) firstTextAt = Date.now();
      counts.textUpdates++;
      post(turnId, text, false, '');
    }

    function onMessageObject(m) {
      if (!m || !m.content) return;
      const role = m.author && m.author.role;
      const ct = m.content.content_type;
      if (role && role !== 'assistant') { capturing = false; return; }
      if (ct && NON_ANSWER.has(ct)) { capturing = false; return; }
      // Assistant + not a known reasoning type ⇒ this is the answer stream.
      capturing = true;
      const parts = m.content.parts;
      if (Array.isArray(parts)) {
        text = parts.filter((part) => typeof part === 'string').join('');
      } else if (typeof m.content.text === 'string') {
        text = m.content.text;
      } else {
        text = '';
      }
      lastPath = '/message/content/parts/0';
      publishText();
    }

    function applyOp(op) {
      const o = op.o !== undefined ? op.o : op.op;
      const pth = pathText(op.p !== undefined ? op.p : op.path);
      const v = op.v !== undefined ? op.v : op.value;
      if (o === 'add' && v && v.message) {
        onMessageObject(v.message);
        return;
      }
      if (o === 'append' && typeof v === 'string' && pth && partsRe.test(pth)) {
        // An append targeting a content-parts path IS answer text. Accept it unless
        // we positively know the current message is reasoning/tool output.
        if (capturing !== false) {
          capturing = true;
          text += v;
          lastPath = pth;
          publishText();
        }
        return;
      }
      if (o === 'replace' && typeof v === 'string' && pth && partsRe.test(pth)) {
        if (capturing !== false) {
          capturing = true;
          text = v;
          lastPath = pth;
          publishText();
        }
        return;
      }
      if (o === 'patch' && Array.isArray(v)) {
        for (const inner of v) applyOp(inner);
        return;
      }
    }

    function handle(ev) {
      if (!ev || typeof ev !== 'object') return;
      // The message object can arrive at ev.message (snapshot form) OR nested under
      // ev.v.message — delta_encoding's initial c:0 state carries it there with no
      // `o` field, which the old code ignored (→ capturing never turned on → 0 chars).
      const msg =
        ev.message && ev.message.content
          ? ev.message
          : ev.v && ev.v.message && ev.v.message.content
            ? ev.v.message
            : null;
      if (msg && (ev.o === undefined || ev.o === 'add' || ev.o === 'replace')) {
        onMessageObject(msg);
        return;
      }
      // Delta-encoding v1: {p, o, v}
      if (
        ev.o !== undefined ||
        ev.p !== undefined ||
        ev.v !== undefined ||
        ev.op !== undefined ||
        ev.path !== undefined ||
        ev.value !== undefined
      ) {
        // bare {v:"..."} continues the previous append at lastPath
        if (ev.o === undefined && ev.p === undefined && typeof ev.v === 'string') {
          if (capturing !== false && partsRe.test(lastPath)) {
            capturing = true;
            text += ev.v;
            publishText();
          }
          return;
        }
        applyOp(ev);
        return;
      }
      const deltaPath = pathText(ev.path);
      if (typeof ev.delta === 'string' && partsRe.test(deltaPath || lastPath)) {
        if (capturing !== false) {
          capturing = true;
          text += ev.delta;
          if (deltaPath) lastPath = deltaPath;
          publishText();
        }
      }
    }

    function metric(status, completion) {
      const endedAt = Date.now();
      return {
        turnId,
        source: 'network',
        status,
        completion,
        chars: text.length,
        transports: [...transports],
        frames: counts.frames,
        decodedEvents: counts.decodedEvents,
        parseMisses: counts.parseMisses,
        handoffs: counts.handoffs,
        messageBoundaries: counts.messageBoundaries,
        textUpdates: counts.textUpdates,
        sourceErrors: counts.sourceErrors,
        firstTextMs: firstTextAt === null ? null : firstTextAt - startedAt,
        durationMs: endedAt - startedAt,
        domFallbacks: 0,
      };
    }

    function finish(completion) {
      if (finished) return;
      finished = true;
      const status = text.trim() ? 'completed' : 'empty';
      postDebug(
        `network turn ${status}: chars=${text.length} frames=${counts.frames} ` +
        `events=${counts.decodedEvents} misses=${counts.parseMisses} ` +
        `transports=${[...transports].join('+') || 'none'} completion=${completion}`,
      );
      post(turnId, text, true, completion);
      postMetric(metric(status, completion));
    }

    function completionIdentity(event) {
      const conversation = String(
        event.conversation_id ||
        event.conversationId ||
        event.payload?.conversation_id ||
        event.payload?.conversationId ||
        event.payload?.payload?.conversation_id ||
        event.metadata?.conversation_id ||
        '',
      );
      const exchange = String(
        event.turn_exchange_id ||
        event.turnExchangeId ||
        event.payload?.turn_exchange_id ||
        event.payload?.turnExchangeId ||
        event.payload?.payload?.turn_exchange_id ||
        event.metadata?.turn_exchange_id ||
        '',
      );
      return { conversation, exchange };
    }

    function completionMatches(event) {
      const { conversation, exchange } = completionIdentity(event);
      if (expectedConversation && conversation && conversation !== expectedConversation) return false;
      if (expectedExchange && exchange && exchange !== expectedExchange) return false;
      return true;
    }

    return {
      turnId,
      get done() { return finished; },
      get resumeTopic() { return expectedTopic; },
      acceptsSharedCompletion(event) {
        if (!event || !turnCompletionTypes.has(event.type)) return false;
        const { conversation, exchange } = completionIdentity(event);
        if (!expectedConversation || conversation !== expectedConversation) return false;
        if (expectedExchange && exchange && exchange !== expectedExchange) return false;
        return true;
      },
      observeFrame(source) {
        if (finished) return;
        transports.add(source);
        counts.frames++;
      },
      miss(source, value) {
        if (finished) return;
        transports.add(source);
        counts.parseMisses++;
        if (counts.parseMisses <= 3) {
          const shape = Array.isArray(value)
            ? `array(${value.length})`
            : value && typeof value === 'object'
              ? `object(${Object.keys(value).sort().join(',')})`
              : typeof value;
          postDebug(`unrecognized ${source} frame shape: ${shape}`);
        }
      },
      // Returns true when this physical source should stop feeding the turn sink.
      feed(payload, source, sourceState, countFrame = true) {
        if (finished) return true;
        const state = sourceState || { handoff: false };
        transports.add(source);
        if (countFrame) counts.frames++;
        // Sample BEFORE the [DONE] short-circuit — an immediate [DONE] used to
        // return first, so a stream that produced nothing logged nothing either.
        if (dbgCount < 4) {
          postDebug(`sse#${dbgCount}: ${payload.slice(0, 200)}`);
          dbgCount++;
        }
        if (!payload) return false;
        if (payload === '[DONE]') {
          if (state.handoff) {
            postDebug(`[DONE] closed the ${source} handoff ticket; awaiting resumed transport`);
            return true;
          }
          finish(`[DONE] via ${source}`);
          return true;
        }
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          counts.parseMisses++;
          return false;
        }
        counts.decodedEvents++;
        // The handoff frame means the ANSWER is on another stream entirely — this
        // one legitimately carries no text, so don't report it as a failed parse.
        if (ev && ev.type === 'stream_handoff') {
          state.handoff = true;
          counts.handoffs++;
          expectedConversation = String(ev.conversation_id || '');
          expectedExchange = String(ev.turn_exchange_id || '');
          expectedTopic = String(
            ev.options?.find((option) => option && option.topic_id)?.topic_id || '',
          );
          postDebug(
            `stream_handoff turn=${ev.turn_exchange_id || '-'} ` +
            `topic=${expectedTopic || '-'}`,
          );
          return false;
        }
        handle(ev);
        // `message_stream_complete` closes one assistant message, not the whole
        // turn. ChatGPT can continue the same visible answer in another message
        // on this topic; treating this boundary as terminal truncated replies
        // after their first sentence. Only a turn-level completion may finalize.
        if (ev && messageBoundaryTypes.has(ev.type)) {
          counts.messageBoundaries++;
          postDebug(`assistant message boundary (${ev.type}); awaiting turn completion`);
          return false;
        }
        if (ev && turnCompletionTypes.has(ev.type)) {
          if (!completionMatches(ev)) {
            postDebug(`ignored completion for another network turn (${ev.type})`);
            return false;
          }
          finish(`${ev.type} via ${source}`);
          return true;
        }
        return false;
      },
      sourceEnded(source, why, sourceState) {
        if (finished) return;
        if (sourceState?.handoff) {
          postDebug(`${source} handoff source ended; resumed transport remains active`);
          return;
        }
        if (text) finish(`${why} via ${source}`);
      },
      sourceError(source, why) {
        if (finished) return;
        transports.add(source);
        counts.sourceErrors++;
        postDebug(`${source} error: ${why}`);
      },
      timeout() {
        finish('network timeout');
      },
    };
  }
})();
