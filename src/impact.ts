export interface ImpactRule {
  tag: string;
  weight: number;
  keywords: string[];
}

export const IMPACT_RULES: ImpactRule[] = [
  { tag: "금리", weight: 28, keywords: ["금리", "기준금리", "연준", "fed", "fomc", "powell", "rate cut", "rate hike", "interest rate", "금통위", "한국은행", "한은", "잭슨홀", "jackson hole", "ecb", "boe"] },
  { tag: "환율", weight: 22, keywords: ["환율", "원달러", "원/달러", "엔화", "엔저", "dxy", "dollar", "원화"] },
  { tag: "물가", weight: 24, keywords: ["cpi", "pce", "인플레", "inflation", "물가", "소비자물가"] },
  { tag: "고용", weight: 20, keywords: ["고용", "실업", "nfp", "jobs report", "nonfarm", "payroll"] },
  { tag: "유가", weight: 18, keywords: ["유가", "원유", "wti", "brent", "opec", "oil price"] },
  { tag: "관세", weight: 26, keywords: ["관세", "tariff", "무역전쟁", "trade war", "제재", "sanction"] },
  { tag: "지정학", weight: 22, keywords: ["전쟁", "미사일", "대만", "이스라엘", "우크라이나", "중동", "지정학", "geopolit"] },
  { tag: "실적", weight: 18, keywords: ["실적", "어닝", "earnings", "가이던스", "guidance", "매출", "영업이익", "eps"] },
  { tag: "반도체", weight: 16, keywords: ["반도체", "hbm", "nvidia", "엔비디아", "tsmc", "칩", "semiconductor", "ai 칩"] },
  { tag: "AI", weight: 14, keywords: ["인공지능", " ai ", "chatgpt", "openai", "데이터센터"] },
  { tag: "증시", weight: 12, keywords: ["코스피", "코스닥", "나스닥", "nasdaq", "s&p", "다우", "급락", "급등", "서킷", "증시", "stock market"] },
  { tag: "환율외환", weight: 10, keywords: ["외환", "외환보유", "자본유출"] },
  { tag: "공매도", weight: 12, keywords: ["공매도", "short squeeze", "short selling"] },
  { tag: "IPO", weight: 10, keywords: ["ipo", "상장", "공모"] },
  { tag: "M&A", weight: 12, keywords: ["인수", "합병", "m&a", "acquisition", "takeover"] },
];

const HANGUL = /[\uac00-\ud7a3]/;

export function scoreImpact(title: string, snippet = ""): { score: number; tags: string[] } {
  const text = ` ${title} ${snippet} `.toLowerCase();
  const tags: string[] = [];
  let score = 0;
  for (const rule of IMPACT_RULES) {
    if (rule.keywords.some((k) => text.includes(k.toLowerCase()))) {
      tags.push(rule.tag);
      score += rule.weight;
    }
  }
  if (/\b(breaking|속보|긴급)\b/i.test(title)) score += 10;
  return { score: Math.min(100, score), tags: tags.slice(0, 3) };
}

export function inferRegion(title: string, source: string, url: string): "kr" | "us" | "global" {
  const blob = `${title} ${source} ${url}`;
  if (HANGUL.test(blob) || /\.(kr)\b/i.test(url) || /한국|한경|매일경제|연합|서울경제|조선비즈/.test(blob)) {
    return "kr";
  }
  if (/\b(fed|nasdaq|wall street|s&p|dow |treasury)\b/i.test(blob)) return "us";
  return "global";
}

export function isMarketRelevant(title: string, snippet: string, impact: number): boolean {
  if (impact >= 12) return true;
  const text = `${title} ${snippet}`.toLowerCase();
  return /주식|증시|stock|market|증권|투자|연준|금리|환율|실적|반도체|ai |코스피|나스닥/.test(text);
}

export type Tone = "up" | "down" | "mixed";

export interface ToneCall {
  tone: Tone;
  label: "호재" | "악재" | "혼조";
}

const BULL: [string, number][] = [
  ["어닝 서프라이즈", 3], ["실적 서프라이즈", 3], ["호실적", 3], ["깜짝 실적", 3],
  ["컨센서스 상회", 3], ["가이던스 상향", 3], ["raised guidance", 3], ["earnings beat", 3],
  ["금리 인하", 3], ["금리인하", 3], ["rate cut", 3], ["비둘기", 2], ["dovish", 2],
  ["목표주가 상향", 3], ["업그레이드", 2], ["upgrade", 2],
  ["대규모 수주", 3], ["수주", 2], ["계약", 1], ["수혜", 3],
  ["자사주 매입", 2], ["배당 확대", 2], ["흑자 전환", 3],
  ["신고가", 2], ["급등", 2], ["강세", 2], ["반등", 2], ["상승", 1],
  ["낙관", 1], ["호조", 2], ["긍정", 1], ["rally", 2], ["surge", 2], ["soar", 2],
  ["beat", 2], ["record high", 2], ["buyback", 2],
  ["허가", 2], ["승인", 1], ["fda", 1],
];

const BEAR: [string, number][] = [
  ["어닝 쇼크", 3], ["실적 부진", 3], ["실적 쇼크", 3], ["컨센서스 하회", 3],
  ["가이던스 하향", 3], ["cut guidance", 3], ["earnings miss", 3], ["miss", 1],
  ["금리 인상", 3], ["금리인상", 3], ["rate hike", 3], ["매파", 2], ["hawkish", 2],
  ["목표주가 하향", 3], ["다운그레이드", 2], ["downgrade", 2],
  ["관세", 2], ["tariff", 2], ["제재", 2], ["sanction", 2],
  ["타격", 2], ["충격", 2], ["우려", 1], ["리스크", 1], ["위험", 1],
  ["급락", 2], ["폭락", 3], ["약세", 2], ["하락", 1], ["부진", 2],
  ["적자", 2], ["리콜", 2], ["소송", 2], ["공매도", 1],
  ["plunge", 2], ["slump", 2], ["tumble", 2], ["selloff", 2],
];

const FLIP_BULL = /우려\s*(를\s*)?(덜|완화|해소)|하락을 막|낙폭을 줄|악재가 아니|악재 해소/;
const FLIP_BEAR = /상승\s*(을\s*)?(막|제한|제약)|호재가 아니|차익 실현/;

function hasPhrase(text: string, phrase: string): boolean {
  if (/^[a-z0-9 ']+$/i.test(phrase)) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
  }
  return text.includes(phrase) || text.toLowerCase().includes(phrase.toLowerCase());
}

export function classifyTone(title: string, snippet = "", focus: string[] = []): ToneCall {
  const text = `${title} ${snippet}`;
  let bull = 0;
  let bear = 0;
  for (const [phrase, weight] of BULL) {
    if (hasPhrase(text, phrase)) bull += weight;
  }
  for (const [phrase, weight] of BEAR) {
    if (hasPhrase(text, phrase)) bear += weight;
  }
  if (FLIP_BULL.test(text)) {
    bull += 3;
    bear = Math.max(0, bear - 2);
  }
  if (FLIP_BEAR.test(text)) {
    bear += 2;
    bull = Math.max(0, bull - 1);
  }
  for (const name of focus) {
    const token = name.trim();
    if (token.length < 2) continue;
    const idx = text.toLowerCase().indexOf(token.toLowerCase());
    if (idx < 0) continue;
    const window = text.slice(Math.max(0, idx - 8), idx + token.length + 18);
    if (/수혜|급등|강세|상승|반등|호조|서프라이즈/.test(window)) bull += 3;
    if (/타격|급락|약세|하락|부진|쇼크|충격/.test(window)) bear += 3;
  }
  const delta = bull - bear;
  if (delta >= 2) return { tone: "up", label: "호재" };
  if (delta <= -2) return { tone: "down", label: "악재" };
  return { tone: "mixed", label: "혼조" };
}
