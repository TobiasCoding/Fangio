// In-memory fake of the chrome.* APIs used by Fangio's background, with events
// that can be fired and failure injection. Installed on globalThis.chrome.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (...args: any[]) => any;

export class FakeEvent<F extends Listener = Listener> {
  listeners: F[] = [];
  addListener(fn: F): void {
    this.listeners.push(fn);
  }
  removeListener(fn: F): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  hasListener(fn: F): boolean {
    return this.listeners.includes(fn);
  }
  hasListeners(): boolean {
    return this.listeners.length > 0;
  }
  fire(...args: Parameters<F>): unknown[] {
    return this.listeners.map((l) => l(...args));
  }
  clear(): void {
    this.listeners = [];
  }
}

export interface FTab {
  id: number;
  windowId: number;
  index: number;
  url: string;
  pendingUrl?: string;
  openerTabId?: number;
  title: string;
  favIconUrl?: string;
  pinned: boolean;
  active: boolean;
  highlighted: boolean;
  audible: boolean;
  incognito: boolean;
  discarded: boolean;
  frozen: boolean;
  autoDiscardable: boolean;
  selected: boolean;
  lastAccessed: number;
  groupId: number;
  status: 'loading' | 'complete' | 'unloaded';
}

export interface FWindow {
  id: number;
  type: 'normal' | 'popup' | 'app' | 'devtools';
  focused: boolean;
  incognito: boolean;
  tabIds: number[];
}

export interface FGroup {
  id: number;
  windowId: number;
  title?: string;
  color: string;
  collapsed: boolean;
}

export interface FakeChromeOptions {
  extensionId?: string;
  version?: string;
}

const copy = <T>(x: T): T => structuredClone(x);

const BS = String.fromCharCode(92);

function globMatch(url: string, pattern: string): boolean {
  if (!pattern.includes('*')) return url === pattern;
  const esc = (s: string) => [...s].map((c) => ('.+?^${}()|[]/' + BS).includes(c) ? BS + c : c).join('');
  const re = new RegExp('^' + pattern.split('*').map(esc).join('.*') + '$');
  return re.test(url);
}

export class FakeChrome {
  extensionId: string;
  version: string;
  tabs = new Map<number, FTab>();
  windows = new Map<number, FWindow>();
  groups = new Map<number, FGroup>();
  nextTabId = 1;
  nextWindowId = 1;
  nextGroupId = 1;
  lastFocusedWindowId: number | null = null;
  sessionStore: Record<string, unknown> = {};
  localStore: Record<string, unknown> = {};
  alarms = new Map<string, chrome.alarms.Alarm>();
  badgeText = '';
  reloadCount = 0;

  /** Chronological log of side-effecting calls (tabs.create / tabs.remove / ...). */
  log: string[] = [];
  createCalls: chrome.tabs.CreateProperties[] = [];
  removeCalls: number[][] = [];
  discardCalls: number[] = [];

  // ---- failure injection / behavior knobs
  /** tabs.remove rejects for any call that includes one of these ids. */
  failRemove = new Set<number>();
  /** Emulate a partial batch failure: tabs before the failing id are closed, then reject. */
  partialRemoveFailure = false;
  /** tabs.create rejects for these urls. */
  failCreateUrls = new Set<string>();
  /** Called (and awaited) at the beginning of every tabs.remove. */
  removeHook: ((ids: number[]) => void | Promise<void>) | null = null;
  /** Created tabs reach status 'complete' after this many ms (null = never, i.e. load timeout). */
  loadDelayMs: number | null = 2;
  /** tabs.discard returns a tab with a new id (and fires onReplaced). */
  discardReplacesId = false;
  /** Number of tabs currently loading after tabs.create, and the max observed. */
  loadingNow = 0;
  maxLoading = 0;

  ev = {
    tabs: {
      onCreated: new FakeEvent(),
      onUpdated: new FakeEvent(),
      onActivated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      onReplaced: new FakeEvent(),
      onAttached: new FakeEvent(),
      onDetached: new FakeEvent(),
      onHighlighted: new FakeEvent(),
      onMoved: new FakeEvent(),
    },
    windows: { onRemoved: new FakeEvent(), onCreated: new FakeEvent(), onFocusChanged: new FakeEvent() },
    runtime: { onInstalled: new FakeEvent(), onStartup: new FakeEvent(), onMessage: new FakeEvent() },
    alarms: { onAlarm: new FakeEvent() },
    commands: { onCommand: new FakeEvent() },
  };

  api: any;

  constructor(opts: FakeChromeOptions = {}) {
    this.extensionId = opts.extensionId ?? 'fangiotestextensionid';
    this.version = opts.version ?? '1.2.0';
    this.api = this.buildApi();
  }

  allEvents(): FakeEvent[] {
    return Object.values(this.ev).flatMap((g) => Object.values(g) as FakeEvent[]);
  }
  /** Simulates the worker going away: every registered listener is dropped. */
  clearListeners(): void {
    for (const e of this.allEvents()) e.clear();
  }

  // ------------------------------------------------------------------ state helpers

  addWindow(opts: Partial<Pick<FWindow, 'type' | 'incognito' | 'focused'>> = {}): number {
    const id = this.nextWindowId++;
    const w: FWindow = { id, type: opts.type ?? 'normal', focused: opts.focused ?? true, incognito: !!opts.incognito, tabIds: [] };
    if (w.focused) {
      for (const o of this.windows.values()) o.focused = false;
      this.lastFocusedWindowId = id;
    }
    this.windows.set(id, w);
    return id;
  }

  private reindex(windowId: number): void {
    const w = this.windows.get(windowId);
    if (!w) return;
    w.tabIds.forEach((id, i) => {
      const t = this.tabs.get(id);
      if (t) t.index = i;
    });
  }

  private defaultWindow(): number {
    if (this.lastFocusedWindowId !== null && this.windows.has(this.lastFocusedWindowId)) return this.lastFocusedWindowId;
    const first = [...this.windows.values()].find((w) => w.type === 'normal');
    return first ? first.id : this.addWindow();
  }

  /** Adds a tab directly (silent = no onCreated event, e.g. tabs that existed before install). */
  addTab(p: Partial<FTab> = {}, opts: { silent?: boolean } = {}): FTab {
    const windowId = p.windowId ?? this.defaultWindow();
    const w = this.windows.get(windowId) ?? this.windows.get(this.addWindow())!;
    const t: FTab = {
      id: p.id ?? this.nextTabId++,
      windowId: w.id,
      index: 0,
      url: p.url ?? 'https://example.com/',
      title: p.title ?? p.url ?? 'Example',
      pinned: false,
      active: false,
      highlighted: false,
      audible: false,
      incognito: w.incognito,
      discarded: false,
      frozen: false,
      autoDiscardable: true,
      selected: false,
      lastAccessed: Date.now(),
      groupId: -1,
      status: 'complete',
      ...p,
    } as FTab;
    if (p.id !== undefined && p.id >= this.nextTabId) this.nextTabId = p.id + 1;
    t.windowId = w.id;
    if (t.active) for (const id of w.tabIds) this.tabs.get(id)!.active = false;
    this.tabs.set(t.id, t);
    w.tabIds.push(t.id);
    this.reindex(w.id);
    if (!opts.silent) this.ev.tabs.onCreated.fire(copy(t));
    return t;
  }

  /** n silent tabs (one window by default). */
  seedTabs(n: number, url: (i: number) => string = (i) => `https://site${i}.example.com/page?i=${i}`, p: Partial<FTab> = {}): FTab[] {
    const out: FTab[] = [];
    for (let i = 0; i < n; i++) out.push(this.addTab({ url: url(i), title: `Tab ${i}`, lastAccessed: Date.now() - 1000 * i, ...p }, { silent: true }));
    return out;
  }

  private removeTabInternal(id: number, isWindowClosing?: boolean): void {
    const t = this.tabs.get(id);
    if (!t) return;
    const w = this.windows.get(t.windowId)!;
    w.tabIds = w.tabIds.filter((x) => x !== id);
    this.tabs.delete(id);
    this.reindex(w.id);
    const closingWindow = isWindowClosing ?? w.tabIds.length === 0;
    if (t.active && w.tabIds.length > 0) this.tabs.get(w.tabIds[Math.min(t.index, w.tabIds.length - 1)]!)!.active = true;
    this.ev.tabs.onRemoved.fire(id, { windowId: w.id, isWindowClosing: closingWindow });
    if (w.tabIds.length === 0) {
      this.windows.delete(w.id);
      if (this.lastFocusedWindowId === w.id) this.lastFocusedWindowId = [...this.windows.keys()][0] ?? null;
      this.ev.windows.onRemoved.fire(w.id);
    }
  }

  /** The user closes a tab (X button). */
  userCloseTab(id: number): void {
    this.removeTabInternal(id, false);
  }

  /** The user closes a whole window. */
  closeWindow(windowId: number): void {
    const w = this.windows.get(windowId);
    if (!w) return;
    for (const id of [...w.tabIds]) this.removeTabInternal(id, true);
  }

  navigate(tabId: number, url: string, title?: string): void {
    const t = this.tabs.get(tabId);
    if (!t) throw new Error('no tab');
    t.url = url;
    t.status = 'loading';
    this.ev.tabs.onUpdated.fire(tabId, { status: 'loading', url }, copy(t));
    t.status = 'complete';
    if (title !== undefined) t.title = title;
    this.ev.tabs.onUpdated.fire(tabId, { status: 'complete', ...(title !== undefined ? { title } : {}) }, copy(t));
  }

  activate(tabId: number): void {
    const t = this.tabs.get(tabId)!;
    for (const id of this.windows.get(t.windowId)!.tabIds) this.tabs.get(id)!.active = false;
    t.active = true;
    t.lastAccessed = Date.now();
    this.ev.tabs.onActivated.fire({ tabId, windowId: t.windowId });
  }

  setAudible(tabId: number, audible: boolean): void {
    const t = this.tabs.get(tabId)!;
    t.audible = audible;
    this.ev.tabs.onUpdated.fire(tabId, { audible }, copy(t));
  }

  /** Browser restart: same URLs come back with NEW tab/window ids; storage.session is cleared; listeners dropped. */
  restartBrowser(opts: { restore?: boolean; restartIdsFrom?: number } = {}): void {
    const old = [...this.windows.values()].map((w) => ({ w, tabs: w.tabIds.map((id) => this.tabs.get(id)!) }));
    this.tabs.clear();
    this.windows.clear();
    this.groups.clear();
    this.sessionStore = {};
    this.clearListeners();
    if (opts.restartIdsFrom !== undefined) this.nextTabId = opts.restartIdsFrom;
    if (opts.restore === false) {
      this.addWindow();
      this.addTab({ url: 'chrome://newtab/', title: 'Nueva pestaña', active: true }, { silent: true });
      return;
    }
    for (const { tabs } of old) {
      const wid = this.addWindow();
      for (const t of tabs) {
        const { id: _id, windowId: _w, index: _i, groupId: _g, ...rest } = t;
        this.addTab({ ...rest, windowId: wid }, { silent: true });
      }
    }
  }

  /** Extension reload/update: storage.session cleared, listeners dropped; tabs (and ids) stay. */
  reloadExtension(): void {
    this.sessionStore = {};
    this.clearListeners();
  }

  normalTabCount(): number {
    let n = 0;
    for (const t of this.tabs.values()) if (this.windows.get(t.windowId)?.type === 'normal') n++;
    return n;
  }

  // ------------------------------------------------------------------ chrome.tabs

  private queryTabs(q: chrome.tabs.QueryInfo = {}): FTab[] {
    let list = [...this.tabs.values()];
    const focused = this.lastFocusedWindowId;
    if (q.active !== undefined) list = list.filter((t) => t.active === q.active);
    if (q.pinned !== undefined) list = list.filter((t) => t.pinned === q.pinned);
    if (q.audible !== undefined) list = list.filter((t) => t.audible === q.audible);
    if (q.highlighted !== undefined) list = list.filter((t) => t.highlighted === q.highlighted);
    if (q.discarded !== undefined) list = list.filter((t) => t.discarded === q.discarded);
    if (q.status !== undefined) list = list.filter((t) => t.status === q.status);
    if (q.windowId !== undefined) list = list.filter((t) => t.windowId === q.windowId);
    if (q.groupId !== undefined) list = list.filter((t) => t.groupId === q.groupId);
    if (q.lastFocusedWindow || q.currentWindow) list = list.filter((t) => t.windowId === focused);
    if (q.windowType !== undefined) list = list.filter((t) => this.windows.get(t.windowId)?.type === q.windowType);
    if (q.url !== undefined) {
      const pats = Array.isArray(q.url) ? q.url : [q.url];
      list = list.filter((t) => pats.some((p) => globMatch(t.url, p)));
    }
    return list.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  }

  private async createTab(props: chrome.tabs.CreateProperties): Promise<FTab> {
    this.log.push(`tabs.create:${props.url ?? ''}`);
    this.createCalls.push({ ...props });
    if (props.url && this.failCreateUrls.has(props.url)) throw new Error(`Cannot navigate to ${props.url}`);
    const windowId = props.windowId ?? this.defaultWindow();
    if (!this.windows.has(windowId)) throw new Error(`No window with id: ${windowId}.`);
    const target = props.url ?? 'chrome://newtab/';
    const t = this.addTab(
      {
        windowId,
        url: '',
        pendingUrl: target,
        title: '',
        status: 'loading',
        active: props.active ?? true,
        pinned: props.pinned ?? false,
        lastAccessed: Date.now(),
      },
      { silent: true },
    );
    this.ev.tabs.onCreated.fire(copy(t));
    this.loadingNow++;
    this.maxLoading = Math.max(this.maxLoading, this.loadingNow);
    const finish = () => {
      const cur = this.tabs.get(t.id);
      this.loadingNow--;
      if (!cur) return;
      cur.url = target;
      delete cur.pendingUrl;
      this.ev.tabs.onUpdated.fire(cur.id, { status: 'loading', url: target }, copy(cur));
      cur.status = 'complete';
      cur.title = `Title of ${target}`;
      this.ev.tabs.onUpdated.fire(cur.id, { status: 'complete', title: cur.title }, copy(cur));
    };
    if (this.loadDelayMs !== null) setTimeout(finish, this.loadDelayMs);
    return copy(t);
  }

  private async removeTabs(ids: number | number[]): Promise<void> {
    const list = Array.isArray(ids) ? ids : [ids];
    this.log.push(`tabs.remove:${list.join(',')}`);
    this.removeCalls.push([...list]);
    if (this.removeHook) await this.removeHook(list);
    if (this.partialRemoveFailure) {
      for (const id of list) {
        if (!this.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        if (this.failRemove.has(id)) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
        this.removeTabInternal(id);
      }
      return;
    }
    for (const id of list) if (!this.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
    for (const id of list) if (this.failRemove.has(id)) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    for (const id of list) this.removeTabInternal(id);
  }

  private async discardTab(id: number): Promise<FTab> {
    this.discardCalls.push(id);
    const t = this.tabs.get(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    if (t.active) throw new Error('Cannot discard the active tab');
    if (t.discarded) throw new Error('Tab already discarded');
    t.discarded = true;
    t.status = 'unloaded';
    if (this.discardReplacesId) {
      const w = this.windows.get(t.windowId)!;
      const newId = this.nextTabId++;
      this.tabs.delete(id);
      t.id = newId;
      this.tabs.set(newId, t);
      w.tabIds = w.tabIds.map((x) => (x === id ? newId : x));
      this.ev.tabs.onReplaced.fire(newId, id);
    }
    return copy(t);
  }

  private async updateTab(id: number, props: chrome.tabs.UpdateProperties): Promise<FTab> {
    const t = this.tabs.get(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    if (props.active) this.activate(id);
    if (props.pinned !== undefined) t.pinned = props.pinned;
    if (props.highlighted !== undefined) t.highlighted = props.highlighted;
    if (props.url !== undefined) this.navigate(id, props.url);
    return copy(t);
  }

  private async groupTabs(o: chrome.tabs.GroupOptions): Promise<number> {
    if (o.groupId !== undefined && o.createProperties) throw new Error('Cannot specify createProperties along with a groupId.');
    const ids = Array.isArray(o.tabIds) ? o.tabIds : o.tabIds !== undefined ? [o.tabIds] : [];
    let gid = o.groupId;
    if (gid === undefined) {
      gid = this.nextGroupId++;
      const wid = o.createProperties?.windowId ?? this.tabs.get(ids[0]!)!.windowId;
      this.groups.set(gid, { id: gid, windowId: wid, color: 'grey', collapsed: false });
    } else if (!this.groups.has(gid)) throw new Error(`No group with id: ${gid}.`);
    for (const id of ids) {
      const t = this.tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}.`);
      t.groupId = gid;
    }
    return gid;
  }

  // ------------------------------------------------------------------ api object

  private storageArea(get: () => Record<string, unknown>, set: (v: Record<string, unknown>) => void) {
    return {
      get: async (keys?: string | string[] | Record<string, unknown> | null) => {
        const store = get();
        if (keys === undefined || keys === null) return copy(store);
        if (typeof keys === 'string') return keys in store ? { [keys]: copy(store[keys]) } : {};
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in store) out[k] = copy(store[k]);
          return out;
        }
        const out: Record<string, unknown> = {};
        for (const [k, def] of Object.entries(keys)) out[k] = k in store ? copy(store[k]) : def;
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        set({ ...get(), ...copy(items) });
      },
      remove: async (keys: string | string[]) => {
        const s = { ...get() };
        for (const k of Array.isArray(keys) ? keys : [keys]) delete s[k];
        set(s);
      },
      clear: async () => set({}),
    };
  }

  private buildApi(): any {
    const self = this;
    const winOut = (w: FWindow) => ({ id: w.id, type: w.type, focused: w.focused, incognito: w.incognito, state: 'normal', alwaysOnTop: false });
    return {
      tabs: {
        TAB_ID_NONE: -1,
        ...this.ev.tabs,
        query: async (q: chrome.tabs.QueryInfo) => self.queryTabs(q).map(copy),
        get: async (id: number) => {
          const t = self.tabs.get(id);
          if (!t) throw new Error(`No tab with id: ${id}.`);
          return copy(t);
        },
        create: (p: chrome.tabs.CreateProperties) => self.createTab(p),
        remove: (ids: number | number[]) => self.removeTabs(ids),
        update: (id: number, p: chrome.tabs.UpdateProperties) => self.updateTab(id, p),
        discard: (id: number) => self.discardTab(id),
        group: (o: chrome.tabs.GroupOptions) => self.groupTabs(o),
        ungroup: async (ids: number | number[]) => {
          for (const id of Array.isArray(ids) ? ids : [ids]) {
            const t = self.tabs.get(id);
            if (t) t.groupId = -1;
          }
        },
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        query: async (q: { windowId?: number; title?: string } = {}) =>
          [...self.groups.values()]
            .filter((g) => (q.windowId === undefined || g.windowId === q.windowId) && (q.title === undefined || g.title === q.title))
            .map(copy),
        get: async (id: number) => {
          const g = self.groups.get(id);
          if (!g) throw new Error(`No group with id: ${id}.`);
          return copy(g);
        },
        update: async (id: number, p: { title?: string; color?: string; collapsed?: boolean }) => {
          const g = self.groups.get(id);
          if (!g) throw new Error(`No group with id: ${id}.`);
          Object.assign(g, p);
          return copy(g);
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        WINDOW_ID_CURRENT: -2,
        ...this.ev.windows,
        get: async (id: number) => {
          const w = self.windows.get(id);
          if (!w) throw new Error(`No window with id: ${id}.`);
          return winOut(w);
        },
        getAll: async (q: { windowTypes?: string[] } = {}) =>
          [...self.windows.values()].filter((w) => !q.windowTypes || q.windowTypes.includes(w.type)).map(winOut),
        getLastFocused: async (q: { windowTypes?: string[] } = {}) => {
          const cands = [...self.windows.values()].filter((w) => !q.windowTypes || q.windowTypes.includes(w.type));
          const w = cands.find((x) => x.id === self.lastFocusedWindowId) ?? cands[0];
          if (!w) throw new Error('No last-focused window');
          return winOut(w);
        },
        create: async (p: { url?: string; focused?: boolean } = {}) => {
          const id = self.addWindow({ focused: p.focused ?? true });
          self.addTab({ windowId: id, url: p.url ?? 'chrome://newtab/', title: 'Nueva pestaña', active: true });
          return winOut(self.windows.get(id)!);
        },
        update: async (id: number, p: { focused?: boolean }) => {
          const w = self.windows.get(id);
          if (!w) throw new Error(`No window with id: ${id}.`);
          if (p.focused) {
            for (const o of self.windows.values()) o.focused = false;
            w.focused = true;
            self.lastFocusedWindowId = id;
          }
          return winOut(w);
        },
      },
      storage: {
        session: this.storageArea(
          () => self.sessionStore,
          (v) => (self.sessionStore = v),
        ),
        local: this.storageArea(
          () => self.localStore,
          (v) => (self.localStore = v),
        ),
      },
      alarms: {
        ...this.ev.alarms,
        create: async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
          const a: chrome.alarms.Alarm = {
            name,
            persistAcrossSessions: true,
            scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000,
          };
          if (info.periodInMinutes !== undefined) a.periodInMinutes = info.periodInMinutes;
          self.alarms.set(name, a);
        },
        get: async (name: string) => (self.alarms.has(name) ? copy(self.alarms.get(name)!) : undefined),
        getAll: async () => [...self.alarms.values()].map(copy),
        clear: async (name: string) => self.alarms.delete(name),
        clearAll: async () => {
          self.alarms.clear();
          return true;
        },
      },
      runtime: {
        id: this.extensionId,
        lastError: undefined,
        ...this.ev.runtime,
        getManifest: () => ({ manifest_version: 3, name: 'Fangio', version: self.version }),
        getURL: (p: string) => `chrome-extension://${self.extensionId}/${p.replace(/^\//, '')}`,
        reload: () => {
          self.reloadCount++;
        },
        sendMessage: (msg: unknown) => self.sendMessage(msg),
      },
      action: {
        setBadgeText: async (d: { text: string }) => {
          self.badgeText = d.text;
        },
        getBadgeText: async () => self.badgeText,
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
      },
      commands: { ...this.ev.commands },
    };
  }

  /** Delivers a message to runtime.onMessage listeners like the UI would; resolves with the response. */
  sendMessage(msg: unknown): Promise<any> {
    return new Promise((resolve) => {
      let answered = false;
      const sendResponse = (r: unknown) => {
        if (!answered) {
          answered = true;
          resolve(r);
        }
      };
      const results = this.ev.runtime.onMessage.fire(msg, { id: this.extensionId }, sendResponse);
      if (!results.some((r) => r === true) && !answered) resolve(undefined);
    });
  }
}

export function installFakeChrome(opts: FakeChromeOptions = {}): FakeChrome {
  const fc = new FakeChrome(opts);
  (globalThis as any).chrome = fc.api;
  return fc;
}
