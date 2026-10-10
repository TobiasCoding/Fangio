import { describe, expect, it } from 'vitest';
import { buildBookmarksHtml, buildExport, parseAndValidateImport } from '../src/core/backup';
import type { ExportFileV1, TabRecord } from '../src/shared/types';
import { freshBrowser, idle, startWorker } from './helpers/env';

const STRIP = ['state', 'archivedAt', 'lastReason', 'rev', 'live', 'pendingClose', 'updatedAt'] as const;
function comparable(r: TabRecord) {
  const c: Record<string, unknown> = { ...r };
  for (const k of STRIP) delete c[k];
  return c;
}

async function exportFrom(n = 12) {
  const fc = freshBrowser();
  fc.seedTabs(n, (i) => `https://ex${i}.com/a?b=${i}&c=<x>#h`);
  const w = await startWorker(fc);
  await idle(w);
  const recs = await w.db.getAllRecords();
  await w.call({ type: 'archive', recordIds: recs.slice(0, 4).map((r) => r.id) });
  await w.call({ type: 'trash', recordIds: recs.slice(4, 6).map((r) => r.id) });
  await w.call({ type: 'updateRecords', recordIds: [recs[7]!.id], edit: { note: 'por qué', setTags: ['x', 'y'], pending: true, protected: true } });
  const file = buildExport(await w.db.getAllRecords(), await w.db.getSettings(), await w.db.getActions(), '1.2.0');
  return { file: JSON.parse(JSON.stringify(file)) as ExportFileV1, original: await w.db.getAllRecords() };
}

describe('export / import', () => {
  it('round trip: export -> wipe -> import restores everything (open -> archived)', async () => {
    const { file, original } = await exportFrom();
    expect(file.records.every((r) => r.live === null && r.pendingClose === null)).toBe(true);
    const fc = freshBrowser(); // wiped profile
    const w = await startWorker(fc);
    const res = await w.call({ type: 'importJson', data: file });
    expect(res).toMatchObject({ added: 12, updated: 0, unchanged: 0, rejected: [] });
    const back = await w.db.getAllRecords();
    expect(back).toHaveLength(12);
    for (const o of original) {
      const b = back.find((x) => x.id === o.id)!;
      expect(comparable(b)).toEqual(comparable(JSON.parse(JSON.stringify(o))));
      expect(b.state).toBe(o.state === 'open' ? 'archived' : o.state);
      expect(b.live).toBeNull();
    }
    // Re-import is idempotent and never deletes.
    const again = await w.call({ type: 'importJson', data: file });
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 12 });
    expect(await w.db.getAllRecords()).toHaveLength(12);
  });

  it('rejects unknown format or schemaVersion with a clear Spanish error', async () => {
    const fc = freshBrowser();
    const w = await startWorker(fc);
    const r1 = await w.send({ type: 'importJson', data: { format: 'otra-cosa', schemaVersion: 1, records: [] } });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Formato no reconocido/);
    const r2 = await w.send({ type: 'importJson', data: { format: 'fangio-export', schemaVersion: 2, records: [] } });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/schemaVersion 2/);
    expect(() => parseAndValidateImport('{no json')).toThrow(/JSON/);
  });

  it('malformed records are rejected individually', async () => {
    const { file } = await exportFrom();
    const bad = {
      ...file,
      records: [
        file.records[0],
        { ...file.records[1], url: 'not a url' },
        { ...file.records[2], state: 'deleted' },
        { id: 5 },
        'x',
        { ...file.records[0], id: 'dup-free', tags: 'notarray' },
      ],
    };
    const fc = freshBrowser();
    const w = await startWorker(fc);
    const res = await w.call({ type: 'importJson', data: bad });
    expect(res.added).toBe(1);
    expect(res.rejected.map((r: { index: number }) => r.index)).toEqual([1, 2, 3, 4, 5]);
    expect(await w.db.getAllRecords()).toHaveLength(1);
  });

  it('merge by id: the newest updatedAt wins, older is unchanged', async () => {
    const { file } = await exportFrom();
    const fc = freshBrowser();
    const w = await startWorker(fc);
    await w.call({ type: 'importJson', data: file });
    const target = file.records.find((r) => r.state === 'archived')!;
    const older = { ...file, records: [{ ...target, note: 'vieja', updatedAt: target.updatedAt - 1000 }] };
    expect(await w.call({ type: 'importJson', data: older })).toMatchObject({ unchanged: 1, updated: 0 });
    expect((await w.db.getRecord(target.id))!.note).not.toBe('vieja');
    const newer = { ...file, records: [{ ...target, note: 'nueva', updatedAt: Date.now() + 1000 }] };
    expect(await w.call({ type: 'importJson', data: newer })).toMatchObject({ updated: 1 });
    expect((await w.db.getRecord(target.id))!.note).toBe('nueva');
  });

  it('import never overwrites the state of a record that is open in this browser', async () => {
    const fc = freshBrowser();
    fc.seedTabs(2);
    const w = await startWorker(fc);
    await idle(w);
    const recs = await w.db.getAllRecords();
    const file = buildExport(recs, await w.db.getSettings(), [], '1');
    file.records[0] = { ...file.records[0]!, note: 'from backup', updatedAt: Date.now() + 5000 };
    await w.call({ type: 'importJson', data: JSON.parse(JSON.stringify(file)) });
    const r = (await w.db.getRecord(recs[0]!.id))!;
    expect(r.state).toBe('open');
    expect(r.live).toBeTruthy();
    expect(r.note).toBe('from backup');
  });

  it('bookmarks HTML escapes titles and URLs, one folder per state', () => {
    const base = { domain: 'a', protected: false, pending: false, tags: ['t'], project: '', note: 'n<b>', source: 'tracked' as const,
      createdAt: 1700000000000, updatedAt: 1, origin: {}, previousUrls: [], reopenCount: 0, mergedFrom: [], live: null, pendingClose: null, rev: 1 };
    const html = buildBookmarksHtml([
      { ...base, id: '1', url: 'https://a.com/?x=1&y="2"', title: '<script>alert("x")</script> & \'q\'', state: 'archived' },
      { ...base, id: '2', url: 'https://b.com/', title: 'B', state: 'trash' },
    ]);
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(html).toContain('HREF="https://a.com/?x=1&amp;y=&quot;2&quot;"');
    expect(html).toContain('>Archivadas</H3>');
    expect(html).toContain('>Papelera</H3>');
    expect(html).not.toContain('>Abiertas</H3>');
    expect(html).toContain('ADD_DATE="1700000000"');
    expect(html).toContain('<DD>n&lt;b&gt;');
  });
});
