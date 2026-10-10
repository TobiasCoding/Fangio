// Memory of a Chromium process tree on Windows (Win32_Process via PowerShell/CIM).
// Sums WorkingSetSize and PrivatePageCount over the root process and all descendants.
import { execFileSync } from 'node:child_process';

function listProcesses() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
    'Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (!out.trim()) return [];
  const j = JSON.parse(out);
  return Array.isArray(j) ? j : [j];
}

function typeOf(cmd = '') {
  const m = /--type=([\w-]+)/.exec(cmd);
  if (!m) return 'browser';
  if (m[1] === 'renderer' && cmd.includes('--extension-process')) return 'extension';
  return m[1];
}

/** { summary: { processes, workingSetMB, privateMB, byType }, procs } for rootPid's tree. */
export function processTree(rootPid) {
  if (process.platform !== 'win32') return { summary: { unsupported: true }, procs: [] };
  const all = listProcesses();
  const children = new Map();
  for (const p of all) {
    if (!children.has(p.ParentProcessId)) children.set(p.ParentProcessId, []);
    children.get(p.ParentProcessId).push(p);
  }
  const tree = [];
  const root = all.find((p) => p.ProcessId === rootPid);
  const stack = root ? [root] : [];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.ProcessId)) continue;
    seen.add(p.ProcessId);
    tree.push(p);
    for (const c of children.get(p.ProcessId) ?? []) stack.push(c);
  }
  const mb = (x) => Math.round((x / 1048576) * 10) / 10;
  const byType = {};
  let ws = 0;
  let priv = 0;
  const procs = tree.map((p) => {
    const type = typeOf(p.CommandLine);
    const w = Number(p.WorkingSetSize) || 0;
    const pv = Number(p.PrivatePageCount) || 0;
    ws += w;
    priv += pv;
    byType[type] ??= { n: 0, workingSetMB: 0 };
    byType[type].n++;
    byType[type].workingSetMB = mb(byType[type].workingSetMB * 1048576 + w);
    return { pid: p.ProcessId, type, workingSetMB: mb(w), privateMB: mb(pv) };
  });
  return { summary: { processes: tree.length, workingSetMB: mb(ws), privateMB: mb(priv), byType }, procs };
}
