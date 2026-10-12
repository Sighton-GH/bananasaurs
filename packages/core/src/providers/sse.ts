export interface SseEvent {
  readonly data: string;
  readonly keepalive: boolean;
}

async function* textChunks(
  body: ReadableStream<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<string> {
  // ReadableStream is itself async iterable in Node, but yields bytes, not
  // strings. Select the reader path first so UTF-8 is always decoded.
  if (!('getReader' in body)) {
    yield* body;
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Parse complete lines as bytes arrive, retaining only the unfinished event. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<string>,
): AsyncGenerator<SseEvent> {
  let buffer = '';
  const pendingData: string[] = [];
  const flushData = (): SseEvent | 'done' | undefined => {
    if (pendingData.length === 0) return undefined;
    const data = pendingData.splice(0).join('\n');
    return data === '[DONE]' ? 'done' : { data, keepalive: false };
  };
  const parseLine = (raw: string): SseEvent | 'done' | undefined => {
    const line = raw.replace(/\r$/, '');
    if (line === '') return flushData();
    if (line.startsWith(':')) return { data: '', keepalive: true };
    if (line.startsWith('data:')) {
      pendingData.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
    }
    return undefined;
  };

  for await (const chunk of textChunks(body)) {
    buffer += chunk;
    let start = 0;
    let end: number;
    while ((end = buffer.indexOf('\n', start)) !== -1) {
      const event = parseLine(buffer.slice(start, end));
      start = end + 1;
      if (event === 'done') return;
      if (event !== undefined) yield event;
    }
    buffer = buffer.slice(start);
  }
  // Providers normally terminate events with a blank line, but keep the
  // brief's EOF behaviour for a final unterminated data line or event.
  if (buffer !== '') {
    const event = parseLine(buffer);
    if (event === 'done') return;
    if (event !== undefined) yield event;
  }
  const event = flushData();
  if (event !== undefined && event !== 'done') yield event;
}
