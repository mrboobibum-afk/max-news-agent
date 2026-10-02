// ============================================================
// MAX NEWS AGENT — ФАКТОР
// FIX v4: media-first pipeline — publisher video -> external/witness video -> publisher photo -> external/witness photo -> text
// DENO DEPLOY
// ============================================================
//
// АВТОМАТИЧЕСКАЯ СИСТЕМА НОВОСТЕЙ
//
// Cron:
// каждые 5 минут
//
// Логика:
// RSS
// ↓
// локальная дедупликация
// ↓
// News Score
// ↓
// TOP кандидаты
// ↓
// определение реального URL СМИ
// ↓
// проверка статьи
// ↓
// Gemini
// ↓
// VIDEO → IMAGE → TEXT
// ↓
// MAX /uploads
// ↓
// ожидание обработки media
// ↓
// MAX /messages
// ↓
// Deno KV
//
// ВАЖНО:
// Google News URL НИКОГДА не публикуется.
// Если реальный URL СМИ не найден — кандидат отбрасывается.
// ============================================================
// ============================================================
// CONFIG
// ============================================================
const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const CRON_SCHEDULE = "*/5 * * * *";
const URGENT_INTERVAL_MS = 5 * 60 * 1000;
const REGULAR_INTERVAL_MS = 30 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 8 * 60 * 1000;
const MAX_VIDEO_BYTES =
  Number(Deno.env.get("MAX_VIDEO_MB") ?? "60") * 1024 * 1024;
const MAX_IMAGE_BYTES =
  Number(Deno.env.get("MAX_IMAGE_MB") ?? "15") * 1024 * 1024;
const RSS_LIMIT_PER_FEED = 30;
const MAX_RSS_ITEMS = 300;
const SCORE_CANDIDATES = 45;
const GEMINI_CANDIDATES = 10;
const MAX_HISTORY_CHECKED = 300;
const MAX_POST_LENGTH = 3900;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";
const MEDIA_SEARCH_MAX_RESULTS = 12;
const MEDIA_SEARCH_MAX_PAGES = 14;
const MEDIA_SEARCH_TIMEOUT_MS = 9000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 45000;

// ============================================================
// MAX CERTIFICATES
// ============================================================
const MAX_ROOT_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";
const MAX_SUB_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";
let maxHttpClient = null;
let maxHttpClientError = null;
const maxCaStatus = {
  loaded: false,
  root: false,
  sub: false,
  error: null,
};
async function initMaxHttpClient() {
  if (maxHttpClient) {
    return maxHttpClient;
  }
  if (maxHttpClientError) {
    return null;
  }
  try {
    const rootResponse = await fetch(MAX_ROOT_CA_URL, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!rootResponse.ok) {
      throw new Error(`Root CA HTTP ${rootResponse.status}`);
    }
    const rootCa = await rootResponse.text();
    if (!rootCa.includes("BEGIN CERTIFICATE")) {
      throw new Error("Root CA certificate content is invalid");
    }
    maxCaStatus.root = true;
    const subResponse = await fetch(MAX_SUB_CA_URL, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!subResponse.ok) {
      throw new Error(`Sub CA HTTP ${subResponse.status}`);
    }
    const subCa = await subResponse.text();
    if (!subCa.includes("BEGIN CERTIFICATE")) {
      throw new Error("Sub CA certificate content is invalid");
    }
    maxCaStatus.sub = true;
    maxHttpClient = Deno.createHttpClient({
      caCerts: [rootCa, subCa],
    });
    maxCaStatus.loaded = true;
    return maxHttpClient;
  } catch (error) {
    maxHttpClientError = error instanceof Error ? error.message : String(error);
    maxCaStatus.error = maxHttpClientError;
    console.error("MAX CA initialization failed:", maxHttpClientError);
    return null;
  }
}
// ============================================================
// RSS FEEDS
// ============================================================
const RSS_FEEDS = [
  {
    category: "МИР",
    emoji: "🌍",
    url: "https://news.google.com/rss/search?q=world+OR+мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ПОЛИТИКА",
    emoji: "🏛️",
    url: "https://news.google.com/rss/search?q=политика+OR+правительство+OR+президент&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ЭКОНОМИКА",
    emoji: "📈",
    url: "https://news.google.com/rss/search?q=экономика+OR+инфляция+OR+ставка+OR+рынки&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "БИЗНЕС",
    emoji: "💼",
    url: "https://news.google.com/rss/search?q=бизнес+OR+компания+OR+корпорация+OR+инвестиции&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ФИНАНСЫ",
    emoji: "💰",
    url: "https://news.google.com/rss/search?q=финансы+OR+банки+OR+биржа+OR+рубль+OR+доллар&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ПРАВО",
    emoji: "⚖️",
    url: "https://news.google.com/rss/search?q=закон+OR+суд+OR+право+OR+законопроект&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ПРОИСШЕСТВИЯ",
    emoji: "🚨",
    url: "https://news.google.com/rss/search?q=происшествие+OR+ДТП+OR+пожар+OR+авария+OR+катастрофа&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ТЕХНОЛОГИИ",
    emoji: "💻",
    url: "https://news.google.com/rss/search?q=технологии+OR+ИИ+OR+искусственный+интеллект+OR+кибербезопасность&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "ПРОМЫШЛЕННОСТЬ",
    emoji: "🏭",
    url: "https://news.google.com/rss/search?q=промышленность+OR+производство+OR+энергетика&hl=ru&gl=RU&ceid=RU:ru",
  },
  {
    category: "АВТО",
    emoji: "🚗",
    url: "https://news.google.com/rss/search?q=авто+OR+автомобили+OR+транспорт&hl=ru&gl=RU&ceid=RU:ru",
  },
];
// ============================================================
// DENO KV
// ============================================================
let kv = null;
async function getKV() {
  if (!kv) {
    kv = await Deno.openKv();
  }
  return kv;
}
// ============================================================
// TEXT UTILS
// ============================================================
function cleanText(value) {
  let text = String(value ?? "");
  // RSS from Google News often contains HTML that is entity-encoded, e.g.
  // &lt;a href=...&gt;...&lt;/a&gt;. Decode BEFORE removing tags.
  for (let i = 0; i < 2; i++) {
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
        String.fromCodePoint(parseInt(code, 16))
      );
  }
  return text
    .replace(/<!\[CDATA\[/gi, "")
    .replace(/\]\]>/gi, "")
    .replace(/<br\s*\/?>(?:\s*)/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function stripHtml(value) {
  return cleanText(value).replace(/\*\*/g, "").replace(/__+/g, "").trim();
}
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function normalizeForHash(value) {
  return stripHtml(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"“”'`]/g, "")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function truncate(value, max) {
  const s = value.trim();
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - 1).trimEnd() + "…";
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// ============================================================
// URL UTILS
// ============================================================
function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}
function isGoogleNewsUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "news.google.com" || host.endsWith(".news.google.com");
  } catch {
    return false;
  }
}
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const removeParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "yclid",
      "mc_cid",
      "mc_eid",
    ];
    for (const param of removeParams) {
      parsed.searchParams.delete(param);
    }
    return parsed.href;
  } catch {
    return "";
  }
}
function isUsableArticleUrl(url) {
  if (!isHttpUrl(url) || isGoogleNewsUrl(url) || isTechnicalUrl(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === "google.com" ||
      host.endsWith(".google.com") ||
      host.includes("googleusercontent")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
function absoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}
function normalizeMediaUrl(value) {
  return decodeHtmlEntities(
    value
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003A/gi, ":")
      .replace(/\\u002F/gi, "/")
      .trim()
  );
}
// ============================================================
// RSS XML
// ============================================================
function extractXmlTag(xml, tag) {
  const pattern = `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`;
  const match = new RegExp(pattern, "i").exec(xml);
  return match?.[1] ?? "";
}
function extractXmlTagWithAttrs(xml, tag) {
  const match = new RegExp(
    `<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  ).exec(xml);
  return {
    attrs: match?.[1] ?? "",
    value: match?.[2] ?? "",
  };
}
function extractAttr(attrs, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attrs);
  return match?.[1] ?? "";
}
function parseRSS(xml, feed) {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const itemXml of matches.slice(0, RSS_LIMIT_PER_FEED)) {
    const title = cleanText(extractXmlTag(itemXml, "title"));
    const link =
      cleanText(extractXmlTag(itemXml, "link")) ||
      cleanText(extractXmlTag(itemXml, "guid"));
    const description = cleanText(extractXmlTag(itemXml, "description"));
    const pubDate = cleanText(extractXmlTag(itemXml, "pubDate"));
    const sourceTag = extractXmlTagWithAttrs(itemXml, "source");
    const source = cleanText(sourceTag.value) || feed.category;
    const sourceUrl = decodeHtmlEntities(extractAttr(sourceTag.attrs, "url"));
    const rssMediaUrls = [];
    for (const match of itemXml.matchAll(
      /<(?:media:content|media:thumbnail|enclosure)\b[^>]*?(?:url|href)=["']([^"']+)["'][^>]*>/gi
    )) {
      const mediaUrl = decodeHtmlEntities(match[1]);
      if (isHttpUrl(mediaUrl)) rssMediaUrls.push(mediaUrl);
    }
    if (!title || !link) {
      continue;
    }
    items.push({
      title,
      link,
      description,
      pubDate,
      source,
      sourceUrl,
      category: feed.category,
      categoryEmoji: feed.emoji,
      sourceFeed: feed.url,
      rssMediaUrls,
    });
  }
  return items;
}
async function loadRSS(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      console.error(`RSS ${feed.category}: HTTP ${response.status}`);
      return [];
    }
    const xml = await response.text();
    return parseRSS(xml, feed);
  } catch (error) {
    console.error(
      `RSS ${feed.category}:`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}
// ============================================================
// HTML META
// ============================================================
function findMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(cleanText(match[1]));
    }
  }
  return null;
}
function extractCanonical(html, baseUrl) {
  const canonical =
    html.match(
      /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i
    )?.[1] ??
    html.match(
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i
    )?.[1];
  if (!canonical) {
    return null;
  }
  return absoluteUrl(decodeHtmlEntities(canonical), baseUrl);
}
function extractJsonLd(html) {
  const blocks =
    html.match(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
    ) ?? [];
  const result = [];
  for (const block of blocks) {
    const jsonText = block
      .replace(/<script[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "")
      .trim();
    try {
      const data = JSON.parse(jsonText);
      result.push(data);
    } catch {
      // ignore invalid JSON-LD
    }
  }
  return result;
}
function collectArticleJsonLd(value, result) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectArticleJsonLd(item, result);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const type = value["@type"];
  if (
    type === "NewsArticle" ||
    type === "Article" ||
    (Array.isArray(type) &&
      (type.includes("NewsArticle") || type.includes("Article")))
  ) {
    result.push(value);
  }
  if (value["@graph"]) {
    collectArticleJsonLd(value["@graph"], result);
  }
}
// ============================================================
// ARTICLE-LINK QUALITY
// ============================================================
const BAD_HOST_PARTS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "t.me",
  "vk.com",
  "ok.ru",
  "linkedin.com",
  "pinterest.com",
  "reddit.com",
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
  "gstaticusercontent.com",
  "ggpht.com",
  // Technical/XML namespace hosts frequently occur inside Google News HTML
  // and are never article pages.
  "w3.org",
  "schema.org",
  "ogp.me",
  "xmlns.com",
  "purl.org",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "googlesyndication.com",
];
const BAD_PATH_PARTS = [
  "/search",
  "/tag/",
  "/tags/",
  "/category/",
  "/categories/",
  "/author/",
  "/authors/",
  "/login",
  "/signin",
  "/signup",
  "/register",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
  "/advert",
  "/2000/svg",
  "/1999/xhtml",
  "/1999/xlink",
  "/xmlns/",
  "/gtag/",
  "/analytics",
  "/collect",
  "/pixel",
  "/favicon",
  "/assets/js/",
  "/static/js/",
  "/scripts/",
];
function isTechnicalHost(host) {
  const h = String(host || "")
    .toLowerCase()
    .replace(/^www\./, "");
  return (
    h === "googletagmanager.com" ||
    h.endsWith(".googletagmanager.com") ||
    h === "google-analytics.com" ||
    h.endsWith(".google-analytics.com") ||
    h === "doubleclick.net" ||
    h.endsWith(".doubleclick.net") ||
    h === "googlesyndication.com" ||
    h.endsWith(".googlesyndication.com") ||
    h === "gstatic.com" ||
    h.endsWith(".gstatic.com") ||
    h === "googleusercontent.com" ||
    h.endsWith(".googleusercontent.com")
  );
}
function isTechnicalUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const host = u.hostname.toLowerCase();
    if (isTechnicalHost(host)) return true;
    return (
      /(?:^|\/)(?:gtag|analytics|collect|pixel|track|tracking|tag|beacon)(?:\/|$)/i.test(
        path
      ) ||
      /(?:\.js|\.mjs|\.css|\.json|\.xml|\.rss|\.atom)(?:$|[?#])/i.test(path)
    );
  } catch {
    return true;
  }
}
function isBadHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return BAD_HOST_PARTS.some(
      (part) => host === part || host.endsWith("." + part)
    );
  } catch {
    return true;
  }
}
function isLikelyArticleUrl(url) {
  if (!isUsableArticleUrl(url)) {
    return false;
  }
  if (isBadHost(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (BAD_PATH_PARTS.some((part) => path.includes(part))) {
      return false;
    }
    if (path === "/" || path.length < 8) {
      return false;
    }
    // Reject namespace/technical URLs such as http://www.w3.org/2000/svg
    // even when they superficially look like a multi-segment article URL.
    if (
      /(?:^|\/)2000\/svg(?:$|\/)|(?:^|\/)1999\/(?:xhtml|xlink)(?:$|\/)/i.test(
        path
      )
    ) {
      return false;
    }
    // Never accept scripts, stylesheets, feeds, JSON/XML or tracking endpoints as articles.
    if (
      /(?:\.js|\.mjs|\.css|\.json|\.xml|\.rss|\.atom|\.map)(?:$|[?#])/i.test(
        path
      )
    ) {
      return false;
    }
    if (/\/(?:gtag|analytics|collect|pixel)(?:\/|$)/i.test(path)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
function articleLinkScore(url, sourceHost) {
  if (!isLikelyArticleUrl(url)) {
    return -1000;
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    let score = 0;
    if (sourceHost && parsed.hostname.toLowerCase() === sourceHost) {
      score += 50;
    }
    if (path.length >= 20) {
      score += 10;
    }
    if (path.split("/").filter(Boolean).length >= 2) {
      score += 10;
    }
    if (/\d{4,}/.test(path)) {
      score += 5;
    }
    if (/[a-zа-я]{4,}[-_][a-zа-я]{4,}/i.test(path)) {
      score += 5;
    }
    return score;
  } catch {
    return -1000;
  }
}
function extractExternalLinks(html, baseUrl, preferredHost) {
  const scored = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
    const raw = decodeHtmlEntities(match[1]);
    const url = absoluteUrl(raw, baseUrl);
    if (!url || !isLikelyArticleUrl(url)) {
      continue;
    }
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const score = articleLinkScore(normalized, preferredHost);
    if (score > 0) {
      scored.push({
        url: normalized,
        score,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((x) => x.url);
}
// ============================================================
// GOOGLE NEWS URL CANDIDATES
// ============================================================
function normalizeHost(host) {
  return host.toLowerCase().replace(/^www\./, "");
}
function hostMatches(url, preferredHost) {
  if (!preferredHost) return false;
  try {
    const host = normalizeHost(new URL(url).hostname);
    const preferred = normalizeHost(preferredHost);
    return (
      host === preferred ||
      host.endsWith("." + preferred) ||
      preferred.endsWith("." + host)
    );
  } catch {
    return false;
  }
}
function extractGoogleNewsUrlCandidates(html, baseUrl, preferredHost) {
  const rawCandidates = new Set();
  for (const match of html.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi))
    rawCandidates.add(match[1]);
  for (const match of html.matchAll(/\bdata-(?:href|url)=["']([^"']+)["']/gi))
    rawCandidates.add(match[1]);
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>\\]+/gi))
    rawCandidates.add(match[0]);
  const scored = [];
  const seen = new Set();
  for (const rawValue of rawCandidates) {
    const decoded = decodeHtmlEntities(
      String(rawValue)
        .replace(/\\\//g, "/")
        .replace(/\\u002f/gi, "/")
        .replace(/\\u003a/gi, ":")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\u003f/gi, "?")
        .replace(/\\u0025/gi, "%")
    );
    const absolute = absoluteUrl(decoded, baseUrl);
    if (!absolute || !isLikelyArticleUrl(absolute)) continue;
    if (preferredHost && !hostMatches(absolute, preferredHost)) continue;
    const normalized = normalizeUrl(absolute);
    if (!normalized || seen.has(normalized) || isBadHost(normalized)) continue;
    seen.add(normalized);
    let score = articleLinkScore(normalized, preferredHost);
    if (hostMatches(normalized, preferredHost)) score += 100;
    if (score > 0) scored.push({ url: normalized, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((entry) => entry.url);
}
// ============================================================
// GOOGLE NEWS RESOLUTION
// ============================================================
function googleNewsArticleId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "news.google.com") return "";
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.lastIndexOf("articles");
    if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
    const readIdx = parts.lastIndexOf("read");
    if (readIdx >= 0 && parts[readIdx + 1])
      return decodeURIComponent(parts[readIdx + 1]);
    return "";
  } catch {
    return "";
  }
}

function decodeLegacyGoogleNewsUrl(url) {
  const id = googleNewsArticleId(url);
  if (!id) return "";
  try {
    const bytes = Uint8Array.from(
      atob(id.replace(/-/g, "+").replace(/_/g, "/") + "==="),
      (c) => c.charCodeAt(0)
    );
    let start = 0;
    if (
      bytes.length >= 3 &&
      bytes[0] === 0x08 &&
      bytes[1] === 0x13 &&
      bytes[2] === 0x22
    )
      start = 3;
    let len = bytes[start];
    let lenBytes = 1;
    if (len >= 0x80 && bytes.length > start + 1) {
      len = (len & 0x7f) | (bytes[start + 1] << 7);
      lenBytes = 2;
    }
    const begin = start + lenBytes;
    const end = begin + len;
    if (end <= bytes.length) {
      const decoded = new TextDecoder().decode(bytes.slice(begin, end));
      if (isLikelyArticleUrl(decoded)) return normalizeUrl(decoded);
    }
  } catch {}
  return "";
}

async function resolveGoogleNewsViaBatchExecute(originalUrl) {
  const articleId = googleNewsArticleId(originalUrl);
  if (!articleId) return "";

  // Google changed RSS article links after 2024. The current format is
  // resolved by obtaining data-n-a-sg/data-n-a-ts from the article shell
  // and calling Google's Fbv4je/garturlreq RPC. This is the same mechanism
  // used by current open-source Google News decoders.
  try {
    const shellUrls = [
      `https://news.google.com/articles/${encodeURIComponent(articleId)}`,
      originalUrl,
    ];
    let shellHtml = "";
    let shellResponseUrl = "";
    for (const shellUrl of shellUrls) {
      try {
        const r = await fetch(shellUrl, {
          redirect: "follow",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
            "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout(10000),
        });
        const text = await r.text();
        if (text && text.length > 1000) {
          shellHtml = text;
          shellResponseUrl = r.url || shellUrl;
          if (/data-n-a-sg\s*=|data-n-a-ts\s*=/i.test(text)) break;
        }
      } catch {}
    }
    if (!shellHtml) return "";

    const sig =
      shellHtml.match(/data-n-a-sg=["']([^"']+)["']/i)?.[1] ||
      shellHtml.match(/data-n-a-sg\\?=["']([^"']+)["']/i)?.[1] ||
      "";
    const ts =
      shellHtml.match(/data-n-a-ts=["']([^"']+)["']/i)?.[1] ||
      shellHtml.match(/data-n-a-ts\\?=["']([^"']+)["']/i)?.[1] ||
      "";
    const dataId =
      shellHtml.match(/data-n-a-id=["']([^"']+)["']/i)?.[1] || articleId;
    if (!sig || !ts) return "";

    const inner = JSON.stringify([
      "garturlreq",
      [
        [
          "X",
          "X",
          ["X", "X"],
          null,
          null,
          1,
          1,
          "RU:ru",
          null,
          1,
          null,
          null,
          null,
          null,
          null,
          0,
          1,
        ],
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
      ],
      dataId,
      Number(ts),
      sig,
    ]);
    const requestEntry = ["Fbv4je", inner];
    const body =
      "f.req=" + encodeURIComponent(JSON.stringify([[requestEntry]]));
    const response = await fetch(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          Origin: "https://news.google.com",
          Referer: shellResponseUrl || originalUrl,
        },
        body,
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!response.ok) return "";
    const text = await response.text();
    const chunks = text.split("\n\n");
    for (const chunk of chunks) {
      try {
        const parsed = JSON.parse(chunk);
        const rows = Array.isArray(parsed) ? parsed : [];
        for (const row of rows) {
          const payload = row?.[2];
          if (typeof payload !== "string") continue;
          try {
            const decoded = JSON.parse(payload);
            const candidate = decoded?.[1];
            if (typeof candidate === "string" && isLikelyArticleUrl(candidate))
              return normalizeUrl(candidate);
          } catch {}
        }
      } catch {}
    }
    // Some Google responses contain escaped JSON around the URL.
    const urls = text.match(/https?:\\?\/\\?\/[^"\\\s]+/g) || [];
    for (const raw of urls) {
      const candidate = normalizeUrl(
        raw.replace(/\\\//g, "/").replace(/\\u0026/gi, "&")
      );
      if (isLikelyArticleUrl(candidate)) return candidate;
    }
  } catch (error) {
    console.error(
      "Google News batchexecute:",
      error instanceof Error ? error.message : String(error)
    );
  }
  return "";
}

async function resolveArticleUrl(item) {
  const originalUrl = normalizeUrl(item.link);
  let preferredHost = null;
  if (item.sourceUrl) {
    try {
      preferredHost = normalizeHost(new URL(item.sourceUrl).hostname);
    } catch {
      preferredHost = null;
    }
  }
  if (!isGoogleNewsUrl(originalUrl)) {
    return isLikelyArticleUrl(originalUrl) ? originalUrl : "";
  }

  // 1) Current Google News decoder.
  const decoded = await resolveGoogleNewsViaBatchExecute(originalUrl);
  if (
    isLikelyArticleUrl(decoded) &&
    (!preferredHost || hostMatches(decoded, preferredHost))
  )
    return decoded;

  // 2) Legacy payloads still occur in some feeds.
  const legacy = decodeLegacyGoogleNewsUrl(originalUrl);
  if (
    isLikelyArticleUrl(legacy) &&
    (!preferredHost || hostMatches(legacy, preferredHost))
  )
    return legacy;

  // 3) Last-resort HTTP redirect/canonical extraction. Do not treat the
  // Google shell itself as an article.
  try {
    const response = await fetch(originalUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });
    const finalUrl = normalizeUrl(response.url || "");
    if (
      isLikelyArticleUrl(finalUrl) &&
      (!preferredHost || hostMatches(finalUrl, preferredHost))
    )
      return finalUrl;
    const html = await response.text();
    const directCandidates = [];
    const canonical = extractCanonical(html, originalUrl);
    if (canonical) directCandidates.push(canonical);
    const ogUrl = findMeta(html, "og:url");
    if (ogUrl) directCandidates.push(absoluteUrl(ogUrl, originalUrl));
    const jsonLd = extractJsonLd(html);
    const articles = [];
    for (const block of jsonLd) collectArticleJsonLd(block, articles);
    for (const article of articles) {
      for (const candidate of [article.url, article.mainEntityOfPage]) {
        if (typeof candidate === "string") directCandidates.push(candidate);
        else if (candidate && typeof candidate === "object")
          directCandidates.push(candidate["@id"] ?? candidate.url ?? "");
      }
    }
    for (const raw of directCandidates) {
      const candidate = normalizeUrl(
        absoluteUrl(String(raw || ""), originalUrl)
      );
      if (
        isLikelyArticleUrl(candidate) &&
        (!preferredHost || hostMatches(candidate, preferredHost))
      )
        return candidate;
    }
  } catch (error) {
    console.error(
      "Google News fallback:",
      error instanceof Error ? error.message : String(error)
    );
  }
  return "";
}
// ============================================================
// ARTICLE PAGE
// ============================================================
async function loadArticlePage(articleUrl) {
  if (!isLikelyArticleUrl(articleUrl)) return null;
  let sourceHost = null;
  try {
    sourceHost = normalizeHost(new URL(articleUrl).hostname);
  } catch {
    return null;
  }
  try {
    const response = await fetch(articleUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const finalUrl = normalizeUrl(response.url || articleUrl);
    if (!isLikelyArticleUrl(finalUrl) || isTechnicalUrl(finalUrl)) return null;
    const finalHost = normalizeHost(new URL(finalUrl).hostname);
    // Do not silently turn a publisher article into an unrelated technical/CDN page.
    if (!hostMatches(finalUrl, sourceHost)) return null;
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    )
      return null;
    const html = await response.text();
    if (html.length < 500) return null;
    return { finalUrl, html };
  } catch (error) {
    console.error(
      "Article page:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
// ============================================================
// VIDEO EXTRACTION
// ============================================================
function isDirectVideoUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes(".m3u8") || lower.includes(".mpd")) {
    return false;
  }
  return (
    lower.includes(".mp4") ||
    lower.includes(".mov") ||
    lower.includes(".webm") ||
    lower.includes(".mkv")
  );
}
function collectVideoUrls(value, result) {
  if (typeof value === "string") {
    if (isDirectVideoUrl(value)) {
      result.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVideoUrls(item, result);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        ["contentUrl", "videoUrl", "video_url", "url", "file"].includes(key)
      ) {
        collectVideoUrls(item, result);
      }
      if (
        key === "@graph" ||
        key === "video" ||
        key === "content" ||
        key === "associatedMedia"
      ) {
        collectVideoUrls(item, result);
      }
    }
  }
}
function findVideoFromHtml(html, baseUrl) {
  const candidates = [];
  const metaNames = [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "twitter:player:stream",
  ];
  for (const name of metaNames) {
    const value = findMeta(html, name);
    if (value) {
      candidates.push(value);
    }
  }
  for (const match of html.matchAll(
    /<video[^>]+src=["']([^"']+)["'][^>]*>/gi
  )) {
    candidates.push(match[1]);
  }
  for (const match of html.matchAll(
    /<source[^>]+src=["']([^"']+)["'][^>]*>/gi
  )) {
    candidates.push(match[1]);
  }
  for (const match of html.matchAll(
    /["'](?:contentUrl|videoUrl|video_url|file)["']\s*:\s*["']([^"']+)["']/gi
  )) {
    candidates.push(match[1]);
  }
  for (const candidate of candidates) {
    const url = absoluteUrl(normalizeMediaUrl(candidate), baseUrl);
    if (url && isDirectVideoUrl(url)) {
      return url;
    }
  }
  const jsonLd = extractJsonLd(html);
  for (const data of jsonLd) {
    const urls = [];
    collectVideoUrls(data, urls);
    for (const rawUrl of urls) {
      const url = absoluteUrl(normalizeMediaUrl(rawUrl), baseUrl);
      if (url && isDirectVideoUrl(url)) {
        return url;
      }
    }
  }
  return null;
}
// ============================================================
// ARTICLE MEDIA
// ============================================================
function mediaCandidateUrl(value, baseUrl) {
  const absolute = absoluteUrl(
    normalizeMediaUrl(decodeHtmlEntities(String(value || ""))),
    baseUrl
  );
  return isHttpUrl(absolute) ? absolute : null;
}
function mediaIsGeneric(url, text = "") {
  const value = `${url} ${text}`.toLowerCase();
  return /(?:logo|favicon|avatar|icon|sprite|placeholder|default[-_]?image|share[-_]?image|social[-_]?image|banner|advert|tracking|pixel|brand|site[-_]?image|opengraph[-_]?image)/i.test(
    value
  );
}
function mediaTextScore(url, context, title, description) {
  const hay = normalizeForHash(`${context} ${url}`);
  const titleWords = storyTokens(`${title} ${description}`);
  let score = 0;
  for (const token of titleWords) {
    if (token.length >= 4 && hay.includes(token)) score += 3;
  }
  if (mediaIsGeneric(url, context)) score -= 8;
  return score;
}
function collectImageCandidates( html, baseUrl, title, description, rssMediaUrls = [] ) {
  const candidates = [];
  const seen = new Set();
  const titleContext = `${title} ${description}`;

  const push = (raw, kind, context = "", priority = 0, extra = {}) => {
    const url = mediaCandidateUrl(raw, baseUrl);
    if (!url || isTechnicalUrl(url)) return;
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) return;

    const generic = mediaIsGeneric(url, context);
    const relevance = mediaTextScore(url, context, title, description);
    if (generic && kind !== "rss") return;

    // RSS enclosure/media is often a publisher's feed-card/logo image.
    // Keep it only as a LAST-RESORT candidate, never above article media.
    let score = priority + relevance;
    if (kind === "rss") score = -40 + relevance;

    // Real article-body images are preferred even when they have no alt text.
    // Filename/title matching is only a bonus, never a hard requirement.
    if (kind === "article_body") score += 18;
    if (kind === "jsonld") score += 16;
    if (kind === "og") score += 14;
    if (kind === "twitter") score += 10;

    // Size hints are useful for rejecting tiny icons while preserving
    // normal news photographs.
    const width = Number(extra.width || 0);
    const height = Number(extra.height || 0);
    if (width >= 500) score += 6;
    if (height >= 300) score += 4;
    if (width > 0 && width < 200) score -= 20;
    if (height > 0 && height < 120) score -= 20;

    seen.add(key);
    candidates.push({ url: key, score, kind, context });
  };

  // DO NOT give RSS media the old trust bonus. It is frequently a logo/card.
  for (const url of rssMediaUrls) push(url, "rss", titleContext, 0);

  // Standard images, lazy-loaded images, data-src and responsive srcset.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(
      /\b(?:src|data-src|data-lazy-src|data-original|data-image)=['"]([^'"]+)['"]/i
    )?.[1];
    const srcset = tag.match(/\b(?:srcset|data-srcset)=['"]([^'"]+)['"]/i)?.[1];
    const alt = tag.match(/\balt=['"]([^'"]*)['"]/i)?.[1] || "";
    const titleAttr = tag.match(/\btitle=['"]([^'"]*)['"]/i)?.[1] || "";
    const caption =
      tag.match(/\b(?:data-caption|data-description)=['"]([^'"]*)['"]/i)?.[1] ||
      "";
    const cls = tag.match(/\b(?:class|id)=['"]([^'"]*)['"]/gi)?.join(" ") || "";
    const width = tag.match(/\bwidth=['"](\d+)/i)?.[1] || "";
    const height = tag.match(/\bheight=['"](\d+)/i)?.[1] || "";
    const context = `${alt} ${titleAttr} ${caption} ${cls}`;

    if (src) push(src, "article_body", context, 24, { width, height });
    if (srcset) {
      for (const part of srcset.split(",")) {
        const raw = part.trim().split(/\s+/)[0];
        if (raw) push(raw, "article_body", context, 22, { width, height });
      }
    }
  }

  // <picture><source srcset=...> is common on modern news sites.
  for (const m of html.matchAll(
    /<source\b[^>]*\b(?:srcset|data-srcset)=['"]([^'"]+)['"][^>]*>/gi
  )) {
    for (const part of m[1].split(",")) {
      const raw = part.trim().split(/\s+/)[0];
      if (raw) push(raw, "article_body", "picture source", 23);
    }
  }

  // JSON-LD Article.image / ImageObject.
  for (const data of extractJsonLd(html)) {
    const stack = [data];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        for (const x of value) stack.push(x);
        continue;
      }
      if (value.image) {
        const images = Array.isArray(value.image) ? value.image : [value.image];
        for (const image of images) {
          if (typeof image === "string") {
            push(
              image,
              "jsonld",
              `${value.caption || ""} ${value.name || ""}`,
              30,
              {
                width: value.width,
                height: value.height,
              }
            );
          } else if (image && typeof image === "object") {
            push(
              image.url || image.contentUrl,
              "jsonld",
              `${image.caption || ""} ${image.name || ""} ${ value.caption || "" } ${value.name || ""}`,
              30,
              {
                width: image.width || value.width,
                height: image.height || value.height,
              }
            );
          }
        }
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
  }

  // OG/Twitter are useful fallbacks, but not preferred over article-body/JSON-LD.
  push(findMeta(html, "og:image"), "og", titleContext, 28);
  push(findMeta(html, "og:image:url"), "og", titleContext, 27);
  push(findMeta(html, "og:image:secure_url"), "og", titleContext, 27);
  push(findMeta(html, "twitter:image"), "twitter", titleContext, 26);
  push(findMeta(html, "twitter:image:src"), "twitter", titleContext, 26);

  // Original image links and gallery anchors. These are often the full-size
  // news photo even when the <img> itself is a thumbnail or lazy placeholder.
  for (const linked of extractImageLinksFromHtml(
    html,
    baseUrl,
    title,
    description
  )) {
    const key = normalizeUrl(linked.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push(linked);
  }

  return candidates
    .filter((c) => c.score > -25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}
function collectVideoCandidates(html, baseUrl) {
  const raw = [];
  const seen = new Set();
  const add = (value, kind = "html") => {
    const url = mediaCandidateUrl(value, baseUrl);
    if (!url) return;
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) return;
    if (!isDirectVideoUrl(key)) return;
    seen.add(key);
    raw.push({ url: key, kind });
  };

  for (const name of [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "twitter:player:stream",
    "twitter:player:stream:content_type",
  ])
    add(findMeta(html, name), "meta");

  // Native players and lazy-loaded sources.
  for (const m of html.matchAll(/<(?:video|source)\b[^>]*>/gi)) {
    const tag = m[0];
    for (const attr of [
      "src",
      "data-src",
      "data-video",
      "data-video-url",
      "data-file",
      "data-content-url",
    ]) {
      const hit = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i"));
      if (hit?.[1]) add(hit[1], `element:${attr}`);
    }
    const srcset = tag.match(/\b(?:srcset|data-srcset)=["']([^"']+)["']/i)?.[1];
    if (srcset) {
      for (const part of srcset.split(","))
        add(part.trim().split(/\s+/)[0], "video-srcset");
    }
  }

  // Common player JSON fields.
  for (const m of html.matchAll(
    /["'](?:contentUrl|videoUrl|video_url|videoSrc|video_src|mediaUrl|media_url|file|mp4|src)["']\\s*:\\s*["']([^"']+)["']/gi
  )) {
    add(m[1], "json");
  }

  for (const data of extractJsonLd(html)) {
    const urls = [];
    collectVideoUrls(data, urls);
    for (const u of urls) add(u, "jsonld");
  }

  // Some publishers place the direct media URL in escaped JSON inside scripts.
  for (const m of html.matchAll(
    /https?:\/\/[^"'\s<>]+(?:\.mp4|\.mov|\.webm)(?:\?[^"'\s<>]*)?/gi
  )) {
    add(m[0], "escaped-json");
  }

  return raw.slice(0, 40);
}

function isProbablyVideoOnlyUrl(url) {
  return /(?:video[-_]?only|no[-_]?audio|mute|silent|without[-_]?audio|audio[-_]?none|_vo\b)/i.test(
    url
  );
}

function hasMp4AudioTrack(bytes) {
  // ISO-BMFF: walk boxes recursively and look for mdia/hdlr with handler_type "soun".
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const textAt = (offset, len) => {
    if (offset + len > dv.byteLength) return "";
    let out = "";
    for (let i = 0; i < len; i++)
      out += String.fromCharCode(dv.getUint8(offset + i));
    return out;
  };
  const walk = (start, end, depth = 0) => {
    if (depth > 10) return false;
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = textAt(p + 4, 4);
      let header = 8;
      if (size === 1 && p + 16 <= end) {
        const hi = dv.getUint32(p + 8);
        const lo = dv.getUint32(p + 12);
        if (hi !== 0) return false;
        size = lo;
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) break;
      if (type === "hdlr" && p + 20 <= end && textAt(p + 16, 4) === "soun")
        return true;
      if (
        ["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"].includes(type)
      ) {
        if (walk(p + header, p + size, depth + 1)) return true;
      }
      p += size;
    }
    return false;
  };
  // If there is no moov box, this may be a fragmented MP4. Do not reject it
  // merely because the complete track metadata is not present in this chunk.
  let hasMoov = false;
  for (let p = 0; p + 8 <= dv.byteLength; ) {
    const size = dv.getUint32(p);
    const type = textAt(p + 4, 4);
    if (type === "moov") {
      hasMoov = true;
      break;
    }
    if (size < 8) break;
    p += size;
  }
  if (!hasMoov) return null;
  return walk(0, dv.byteLength);
}

function hasWebmAudioTrack(bytes) {
  let hasVideoTrack = false;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x83 && bytes[i + 1] === 0x81 && bytes[i + 2] === 0x02)
      return true;
    if (bytes[i] === 0x83 && bytes[i + 1] === 0x81 && bytes[i + 2] === 0x01)
      hasVideoTrack = true;
  }
  return hasVideoTrack ? false : null;
}

function videoHasAudio(bytes, contentType, url) {
  const ct = (contentType || "").toLowerCase();
  if (isProbablyVideoOnlyUrl(url)) return false;
  if (
    ct.includes("mp4") ||
    ct.includes("quicktime") ||
    /\.(mp4|mov)(?:\?|$)/i.test(url)
  ) {
    const result = hasMp4AudioTrack(bytes);
    return result === null ? true : result;
  }
  if (ct.includes("webm") || /\.webm(?:\?|$)/i.test(url)) {
    const result = hasWebmAudioTrack(bytes);
    return result === null ? true : result;
  }
  return true;
}

function parseSearchRss(xml, engine = "search") {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const itemXml of matches.slice(0, MEDIA_SEARCH_MAX_RESULTS)) {
    const title = cleanText(extractXmlTag(itemXml, "title"));
    const link =
      cleanText(extractXmlTag(itemXml, "link")) ||
      cleanText(extractXmlTag(itemXml, "guid"));
    const description = cleanText(extractXmlTag(itemXml, "description"));
    const sourceTag = extractXmlTagWithAttrs(itemXml, "source");
    const source = cleanText(sourceTag.value) || engine;
    const media = [];
    for (const match of itemXml.matchAll(
      /<(?:media:content|media:thumbnail|enclosure|video:content|video:thumbnail)\b[^>]*?(?:url|href)=['"]([^'"]+)['"][^>]*>/gi
    )) {
      const url = decodeHtmlEntities(match[1]);
      if (isHttpUrl(url)) media.push(url);
    }
    if (title && link)
      items.push({ title, link, description, source, rssMediaUrls: media });
  }
  return items;
}

async function fetchRssSearch(url) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.5",
      },
      signal: AbortSignal.timeout(MEDIA_SEARCH_TIMEOUT_MS),
    });
    if (!r.ok) return [];
    return parseSearchRss(await r.text(), new URL(url).hostname);
  } catch (error) {
    console.error(
      "Media search RSS:",
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

function buildMediaSearchQueries(item) {
  const headline = cleanText(item.title || "")
    .replace(/[|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!headline) return [];

  const tokens = storyTokens(headline);
  const words = [...tokens].filter((w) => w.length >= 4).slice(0, 8);
  const compact = words.join(" ");
  const locationWords = words.filter((w) =>
    /(?:рязан|мост|солотч|москв|петер|волгоград|калуж|санкт|спб|москв|област|район)/i.test(
      w
    )
  );
  const place = locationWords.slice(0, 2).join(" ");

  // Do not require the exact original headline. A witness/video report
  // almost always has a different headline from the first RSS story.
  const queries = [
    `${compact} видео`,
    `${compact} кадры`,
    `${compact} очевидец видео`,
    `${compact} регистратор видео`,
    `${compact} соцсети видео`,
  ];
  if (place) {
    queries.push(`${place} ДТП видео`);
    queries.push(`${place} авария видео очевидцы`);
  }
  // Also keep one exact-ish query as a high precision fallback.
  queries.push(`"${headline.slice(0, 140)}" видео`);

  return [...new Set(queries)];
}
function buildSearchFeedUrls(query) {
  const encoded = encodeURIComponent(`${query} when:3d`);
  return [
    `https://www.bing.com/search?q=${encoded}&format=rss`,
    `https://news.google.com/rss/search?q=${encoded}&hl=ru&gl=RU&ceid=RU:ru`,
  ];
}

async function loadExternalMediaPages(item, articleUrl) {
  const queries = buildMediaSearchQueries(item);
  const feeds = queries.flatMap(buildSearchFeedUrls);
  const feedResults = (await Promise.all(feeds.map(fetchRssSearch))).flat();
  const articleHost = (() => {
    try {
      return normalizeHost(new URL(articleUrl).hostname);
    } catch {
      return "";
    }
  })();
  const seen = new Set();
  const candidates = [];
  for (const r of feedResults) {
    const resolved = await resolveArticleUrl({
      link: r.link,
      source: r.source,
      sourceUrl: r.link,
    });
    const url = isLikelyArticleUrl(resolved)
      ? resolved
      : isLikelyArticleUrl(r.link)
      ? normalizeUrl(r.link)
      : "";
    if (!url || isTechnicalUrl(url)) continue;
    const host = (() => {
      try {
        return normalizeHost(new URL(url).hostname);
      } catch {
        return "";
      }
    })();
    if (articleHost && host === articleHost) continue;
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      url: key,
      rssMediaUrls: r.rssMediaUrls || [],
      title: r.title,
      description: r.description,
      source: r.source,
    });
    if (candidates.length >= MEDIA_SEARCH_MAX_PAGES) break;
  }
  return candidates;
}

async function inspectExternalMediaPage(candidate) {
  const page = await loadArticlePage(candidate.url);
  if (!page) return null;
  const { finalUrl, html } = page;
  const title =
    findMeta(html, "og:title") ||
    findMeta(html, "twitter:title") ||
    candidate.title ||
    "";
  const description =
    findMeta(html, "og:description") ||
    findMeta(html, "description") ||
    candidate.description ||
    "";

  const videoUrls = collectVideoCandidates(html, finalUrl).map((x) => x.url);

  // Many regional news sites embed VK/MAX/other players through an iframe.
  // The outer article contains no MP4 itself, so inspect one embed page as a
  // media-only hop. This does not alter story selection.
  const embeds = [];
  for (const m of html.matchAll(
    /<(?:iframe|embed)\b[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/gi
  )) {
    const u = mediaCandidateUrl(m[1], finalUrl);
    if (!u || embeds.includes(u)) continue;
    embeds.push(u);
    if (embeds.length >= 5) break;
  }
  for (const embedUrl of embeds) {
    try {
      const r = await fetch(embedUrl, {
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.5",
          Referer: finalUrl,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("text/html") && !ct.includes("application/xhtml+xml"))
        continue;
      const embedHtml = await r.text();
      const embedFinal = normalizeUrl(r.url || embedUrl);
      for (const v of collectVideoCandidates(embedHtml, embedFinal).map(
        (x) => x.url
      )) {
        if (!videoUrls.includes(v)) videoUrls.push(v);
      }
    } catch {
      // Ignore one blocked embed and continue searching other sources.
    }
  }

  return {
    articleUrl: finalUrl,
    sourceName: findMeta(html, "og:site_name") || candidate.source || "",
    title,
    description,
    imageCandidates: collectImageCandidates(
      html,
      finalUrl,
      title,
      description,
      candidate.rssMediaUrls || []
    ),
    videoUrls,
  };
}

async function discoverExternalMedia(item, articleMedia) {
  // Only search outside the original publisher after exhausting its own page.
  // The order is deliberate: publisher video -> external video -> publisher image -> external image.
  const externalCandidates = await loadExternalMediaPages(
    item,
    articleMedia.articleUrl || item.link || ""
  );
  const inspected = (
    await Promise.all(externalCandidates.map(inspectExternalMediaPage))
  ).filter(Boolean);
  const videos = [];
  const images = [];
  const seenVideo = new Set();
  const seenImage = new Set();
  for (const page of inspected) {
    for (const url of page.videoUrls || []) {
      if (!seenVideo.has(url)) {
        seenVideo.add(url);
        videos.push({
          url,
          referer: page.articleUrl,
          source: page.sourceName || "external",
        });
      }
    }
    for (const c of page.imageCandidates || []) {
      if (!seenImage.has(c.url)) {
        seenImage.add(c.url);
        images.push({
          ...c,
          referer: page.articleUrl,
          source: page.sourceName || "external",
        });
      }
    }
  }
  return { videos, images };
}

async function extractArticleMedia(item) {
  const resolvedUrl = await resolveArticleUrl(item);
  // Google News is a valid last-resort source link. We prefer the real
  // publisher URL, but a resolver failure must NEVER discard an otherwise
  // valid RSS story. The article page loader is intentionally skipped for
  // this fallback; RSS title/description remain usable editorial input.
  const articleUrl = isLikelyArticleUrl(resolvedUrl)
    ? resolvedUrl
    : isGoogleNewsUrl(item.link)
    ? normalizeUrl(item.link)
    : "";
  if (!articleUrl) {
    return {
      articleUrl: "",
      imageUrl: null,
      imageUrls: [],
      imageCandidates: [],
      videoUrl: null,
      videoUrls: [],
      sourceName: null,
      title: null,
      description: null,
    };
  }
  if (isGoogleNewsUrl(articleUrl)) {
    return {
      articleUrl,
      imageUrl: item.rssMediaUrls?.[0] || null,
      imageUrls: item.rssMediaUrls || [],
      imageCandidates: (item.rssMediaUrls || []).map((url, i) => ({
        url,
        score: 16 - i,
        kind: "rss",
      })),
      videoUrl: null,
      videoUrls: [],
      sourceName: item.source || null,
      title: item.title || null,
      description: item.description || null,
    };
  }
  const page = await loadArticlePage(articleUrl);
  if (!page) {
    // The publisher page can block automated requests (403/429, anti-bot,
    // TLS/proxy issues) even when the resolved article URL itself is valid.
    // Try WordPress REST as a media-only fallback before giving up.
    const wp = await wordpressMediaFallback(
      articleUrl,
      item.title || "",
      item.description || ""
    );
    // Do NOT discard the news item in that case. Keep the verified article URL
    // and use the RSS title/description as the editorial source. Media remains
    // empty and the existing VIDEO -> IMAGE -> TEXT fallback handles that.
    return {
      articleUrl,
      imageUrl: null,
      imageUrls: [],
      imageCandidates: wp,
      videoUrl: null,
      videoUrls: [],
      sourceName: item.source || null,
      title: item.title || null,
      description: item.description || null,
    };
  }
  const { finalUrl, html } = page;
  const pageTitle =
    findMeta(html, "og:title") || findMeta(html, "twitter:title") || item.title;
  const pageDescription =
    findMeta(html, "og:description") ||
    findMeta(html, "description") ||
    item.description;
  let imageCandidates = collectImageCandidates(
    html,
    finalUrl,
    pageTitle,
    pageDescription,
    item.rssMediaUrls || []
  );
  const videoUrls = collectVideoCandidates(html, finalUrl);

  // WordPress exposes the original featured image/content media through the
  // REST API even when the rendered page uses lazy loading or CDN markup that
  // a simple HTML extractor cannot see. This is a media-only fallback; it does
  // not alter story selection or the working news pipeline.
  if (
    imageCandidates.length === 0 ||
    imageCandidates.every(
      (x) => x.kind === "rss" || mediaIsGeneric(x.url, x.context)
    )
  ) {
    const wp = await wordpressMediaFallback(
      finalUrl,
      pageTitle,
      pageDescription
    );
    const seen = new Set(imageCandidates.map((x) => normalizeUrl(x.url)));
    imageCandidates = [
      ...imageCandidates,
      ...wp.filter((x) => !seen.has(normalizeUrl(x.url))),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }
  return {
    articleUrl: finalUrl,
    imageUrl: imageCandidates[0]?.url || null,
    imageUrls: imageCandidates.map((x) => x.url),
    imageCandidates,
    videoUrl: videoUrls[0] || null,
    videoUrls,
    sourceName:
      findMeta(html, "og:site_name") ||
      findMeta(html, "application-name") ||
      item.source ||
      null,
    title: pageTitle,
    description: pageDescription,
  };
}
// ============================================================
// MEDIA DOWNLOAD
// ============================================================
function isMaxDirectImageUrl(url) {
  return /\.(?:jpe?g|png|gif|tiff?|bmp|heic)(?:[?#]|$)/i.test(
    String(url || "")
  );
}

function isMaxDirectVideoUrl(url) {
  return /\.(?:mp4|mov|mkv|webm)(?:[?#]|$)/i.test(String(url || ""));
}

function extractImageLinksFromHtml(html, baseUrl, title, description) {
  const out = [];
  const seen = new Set();
  const add = (raw, kind = "linked_image", bonus = 0) => {
    const url = mediaCandidateUrl(raw, baseUrl);
    if (!url || !isMaxDirectImageUrl(url)) return;
    const key = normalizeUrl(url);
    if (!key || seen.has(key) || mediaIsGeneric(key)) return;
    seen.add(key);
    out.push({
      url: key,
      score:
        40 +
        bonus +
        mediaTextScore(key, `${title} ${description}`, title, description),
      kind,
      context: `${title} ${description}`,
    });
  };

  // Very common WordPress pattern: the visible photo is wrapped in an <a>
  // whose href points to the original JPG/PNG, while the <img> itself may
  // be lazy-loaded or served through a thumbnail/CDN URL.
  for (const m of html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>[\s\S]{0,2500}?<img\b[^>]*>/gi
  )) {
    add(m[1], "linked_article_image", 14);
  }
  // Also catch direct image links that contain no <img> tag.
  for (const m of html.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+\.(?:jpe?g|png|gif|tiff?|bmp|heic)(?:\?[^"']*)?)["'][^>]*>/gi
  )) {
    add(m[1], "linked_image", 10);
  }
  // CSS background images used by lazy galleries.
  for (const m of html.matchAll(
    /(?:background-image|data-background-image|data-bg)=\s*(?:url\(\s*)?["']?([^"')\s]+\.(?:jpe?g|png|gif|tiff?|bmp|heic)(?:\?[^"')\s]*)?)["']?\s*\)?/gi
  )) {
    add(m[1], "background_image", 5);
  }
  return out;
}

async function wordpressMediaFallback(articleUrl, title, description) {
  try {
    const u = new URL(articleUrl);
    const slug = u.pathname.split("/").filter(Boolean).pop() || "";
    if (!slug || slug.length < 5) return [];
    const api = new URL("/wp-json/wp/v2/posts", `${u.origin}/`);
    api.searchParams.set("slug", slug);
    api.searchParams.set("_embed", "1");
    const response = await fetch(api.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const post = Array.isArray(data) ? data[0] : null;
    if (!post) return [];
    const candidates = [];
    const push = (raw, kind, bonus = 0) => {
      const url = mediaCandidateUrl(raw, articleUrl);
      if (!url || !isMaxDirectImageUrl(url) || mediaIsGeneric(url)) return;
      if (candidates.some((x) => normalizeUrl(x.url) === normalizeUrl(url)))
        return;
      candidates.push({
        url: normalizeUrl(url),
        score:
          60 +
          bonus +
          mediaTextScore(url, `${title} ${description}`, title, description),
        kind,
        context: `${title} ${description}`,
      });
    };
    push(post.featured_image_url, "wordpress_featured", 20);
    const media = post._embedded?.["wp:featuredmedia"]?.[0];
    push(media?.source_url, "wordpress_featured", 25);
    push(media?.guid?.rendered, "wordpress_featured", 15);
    const html = post.content?.rendered || "";
    candidates.push(
      ...extractImageLinksFromHtml(html, articleUrl, title, description)
    );
    return candidates.sort((a, b) => b.score - a.score).slice(0, 20);
  } catch (error) {
    console.error(
      "WordPress media fallback:",
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

function extensionFromType(type, contentType, url) {
  const ct = contentType.toLowerCase();
  if (type === "video") {
    if (ct.includes("webm")) {
      return "webm";
    }
    if (ct.includes("quicktime")) {
      return "mov";
    }
    if (ct.includes("matroska")) {
      return "mkv";
    }
    return "mp4";
  }
  if (ct.includes("png")) {
    return "png";
  }
  if (ct.includes("gif")) {
    return "gif";
  }
  if (ct.includes("webp")) {
    return "webp";
  }
  if (ct.includes("avif")) {
    return "avif";
  }
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]{2,5})$/i);
    if (match) {
      return match[1].toLowerCase();
    }
  } catch {
    // ignore
  }
  return "jpg";
}
async function downloadMedia(url, type, referer = "") {
  try {
    if (!isHttpUrl(url)) {
      return null;
    }
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          type === "video"
            ? "video/mp4,video/quicktime,video/webm,video/*;q=0.9,*/*;q=0.3"
            : "image/avif,image/webp,image/apng,image/*,*/*;q=0.5",
        ...(referer ? { Referer: referer } : {}),
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
      },
      signal: AbortSignal.timeout(
        type === "video" ? MEDIA_DOWNLOAD_TIMEOUT_MS : 20000
      ),
    });
    if (!response.ok) {
      return null;
    }
    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (
      contentType.includes("mpegurl") ||
      contentType.includes("dash") ||
      contentType.includes("application/vnd.apple.mpegurl")
    ) {
      return null;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    const limit = type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (contentLength > 0 && contentLength > limit) {
      console.log("Media too large:", contentLength);
      return null;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) {
      return null;
    }
    const finalUrl = response.url || url;
    if (type === "video" && !contentType.startsWith("video/")) {
      if (!isDirectVideoUrl(finalUrl)) {
        return null;
      }
    }
    if (type === "video" && !videoHasAudio(buffer, contentType, finalUrl)) {
      console.log("Rejecting video without audio:", finalUrl);
      return null;
    }
    if (type === "image" && !contentType.startsWith("image/")) {
      if (!/\.(jpg|jpeg|png|gif|webp|tiff|bmp|heic)(?:\?|$)/i.test(finalUrl)) {
        return null;
      }
    }
    return {
      type,
      bytes: buffer,
      contentType:
        contentType || (type === "video" ? "video/mp4" : "image/jpeg"),
      extension: extensionFromType(type, contentType, finalUrl),
      sourceUrl: finalUrl,
    };
  } catch (error) {
    console.error(
      "Download media:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
// ============================================================
// MAX API
// ============================================================
async function maxFetch(path, options = {}) {
  if (!MAX_BOT_TOKEN) {
    throw new Error("MAX_BOT_TOKEN is missing");
  }
  const headers = new Headers(options.headers ?? {});
  headers.set("Authorization", MAX_BOT_TOKEN);
  headers.set("Accept", "application/json");
  const client = await initMaxHttpClient();
  return await fetch(`${MAX_API}${path}`, {
    ...options,
    client: client ?? undefined,
    headers,
  });
}
async function maxJson(path, options = {}) {
  const response = await maxFetch(path, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {
      raw: text,
    };
  }
  if (!response.ok) {
    throw new Error(`MAX ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}
// ============================================================
// MAX UPLOAD
// ============================================================
async function uploadMedia(media) {
  const init = await maxJson(
    `/uploads?type=${encodeURIComponent(media.type)}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
    }
  );
  if (!init.url) {
    throw new Error(`MAX upload URL missing for ${media.type}`);
  }
  const form = new FormData();
  const blob = new Blob([media.bytes], {
    type: media.contentType,
  });
  form.append("data", blob, `factor.${media.extension}`);
  const uploadResponse = await fetch(init.url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(
      `Media upload HTTP ${uploadResponse.status}: ${uploadText.slice(0, 1500)}`
    );
  }
  let uploadResult = null;
  try {
    uploadResult = uploadText ? JSON.parse(uploadText) : null;
  } catch {
    // ignore
  }
  const finalToken =
    init.token ||
    uploadResult?.token ||
    uploadResult?.mediafile_token ||
    uploadResult?.photos?.photoIds?.token ||
    null;
  if (typeof finalToken !== "string" || !finalToken) {
    throw new Error(
      `MAX media token missing for ${media.type}. ` +
        `Upload response: ${uploadText.slice(0, 1500)}`
    );
  }
  return finalToken;
}
// ============================================================
// MAX PUBLISH
// ============================================================
async function publishToMax(text, mediaToken) {
  if (!TARGET_CHAT_ID) {
    throw new Error("TARGET_CHAT_ID is missing");
  }
  const body = {
    text,
    format: "html",
    notify: true,
    disable_link_preview: true,
  };
  if (mediaToken) {
    const attachment = {
      type: mediaToken.type,
      payload: mediaToken.remoteUrl
        ? { url: mediaToken.remoteUrl }
        : { token: mediaToken.token },
    };
    body.attachments = [attachment];
  }
  return await maxJson(
    `/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}
// ============================================================
// DEDUPLICATION
// ============================================================
function normalizeArticleUrl(url) {
  if (!isUsableArticleUrl(url)) return "";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    // Never treat Google News logos/images or generic media files as articles.
    if (
      host === "gstatic.com" ||
      host.endsWith(".gstatic.com") ||
      host === "ggpht.com" ||
      host.endsWith(".ggpht.com") ||
      /(^|\/)(google_news|google-news|logo)[^\/]*\.(png|jpg|jpeg|webp|gif)$/i.test(
        path
      ) ||
      /\.(png|jpe?g|webp|gif|svg|mp4|webm|m3u8|mpd)$/i.test(path)
    ) {
      return "";
    }
  } catch {
    return "";
  }
  return normalizeUrl(url);
}
async function publishedKey(item, articleUrl) {
  const normalizedTitle = normalizeForHash(item.title);
  const normalizedUrl = normalizeArticleUrl(articleUrl);
  return await sha256(`${normalizedTitle}|${normalizedUrl}`);
}
async function legacyPublishedKey(item) {
  return await sha256(normalizeForHash(`${item.title}|${item.source}`));
}
// Semantic fingerprint for the STORY itself.
// It deliberately does not include source or URL because the same
// event is often published by several RSS feeds with different URLs.
const STORY_STOP_WORDS = new Set([
  "это",
  "этот",
  "эта",
  "эти",
  "после",
  "перед",
  "когда",
  "который",
  "которая",
  "которые",
  "также",
  "стало",
  "стали",
  "сообщил",
  "сообщили",
  "рассказал",
  "рассказали",
  "заявил",
  "заявили",
  "известно",
  "новости",
  "новость",
  "сегодня",
  "вчера",
  "теперь",
  "против",
  "согласно",
  "сообщает",
]);
function storyTokens(value) {
  const normalized = normalizeForHash(value);
  const words = normalized.split(" ").filter((w) => w.length >= 4);
  const tokens = new Set();
  for (const word of words) {
    if (STORY_STOP_WORDS.has(word)) continue;
    // Prefix normalization catches simple Russian inflections:
    // погиб / погибла / погибли, столкновение / столкновении, etc.
    tokens.add(word.length > 6 ? word.slice(0, 6) : word);
  }
  return tokens;
}
function storySimilarity(a, b) {
  const aw = storyTokens(a);
  const bw = storyTokens(b);
  if (aw.size === 0 || bw.size === 0) return 0;
  let common = 0;
  for (const token of aw) {
    if (bw.has(token)) common++;
  }
  return common / Math.max(aw.size, bw.size);
}
async function semanticStoryKey(item) {
  const title = normalizeForHash(item.title);
  const desc = normalizeForHash(item.description);
  const tokens = [...storyTokens(`${title} ${desc}`)].sort();
  return sha256(tokens.join("|"));
}
function eventSimilarity(a, b) {
  const A = storyTokens(a);
  const B = storyTokens(b);
  if (!A.size || !B.size) return 0;
  const COMMON_EVENT = new Set([
    "санкц",
    "пожар",
    "дтп",
    "авария",
    "взрыв",
    "погиб",
    "погибл",
    "ранен",
    "эвакуа",
    "опасн",
    "атака",
    "удар",
    "транспорт",
    "компан",
    "суд",
    "арест",
    "закон",
    "ставк",
    "банк",
    "рубл",
    "доллар",
    "иран",
    "сша",
  ]);
  let common = 0;
  let eventCommon = 0;
  for (const t of A) {
    if (B.has(t)) {
      common++;
      if (COMMON_EVENT.has(t)) eventCommon++;
    }
  }
  const entityA = [...A].filter((x) => x.length >= 4 && !COMMON_EVENT.has(x));
  const entityB = new Set(
    [...B].filter((x) => x.length >= 4 && !COMMON_EVENT.has(x))
  );
  let entityCommon = 0;
  for (const t of entityA) if (entityB.has(t)) entityCommon++;
  const jaccard = common / Math.max(A.size, B.size);
  // Same distinctive entity + same event family is enough to reject repeated updates.
  if (eventCommon >= 2 && entityCommon >= 1) return 1;
  if (eventCommon >= 3) return 1;
  return jaccard;
}

async function isAlreadyPublished(item, articleUrl = "") {
  const db = await getKV();

  // 1) Exact URL + title key.
  if (articleUrl) {
    const key = await publishedKey(item, articleUrl);
    const result = await db.get(["factor", "published_v2", key]);
    if (result.value === true) {
      return true;
    }
  }

  // 2) Legacy exact key.
  const oldKey = await legacyPublishedKey(item);
  const legacy = await db.get(["factor", "published", oldKey]);
  if (legacy.value === true) {
    return true;
  }

  // 3) Exact source-independent story fingerprint.
  const semanticKey = await semanticStoryKey(item);
  if (semanticKey) {
    const semantic = await db.get([
      "factor",
      "published_story_v3",
      semanticKey,
    ]);
    if (semantic.value === true) {
      return true;
    }
  }

  // 4) Conservative protection against a materially identical event
  // returning with a different headline. The old V18 thresholds were
  // too aggressive and could reject legitimate new stories.
  const recent = await getRecentTitles(Math.min(MAX_HISTORY_CHECKED, 100));
  const candidateTitle = item.title.trim();

  for (const oldTitle of recent) {
    if (storySimilarity(candidateTitle, oldTitle) >= 0.92) {
      return true;
    }
    if (eventSimilarity(candidateTitle, oldTitle) >= 0.99) {
      return true;
    }
  }

  return false;
}
async function markPublished(item, articleUrl) {
  const db = await getKV();
  const normalizedUrl = normalizeArticleUrl(articleUrl);
  const key = await publishedKey(item, normalizedUrl);
  await db.set(["factor", "published_v2", key], true, {
    expireIn: HISTORY_TTL_MS,
  });
  const oldKey = await legacyPublishedKey(item);
  await db.set(["factor", "published", oldKey], true, {
    expireIn: HISTORY_TTL_MS,
  });
  // Persist a source-independent story key. This is what prevents
  // the same event from returning through another RSS feed.
  const semanticKey = await semanticStoryKey(item);
  if (semanticKey) {
    await db.set(["factor", "published_story_v3", semanticKey], true, {
      expireIn: HISTORY_TTL_MS,
    });
  }
}
// ============================================================
// RECENT TITLES
// ============================================================
async function getRecentTitles(limit = MAX_HISTORY_CHECKED) {
  const db = await getKV();
  const titles = [];
  for await (const entry of db.list({
    prefix: ["factor", "recent_title_v2"],
    reverse: true,
  })) {
    if (entry.value) {
      titles.push(entry.value);
    }
    if (titles.length >= limit) {
      break;
    }
  }
  return titles;
}
async function rememberTitle(title) {
  const db = await getKV();
  const id = await sha256(normalizeForHash(title));
  await db.set(["factor", "recent_title_v2", Date.now(), id], title, {
    expireIn: HISTORY_TTL_MS,
  });
}
// ============================================================
// URGENCY
// ============================================================
function detectUrgency(item) {
  const text = normalizeForHash(`${item.title} ${item.description}`);
  const urgentPatterns = [
    "теракт",
    "террорист",
    "атака",
    "взрыв",
    "взрыва",
    "пожар",
    "землетрясение",
    "цунами",
    "катастроф",
    "авария",
    "крушение",
    "самолет разбился",
    "самолет потерпел",
    "погиб",
    "погибли",
    "убит",
    "убиты",
    "захват заложников",
    "военные действия",
    "началась война",
    "обстрел",
    "ракетн",
    "санкции",
    "чрезвычайное положение",
    "эвакуация",
    "прорыв дамбы",
    "массовое отключение",
  ];
  return urgentPatterns.some((pattern) => text.includes(pattern));
}
// ============================================================
// NEWS SCORE
// ============================================================
function scoreNewsItem(item) {
  const title = normalizeForHash(item.title);
  const description = normalizeForHash(item.description);
  const combined = `${title} ${description}`;
  let score = 0;
  const urgency = detectUrgency(item);
  // ----------------------------------------------------------
  // Свежесть
  // ----------------------------------------------------------
  const timestamp = Date.parse(item.pubDate) || 0;
  const ageMinutes =
    timestamp > 0 ? Math.max(0, (Date.now() - timestamp) / 60000) : 180;
  if (ageMinutes <= 15) {
    score += 30;
  } else if (ageMinutes <= 30) {
    score += 27;
  } else if (ageMinutes <= 60) {
    score += 23;
  } else if (ageMinutes <= 120) {
    score += 18;
  } else if (ageMinutes <= 360) {
    score += 10;
  } else {
    score += 2;
  }
  // ----------------------------------------------------------
  // Срочность
  // ----------------------------------------------------------
  if (urgency) {
    score += 30;
  }
  // ----------------------------------------------------------
  // Содержательные ключевые слова
  // ----------------------------------------------------------
  const highValuePatterns = [
    "решение",
    "закон",
    "законопроект",
    "ставка",
    "инфляция",
    "санкции",
    "банк",
    "биржа",
    "рынок",
    "инвестиции",
    "миллиард",
    "миллиона",
    "сделка",
    "компания",
    "акции",
    "нефть",
    "газ",
    "энергетика",
    "производство",
    "технологии",
    "искусственный интеллект",
    "кибербезопасность",
    "суд",
    "правительство",
    "президент",
    "министр",
    "парламент",
    "выборы",
    "авария",
    "катастрофа",
    "землетрясение",
  ];
  for (const pattern of highValuePatterns) {
    if (combined.includes(pattern)) {
      score += 2;
    }
  }
  // ----------------------------------------------------------
  // Длина заголовка
  // ----------------------------------------------------------
  if (title.length >= 35 && title.length <= 180) {
    score += 8;
  }
  // ----------------------------------------------------------
  // Слишком общий заголовок
  // ----------------------------------------------------------
  const weakPatterns = [
    "подробности",
    "стало известно",
    "что известно",
    "последние новости",
    "главные новости",
    "смотрите",
    "рассказали",
  ];
  for (const pattern of weakPatterns) {
    if (title.includes(pattern)) {
      score -= 8;
    }
  }
  // ----------------------------------------------------------
  // Слишком короткая новость
  // ----------------------------------------------------------
  if (description.length < 40) {
    score -= 5;
  }
  return {
    item,
    score,
    urgency,
  };
}
// ============================================================
// GEMINI
// ============================================================
function extractJson(text) {
  const cleaned = text
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}
async function callGemini(item, articleMedia) {
  if (!GEMINI_API_KEY) {
    return null;
  }
  const prompt = ` Ты редактор новостного канала ФАКТОР. Работай ТОЛЬКО с информацией, которая присутствует в исходных данных. НЕ ДОБАВЛЯЙ факты из памяти. НЕ ДОДУМЫВАЙ причины. НЕ ДОДУМЫВАЙ последствия. НЕ ПРИДУМЫВАЙ цифры. ИСХОДНЫЙ ЗАГОЛОВОК: ${item.title} ИСТОЧНИК: ${item.source} ЗАГОЛОВОК СТРАНИЦЫ: ${articleMedia.title ?? ""} ОПИСАНИЕ RSS: ${stripHtml(item.description)} ОПИСАНИЕ СТРАНИЦЫ: ${stripHtml(articleMedia.description ?? "")} Верни ТОЛЬКО JSON: { "headline": "короткий точный заголовок", "short": "одно короткое предложение о событии", "main": [ "конкретный факт 1", "конкретный факт 2", "конкретный факт 3" ], "important": "конкретная информация, которую читателю важно знать", "urgent": false } ПРАВИЛА: 1. Никаких выдуманных фактов. 2. headline должен описывать именно событие. 3. Не используй кликбейт. 4. Не используй вопросительные заголовки. 5. Не пиши "стало известно". 6. Не пиши "ситуация развивается". 7. Не пиши рекламные формулировки. 8. Не повторяй одну мысль в разных блоках. 9. Если фактов мало — используй меньше пунктов. 10. main может содержать от 0 до 3 пунктов. 11. urgent=true только если событие действительно срочное. 12. Не делай выводов, которых нет в исходных данных. 13. Не меняй смысл новости. 14. Не добавляй географию, даты, цифры или имена, которых нет в исходных данных. `;
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        encodeURIComponent(GEMINI_API_KEY),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!response.ok) {
      console.error(
        "Gemini HTTP:",
        response.status,
        (await response.text()).slice(0, 1000)
      );
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      return null;
    }
    const json = extractJson(text);
    if (!json) {
      return null;
    }
    return {
      headline: stripHtml(String(json.headline || item.title)),
      short: stripHtml(String(json.short || item.description || item.title)),
      main: Array.isArray(json.main)
        ? json.main
            .map((x) => stripHtml(String(x)))
            .filter(Boolean)
            .slice(0, 3)
        : [],
      important: stripHtml(String(json.important || "")),
      urgent: Boolean(json.urgent) || detectUrgency(item),
    };
  } catch (error) {
    console.error(
      "Gemini:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
// ============================================================
// FALLBACK
// ============================================================
function makeFallbackStory(item, articleMedia) {
  const short = truncate(
    stripHtml(articleMedia.description || item.description || item.title),
    500
  );
  return {
    headline: stripHtml(articleMedia.title || item.title),
    short,
    // Do not fabricate duplicate sections when there are no extra facts.
    main: [],
    important: "",
    urgent: detectUrgency(item),
  };
}
// ============================================================
// TEXT DUPLICATES
// ============================================================
function textWords(value) {
  return new Set(
    normalizeForHash(value)
      .split(" ")
      .filter((word) => word.length >= 5)
  );
}
function similarity(a, b) {
  const aw = textWords(a);
  const bw = textWords(b);
  if (aw.size === 0 || bw.size === 0) {
    return 0;
  }
  let common = 0;
  for (const word of aw) {
    if (bw.has(word)) {
      common++;
    }
  }
  return common / Math.max(aw.size, bw.size);
}
async function isRepeatedStoryText(story) {
  const recent = await getRecentTitles(MAX_HISTORY_CHECKED);
  if (!story.headline.trim()) {
    return false;
  }
  for (const oldTitle of recent) {
    if (similarity(story.headline, oldTitle) >= 0.72) {
      return true;
    }
  }
  return false;
}
// ============================================================
// SOURCE
// ============================================================
function cleanSourceName(source, articleMedia) {
  const candidate = articleMedia.sourceName || source || "Источник";
  return cleanText(
    candidate.replace(/^https?:\/\//i, "").replace(/^www\./i, "")
  );
}
// ============================================================
// POST
// ============================================================
function buildPost(item, story, sourceName, articleUrl) {
  // TELEGRAM-LIKE LIVE FEED FORMAT.
  // Do not expose internal Gemini fields such as "short", "main" or
  // "important" as separate sections. Keep one compact news message.
  const urgent = Boolean(story.urgent);
  const headlineText = stripHtml(truncate(story.headline || item.title, 260));

  const candidates = [
    story.short,
    ...(Array.isArray(story.main) ? story.main : []),
    story.important,
  ]
    .map((value) => stripHtml(truncate(String(value || ""), 700)).trim())
    .filter(Boolean);

  let bodyText = "";
  for (const candidate of candidates) {
    if (storySimilarity(candidate, headlineText) < 0.82) {
      bodyText = candidate;
      break;
    }
  }

  const sourceLine = isLikelyArticleUrl(articleUrl)
    ? `🔗 <a href="${escapeHtml(articleUrl)}">${escapeHtml(sourceName)}</a>`
    : "";

  // Direct-feed style: marker + headline + one concise body + source.
  // No labels like "Кратко", "Некратко", "Важно", no category block,
  // no artificial footer and no duplicate sections.
  const parts = [];
  if (urgent) parts.push("🔴");
  parts.push(`<b>${escapeHtml(headlineText)}</b>`);
  if (bodyText) parts.push("", escapeHtml(bodyText));
  if (sourceLine) parts.push("", sourceLine);

  let result = parts.join("\n").trim();
  if (result.length > MAX_POST_LENGTH) {
    result = result.slice(0, MAX_POST_LENGTH - 1).trimEnd() + "…";
  }
  return result;
}
// ============================================================
// MEDIA
// ============================================================
async function findBestMedia(articleMedia, item) {
  // 1. VIDEO FROM THE ORIGINAL PUBLISHER.
  const articleVideoCandidates = articleMedia.videoUrls?.length
    ? articleMedia.videoUrls
    : articleMedia.videoUrl
    ? [articleMedia.videoUrl]
    : [];
  for (const videoUrl of articleVideoCandidates) {
    console.log("Trying publisher video:", videoUrl);
    const video = await downloadMedia(
      videoUrl,
      "video",
      articleMedia.articleUrl || ""
    );
    if (video) return video;
  }

  // 2. VIDEO FROM OTHER REPORTING / WITNESSES / LOCAL MEDIA.
  // Search is intentionally performed before any image fallback.
  let external = { videos: [], images: [] };
  try {
    external = await discoverExternalMedia(item, articleMedia);
  } catch (error) {
    console.error(
      "External media discovery:",
      error instanceof Error ? error.message : String(error)
    );
  }
  for (const candidate of external.videos) {
    console.log(
      "Trying external video:",
      candidate.url,
      "source:",
      candidate.source
    );
    const video = await downloadMedia(
      candidate.url,
      "video",
      candidate.referer || articleMedia.articleUrl || ""
    );
    if (video) return video;
  }

  // 3. PHOTO FROM THE ORIGINAL PUBLISHER.
  const imageCandidates = articleMedia.imageCandidates?.length
    ? articleMedia.imageCandidates
    : articleMedia.imageUrls?.length
    ? articleMedia.imageUrls.map((url) => ({ url, score: 0 }))
    : articleMedia.imageUrl
    ? [{ url: articleMedia.imageUrl, score: 0 }]
    : [];
  for (const candidate of imageCandidates) {
    console.log(
      "Trying publisher image:",
      candidate.url,
      "score:",
      candidate.score ?? 0,
      "kind:",
      candidate.kind || "unknown"
    );
    const image = await downloadMedia(
      candidate.url,
      "image",
      articleMedia.articleUrl || ""
    );
    if (image) return image;
    // MAX supports external image URLs directly in an image attachment.
    // Use this only for formats MAX documents as supported; it avoids the
    // old failure mode where a valid JPG was found but the download path
    // was blocked and the bot silently fell back to a page preview.
    if (isMaxDirectImageUrl(candidate.url)) {
      return {
        type: "image",
        remoteUrl: candidate.url,
        sourceUrl: candidate.url,
      };
    }
  }

  // 4. PHOTO FROM OTHER MEDIA / EYEWITNESS COVERAGE.
  for (const candidate of external.images) {
    console.log(
      "Trying external image:",
      candidate.url,
      "source:",
      candidate.source
    );
    const image = await downloadMedia(
      candidate.url,
      "image",
      candidate.referer || articleMedia.articleUrl || ""
    );
    if (image) return image;
    if (isMaxDirectImageUrl(candidate.url)) {
      return {
        type: "image",
        remoteUrl: candidate.url,
        sourceUrl: candidate.url,
      };
    }
  }

  return null;
}
// ============================================================
// CANDIDATE SELECTION
// ============================================================
async function chooseCandidate(items, urgentAllowed, regularAllowed) {
  const diagnostics = {
    input: items.length,
    scored: 0,
    interval_rejected: 0,
    duplicate_rejected: 0,
    article_url_rejected: 0,
    article_page_rejected: 0,
    story_rejected: 0,
    selected: 0,
    top_rejections: [],
  };

  // ----------------------------------------------------------
  // STEP 1 — LOCAL SCORE
  // ----------------------------------------------------------
  const scored = items
    .filter((item) => item.title.length >= 15)
    .map(scoreNewsItem)
    .filter((candidate) => {
      if (candidate.urgency && !urgentAllowed) {
        diagnostics.interval_rejected++;
        return false;
      }
      if (!candidate.urgency && !regularAllowed) {
        diagnostics.interval_rejected++;
        return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, SCORE_CANDIDATES);

  diagnostics.scored = scored.length;
  console.log("Scored candidates:", scored.length);

  // ----------------------------------------------------------
  // STEP 2 — REAL ARTICLE URL + DEDUP + GEMINI
  // Do NOT stop after the first bad candidate. We keep walking
  // the ranked list until a genuinely publishable item is found.
  // ----------------------------------------------------------
  let checked = 0;

  for (const candidate of scored) {
    checked++;
    const { item, score } = candidate;

    const reject = (reason) => {
      if (diagnostics.top_rejections.length < 12) {
        diagnostics.top_rejections.push({
          title: item.title.slice(0, 180),
          reason,
          score,
        });
      }
    };

    // Exact/semantic duplicate before network work.
    if (await isAlreadyPublished(item)) {
      diagnostics.duplicate_rejected++;
      reject("duplicate");
      continue;
    }

    const articleMedia = await extractArticleMedia(item);
    const articleUrl = normalizeArticleUrl(articleMedia.articleUrl);

    if (!isLikelyArticleUrl(articleUrl) && !isGoogleNewsUrl(articleUrl)) {
      diagnostics.article_url_rejected++;
      reject("article URL unavailable");
      continue;
    }

    if (await isAlreadyPublished(item, articleUrl)) {
      diagnostics.duplicate_rejected++;
      reject("published");
      continue;
    }

    // --------------------------------------------------------
    // STEP 3 — STORY
    // --------------------------------------------------------
    let story = null;

    if (checked <= GEMINI_CANDIDATES) {
      story = await callGemini(item, articleMedia);
    }

    if (!story) {
      story = makeFallbackStory(item, articleMedia);
    }

    story.urgent = Boolean(story.urgent || candidate.urgency);

    if (story.urgent && !urgentAllowed) {
      diagnostics.interval_rejected++;
      reject("urgent interval");
      continue;
    }

    if (!story.urgent && !regularAllowed) {
      diagnostics.interval_rejected++;
      reject("regular interval");
      continue;
    }

    if (await isRepeatedStoryText(story)) {
      diagnostics.story_rejected++;
      reject("repeated story text");
      continue;
    }

    diagnostics.selected = 1;
    console.log("Candidate selected:", {
      title: item.title,
      score,
      urgent: story.urgent,
      articleUrl,
    });

    return {
      item,
      story,
      articleMedia: {
        ...articleMedia,
        articleUrl,
      },
      score,
      diagnostics,
    };
  }

  console.log("No candidate selected:", JSON.stringify(diagnostics));

  // Returning null preserves the existing pipeline contract.
  // The caller writes the diagnostics to KV so the exact reason is
  // visible through /pipeline-state.
  await getKV()
    .then((db) =>
      db.set(["factor", "state", "selection_diagnostics"], diagnostics)
    )
    .catch(() => {});

  return null;
}
// ============================================================
// ATOMIC KV LOCK
// ============================================================
const PIPELINE_LOCK_KEY = ["factor", "lock"];
async function acquirePipelineLock() {
  const db = await getKV();
  const token = crypto.randomUUID();
  const result = await db
    .atomic()
    .check({
      key: PIPELINE_LOCK_KEY,
      versionstamp: null,
    })
    .set(
      PIPELINE_LOCK_KEY,
      {
        token,
        created_at: Date.now(),
      },
      {
        expireIn: LOCK_TTL_MS,
      }
    )
    .commit();
  if (!result.ok) {
    return null;
  }
  return token;
}
async function releasePipelineLock(token) {
  const db = await getKV();
  const current = await db.get(PIPELINE_LOCK_KEY);
  if (current.value?.token !== token) {
    return;
  }
  await db
    .atomic()
    .check({
      key: PIPELINE_LOCK_KEY,
      versionstamp: current.versionstamp,
    })
    .delete(PIPELINE_LOCK_KEY)
    .commit();
}
// ============================================================
// STATE
// ============================================================
async function getState() {
  const db = await getKV();
  const regular =
    (await db.get(["factor", "state", "last_regular"])).value ?? null;
  const urgent =
    (await db.get(["factor", "state", "last_urgent"])).value ?? null;
  const lastPipeline =
    (await db.get(["factor", "state", "last_pipeline"])).value ?? null;
  const selectionDiagnostics =
    (await db.get(["factor", "state", "selection_diagnostics"])).value ?? null;
  const lock = await db.get(PIPELINE_LOCK_KEY);
  const running = Boolean(lock.value);
  const now = Date.now();
  return {
    running,
    cron: CRON_SCHEDULE,
    regular: {
      interval_minutes: 30,
      last: regular,
      can_publish: regular === null || now - regular >= REGULAR_INTERVAL_MS,
    },
    urgent: {
      interval_minutes: 5,
      last: urgent,
      can_publish: urgent === null || now - urgent >= URGENT_INTERVAL_MS,
    },
    media: {
      max_video_mb: MAX_VIDEO_BYTES / 1024 / 1024,
      max_image_mb: MAX_IMAGE_BYTES / 1024 / 1024,
      priority: "video -> image -> text",
    },
    dedup: {
      persistent: true,
      ttl_days: 30,
      max_history_checked: MAX_HISTORY_CHECKED,
    },
    lock: {
      atomic: true,
      ttl_minutes: LOCK_TTL_MS / 60000,
    },
    last_pipeline: lastPipeline,
    selection_diagnostics: selectionDiagnostics,
  };
}
// ============================================================
// MEDIA PROCESSING RETRY
// ============================================================
async function publishWithMediaRetry(text, mediaInfo) {
  const delays = [5000, 10000, 20000, 30000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1]);
    }
    try {
      console.log(`MAX media publish attempt ${attempt + 1}`);
      return await publishToMax(text, mediaInfo);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error("MAX media publish:", message);
      const retryable =
        message.includes("attachment.not.ready") ||
        message.includes("not.processed") ||
        message.includes("processing");
      if (!retryable) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
// ============================================================
// PIPELINE
// ============================================================
async function runPipeline(manual = false) {
  const lock = await acquirePipelineLock();
  if (!lock) {
    return {
      ok: false,
      skipped: true,
      reason: "pipeline already running",
    };
  }
  try {
    return await executePipeline(manual);
  } finally {
    await releasePipelineLock(lock);
  }
}
async function executePipeline(manual = false) {
  const db = await getKV();
  const startedAt = Date.now();
  try {
    // --------------------------------------------------------
    // RSS
    // --------------------------------------------------------
    const feedResults = await Promise.all(RSS_FEEDS.map(loadRSS));
    const items = feedResults
      .flat()
      .sort((a, b) => {
        const ad = Date.parse(a.pubDate) || 0;
        const bd = Date.parse(b.pubDate) || 0;
        return bd - ad;
      })
      .slice(0, MAX_RSS_ITEMS);
    console.log("RSS items:", items.length);
    // --------------------------------------------------------
    // INTERVALS
    // --------------------------------------------------------
    const now = Date.now();
    const lastRegular =
      (await db.get(["factor", "state", "last_regular"])).value ?? null;
    const lastUrgent =
      (await db.get(["factor", "state", "last_urgent"])).value ?? null;
    const urgentAllowed =
      manual || lastUrgent === null || now - lastUrgent >= URGENT_INTERVAL_MS;
    const regularAllowed =
      manual ||
      lastRegular === null ||
      now - lastRegular >= REGULAR_INTERVAL_MS;
    if (!urgentAllowed && !regularAllowed) {
      const result = {
        ok: true,
        selected: 0,
        reason: "publication intervals not reached",
        rss_total: items.length,
        duration_ms: Date.now() - startedAt,
      };
      await db.set(["factor", "state", "last_pipeline"], result);
      return result;
    }
    // --------------------------------------------------------
    // CANDIDATE
    // --------------------------------------------------------
    const candidate = await chooseCandidate(
      items,
      urgentAllowed,
      regularAllowed
    );
    if (!candidate) {
      const result = {
        ok: true,
        selected: 0,
        reason: "no new valid candidate",
        rss_total: items.length,
        duration_ms: Date.now() - startedAt,
        selection_diagnostics:
          (await db.get(["factor", "state", "selection_diagnostics"])).value ??
          null,
      };
      await db.set(["factor", "state", "last_pipeline"], result);
      return result;
    }
    const { item, story, articleMedia, score } = candidate;
    const urgent = story.urgent || detectUrgency(item);
    if (urgent && !urgentAllowed && !manual) {
      return {
        ok: true,
        selected: 0,
        reason: "urgent interval not reached",
      };
    }
    if (!urgent && !regularAllowed && !manual) {
      return {
        ok: true,
        selected: 0,
        reason: "regular interval not reached",
      };
    }
    // --------------------------------------------------------
    // FINAL ARTICLE URL
    // --------------------------------------------------------
    const finalArticleUrl = normalizeArticleUrl(articleMedia.articleUrl);
    if (
      !isLikelyArticleUrl(finalArticleUrl) &&
      !isGoogleNewsUrl(finalArticleUrl)
    ) {
      return {
        ok: true,
        selected: 0,
        reason: "article URL missing",
      };
    }
    // --------------------------------------------------------
    // FINAL DEDUP
    // --------------------------------------------------------
    if (await isAlreadyPublished(item, finalArticleUrl)) {
      return {
        ok: true,
        selected: 0,
        reason: "duplicate detected before publish",
      };
    }
    // --------------------------------------------------------
    // MEDIA
    // --------------------------------------------------------
    const media = await findBestMedia(articleMedia, item);
    const sourceName = cleanSourceName(item.source, articleMedia);
    // MEDIA IS OPTIONAL. A valid news item must never be rejected only
    // because the publisher blocks image/video downloads (403/429/CDN,
    // hotlink protection, unsupported content type, etc.). We still try
    // every article media candidate first, but if none is downloadable we
    // publish the news as a normal text post.
    //
    // This is the critical final fallback: media failure must NOT turn
    // selected=1 into selected=0.
    if (!media) {
      console.log(
        "No downloadable article media; publishing text-only:",
        finalArticleUrl
      );
    }
    // --------------------------------------------------------
    // POST
    // --------------------------------------------------------
    const text = buildPost(item, story, sourceName, finalArticleUrl);
    let mediaInfo;
    // --------------------------------------------------------
    // UPLOAD
    // --------------------------------------------------------
    if (media) {
      try {
        if (media.remoteUrl) {
          console.log("Using remote MAX image attachment:", media.remoteUrl);
          mediaInfo = {
            type: media.type,
            remoteUrl: media.remoteUrl,
          };
        } else {
          console.log("Uploading media:", media.type, media.bytes.byteLength);
          const token = await uploadMedia(media);
          mediaInfo = {
            type: media.type,
            token,
          };
        }
      } catch (error) {
        console.error(
          "Media upload failed:",
          error instanceof Error ? error.message : String(error)
        );
        mediaInfo = undefined;
      }
    }
    // --------------------------------------------------------
    // PUBLISH
    // --------------------------------------------------------
    let publication;
    if (mediaInfo) {
      try {
        publication = await publishWithMediaRetry(text, mediaInfo);
      } catch (error) {
        console.error(
          "Media publication failed. " + "Falling back to text:",
          error instanceof Error ? error.message : String(error)
        );
        publication = await publishToMax(text);
      }
    } else {
      publication = await publishToMax(text);
    }
    // --------------------------------------------------------
    // MARK AS PUBLISHED
    // --------------------------------------------------------
    await markPublished(item, finalArticleUrl);
    await rememberTitle(story.headline);
    if (urgent) {
      await db.set(["factor", "state", "last_urgent"], now);
    } else {
      await db.set(["factor", "state", "last_regular"], now);
    }
    const result = {
      ok: true,
      selected: 1,
      urgent,
      manual,
      score,
      rss_total: items.length,
      item: {
        title: item.title,
        source: sourceName,
        article_url: finalArticleUrl,
        category: item.category,
      },
      media: media
        ? {
            type: media.type,
            mode: media.remoteUrl ? "remote_url" : "uploaded_token",
            source_url: media.sourceUrl || media.remoteUrl,
          }
        : null,
      publication,
      duration_ms: Date.now() - startedAt,
    };
    await db.set(["factor", "state", "last_pipeline"], result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    };
    await db.set(["factor", "state", "last_pipeline"], result);
    console.error("PIPELINE ERROR:", result);
    return result;
  }
}
// ============================================================
// TEST PUBLISH
// ============================================================
async function publishTest() {
  const text = [
    "🔴 <b>ФАКТОР • ТЕСТ</b>",
    "",
    "📡 Система публикации работает.",
    "",
    `🕒 ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow", }).format(new Date())}`,
    "",
    "<i>ФАКТОР</i>",
  ].join("\n");
  return await publishToMax(text);
}
// ============================================================
// JSON
// ============================================================
function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
// ============================================================
// CRON
// ============================================================
Deno.cron(
  "FAKTOR news pipeline",
  CRON_SCHEDULE,
  {
    backoffSchedule: [5000, 15000, 30000],
  },
  async () => {
    console.log("CRON: starting pipeline");
    try {
      const result = await runPipeline(false);
      console.log("CRON: finished", JSON.stringify(result));
    } catch (error) {
      console.error("CRON ERROR:", error);
      throw error;
    }
  }
);
// ============================================================
// HTTP SERVER
// ============================================================
Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  try {
    // ------------------------------------------------------
    // ROOT
    // ------------------------------------------------------
    if (request.method === "GET" && path === "/") {
      return json({
        ok: true,
        service: "MAX NEWS AGENT — ФАКТОР",
        runtime: "Deno Deploy",
        cron: CRON_SCHEDULE,
        endpoints: [
          "/",
          "/status",
          "/pipeline-state",
          "/run",
          "/publish-test",
          "/me",
          "/webhook",
        ],
      });
    }
    // ------------------------------------------------------
    // STATUS
    // ------------------------------------------------------
    if (request.method === "GET" && path === "/status") {
      return json({
        ok: true,
        now: new Date().toISOString(),
        service: "MAX NEWS AGENT — ФАКТОР",
        runtime: "Deno Deploy",
        auto_pipeline: true,
        max_connection: {
          ca_loaded: maxCaStatus.loaded,
          root_ca: maxCaStatus.root,
          sub_ca: maxCaStatus.sub,
          error: maxCaStatus.error,
        },
        configuration: {
          max_token: Boolean(MAX_BOT_TOKEN),
          target_chat: Boolean(TARGET_CHAT_ID),
          gemini: Boolean(GEMINI_API_KEY),
        },
        ...(await getState()),
      });
    }
    // ------------------------------------------------------
    // PIPELINE STATE
    // ------------------------------------------------------
    if (request.method === "GET" && path === "/pipeline-state") {
      return json({
        ok: true,
        ...(await getState()),
      });
    }
    // ------------------------------------------------------
    // MANUAL RUN
    // ------------------------------------------------------
    if (
      (request.method === "GET" || request.method === "POST") &&
      path === "/run"
    ) {
      const result = await runPipeline(true);
      return json(result);
    }
    // ------------------------------------------------------
    // SELECTION DIAGNOSTICS
    // ------------------------------------------------------
    if (request.method === "GET" && path === "/selection-diagnostics") {
      const db = await getKV();
      return json({
        ok: true,
        selection_diagnostics:
          (await db.get(["factor", "state", "selection_diagnostics"])).value ??
          null,
      });
    }
    // ------------------------------------------------------
    // TEST PUBLISH
    // ------------------------------------------------------
    if (request.method === "GET" && path === "/publish-test") {
      const result = await publishTest();
      return json({
        ok: true,
        provider: "MAX",
        operation: "publish-test",
        chat_id: TARGET_CHAT_ID,
        response: result,
      });
    }
    // ------------------------------------------------------
    // ME
    // ------------------------------------------------------
    if (request.method === "GET" && path === "/me") {
      const me = await maxJson("/me", {
        method: "GET",
      });
      return json({
        ok: true,
        max_me: me,
      });
    }
    // ------------------------------------------------------
    // WEBHOOK
    // ------------------------------------------------------
    if (request.method === "POST" && path === "/webhook") {
      const body = await request.text();
      console.log("WEBHOOK:", body.slice(0, 2000));
      return json({
        ok: true,
        received: true,
      });
    }
    // ------------------------------------------------------
    // 404
    // ------------------------------------------------------
    return json(
      {
        ok: false,
        error: "Endpoint not found",
        path,
      },
      404
    );
  } catch (error) {
    console.error("HTTP ERROR:", error);
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        path,
      },
      500
    );
  }
});