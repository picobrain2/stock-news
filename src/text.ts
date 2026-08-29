export function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function stripHtml(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  for (let i = 0; i < 3; i++) {
    s = decodeEntities(s);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<\/?[a-z][^>]*>/gi, " ");
  }
  return s.replace(/\s+/g, " ").trim();
}

function compact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

export function cleanSnippet(snippet: string, title = ""): string {
  let s = stripHtml(snippet);
  if (!s) return "";
  if (/<\s*a\b/i.test(s) || /\bhref\s*=/i.test(s)) return "";
  if (/^https?:\/\//i.test(s) && !s.includes(" ")) return "";
  if (title) {
    const t = compact(title);
    const n = compact(s);
    if (n === t || n.startsWith(t) && s.length <= title.length + 24) return "";
  }
  return s.slice(0, 240);
}

export function needsKorean(text: string): boolean {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const hangul = (text.match(/\p{Script=Hangul}/gu) ?? []).length;
  return latin >= 6 && hangul < 4;
}
