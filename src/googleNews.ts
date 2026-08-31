const BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const REQUEST_SHELL = [
  ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
  "X",
  "X",
  1,
  [1, 1, 1],
  1,
  1,
  null,
  0,
  0,
  null,
  0,
] as const;

export function isGoogleNewsUrl(url: string): boolean {
  return /news\.google\.com\/rss\/articles\//i.test(url);
}

export function isGoogleNewsBoilerplate(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return (
    /google\s*뉴스.*(?:포괄|수집|전\s*세계)/i.test(s)
    || /구글\s*뉴스.*(?:포괄|수집|전\s*세계)/i.test(s)
    || /comprehensive up-to-date news coverage.*google news/i.test(s)
    || /aggregated from sources all over the world by google news/i.test(s)
  );
}

export async function resolveGoogleNewsUrl(url: string, fetchText: (url: string, timeoutMs?: number) => Promise<string>): Promise<string | null> {
  if (!isGoogleNewsUrl(url)) return url;
  const articleId = url.split("/").pop()?.split("?")[0];
  if (!articleId) return null;
  try {
    const html = await fetchText(url, 7000);
    const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const timestamp = html.match(/data-n-a-ts="(\d+)"/)?.[1];
    if (!signature || !timestamp) return null;
    const payload = JSON.stringify(["garturlreq", REQUEST_SHELL, articleId, Number(timestamp), signature]);
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[["Fbv4je", payload, null, "generic"]]]),
    });
    const res = await fetch(BATCH_URL, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: "https://news.google.com/",
      },
      body,
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const hit = text.match(/\[\\"garturlres\\",\\"(.*?)\\"/);
    const resolved = hit?.[1]?.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (!resolved || !/^https?:\/\//i.test(resolved) || isGoogleNewsUrl(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}
