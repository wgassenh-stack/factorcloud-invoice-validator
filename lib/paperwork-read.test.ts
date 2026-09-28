import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readFiles } from './paperwork';
import { readerRetryAfterMs } from './extract';

const fields = { documentType: 'invoice' } as never;
const file = (name: string, body = name) => new File([body], name, { type: 'application/pdf' });

describe('reading uploaded files', () => {
  it('retries a file the reader refused, instead of calling it unreadable', async () => {
    let calls = 0;
    const extract = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('429 RESOURCE_EXHAUSTED: too many requests');
      return { fields, usage: undefined };
    });
    const out = await readFiles([file('02_FCB-1002.pdf')], 0, [], { extract, retryDelaysMs: [0, 0] });
    expect(out.documents).toHaveLength(1);
    expect(out.unreadable).toEqual([]);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it('after the retries, says the reader was busy and offers another try', async () => {
    const extract = vi.fn(async () => { throw new Error('503 UNAVAILABLE: high demand'); });
    const out = await readFiles([file('a.pdf')], 4, [], { extract, retryDelaysMs: [0] });
    expect(out.unreadable).toEqual([{ fileName: 'a.pdf', fileIndex: 4, retryable: true, reason: 'The document reader was busy. Try again in a moment.' }]);
  });

  it('reads the same file only once', async () => {
    const extract = vi.fn(async () => ({ fields, usage: undefined }));
    const out = await readFiles([file('a.pdf', 'same'), file('copy.pdf', 'same')], 0, [], { extract });
    expect(out.documents).toHaveLength(1);
    expect(out.duplicates.map((d) => d.fileName)).toEqual(['copy.pdf']);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('gives up straight away when the reader asks for a long wait, rather than hanging the upload', async () => {
    const extract = vi.fn(async () => { throw new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"45s"}]}}'); });
    const out = await readFiles([file('a.pdf')], 0, [], { extract, retryDelaysMs: [0, 0] });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(out.unreadable[0].retryable).toBe(true);
  });

  it('when one file is refused, the others wait too instead of piling on', async () => {
    const t0 = Date.now();
    const started: Record<string, number[]> = {};
    let refused = false;
    const extract = vi.fn(async (f: File) => {
      (started[f.name] ??= []).push(Date.now() - t0);
      if (f.name === 'a.pdf' && !refused) { refused = true; throw new Error('429 RESOURCE_EXHAUSTED'); }
      return { fields, usage: undefined };
    });
    const out = await readFiles([file('a.pdf'), file('b.pdf'), file('c.pdf')], 0, [], { extract, retryDelaysMs: [120], concurrency: 2 });
    expect(out.documents).toHaveLength(3);
    // b was already in flight; c, queued behind it, waited out the pause like a's retry.
    expect(started['c.pdf'][0]).toBeGreaterThanOrEqual(110);
    expect(started['a.pdf'][1]).toBeGreaterThanOrEqual(110);
  });
});

describe('reader wait hints', () => {
  it('reads the retry delay Gemini sends with a rate limit', () => {
    expect(readerRetryAfterMs(new Error('{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"7s"}'))).toBe(7000);
    expect(readerRetryAfterMs(new Error('503 UNAVAILABLE'))).toBeNull();
  });
});
