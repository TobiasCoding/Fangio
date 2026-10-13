# API verification (Chrome MV3) for Fangio

**Verification date:** 2026-10-10. Sources are the official documentation on developer.chrome.com, MDN and GitHub Docs.
**Verdicts:** Confirmed / Contradicted / Partial / Undocumented. "Undocumented" means the official documentation doesn't say. Anything in parentheses as "observed behavior" is not a contract, so the code must be defensive.

## Summary table

| # | Assumption | Verdict | Source |
|---|---|---|---|
| 1 | `tabs.Tab` fields and their versions | Confirmed (with caveats) | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 2 | `query` doesn't load tabs; `remove(array)`; closing the last tab | Partial / Undocumented | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 3 | `onRemoved`, `onReplaced`, `onActivated`, `onUpdated` | Confirmed; browser shutdown is undocumented | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 4 | `discard` and `create` restrictions | Partial | [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs) |
| 5 | `tabGroups` and `tabs.group` | Confirmed | [tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups) |
| 6 | Alarms: 30 s minimum and persistence | Partial (there is a change in Chrome 150) | [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms) |
| 7 | `storage.session` | Confirmed | [storage](https://developer.chrome.com/docs/extensions/reference/api/storage) |
| 8 | Service worker lifecycle | Confirmed; BroadcastChannel is undocumented for extensions | [lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) |
| 9 | `favicon` permission and `_favicon` | Confirmed; the origin (cache or network) is undocumented | [favicons](https://developer.chrome.com/docs/extensions/how-to/ui/favicons) |
| 10 | `unlimitedStorage` and IndexedDB | Confirmed; deletion and reload, partial | [storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) |
| 11 | Manifest `key` field | Confirmed; risks are undocumented | [key](https://developer.chrome.com/docs/extensions/reference/manifest/key) |
| 12 | IndexedDB durability | Confirmed (default `relaxed` since Chrome 121) | [blog](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed) |
| 13 | Auto-update outside the store on Windows | **Contradicted** | [install-extensions](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions) |
| 14 | `onStartup` and `onInstalled` | Confirmed / Partial | [runtime](https://developer.chrome.com/docs/extensions/reference/api/runtime) |
| 15 | Command shortcuts: at most 4 and Alt+Shift+letter | Confirmed | [commands](https://developer.chrome.com/docs/extensions/reference/api/commands) |
| 16 | `incognito: "not_allowed"` | Confirmed | [incognito](https://developer.chrome.com/docs/extensions/reference/manifest/incognito) |
| 17 | `fetch` to api.github.com without `host_permissions` | Confirmed (via CORS) | [GitHub CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests) |

## Notes per item

**1. Tab.** With the `tabs` permission (or with host permissions), `url`, `title`, `favIconUrl` and `pendingUrl` are exposed (Chrome 79+, only while a navigation is pending). Minimum versions of other fields: `discarded` and `autoDiscardable` since 54, `groupId` since 88, `mutedInfo` since 46, `audible` since 45, **`frozen` since Chrome 132** and **`lastAccessed` since Chrome 121** (in ms epoch). There is also `splitViewId` since 140. `TabStatus` is `unloaded`, `loading` or `complete`. Caveats:
- `url` is the last committed URL and **can be `""`** if there has been no commit yet. `favIconUrl` can be `""` while the tab loads.
- `id` is optional and is unique **only within the session**.
- The documentation doesn't explicitly say that url and title are available on discarded or unloaded tabs. It only says the tab stays in the tab strip.
- *Implication:* fall back to `url || pendingUrl` and drop entries without a URL. Never persist `tab.id` as a stable key across sessions.

**2. query and remove.** The documentation doesn't say whether `query` activates or reloads tabs, though nothing suggests it does. Without the permission, the `url` and `title` filters are ignored. `remove(number | number[])` accepts an array (Chrome 88+), but **doesn't document what happens with an invalid id**. Observed behavior: the error rejects the promise and earlier tabs in the array may already be closed. Whether the browser closes when the last tab of the last window is removed is also undocumented. *Implication:* query the ids again right before closing. Close in error-tolerant batches, with a one-by-one fallback. Before archiving every tab, create a replacement tab (for example, the Fangio page).

**3. Events.** `onRemoved` includes `{isWindowClosing, windowId}`, and `isWindowClosing` is true if the tab was closed because its window was closed. **Whether it fires when the browser closes is undocumented.** `onReplaced(addedTabId, removedTabId)` fires on prerender or instant navigation. `onActivated` includes `{tabId, windowId}`. `changeInfo` can carry url, title (48+), favIconUrl, audible, status, discarded, frozen (132+), groupId, pinned, mutedInfo and autoDiscardable. *Implication:* don't rely on `onRemoved` during shutdown. Reconcile with `tabs.query` in `onStartup` and remap ids in `onReplaced`.

**4. discard and create.** `discard(tabId)` discards the tab unless it is **active or already discarded**. It can fail if there are no discardable tabs. Tabs that are still loading are undocumented. The documentation doesn't say whether the id changes, so it's better to use the returned Tab. `create` requires a URL with a scheme. `active` defaults to true and `index` is clamped to the valid range. `javascript:` URLs are not supported in `update`. **`file://`:** the official documentation doesn't cover it. According to the announcement in the chromium-extensions group, since Chrome 118 it only works if the user enables "Allow access to file URLs". Restrictions on `chrome://` are undocumented. *Implication:* restore in a per-tab try/catch and, if it fails, show the URL so the user can copy it.

**5. tabGroups.** Requires the `tabGroups` permission (MV3, Chrome 89+). Methods: `get`, `query`, `update` and `move`. Colors: grey, blue, red, yellow, green, pink, purple, cyan and orange. `TabGroup` has `collapsed`, `color`, `id`, `title?`, `windowId` and `shared` (137+). `TAB_GROUP_ID_NONE` is -1. In `tabs.group({tabIds, groupId?, createProperties:{windowId}})`, **`groupId` cannot be combined with `createProperties`**.

**6. alarms.** A value below 0.5 min is not honored and produces a warning. The lifecycle page places the 30 s minimum at Chrome 120. Unpacked extensions have no limit. **Since Chrome 150** there is `persistAcrossSessions`, which defaults to true in Chrome. With true, the alarm persists until the extension is updated. With false, it is cleared on reload or browser restart. Before 150 the behavior was "unpredictable". *Implication:* in `onStartup` and `onInstalled`, call `alarms.get()` and recreate the alarm if it is missing. Alarms are lost on update.

**7. storage.session.** Lives in memory. It is cleared when the extension is **disabled, reloaded or updated, and when the browser restarts**. The quota is 10 MB (1 MB up to Chrome 111). Needs the `storage` permission. By default it isn't exposed to content scripts (only to trusted contexts), which can be changed with `setAccessLevel`.

**8. Service worker.** Terminated after 30 s idle. Events and extension API calls reset the timer; API calls count since Chrome 110. A single request lasting more than 5 min terminates the SW, as does a `fetch` response taking more than 30 s. Global variables are lost. Listeners must be registered synchronously at the top level (see [events](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)). IndexedDB and Cache Storage are available, Web Storage is not. Module SWs have no dynamic `import()`. **BroadcastChannel is undocumented for extensions.** It is a same-origin worker standard and doesn't wake a sleeping SW. *Implication:* use `runtime.sendMessage` and `storage.onChanged` to wake or notify the SW. BroadcastChannel only works between open pages.

**9. favicon.** Requires the `favicon` permission, with the warning "Read the icons of the websites you visit". The URL is `chrome-extension://<id>/_favicon/?pageUrl=<url>&size=<px>`, built with `runtime.getURL("/_favicon/")`. From content scripts it must be declared in `web_accessible_resources`. **Whether it comes from the cache or the network, and what it returns when there is no icon, is undocumented.** *Implication:* treat it as cache-only and have a default icon of our own.

**10. unlimitedStorage.** Lifts the quota of `storage.local`, IndexedDB, Cache Storage and OPFS, and exempts them from eviction ([permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list)). Extension data is not deleted when clearing browsing data. `storage.local` "is cleared when the extension is removed". For IndexedDB it doesn't say so explicitly, although in practice it is deleted too. The documentation doesn't say that IndexedDB survives a reload or update. It only says that `storage.session` is cleared in that case, and practice confirms it does survive. *Implication:* offer a manual export or backup before uninstalling or moving the project.

**11. key.** Keeps the extension ID during development. It is obtained by uploading the package to the Developer Dashboard and copying the key from the "View public key" button. The documentation mentions no risks. It is a public key, so publishing it exposes no secret, but **anyone can reuse it to load an unpacked extension with the same ID**. *Implication:* don't use the ID as authentication (externally_connectable, server allowlists). Without `key`, moving the folder changes the ID and the data is orphaned.

**12. IndexedDB durability.** The values are `strict`, `relaxed` and `default` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction)). **Since Chrome 121 the default is `relaxed`** (it used to be `strict`). The version in which the option was introduced (supposedly Chrome 83) is not verified. *Implication:* use `{durability:'strict'}` in the transactions that archive before closing tabs.

**13. Distribution.** According to the documentation, **"on Windows and macOS the update_URL must point to the Chrome Web Store"**. External installs from a local CRX have not been allowed on Windows since Chrome 33. Self-hosting is only possible on Linux ([host-on-linux](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)) or through enterprise policies. `runtime.reload()` is allowed except in kiosk mode. In an unpacked extension, a reload counts as an update and fires `onInstalled` with the reason `update`.

**14. onStartup and onInstalled.** `onStartup` fires when a profile that has the extension installed starts, and not in incognito. The `onInstalled` reasons are `install`, `update`, `chrome_update` and `shared_module_update`. Whether `onStartup` fires when a freshly installed extension loads is undocumented, and in practice it doesn't. *Implication:* put the shared initialization in a function called by both events and by the SW top level, idempotently.

**15. commands.** Supports at most 4 suggested shortcuts. Each shortcut must include Ctrl or Alt, and Ctrl+Alt is not allowed. Alt+Shift+letter is valid. If another extension already uses the shortcut, it isn't registered; this is detected because `commands.getAll()` returns an empty `shortcut`.

**16. incognito "not_allowed".** The extension cannot be enabled in incognito. Available since Chrome 47.

**17. GitHub.** The REST API supports CORS from any origin and responds with `Access-Control-Allow-Origin: *`. Without host permissions, the extension's `fetch` is treated as cross-origin ([network-requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)) and works thanks to CORS. Unauthenticated rate limits are not listed on that page.
