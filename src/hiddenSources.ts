const KEY = "sihwang.hiddenSources.v1";

export function loadHiddenSources(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((s): s is string => typeof s === "string" && s.trim().length > 0));
  } catch {
    return new Set();
  }
}

export function saveHiddenSources(sources: Set<string>): void {
  localStorage.setItem(KEY, JSON.stringify([...sources].sort((a, b) => a.localeCompare(b, "ko"))));
}
