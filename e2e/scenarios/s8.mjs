// S8 — Resource use: working set / private bytes of the whole Chromium process tree
// measured at each phase (collected by S1/S2/S3), plus Fangio's own extension process
// and the dashboard's JS heap. Measured on THIS machine with Playwright's Chromium.
import { processTree } from '../lib/mem.mjs';
import { checker } from '../lib/fangio.mjs';

export default {
  title: 'Uso de recursos (memoria del árbol de procesos)',
  async run(ctx) {
    const c = checker();
    const main = ctx.shared.main;
    const out = { phases: ctx.memory.map((m) => ({ label: m.label, processes: m.processes, workingSetMB: m.workingSetMB, privateMB: m.privateMB, byType: m.byType })) };
    if (main?.b && !main.b.exited) {
      out.browserVersion = await main.b.version();
      const t = processTree(main.b.pid);
      const ext = t.procs.filter((p) => p.type === 'extension');
      out.extensionProcessesNow = ext;
      if (main.page) {
        const h = await main.page.jsHeap().catch(() => null);
        if (h) out.dashboardJsHeapMB = Math.round((h.usedJSHeap / 1048576) * 10) / 10;
      }
    }
    out.fangioExtensionProcessAtInstallMB = ctx.done.s1?.metrics?.fangioExtensionProcessMB;
    const before = ctx.memory.find((m) => m.label.startsWith('S2 antes'));
    const after = ctx.memory.find((m) => m.label.startsWith('S2 después'));
    c('memory measured before and after the mass archive', !!before && !!after, { before: before?.workingSetMB, after: after?.workingSetMB });
    c('Fangio extension process stays small (< 150 MB working set)', (out.fangioExtensionProcessAtInstallMB ?? 0) < 150, `${out.fangioExtensionProcessAtInstallMB} MB`);
    return { checks: c.list, metrics: out };
  },
};
