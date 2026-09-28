import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readFiles } from './paperwork';

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
});
