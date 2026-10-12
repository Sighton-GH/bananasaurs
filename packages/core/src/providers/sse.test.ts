import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.js';

const collect = async (chunks: readonly string[]) => {
  async function* feed() {
    for (const c of chunks) yield c;
  }
  const out = [];
  for await (const e of parseSseStream(feed())) out.push(e);
  return out;
};

const byteStream = (chunks: readonly Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe('parseSseStream', () => {
  it('ignores keepalive comments and counts them', async () => {
    const events = await collect([': OPENROUTER PROCESSING\n', 'data: {"a":1}\n\n']);
    expect(events).toEqual([
      { data: '', keepalive: true },
      { data: '{"a":1}', keepalive: false },
    ]);
  });

  it('reassembles a data line split across chunks', async () => {
    const events = await collect(['data: {"delta', ': {"content": "hi"}}\n\n']);
    expect(events).toEqual([{ data: '{"delta: {"content": "hi"}}', keepalive: false }]);
  });

  it('joins multi-line data with newlines', async () => {
    const events = await collect(['data: line1\ndata: line2\n\n']);
    expect(events).toEqual([{ data: 'line1\nline2', keepalive: false }]);
  });

  it('stops at [DONE]', async () => {
    const events = await collect(['data: {"a":1}\n\n', 'data: [DONE]\n\n', 'data: {"a":2}\n\n']);
    expect(events).toEqual([{ data: '{"a":1}', keepalive: false }]);
  });

  it('yields events before reading the next iterable chunk', async () => {
    let continued = false;
    async function* feed() {
      yield 'data: first\n\n';
      continued = true;
      yield 'data: second\n\n';
    }
    const events = parseSseStream(feed());
    try {
      expect(await events.next()).toEqual({
        value: { data: 'first', keepalive: false },
        done: false,
      });
      expect(continued).toBe(false);
    } finally {
      await events.return(undefined);
    }
  });

  it('yields comments and data while the byte stream is still open', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode(': working\ndata: first\n\n'));
      },
    });
    const events = parseSseStream(body);
    let received = false;
    const pending = events.next().then((event) => {
      received = true;
      return event;
    });
    // The queued bytes must be yielded without an EOF. Closing on a later
    // turn lets a buffering parser fail an assertion instead of hanging.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const receivedBeforeEof = received;
    source?.close();
    try {
      expect(receivedBeforeEof).toBe(true);
      expect(await pending).toEqual({ value: { data: '', keepalive: true }, done: false });
      expect(body.locked).toBe(true);
      expect(await events.next()).toEqual({
        value: { data: 'first', keepalive: false },
        done: false,
      });
    } finally {
      await events.return(undefined);
    }
    expect(body.locked).toBe(false);
  });

  it('stops at [DONE] without consuming another iterable chunk', async () => {
    let continued = false;
    let closed = false;
    async function* feed() {
      try {
        yield 'data: [DONE]\n\n';
        continued = true;
        yield 'data: too late\n\n';
      } finally {
        closed = true;
      }
    }
    expect(await parseSseStream(feed()).next()).toEqual({ value: undefined, done: true });
    expect(continued).toBe(false);
    expect(closed).toBe(true);
  });

  it('stops at [DONE] and releases the reader without waiting for EOF', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
    });
    const pending = parseSseStream(body).next();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const lockedBeforeEof = body.locked;
    source?.close();
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(lockedBeforeEof).toBe(false);
  });

  it('decodes UTF-8 split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: café 🍌\n\n');
    const events = [];
    for await (const event of parseSseStream(
      byteStream(Array.from(bytes, (byte) => Uint8Array.of(byte))),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ data: 'café 🍌', keepalive: false }]);
  });

  it('handles CRLF split across chunks', async () => {
    expect(await collect([': working\r', '\ndata: first\r', '\ndata: second\r\n\r', '\n'])).toEqual(
      [
        { data: '', keepalive: true },
        { data: 'first\nsecond', keepalive: false },
      ],
    );
  });

  it('flushes a final partial data line at EOF', async () => {
    expect(await collect(['data: first\ndata: sec', 'ond'])).toEqual([
      { data: 'first\nsecond', keepalive: false },
    ]);
    expect(await collect(['data: [DONE]'])).toEqual([]);
  });

  it('preserves empty data and removes only one optional space', async () => {
    expect(await collect(['data:\n\ndata:  spaced \n\ndata:no-space\n\n'])).toEqual([
      { data: '', keepalive: false },
      { data: ' spaced ', keepalive: false },
      { data: 'no-space', keepalive: false },
    ]);
  });

  it('ignores other SSE fields and preserves data across comments', async () => {
    expect(
      await collect([
        'event: message\nid: 1\nretry: 1000\ndata: first\n: working\ndata: second\n\n',
      ]),
    ).toEqual([
      { data: '', keepalive: true },
      { data: 'first\nsecond', keepalive: false },
    ]);
  });

  it('releases the reader when a byte stream fails', async () => {
    const failure = new Error('stream failed');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    await expect(parseSseStream(body).next()).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
});
