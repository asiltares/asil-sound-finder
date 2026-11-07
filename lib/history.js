const KEY = "history";
const MAX = 100;

const sameSong = (a, b) =>
  a.title?.toLowerCase() === b.title?.toLowerCase() && a.artist?.toLowerCase() === b.artist?.toLowerCase();

export async function addToHistory(entry) {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  const rest = list.filter((h) => !sameSong(h, entry));
  rest.unshift({ ...entry, at: Date.now() });
  await chrome.storage.local.set({ [KEY]: rest.slice(0, MAX) });
}

export async function getHistory() {
  const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
  return list;
}

export async function clearHistory() {
  await chrome.storage.local.remove(KEY);
}
