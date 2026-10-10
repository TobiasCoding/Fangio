// S6 — Automation: target 15 open tabs, exact-URL rule for the server root (trash after
// 0 min), per-run cap. Preview must equal the result; protections are never closed.
import { resolve } from 'node:path';
import { freshProfile, helperId, launchBrowser } from '../lib/browser.mjs';
import { checkInvariants, readState, waitSettled, TRACKABLE } from '../lib/checks.mjs';
import { checker, installAndSnapshot, openDashboard, sendMsg, trackableTabs } from '../lib/fangio.mjs';

export default {
  title: 'Automatización: objetivo, regla de URL exacta, tope y protecciones',
  async run(ctx) {
    const c = checker();
    const { srv } = ctx;
    const root = `${srv.origin}/`;
    const local = `http://localhost:${srv.port}`;
    const w1 = Array.from({ length: 25 }, (_, i) => ({ url: `${srv.origin}/p/${5000 + i}` }));
    const w2 = Array.from({ length: 15 }, (_, i) => ({ url: `${srv.origin}/p/${6000 + i}` }));
    w1[3] = { url: root }; w1[9] = { url: root }; w2[4] = { url: root };
    w1[1].pinned = true; w2[1].pinned = true;
    w1[6] = { url: `${local}/p/1` }; w2[6] = { url: `${local}/p/2` };
    w1[2] = { url: `${root}?model=x` }; w1[4] = { url: `${root}#frag` }; // near-misses of the exact root rule
    const dir = freshProfile(resolve(ctx.profilesDir, 'automation'));
    const b = await launchBrowser({ profileDir: dir, loadExtensions: [ctx.helperPath], headless: ctx.headless });
    ctx.shared.cleanup = [...(ctx.shared.cleanup ?? []), () => b.close().catch(() => b.kill())];
    const helper = b.ext(await helperId(b));
    await helper.eval((s) => helper.build(s), { concurrency: 8, windows: [{ tabs: w1 }, { tabs: w2 }] });
    const { tabs } = await trackableTabs(helper);
    const original = tabs.map((t) => ({ url: t.url }));
    await installAndSnapshot(ctx, b, tabs.length);
    const page = await openDashboard(b, '#/reglas');
    await waitSettled(b);
    const st0 = await readState(b, { actions: false });
    const protIds = st0.records.filter((r) => r.url.includes('/p/5010') || r.url.includes('/p/6010')).map((r) => r.id);
    await sendMsg(page, { type: 'updateRecords', recordIds: protIds, edit: { protected: true } });
    const s = await sendMsg(page, { type: 'getSettings' });
    await sendMsg(page, { type: 'saveSettings', settings: {
      ...s, automationEnabled: true, targetOpenTabs: 15, targetMinIdleMinutes: 0, idleArchiveHours: 0, maxAutoClosePerRun: 20,
      siteExclusions: [...s.siteExclusions, 'localhost'],
      urlRules: [...s.urlRules, { id: 'e2e-root', enabled: true, url: root, action: 'trash', afterMinutes: 0, label: 'Raíz de prueba' }],
    } });
    await waitSettled(b);
    const before = await readState(b, { actions: false });
    const sid = before.sess.sessionId;
    const tabById = new Map(before.tabs.map((t) => [t.id, t]));
    const blockedIds = new Set(before.records.filter((r) => {
      const t = r.live?.sessionId === sid ? tabById.get(r.live.tabId) : null;
      return r.protected || (t && (t.pinned || t.active || new URL(t.url).hostname === 'localhost'));
    }).map((r) => r.id));
    const runs = [];
    for (let i = 1; i <= 2; i++) {
      const tp = Date.now();
      const preview = await sendMsg(page, { type: 'previewRules' });
      const previewMs = Date.now() - tp;
      const acting = preview.decisions.filter((d) => d.action !== 'keep');
      const tr = Date.now();
      const res = await sendMsg(page, { type: 'runRulesNow' });
      const runMs = Date.now() - tr;
      await waitSettled(b);
      const st = await readState(b);
      const done = new Set(res.done);
      const same = acting.length === done.size && acting.every((d) => done.has(d.recordId));
      c(`run ${i}: result equals the preview`, same && res.failed.length === 0, { preview: acting.length, done: done.size, skipped: res.skipped.length });
      c(`run ${i}: protections never closed (pinned/protected/active/site-excluded)`, [...done].every((id) => !blockedIds.has(id)));
      c(`run ${i}: per-run cap respected`, done.size <= 20, `${done.size} closed, capped=${preview.capped}`);
      const rootTrashed = acting.filter((d) => d.ruleId === 'e2e-root');
      c(`run ${i}: exact-URL rule trashes only exact root URLs`, rootTrashed.every((d) => d.url === root && st.records.find((r) => r.id === d.recordId)?.state === 'trash'), rootTrashed.length);
      const autoActs = st.actions.filter((a) => a.auto && (a.kind === 'archive' || a.kind === 'trash') && a.at >= tr);
      c(`run ${i}: reasons logged per rule`, autoActs.length > 0 && autoActs.every((a) => a.reason && a.ruleId), autoActs.map((a) => `${a.ruleId}: ${a.reason}`));
      runs.push({ previewMs, runMs, openBefore: preview.openCount, projected: preview.projectedOpenCount, acting: acting.length, capped: preview.capped,
        byRule: acting.reduce((m, d) => ((m[d.ruleId] = (m[d.ruleId] ?? 0) + 1), m), {}), openAfter: st.tabs.filter((t) => TRACKABLE.test(t.url)).length });
    }
    c('run 1 was capped (more than 20 candidates)', runs[0].capped && runs[0].acting === 20, runs[0]);
    c('after run 2 the open count reaches the target (protections may keep more)', runs[1].openAfter <= Math.max(15, blockedIds.size), runs[1]);
    const stEnd = await readState(b);
    const nearMiss = stEnd.records.filter((r) => r.url !== root && r.url.startsWith(root) && /^[?#]/.test(r.url.slice(root.length)));
    c('root URL with query/fragment never matched by the exact rule', nearMiss.length === 2 && nearMiss.every((r) => !/Raíz de prueba/.test(r.lastReason ?? '')), nearMiss.map((r) => [r.url, r.state, r.lastReason]));
    c.invariants('S6', checkInvariants(original, stEnd));
    await b.close().catch(() => b.kill());
    return { checks: c.list, metrics: { trackableTabs: tabs.length, blocked: blockedIds.size, runs } };
  },
};
