import type { Stock } from "./types";

function kr(
  code: string,
  name: string,
  nameEn: string,
  aliases: string[],
  yahoo: string,
  popular = false,
): Stock {
  return { id: code, name, nameEn, aliases, yahoo, market: "kr", popular };
}

function us(
  ticker: string,
  name: string,
  nameEn: string,
  aliases: string[] = [],
  popular = false,
): Stock {
  return {
    id: ticker,
    name,
    nameEn,
    aliases,
    yahoo: ticker,
    market: "us",
    popular,
  };
}

export const CATALOG: Stock[] = [
  kr("005930", "삼성전자", "Samsung Electronics", ["samsung", "삼성"], "005930.KS", true),
  kr("000660", "SK하이닉스", "SK hynix", ["hynix", "하이닉스"], "000660.KS", true),
  kr("373220", "LG에너지솔루션", "LG Energy Solution", ["lg엔솔", "엔솔"], "373220.KS", true),
  kr("207940", "삼성바이오로직스", "Samsung Biologics", ["삼바"], "207940.KS", true),
  kr("005380", "현대차", "Hyundai Motor", ["hyundai", "현대자동차"], "005380.KS", true),
  kr("000270", "기아", "Kia", ["kia"], "000270.KS", true),
  kr("068270", "셀트리온", "Celltrion", ["celltrion"], "068270.KS", true),
  kr("035420", "NAVER", "NAVER", ["네이버", "naver"], "035420.KS", true),
  kr("035720", "카카오", "Kakao", ["kakao"], "035720.KS", true),
  kr("105560", "KB금융", "KB Financial", ["kb"], "105560.KS", true),
  kr("055550", "신한지주", "Shinhan", ["shinhan", "신한"], "055550.KS"),
  kr("006400", "삼성SDI", "Samsung SDI", ["sdi"], "006400.KS", true),
  kr("051910", "LG화학", "LG Chem", ["lgchem", "화학"], "051910.KS", true),
  kr("066570", "LG전자", "LG Electronics", ["lge", "엘지전자"], "066570.KS"),
  kr("005490", "POSCO홀딩스", "POSCO Holdings", ["포스코", "posco"], "005490.KS", true),
  kr("015760", "한국전력", "KEPCO", ["한전", "kepco"], "015760.KS"),
  kr("086790", "하나금융지주", "Hana Financial", ["하나금융", "하나"], "086790.KS"),
  kr("011200", "HMM", "HMM", ["hmm", "현대상선"], "011200.KS", true),
  kr("009540", "HD한국조선해양", "HD Korea Shipbuilding", ["한조해", "조선"], "009540.KS", true),
  kr("042700", "한미반도체", "Hanmi Semiconductor", ["한미반도체"], "042700.KQ", true),
  kr("196170", "알테오젠", "Alteogen", ["알테오젠"], "196170.KQ", true),
  kr("247540", "에코프로비엠", "EcoPro BM", ["에코프로", "에코비엠"], "247540.KQ", true),
  kr("086520", "에코프로", "EcoPro", ["에코프로"], "086520.KQ", true),
  kr("012450", "한화에어로스페이스", "Hanwha Aerospace", ["한화에어로", "에어로"], "012450.KS", true),
  kr("047810", "한국항공우주", "KAI", ["kai", "항공기"], "047810.KS", true),
  kr("259960", "크래프톤", "Krafton", ["krafton", "배그"], "259960.KS", true),
  kr("352820", "하이브", "HYBE", ["hybe", "bts"], "352820.KS", true),
  kr("041510", "에스엠", "SM Entertainment", ["sm"], "041510.KQ"),
  kr("035900", "JYP Ent.", "JYP Entertainment", ["jyp"], "035900.KQ"),
  kr("323410", "카카오뱅크", "KakaoBank", ["카뱅"], "323410.KS", true),
  kr("034020", "두산에너빌리티", "Doosan Enerbility", ["두산에너", "두산중공업"], "034020.KS", true),
  kr("064350", "현대로템", "Hyundai Rotem", ["로템"], "064350.KS", true),
  kr("010140", "삼성중공업", "Samsung Heavy", ["삼성중공업"], "010140.KS", true),
  kr("042660", "한화오션", "Hanwha Ocean", ["한화오션", "대우조선"], "042660.KS", true),
  kr("003670", "포스코퓨처엠", "POSCO Future-M", ["퓨처엠"], "003670.KS"),
  kr("012330", "현대모비스", "Hyundai Mobis", ["mobis", "모비스"], "012330.KS"),
  kr("028260", "삼성물산", "Samsung C&T", ["물산"], "028260.KS"),
  kr("000810", "삼성화재", "Samsung Fire", ["삼성화재"], "000810.KS"),
  kr("032830", "삼성생명", "Samsung Life", ["삼성생명"], "032830.KS"),
  kr("017670", "SK텔레콤", "SK Telecom", ["skt"], "017670.KS"),
  kr("030200", "KT", "KT", ["kt"], "030200.KS"),
  kr("096770", "SK이노베이션", "SK Innovation", ["sk이노"], "096770.KS"),
  kr("034730", "SK", "SK", ["sk"], "034730.KS"),
  kr("402340", "SK스퀘어", "SK Square", ["sk스퀘어"], "402340.KS"),
  kr("036570", "엔씨소프트", "NCSoft", ["nc", "엔씨"], "036570.KS"),
  kr("251270", "넷마블", "Netmarble", ["netmarble"], "251270.KS"),
  kr("090430", "아모레퍼시픽", "Amorepacific", ["아모레"], "090430.KS"),
  kr("097950", "CJ제일제당", "CJ CheilJedang", ["cj", "제일제당"], "097950.KS"),
  kr("003490", "대한항공", "Korean Air", ["대한항공", "kal"], "003490.KS"),
  kr("000100", "유한양행", "Yuhan", ["유한"], "000100.KS"),
  kr("128940", "한미약품", "Hanmi Pharm", ["한미약품"], "128940.KS"),
  kr("069500", "KODEX 200", "KODEX 200", ["kodex", "코덱스200"], "069500.KS"),

  us("AAPL", "애플", "Apple", ["apple", "애플"], true),
  us("MSFT", "마이크로소프트", "Microsoft", ["microsoft", "마소"], true),
  us("NVDA", "엔비디아", "NVIDIA", ["nvidia", "엔비"], true),
  us("AMZN", "아마존", "Amazon", ["amazon", "아마존"], true),
  us("GOOGL", "알파벳", "Alphabet", ["google", "구글", "alphabet"], true),
  us("META", "메타", "Meta", ["facebook", "페이스북", "메타"], true),
  us("TSLA", "테슬라", "Tesla", ["tesla", "테슬라"], true),
  us("AMD", "AMD", "AMD", ["amd"], true),
  us("NFLX", "넷플릭스", "Netflix", ["netflix"], true),
  us("AVGO", "브로드컴", "Broadcom", ["broadcom"], true),
  us("JPM", "JP모건", "JPMorgan", ["jpmorgan", "제이피모건"]),
  us("MU", "마이크론", "Micron", ["micron", "마이크론"], true),
  us("TSM", "TSMC", "TSMC", ["tsmc", "대만반도체"], true),
  us("ASML", "ASML", "ASML", ["asml"]),
  us("INTC", "인텔", "Intel", ["intel", "인텔"]),
  us("QCOM", "퀄컴", "Qualcomm", ["qualcomm", "퀄컴"]),
  us("AMAT", "어플라이드머티어리얼즈", "Applied Materials", ["amat"]),
  us("ARM", "암", "Arm", ["arm"]),
  us("PLTR", "팔란티어", "Palantir", ["palantir", "팔란티어"], true),
  us("COIN", "코인베이스", "Coinbase", ["coinbase"]),
  us("MSTR", "마이크로스트래티지", "MicroStrategy", ["microstrategy", "mstr"]),
  us("QQQ", "QQQ", "Invesco QQQ", ["qqq", "나스닥100"], true),
  us("SPY", "SPY", "SPDR S&P 500", ["spy", "S&P500"], true),
  us("TQQQ", "TQQQ", "TQQQ", ["tqqq", "나스닥3배"], true),
  us("SOXL", "SOXL", "SOXL", ["soxl", "반도체3배"], true),
  us("IWM", "IWM", "Russell 2000", ["iwm", "러셀"]),
];

const byId = new Map(CATALOG.map((s) => [s.id.toUpperCase(), s]));

export function findStock(id: string): Stock | undefined {
  return byId.get(id.trim().toUpperCase());
}

export function searchCatalog(query: string): Stock[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return CATALOG.filter((s) => matches(s, q)).slice(0, 12);
}

export function matches(stock: Stock, q: string): boolean {
  if (stock.id.toLowerCase().includes(q)) return true;
  if (stock.yahoo.toLowerCase().includes(q)) return true;
  if (stock.name.toLowerCase().includes(q)) return true;
  if (stock.nameEn.toLowerCase().includes(q)) return true;
  return stock.aliases.some((a) => a.toLowerCase().includes(q));
}

export function typedStock(query: string): Stock | undefined {
  const q = query.trim().toUpperCase();
  if (!q || findStock(q)) return undefined;
  if (/^\d{6}$/.test(q)) {
    return {
      id: q,
      name: q,
      nameEn: q,
      aliases: [],
      yahoo: `${q}.KS`,
      market: "kr",
      popular: false,
    };
  }
  if (/^[A-Z][A-Z0-9.]{0,9}$/.test(q) && q.length <= 10) {
    return {
      id: q.replace(".", "-"),
      name: q,
      nameEn: q,
      aliases: [],
      yahoo: q,
      market: "us",
      popular: false,
    };
  }
  return undefined;
}

export function popularStocks(): Stock[] {
  return CATALOG.filter((s) => s.popular);
}

export function defaultWatchlist(): Stock[] {
  return ["005930", "000660", "NVDA", "AAPL", "TSLA"]
    .map(findStock)
    .filter((s): s is Stock => Boolean(s));
}
