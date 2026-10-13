// Pure helpers of the v1.1 views: timeline grouping and the local-AI answer parser.
import { describe, expect, it } from 'vitest';
import { cardMetrics, DEFAULT_CARD_PREFS, sanitizeCardPrefs } from '../src/ui/dashboard/cardPrefs';
import type { TabRecord } from '../src/shared/types';
import { parseAiAnswer } from '../src/ui/dashboard/localAi';
import { buildTimeline, SESSION_GAP_MS } from '../src/ui/dashboard/views/Timeline';
import { isDismissed, jaccard } from '../src/ui/dashboard/context';

const DAY = 86_400_000;
const base = new Date(2026, 9, 11, 10, 0).getTime();
const rec = (id: string, lastAccessedAt?: number): TabRecord =>
  ({ id, url: 'https://' + id + '.com/', title: id, domain: id + '.com', state: 'archived', tags: [], project: '', note: '', createdAt: base, lastAccessedAt, origin: {} }) as unknown as TabRecord;

describe('timeline', () => {
  it('groups by day, splits sessions on gaps and puts unknown dates last', () => {
    const items = [rec('a', base), rec('b', base + 10 * 60_000), rec('c', base + SESSION_GAP_MS + 20 * 60_000), rec('d', base - DAY)];
    // no lastAccessedAt -> falls back to createdAt (known); force unknown with a record without dates
    const unknown = { ...rec('e'), createdAt: undefined } as unknown as TabRecord;
    const rows = buildTimeline([...items, unknown], 'accessed', 'desc', base + 60 * 60_000);
    const kinds = rows.map((r) => (r.kind === 'rec' ? r.r.id : r.kind));
    expect(kinds).toEqual(['day', 'session', 'c', 'session', 'b', 'a', 'day', 'session', 'd', 'day', 'e']);
    const today = rows[0]!;
    expect(today.kind === 'day' && today.label.startsWith('Hoy')).toBe(true);
    expect(today.kind === 'day' && today.ids.length).toBe(3);
    expect(rows[6]!.kind === 'day' && rows[6]!.label.startsWith('Ayer')).toBe(true);
  });

  it('ascending order keeps sessions chronological', () => {
    const rows = buildTimeline([rec('b', base + 60_000), rec('a', base)], 'accessed', 'asc', base);
    expect(rows.filter((r) => r.kind === 'rec').map((r) => (r.kind === 'rec' ? r.r.id : ''))).toEqual(['a', 'b']);
  });
});

describe('local AI answers', () => {
  it('parses name and 1-based outliers, never trusting junk', () => {
    expect(parseAiAnswer('{"name":"«Aprender hooks de React»","outliers":[3]}', 5)).toEqual({ name: 'Aprender hooks de React', outliers: [2] });
    expect(parseAiAnswer('{"name":"X","outliers":[0, 9, 2, 2]}', 4)).toEqual({ name: 'X', outliers: [1] });
    expect(parseAiAnswer('{"name":"X","outliers":[1,2,3]}', 4)).toEqual({ name: 'X', outliers: [] });
    expect(parseAiAnswer('{"name":""}', 3)).toBeNull();
    expect(parseAiAnswer('not json', 3)).toBeNull();
  });
});

describe('dismissed suggestions', () => {
  it('hide while the member set stays mostly the same', () => {
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toBeCloseTo(0.75);
    const s = { ids: ['a', 'b', 'c', 'd'] } as never;
    expect(isDismissed(s, [['a', 'b', 'c']])).toBe(true);
    expect(isDismissed(s, [['a', 'x', 'y']])).toBe(false);
  });
});

describe('card design preferences', () => {
  it('defaults to minimal and repairs stored values', () => {
    expect(DEFAULT_CARD_PREFS).toMatchObject({ image: 'none', colors: false });
    expect(sanitizeCardPrefs(null)).toEqual(DEFAULT_CARD_PREFS);
    expect(sanitizeCardPrefs({ image: 'thumb', size: 'huge', colors: 'yes', extra: 1 })).toEqual({ ...DEFAULT_CARD_PREFS, image: 'thumb' });
  });

  it('card height grows with what is shown (fixed per layout, for the virtual grid)', () => {
    const base = cardMetrics(DEFAULT_CARD_PREFS);
    expect(cardMetrics({ ...DEFAULT_CARD_PREFS, showUrl: true }).height).toBeGreaterThan(base.height);
    expect(cardMetrics({ ...DEFAULT_CARD_PREFS, showMarks: false, showDate: false }).height).toBeLessThan(base.height);
    const thumb = cardMetrics({ ...DEFAULT_CARD_PREFS, image: 'thumb', size: 'comfortable' });
    expect(thumb.thumbHeight).toBeGreaterThan(0);
    expect(thumb.titleLines).toBe(3);
    expect(thumb.height).toBeGreaterThan(base.height + thumb.thumbHeight);
  });
});
