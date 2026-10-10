// Opens (or focuses) the Fangio dashboard tab. Framework-free on purpose: the
// background may import it for the "open-dashboard" command.

export async function openDashboard(hash?: string): Promise<void> {
  const base = chrome.runtime.getURL('dashboard.html');
  const target = hash ? `${base}#${hash.replace(/^#/, '')}` : base;
  let existing: chrome.tabs.Tab | undefined;
  try {
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    existing = tabs.find((t) => typeof t.id === 'number');
  } catch {
    existing = undefined;
  }
  if (existing && typeof existing.id === 'number') {
    const props: chrome.tabs.UpdateProperties = { active: true };
    if (hash) props.url = target;
    await chrome.tabs.update(existing.id, props);
    if (typeof existing.windowId === 'number') {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch {
        // window may have closed in the meantime; the tab update already happened
      }
    }
    return;
  }
  await chrome.tabs.create({ url: target, active: true });
}
