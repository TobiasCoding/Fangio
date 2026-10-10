import { describe, expect, it } from 'vitest';
import { blockReasons, evaluateRules, matchUrlRule } from '../src/core/rules';
import { canonicalUrl, domainOf, isTrackableUrl, matchesSiteExclusion, normalizeTags, sanitizeFavicon } from '../src/core/url';
import { defaultSettings } from '../src/shared/settings';
import type { Settings, TabRecord, UrlRule } from '../src/shared/types';

const NOW = 1_800_000_000_000;
const MIN = 60000;
const SID = 'sess';

let nextId = 1;
function tab(p: Partial<chrome.tabs.Tab> & { idleMin?: number } = {}): chrome.tabs.Tab {
  const id = p.id ?? nextId++;
  const { idleMin, ...rest } = p;
  return {
    id,
    windowId: 1,
    index: id,
    url: `https://site${id}.com/`,
    title: `t${id}`,
    pinned: false,
    active: false,
    highlighted: false,
    audible: false,
    incognito: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    selected: false,
    groupId: -1,
    lastAccessed: NOW - (idleMin ?? 0) * MIN,
    ...rest,
  } as chrome.tabs.Tab;
}
function recFor(t: chrome.tabs.Tab, p: Partial<TabRecord> = {}): TabRecord {
  return {
    id: `r${t.id}`,
    url: t.url!,
    title: t.title!,
    domain: domainOf(t.url!),
    state: 'open',
    protected: false,
    pending: false,
    tags: [],
    project: '',
    note: '',
    source: 'tracked',
    createdAt: NOW - 1e9,
    updatedAt: NOW,
    origin: {},
    previousUrls: [],
    reopenCount: 0,
    mergedFrom: [],
    live: { tabId: t.id!, windowId: 1, sessionId: SID, boundAt: NOW },
    pendingClose: null,
    rev: 1,
    ...p,
  };
}
function settings(p: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), targetOpenTabs: 1000, ...p };
}
function run(tabs: chrome.tabs.Tab[], recs: TabRecord[], s: Settings) {
  return evaluateRules({ tabs, records: recs, settings: s, now: NOW, sessionId: SID, extensionId: 'ext' });
}
const decisionOf = (p: ReturnType<typeof run>, t: chrome.tabs.Tab) => p.decisions.find((d) => d.tabId === t.id)!;

describe('exact URL rules', () => {
  const rule: UrlRule = { id: 'r', enabled: true, url: 'https://chatgpt.com/', action: 'trash', afterMinutes: 60 };
  it('match canonical form only', () => {
    expect(matchUrlRule('https://chatgpt.com', [rule])).toBeTruthy();
    expect(matchUrlRule('https://chatgpt.com/', [rule])).toBeTruthy();
    expect(matchUrlRule('https://CHATGPT.com/', [rule])).toBeTruthy();
    for (const u of ['https://chatgpt.com/c/123', 'https://chatgpt.com/?x=1', 'https://chatgpt.com/#frag', 'https://chat.openai.com/', 'http://chatgpt.com/']) {
      expect(matchUrlRule(u, [rule]), u).toBeUndefined();
    }
    expect(matchUrlRule('https://chatgpt.com/', [{ ...rule, url: 'https://chatgpt.com' }])).toBeTruthy();
    expect(matchUrlRule('https://chatgpt.com/', [{ ...rule, enabled: false }])).toBeUndefined();
  });
  it('apply only after afterMinutes without being viewed', () => {
    const s = settings({ urlRules: [rule], idleArchiveHours: 0 });
    const fresh = tab({ url: 'https://chatgpt.com/', idleMin: 30 });
    const old = tab({ url: 'https://chatgpt.com/', idleMin: 90 });
    const sub = tab({ url: 'https://chatgpt.com/c/123', idleMin: 900 });
    const p = run([fresh, old, sub], [recFor(fresh), recFor(old), recFor(sub)], s);
    expect(decisionOf(p, fresh).action).toBe('keep');
    expect(decisionOf(p, old).action).toBe('trash');
    expect(decisionOf(p, old).ruleId).toBe('r');
    expect(decisionOf(p, sub).action).toBe('keep');
  });
});

describe('idle rule', () => {
  it('archives tabs not viewed for idleArchiveHours with an explicit reason', () => {
    const t1 = tab({ idleMin: 26 * 60 });
    const t2 = tab({ idleMin: 23 * 60 });
    const p = run([t1, t2], [recFor(t1), recFor(t2)], settings({ idleArchiveHours: 24, urlRules: [] }));
    expect(decisionOf(p, t1).action).toBe('archive');
    expect(decisionOf(p, t1).reason).toBe('Archivada automáticamente: sin consultar hace 26 h (inactividad > 24 h)');
    expect(decisionOf(p, t2).action).toBe('keep');
  });
  it('uses the max of record.lastAccessedAt and tab.lastAccessed', () => {
    const t1 = tab({ idleMin: 48 * 60 });
    const p = run([t1], [recFor(t1, { lastAccessedAt: NOW - 5 * MIN })], settings({ idleArchiveHours: 24, urlRules: [] }));
    expect(decisionOf(p, t1).action).toBe('keep');
  });
});

describe('target rule', () => {
  it('archives the least recently viewed until the target, keeping recently viewed ones', () => {
    const tabs = Array.from({ length: 20 }, (_, i) => tab({ idleMin: (i + 1) * 10 })); // 10..200 min
    const p = run(tabs, tabs.map((t) => recFor(t)), settings({ targetOpenTabs: 15, targetMinIdleMinutes: 60, idleArchiveHours: 0, urlRules: [] }));
    const archived = p.decisions.filter((d) => d.action === 'archive');
    expect(archived).toHaveLength(5);
    expect(archived.every((d) => d.ruleId === 'target' && d.idleMinutes >= 160)).toBe(true);
    expect(p.projectedOpenCount).toBe(15);
  });
  it('respects targetMinIdleMinutes even if the target is exceeded', () => {
    const tabs = Array.from({ length: 20 }, (_, i) => tab({ idleMin: i })); // 0..19 min
    const p = run(tabs, tabs.map((t) => recFor(t)), settings({ targetOpenTabs: 5, targetMinIdleMinutes: 15, idleArchiveHours: 0, urlRules: [] }));
    expect(p.decisions.filter((d) => d.action === 'archive')).toHaveLength(5); // 15..19 min
    const kept = p.decisions.filter((d) => d.blockedBy?.includes('recently-viewed'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((d) => d.idleMinutes < 15)).toBe(true);
  });
  it('counts blocked and unbound trackable tabs towards the open count', () => {
    const pinned = Array.from({ length: 5 }, () => tab({ pinned: true, idleMin: 999 }));
    const unbound = Array.from({ length: 5 }, () => tab({ idleMin: 999 }));
    const normal = Array.from({ length: 3 }, () => tab({ idleMin: 999 }));
    const p = run([...pinned, ...unbound, ...normal], [...pinned, ...normal].map((t) => recFor(t)), settings({ targetOpenTabs: 11, idleArchiveHours: 0, urlRules: [] }));
    expect(p.openCount).toBe(13);
    expect(p.decisions.filter((d) => d.action === 'archive')).toHaveLength(2);
  });
});

describe('cap', () => {
  it('truncates to maxAutoClosePerRun, most idle first', () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab({ idleMin: 2000 + i * 100 }));
    const p = run(tabs, tabs.map((t) => recFor(t)), settings({ maxAutoClosePerRun: 3, idleArchiveHours: 24, urlRules: [] }));
    const acts = p.decisions.filter((d) => d.action !== 'keep');
    expect(acts).toHaveLength(3);
    expect(p.capped).toBe(true);
    expect(acts.map((d) => d.idleMinutes)).toEqual([2900, 2800, 2700]);
  });
});

describe('protections beat every rule', () => {
  const rule: UrlRule = { id: 'r', enabled: true, url: 'https://chatgpt.com/', action: 'trash', afterMinutes: 0 };
  const s = settings({ urlRules: [rule], idleArchiveHours: 1, targetOpenTabs: 1, targetMinIdleMinutes: 0 });
  const veryIdle = 100 * 60;
  const cases: [string, () => { t: chrome.tabs.Tab; r: TabRecord }][] = [
    ['protected', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle }); return { t, r: recFor(t, { protected: true }) }; }],
    ['pinned', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle, pinned: true }); return { t, r: recFor(t) }; }],
    ['active', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle, active: true }); return { t, r: recFor(t) }; }],
    ['highlighted', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle, highlighted: true }); return { t, r: recFor(t) }; }],
    ['audible', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle, audible: true }); return { t, r: recFor(t) }; }],
    ['recent-audio', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle }); return { t, r: recFor(t, { lastAudibleAt: NOW - 5 * MIN }) }; }],
    ['site-excluded', () => { const t = tab({ url: 'https://sub.docs.google.com/d/1', idleMin: veryIdle }); return { t, r: recFor(t) }; }],
    ['site-excluded', () => { const t = tab({ url: 'https://zoom.us/j/1', idleMin: veryIdle }); return { t, r: recFor(t) }; }],
    ['extension-page', () => { const t = tab({ url: 'chrome-extension://ext/dashboard.html', idleMin: veryIdle }); return { t, r: recFor(t, { url: 'https://x.com/' }) }; }],
    ['untrackable-url', () => { const t = tab({ url: 'chrome://settings/', idleMin: veryIdle }); return { t, r: recFor(t, { url: 'https://x.com/' }) }; }],
    ['pending-operation', () => { const t = tab({ url: 'https://chatgpt.com/', idleMin: veryIdle }); return { t, r: recFor(t, { pendingClose: { opId: 'o', tabId: t.id!, sessionId: SID, expectedUrl: t.url!, targetState: 'archived', reason: '', at: NOW } }) }; }],
  ];
  for (const [block, mk] of cases) {
    it(`${block} -> keep`, () => {
      const { t, r } = mk();
      const filler = Array.from({ length: 5 }, () => tab({ idleMin: veryIdle }));
      const p = run([t, ...filler], [r, ...filler.map((f) => recFor(f))], s);
      const d = decisionOf(p, t);
      expect(d.action).toBe('keep');
      expect(d.blockedBy).toContain(block);
      expect(p.decisions.filter((x) => x.action !== 'keep').length).toBe(5);
    });
  }
  it('incognito tabs are ignored entirely', () => {
    const t = tab({ incognito: true, idleMin: veryIdle });
    const p = run([t], [recFor(t)], s);
    expect(p.decisions).toHaveLength(0);
    expect(p.openCount).toBe(0);
  });
  it('recent audio grace expires', () => {
    const t = tab({ idleMin: veryIdle });
    const r = recFor(t, { lastAudibleAt: NOW - 11 * MIN });
    expect(blockReasons(t, r, settings({ audioGraceMinutes: 10 }), NOW, 'auto')).toEqual([]);
  });
  it('manual mode only refuses protected / unsafe pages', () => {
    const t = tab({ pinned: true, active: true, audible: true });
    expect(blockReasons(t, recFor(t), s, NOW, 'manual')).toEqual([]);
    expect(blockReasons(t, recFor(t, { protected: true }), s, NOW, 'manual')).toEqual(['protected']);
  });
});

describe('url helpers', () => {
  it('trackable urls', () => {
    for (const u of ['http://a.com', 'https://a.com/x', 'file:///C:/x.txt', 'ftp://h/x']) expect(isTrackableUrl(u)).toBe(true);
    for (const u of ['chrome://newtab/', 'about:blank', 'chrome-extension://abc/dashboard.html', 'data:text/plain,x', '', 'nonsense'])
      expect(isTrackableUrl(u)).toBe(false);
  });
  it('domain and canonical url', () => {
    expect(domainOf('https://WWW.Example.COM/x')).toBe('example.com');
    expect(canonicalUrl('https://Chatgpt.com')).toBe('https://chatgpt.com/');
    expect(canonicalUrl('https://a.com/x?y=1#z')).toBe('https://a.com/x?y=1#z');
    expect(canonicalUrl('not a url')).toBeNull();
  });
  it('site exclusions', () => {
    expect(matchesSiteExclusion('https://docs.google.com/d', ['docs.google.com'])).toBe(true);
    expect(matchesSiteExclusion('https://a.docs.google.com/d', ['docs.google.com'])).toBe(true);
    expect(matchesSiteExclusion('https://google.com/', ['docs.google.com'])).toBe(false);
    expect(matchesSiteExclusion('https://evil-docs.google.com.x.io/', ['docs.google.com'])).toBe(false);
    expect(matchesSiteExclusion('https://zoom.us/', ['*.zoom.us'])).toBe(true);
    expect(matchesSiteExclusion('https://us02web.zoom.us/j', ['*.zoom.us'])).toBe(true);
    expect(matchesSiteExclusion('https://notzoom.us/', ['*.zoom.us'])).toBe(false);
    expect(matchesSiteExclusion('https://docs.google.com/a', ['https://docs.google.com/x'])).toBe(true);
  });
  it('favicon and tags', () => {
    expect(sanitizeFavicon('https://a.com/f.ico')).toBe('https://a.com/f.ico');
    expect(sanitizeFavicon('data:image/png;base64,xxx')).toBeUndefined();
    expect(sanitizeFavicon('https://a.com/' + 'x'.repeat(3000))).toBeUndefined();
    expect(normalizeTags([' Work ', 'work', '', 'b', 3])).toEqual(['b', 'work']);
  });
});
