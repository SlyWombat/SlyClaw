import { describe, expect, it } from 'vitest';

import { renderList } from './outlook.js';

describe('renderList', () => {
  it('reports when there are no messages', () => {
    const r = renderList([]);
    expect(r.ids).toEqual([]);
    expect(r.text).toMatch(/no matching emails/i);
  });

  it('numbers messages, preserves ID order, and flags unread', () => {
    const r = renderList([
      {
        id: 'AAA',
        subject: 'Encore heating quote',
        from: { emailAddress: { name: 'Encore Heating', address: 'info@encore.example' } },
        receivedDateTime: '2026-07-01T10:00:00Z',
        isRead: false,
        bodyPreview: 'Here is the quote you requested for the heat pump install.',
      },
      {
        id: 'BBB',
        subject: 'Re: Encore heating',
        from: { emailAddress: { address: 'you@example.com' } },
        receivedDateTime: '2026-07-02T12:00:00Z',
        isRead: true,
        bodyPreview: 'Thanks, following up on the rebate question.',
      },
    ]);

    // ids come back in list order so read_email index N maps to ids[N-1]
    expect(r.ids).toEqual(['AAA', 'BBB']);
    expect(r.text).toContain('[1]');
    expect(r.text).toContain('[2]');
    expect(r.text).toContain('[UNREAD]'); // first message only
    expect(r.text).toContain('Encore Heating'); // sender name preferred
    expect(r.text).toContain('you@example.com'); // falls back to address
    expect(r.text.match(/\[UNREAD\]/g)?.length).toBe(1);
  });

  it('truncates long previews and collapses whitespace', () => {
    const long = 'word '.repeat(200);
    const r = renderList([{ id: 'X', subject: 's', bodyPreview: long }]);
    // Last line is the preview, indented by two spaces — strip that indent first.
    const preview = (r.text.split('\n').at(-1) ?? '').trimStart();
    expect(preview.length).toBeLessThanOrEqual(220);
    expect(preview).not.toContain('  '); // whitespace collapsed within the content
  });
});
