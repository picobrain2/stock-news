import { parseNewsDate } from "./time";
import { isGoogleNewsBoilerplate } from "./googleNews";

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

const JUNK = /cookie|subscribe subscribe|all rights reserved|copyright|구독하기|무단.?전재|저작권자|클릭하세요|로그인/i;

export function cleanSnippet(snippet: string, title = ""): string {
  let s = stripHtml(snippet);
  if (!s) return "";
  if (isGoogleNewsBoilerplate(s)) return "";
  if (/<\s*a\b/i.test(s) || /\bhref\s*=/i.test(s)) return "";
  if (/^https?:\/\//i.test(s) && !s.includes(" ")) return "";
  if (JUNK.test(s) && s.length < 80) return "";
  if (title) {
    const t = compact(title);
    const n = compact(s);
    if (n === t) return "";
    if (n.startsWith(t)) {
      if (s.length <= title.length + 24) return "";
      const cut = s.slice(title.length).replace(/^[\s:.\-–—]+/, "");
      if (cut.length >= 40) s = cut;
    }
  }
  return s.slice(0, 800);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|(?<=(?:다|요|니다|까|음)\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && !JUNK.test(s));
}

export function summarizeText(text: string, title = "", max = 280): string {
  const cleaned = cleanSnippet(text, title);
  if (!cleaned) return "";
  const sentences = splitSentences(cleaned);
  if (sentences.length === 0) return cleaned.slice(0, max);
  let out = "";
  for (const sentence of sentences.slice(0, 4)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (out && next.length > max) break;
    out = next;
    if (out.length >= Math.min(180, max)) break;
  }
  return out.slice(0, max);
}

function metaAttr(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tags = html.match(new RegExp(`<meta\\b[^>]*>`, "gi")) ?? [];
  for (const tag of tags) {
    if (!new RegExp(`(?:name|property)\\s*=\\s*["']${escaped}["']`, "i").test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content).trim();
  }
  return "";
}

function jsonLdField(html: string, field: "description" | "articleBody"): string {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const nodes = flattenLd(parsed);
      for (const node of nodes) {
        const value = node[field];
        if (typeof value === "string" && value.trim().length >= 40) return stripHtml(value);
      }
    } catch {
      /* skip broken json-ld */
    }
  }
  return "";
}

function flattenLd(data: unknown): Record<string, unknown>[] {
  if (!data) return [];
  if (Array.isArray(data)) return data.flatMap(flattenLd);
  if (typeof data !== "object") return [];
  const rec = data as Record<string, unknown>;
  const nested = rec["@graph"];
  return nested ? [rec, ...flattenLd(nested)] : [rec];
}

function firstParagraphs(html: string): string {
  const scope = html.match(/<article\b[\s\S]{0,25000}/i)?.[0] ?? html.slice(0, 50000);
  const parts = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((p) => p.length >= 40 && !JUNK.test(p) && !/^(advertisement|sponsored)/i.test(p));
  return parts.slice(0, 3).join(" ");
}

export function extractCanonicalUrl(html: string, fallback: string): string {
  const link = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]
    ?? html.match(/<link[^>]+href=["'][^"']+["'][^>]+rel=["']canonical["'][^>]*>/i)?.[0];
  const href = link?.match(/href=["']([^"']+)["']/i)?.[1];
  const og = metaAttr(html, "og:url");
  for (const candidate of [href, og]) {
    if (candidate?.startsWith("http") && !/news\.google\.com/i.test(candidate)) return candidate;
  }
  return fallback;
}

function jsonLdDate(html: string): number {
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const node of flattenLd(parsed)) {
        const value = node.datePublished ?? node.dateCreated ?? node.uploadDate;
        if (typeof value === "string") {
          const t = parseNewsDate(value);
          if (t) return t;
        }
      }
    } catch {
      /* skip broken json-ld */
    }
  }
  return 0;
}

export function extractPublishedAt(html: string): number {
  const keys = [
    "article:published_time",
    "article:published",
    "pubdate",
    "publishdate",
    "datePublished",
    "og:published_time",
    "sailthru.date",
  ];
  for (const key of keys) {
    const t = parseNewsDate(metaAttr(html, key));
    if (t) return t;
  }
  const timeAttr = html.match(/<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i)?.[1];
  const fromTime = parseNewsDate(timeAttr ?? "");
  if (fromTime) return fromTime;
  return jsonLdDate(html);
}

export function extractArticleText(html: string): string {
  const og =
    metaAttr(html, "og:description") ||
    metaAttr(html, "twitter:description") ||
    metaAttr(html, "description");
  if (og.length >= 40) return og;
  const ldDesc = jsonLdField(html, "description");
  if (ldDesc.length >= 40) return ldDesc;
  const paras = firstParagraphs(html);
  if (paras.length >= 40) return paras;
  return jsonLdField(html, "articleBody");
}

export function needsKorean(text: string): boolean {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const hangul = (text.match(/\p{Script=Hangul}/gu) ?? []).length;
  return latin >= 6 && hangul < 4;
}

export function betterSnippet(a: string, b: string, title: string): string {
  const left = summarizeText(a, title);
  const right = summarizeText(b, title);
  if (!left) return right;
  if (!right) return left;
  const leftKo = !needsKorean(left);
  const rightKo = !needsKorean(right);
  if (leftKo !== rightKo) return leftKo ? left : right;
  return left.length >= right.length ? left : right;
}
