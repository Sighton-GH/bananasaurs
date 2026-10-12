export interface SseEvent {
  readonly data: string;
  readonly keepalive: boolean;
}

// Generous bounds for tool arguments and provider metadata, not answer caps.
const MAX_LINE_CHARS = 1_048_576;
const MAX_EVENT_CHARS = 8_388_608;

async function* textChunks(
  body: ReadableStream<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<string> {
  // Node streams are async iterable too, but yield bytes rather than strings.
  if (!('getReader' in body)) {
    yield* body;
    return;
  }
  const reader = body.getReader();
  // Preserve the BOM here; the parser strips exactly one on both input paths.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let exhausted = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    try {
      if (!exhausted) await reader.cancel();
    } catch {
      // Cleanup must not replace a parser, source or consumer error.
    } finally {
      reader.releaseLock();
    }
  }
}

/** Parse lines as bytes arrive, with bounded unfinished lines and events. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<SseEvent> {
  let buffer = '';
  let skipLf = false;
  let atStart = true;
  let pendingChars = 0;
  const pendingData: string[] = [];
  const flushData = (): SseEvent | 'done' | undefined => {
    if (pendingData.length === 0) return undefined;
    const data = pendingData.splice(0).join('\n');
    pendingChars = 0;
    return data === '[DONE]' ? 'done' : { data, keepalive: false };
  };
  const parseLine = (line: string): SseEvent | 'done' | undefined => {
    if (line === '') return flushData();
    if (line.startsWith(':')) return { data: '', keepalive: true };
    if (line === 'data' || line.startsWith('data:')) {
      const data = line === 'data' ? '' : line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      pendingChars += data.length + (pendingData.length === 0 ? 0 : 1);
      if (pendingChars > MAX_EVENT_CHARS) {
        throw new Error(`SSE event exceeds ${MAX_EVENT_CHARS} characters`);
      }
      pendingData.push(data);
    }
    return undefined;
  };

  for await (const chunk of textChunks(body)) {
    let start = 0;
    if (atStart && chunk.length > 0) {
      atStart = false;
      if (chunk.startsWith('\uFEFF')) start = 1;
    }
    // Treat CR as a terminator immediately; skip one following LF, even if
    // it arrives in a later chunk. Never wait for EOF to dispatch CR frames.
    for (let i = start; i < chunk.length; i++) {
      const char = chunk[i];
      if (skipLf) {
        skipLf = false;
        if (char === '\n') {
          start = i + 1;
          continue;
        }
      }
      if (char !== '\r' && char !== '\n') continue;
      if (buffer.length + i - start > MAX_LINE_CHARS) {
        throw new Error(`SSE line exceeds ${MAX_LINE_CHARS} characters`);
      }
      const event = parseLine(buffer + chunk.slice(start, i));
      buffer = '';
      start = i + 1;
      skipLf = char === '\r';
      if (event === 'done') return;
      if (event !== undefined) yield event;
    }
    if (buffer.length + chunk.length - start > MAX_LINE_CHARS) {
      throw new Error(`SSE line exceeds ${MAX_LINE_CHARS} characters`);
    }
    buffer += chunk.slice(start);
  }
  // Preserve the brief's EOF flush for unterminated final lines and events.
  if (buffer !== '') {
    const event = parseLine(buffer);
    if (event === 'done') return;
    if (event !== undefined) yield event;
  }
  const event = flushData();
  if (event !== undefined && event !== 'done') yield event;
}
