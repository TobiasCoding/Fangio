// S9 — Duplicates: identical-URL tabs keep separate records (checked at install, S1);
// merge in #/duplicados through the UI, then undo it from #/registro.
import { checkInvariants, readState, waitSettled } from '../lib/checks.mjs';
import { checker, DASH, sleep, waitFor } from '../lib/fangio.mjs';

export default {
  title: 'Duplicados: registros separados, fusionar y deshacer (UI)',
  async run(ctx) {
    const c = checker();
    const { b, page } = ctx.shared.main;
    const p1 = ctx.shared.s9part1;
    c('identical-URL tabs got separate records at install (S1)', p1?.dupOk && p1.dupUrls > 0, p1);
    await page.goto(`${DASH}#/duplicados`);
    await page.front();
    const t0 = Date.now();
    await page.waitFor(() => document.querySelectorAll('.dup-group').length > 0, undefined, { timeout: 30000, label: 'duplicate groups' });
    const loadMs = Date.now() - t0;
    const pick = await page.eval(() => {
      const buttons = [...document.querySelectorAll('.dup-row button')].filter((x) => x.textContent.includes('Fusionar en este'));
      for (const card of document.querySelectorAll('.dup-group')) {
        const rows = [...card.querySelectorAll('.dup-row')];
        const nonOpen = rows.filter((r) => !r.querySelector('.badge-open'));
        if (nonOpen.length < 2) continue;
        const btn = [...nonOpen[0].querySelectorAll('button')].find((x) => x.textContent.includes('Fusionar en este'));
        if (!btn || btn.disabled) continue;
        return { url: card.querySelector('.dup-url').textContent.trim(), index: buttons.indexOf(btn), rows: rows.length, nonOpen: nonOpen.length };
      }
      return null;
    });
    c('a mergeable duplicate group is listed', !!pick, pick);
    if (!pick) return { checks: c.list, metrics: { loadMs } };
    const before = (await readState(b, { actions: false })).records.filter((r) => r.url === pick.url);
    await page.click('.dup-row button', { text: 'Fusionar en este', index: pick.index });
    await page.click('dialog[open] button[type=submit]');
    const merged = await waitFor(
      async () => {
        const rs = (await readState(b, { actions: false })).records.filter((r) => r.url === pick.url);
        const keep = rs.find((r) => r.mergedFrom?.length);
        return keep ? { rs, keep } : null;
      },
      { timeout: 30000, label: 'merge applied' },
    );
    const mergedAway = merged.rs.filter((r) => r.id !== merged.keep.id && before.find((x) => x.id === r.id)?.state !== 'open');
    c('merge keeps one record and sends the others to trash', mergedAway.length === pick.nonOpen - 1 &&
      mergedAway.every((r) => r.state === 'trash' && /Fusionada/.test(r.lastReason ?? '')), { kept: merged.keep.id, mergedAway: mergedAway.length });
    c('no record deleted by merge', merged.rs.length === before.length);
    // Undo from Registro
    await page.goto(`${DASH}#/registro`);
    await page.waitFor(() => document.querySelectorAll('.log-entry').length > 0, undefined, { label: 'log entries' });
    const first = await page.eval(() => document.querySelector('.log-entry .log-kind')?.textContent);
    await page.click('.log-entry button', { text: 'Deshacer', index: 0 });
    await sleep(300);
    if (await page.eval(() => !!document.querySelector('dialog[open]'))) await page.click('dialog[open] button[type=submit]');
    const undone = await waitFor(
      async () => {
        const rs = (await readState(b, { actions: false })).records.filter((r) => r.url === pick.url);
        return rs.every((r) => before.find((x) => x.id === r.id)?.state === r.state && !(r.mergedFrom?.length)) ? rs : null;
      },
      { timeout: 30000, label: 'merge undone' },
    ).catch(() => null);
    c('undo restores every merged record (state and mergedFrom)', !!undone, { firstLogEntry: first });
    await waitSettled(b);
    const st = await readState(b);
    const mergeAct = st.actions.find((a) => a.kind === 'merge');
    c('merge action logged, undoable and marked undone', mergeAct?.undoable && !!mergeAct.undoneAt, mergeAct);
    c.invariants('S9', checkInvariants(ctx.shared.original, st, { testCreated: ctx.shared.testCreated }));
    return { checks: c.list, metrics: { duplicatesViewLoadMs: loadMs, group: pick } };
  },
};
