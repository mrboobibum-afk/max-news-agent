// ============================================================
// MAX NEWS AGENT — ФАКТОР (Direct Live Edition)
// GITHUB ACTIONS RUNTIME
// ============================================================
//
// АВТОМАТИЧЕСКАЯ СИСТЕМА НОВОСТЕЙ
// Приоритет: VIDEO (СМИ / TG / VK / RuTube / Web) -> IMAGE -> TEXT
// Формат подачи: «Прямой эфир» (динамично, ёмко, без мелкого бытового шума)
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const URGENT_INTERVAL_MS = 5 * 60 * 1000;
const REGULAR_INTERVAL_MS = 25 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EVENT_HISTORY_TTL_MS = 48 * 60 * 60 * 1000;

const MAX_VIDEO_BYTES = Number(Deno.env.get("MAX_VIDEO_MB") ?? "50") * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(Deno.env.get("MAX_IMAGE_MB") ?? "15") * 1024 * 1024;

const RSS_LIMIT_PER_FEED = 35;
const MAX_RSS_ITEMS = 350;
const SCORE_CANDIDATES = 20;
const AI_CANDIDATES = 10;
const MAX_HISTORY_CHECKED = 300;
const MAX_POST_LENGTH = 3900;

const PUBLIC_TELEGRAM_VIDEO_CHANNELS = (Deno.env.get("PUBLIC_TELEGRAM_VIDEO_CHANNELS") ?? "novosti_efir,shot_shot,mash,breakingmash,bazabazon")
    .split(",")
    .map((v) => v.trim().replace(/^@/, ""))
    .filter((v) => /^[a-zA-Z0-9_]{3,64}$/.test(v));

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// ============================================================
// MAX CERTIFICATES
// ============================================================
const MAX_ROOT_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";
const MAX_SUB_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";
let maxHttpClient = null;
let maxHttpClientError = null;

async function initMaxHttpClient() {
    if (maxHttpClient) return maxHttpClient;
    if (maxHttpClientError) return null;

    try {
        const [rootRes, subRes] = await Promise.all([
            fetch(MAX_ROOT_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }),
            fetch(MAX_SUB_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }),
        ]);

        if (!rootRes.ok || !subRes.ok) throw new Error("CA cert HTTP fetch error");
        const rootCa = await rootRes.text();
        const subCa = await subRes.text();

        maxHttpClient = Deno.createHttpClient({ caCerts: [rootCa, subCa] });
        return maxHttpClient;
    } catch (error) {
        maxHttpClientError = error instanceof Error ? error.message : String(error);
        console.warn("MAX CA warning (falling back to default client):", maxHttpClientError);
        return null;
    }
}

// ============================================================
// RSS FEEDS
// ============================================================
const RSS_FEEDS = [
    { category: "ГЛАВНОЕ", emoji: "⚡", url: "https://news.google.com/rss?hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ВИДЕО_ЭФИР", emoji: "🎥", url: "https://news.google.com/rss/search?q=видео+OR+кадры+OR+момент+OR+очевидцы&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "РОССИЯ", emoji: "🇷🇺", url: "https://news.google.com/rss/search?q=Россия+OR+Москва+OR+Петербург&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "МИР", emoji: "🌍", url: "https://news.google.com/rss/search?q=world+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ТЕХНОЛОГИИ", emoji: "💻", url: "https://news.google.com/rss/search?q=технологии+OR+ИИ+OR+роботы+OR+космос&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ЭКОНОМИКА", emoji: "📈", url: "https://news.google.com/rss/search?q=экономика+OR+бизнес+OR+рубль+OR+рынки&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ИНЦИДЕНТЫ", emoji: "🚨", url: "https://news.google.com/rss/search?q=ЧП+OR+крушение+OR+стихия+OR+спасение&hl=ru&gl=RU&ceid=RU:ru" },
];

// ============================================================
// STATE STORAGE (File-based for GitHub Actions)
// ============================================================
class FileKV {
    constructor(filePath = ".factor-state.json") {
        this.filePath = filePath;
        this.data = null;
    }

    async load() {
        if (this.data) return this.data;
        try {
            const text = await Deno.readTextFile(this.filePath);
            const parsed = JSON.parse(text);
            this.data = parsed && typeof parsed === "object" && parsed.entries ? parsed : { version: 1, entries: {} };
        } catch {
            this.data = { version: 1, entries: {} };
        }
        return this.data;
    }

    keyId(key) {
        return JSON.stringify(key);
    }

    cleanupExpired(data) {
        const now = Date.now();
        let changed = false;
        for (const [id, entry] of Object.entries(data.entries)) {
            if (entry && entry.expiresAt && Number(entry.expiresAt) <= now) {
                delete data.entries[id];
                changed = true;
            }
        }
        return changed;
    }

    async persist() {
        await Deno.writeTextFile(this.filePath, JSON.stringify(this.data, null, 2) + "\n");
    }

    async get(key) {
        const data = await this.load();
        if (this.cleanupExpired(data)) await this.persist();
        const entry = data.entries[this.keyId(key)];
        return { value: entry?.value ?? null, versionstamp: entry?.versionstamp ?? null };
    }

    async set(key, value, options = {}) {
        const data = await this.load();
        const expireIn = Number(options?.expireIn ?? 0);
        data.entries[this.keyId(key)] = {
            key,
            value,
            expiresAt: expireIn > 0 ? Date.now() + expireIn : null,
            versionstamp: crypto.randomUUID(),
        };
        await this.persist();
    }

    async delete(key) {
        const data = await this.load();
        delete data.entries[this.keyId(key)];
        await this.persist();
    }

    async *list(options = {}) {
        const data = await this.load();
        if (this.cleanupExpired(data)) await this.persist();
        const prefix = Array.isArray(options.prefix) ? options.prefix : [];
        const rows = Object.values(data.entries).filter((entry) => {
            if (!entry || !Array.isArray(entry.key) || entry.key.length < prefix.length) return false;
            return prefix.every((v, i) => JSON.stringify(entry.key[i]) === JSON.stringify(v));
        });
        if (options.reverse) rows.reverse();
        for (const entry of rows) {
            yield { key: entry.key, value: entry.value, versionstamp: entry.versionstamp ?? null };
        }
    }
}

let kvInstance = null;
async function getKV() {
    if (!kvInstance) kvInstance = new FileKV();
    return kvInstance;
}

// ============================================================
// TEXT & STRING UTILITIES
// ============================================================
function cleanText(value) {
    let text = String(value ?? "");
    for (let i = 0; i < 2; i++) {
        text = text
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&#x27;/gi, "'")
            .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
            .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)));
    }
    return text
        .replace(/<!\[CDATA\[/gi, "")
        .replace(/\]\]>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function stripHtml(value) {
    return cleanText(value).replace(/\*\*/g, "").replace(/__+/g, "").trim();
}

function escapeHtml(value) {
    return String(value ?? "")
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
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function truncate(value, max) {
    const s = String(value ?? "").trim();
    return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// URL PROCESSING
// ============================================================
function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url ?? ""));
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
        const p = new URL(url);
        p.hash = "";
        ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "yclid"].forEach((k) => p.searchParams.delete(k));
        return p.href;
    } catch {
        return "";
    }
}

function absoluteUrl(value, baseUrl) {
    try {
        return new URL(value, baseUrl).href;
    } catch {
        return null;
    }
}

function normalizeMediaUrl(value) {
    return cleanText(value)
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003A/gi, ":")
        .replace(/\\u002F/gi, "/")
        .trim();
}

// ============================================================
// RSS FETCHING & PARSING
// ============================================================
function extractXmlTag(xml, tag) {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
    return m?.[1] ?? "";
}

function extractXmlTagWithAttrs(xml, tag) {
    const m = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
    return { attrs: m?.[1] ?? "", value: m?.[2] ?? "" };
}

function extractAttr(attrs, name) {
    const m = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attrs);
    return m?.[1] ?? "";
}

function parseRSS(xml, feed) {
    const items = [];
    const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
    for (const itemXml of matches.slice(0, RSS_LIMIT_PER_FEED)) {
        const title = cleanText(extractXmlTag(itemXml, "title"));
        const link = cleanText(extractXmlTag(itemXml, "link")) || cleanText(extractXmlTag(itemXml, "guid"));
        const description = cleanText(extractXmlTag(itemXml, "description"));
        const pubDate = cleanText(extractXmlTag(itemXml, "pubDate"));
        const sourceTag = extractXmlTagWithAttrs(itemXml, "source");
        const source = cleanText(sourceTag.value) || feed.category;
        const sourceUrl = cleanText(extractAttr(sourceTag.attrs, "url"));

        if (!title || !link) continue;
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
        });
    }
    return items;
}

async function loadRSS(feed) {
    try {
        const res = await fetch(feed.url, {
            headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/xml" },
            signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) return [];
        return parseRSS(await res.text(), feed);
    } catch {
        return [];
    }
}

// ============================================================
// GOOGLE NEWS DIRECT DECODER (batchexecute RPC)
// ============================================================
async function decodeGoogleNewsArticleUrl(googleUrl) {
    try {
        if (!isGoogleNewsUrl(googleUrl)) return "";
        const parts = new URL(googleUrl).pathname.split("/").filter(Boolean);
        const articleIndex = parts.lastIndexOf("articles");
        if (articleIndex < 0 || !parts[articleIndex + 1]) return "";

        const articleId = parts[articleIndex + 1];
        let signature = "";
        let timestamp = "";

        const variants = [
            `https://news.google.com/rss/articles/${encodeURIComponent(articleId)}`,
            `https://news.google.com/articles/${encodeURIComponent(articleId)}`,
        ];

        for (const pageUrl of variants) {
            try {
                const res = await fetch(pageUrl, {
                    headers: { "User-Agent": USER_AGENT },
                    signal: AbortSignal.timeout(8000),
                });
                if (!res.ok) continue;
                const html = await res.text();
                const sigMatch = html.match(/data-n-a-sg=["']([^"']+)["']/i);
                const tsMatch = html.match(/data-n-a-ts=["']([^"']+)["']/i);
                if (sigMatch?.[1] && tsMatch?.[1]) {
                    signature = sigMatch[1];
                    timestamp = tsMatch[1];
                    break;
                }
            } catch {}
        }

        if (!signature || !timestamp) return "";

        const rpc = [
            "Fbv4je",
            `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${articleId}",${Number(timestamp)},"${signature}"]`,
        ];

        const payload = new URLSearchParams({ "f.req": JSON.stringify([[rpc]]) });
        const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": USER_AGENT },
            body: payload.toString(),
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) return "";
        const text = await res.text();
        const urls = text.match(/https?:\/\/[^"\s\\]+/g) ?? [];
        for (const raw of urls) {
            const c = raw.replace(/\\\\u003d/gi, "=").replace(/\\\\u0026/gi, "&").replace(/\\\\\//g, "/");
            if (isLikelyArticleUrl(c)) return normalizeUrl(c);
        }
        return "";
    } catch {
        return "";
    }
}

// ============================================================
// ARTICLE PAGE PARSER
// ============================================================
const BAD_DOMAINS = ["google.com", "gstatic.com", "youtube.com", "t.me", "vk.com", "w3.org", "schema.org"];

function isLikelyArticleUrl(url) {
    if (!isHttpUrl(url) || isGoogleNewsUrl(url)) return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (BAD_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return false;
        const path = new URL(url).pathname.toLowerCase();
        return path.length > 5 && path !== "/";
    } catch {
        return false;
    }
}

function findMeta(html, property) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i")) ||
              html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
    return m?.[1] ? cleanText(m[1]) : null;
}

function extractPageTitle(html) {
    const meta = findMeta(html, "og:title") || findMeta(html, "twitter:title");
    if (meta) return stripHtml(meta);
    const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return m ? stripHtml(m[1]) : "";
}

async function loadArticlePage(url) {
    if (!isLikelyArticleUrl(url)) return null;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const html = await res.text();
        return { finalUrl: normalizeUrl(res.url || url), html };
    } catch {
        return null;
    }
}

async function resolveArticleUrl(item) {
    const original = normalizeUrl(item.link);
    if (!isGoogleNewsUrl(original)) return isLikelyArticleUrl(original) ? original : "";

    const decoded = await decodeGoogleNewsArticleUrl(original);
    if (decoded && isLikelyArticleUrl(decoded)) return decoded;

    try {
        const res = await fetch(original, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
        const finalUrl = normalizeUrl(res.url || "");
        if (isLikelyArticleUrl(finalUrl)) return finalUrl;
    } catch {}
    return "";
}

// ============================================================
// MEDIA EXTRACTION & DOWNLOAD (Video Priority)
// ============================================================
function isDirectVideoUrl(url) {
    const l = String(url || "").toLowerCase();
    return l.includes(".mp4") || l.includes(".mov") || l.includes(".webm") || l.includes(".m3u8");
}

function collectVideoSourcesFromHtml(html, baseUrl) {
    const result = [];
    const add = (v) => {
        const u = absoluteUrl(normalizeMediaUrl(v), baseUrl);
        if (u && isDirectVideoUrl(u) && !result.includes(u)) result.push(u);
    };

    // <video> and <source>
    for (const m of html.matchAll(/<(?:video|source)\b[^>]*?(?:src|data-src|data-video)=["']([^"']+)["']/gi)) {
        add(m[1]);
    }
    // embedded config / JSON
    for (const m of html.matchAll(/["'](?:video_url|videoUrl|file|stream|hls|m3u8)["']\s*:\s*["']([^"']+)["']/gi)) {
        add(m[1]);
    }
    // og:video
    const ogVideo = findMeta(html, "og:video") || findMeta(html, "og:video:url") || findMeta(html, "og:video:secure_url");
    if (ogVideo) add(ogVideo);

    return result;
}

function collectImageCandidates(html, baseUrl) {
    const list = [];
    const add = (v) => {
        const u = absoluteUrl(normalizeMediaUrl(v), baseUrl);
        if (u && /^https?:\/\//i.test(u) && !list.includes(u) && !/(?:logo|avatar|icon|1x1|pixel|banner)/i.test(u)) {
            list.push(u);
        }
    };

    const ogImg = findMeta(html, "og:image") || findMeta(html, "twitter:image");
    if (ogImg) add(ogImg);

    for (const m of html.matchAll(/<(?:img|source)\b[^>]*?(?:src|data-src)=["']([^"']+)["']/gi)) {
        add(m[1]);
    }
    return list.slice(0, 5);
}

// Скачивание HLS-потоков через ffmpeg (в GitHub Actions доступен)
async function downloadHlsVideo(url) {
    let tempPath = "";
    try {
        tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
        const command = new Deno.Command("ffmpeg", {
            args: [
                "-hide_banner", "-loglevel", "error", "-y",
                "-user_agent", USER_AGENT,
                "-i", url,
                "-t", "90",
                "-c", "copy",
                "-movflags", "+faststart",
                tempPath,
            ],
            stdout: "null",
            stderr: "piped",
        });

        const res = await command.output();
        if (!res.success) return null;

        const stat = await Deno.stat(tempPath);
        if (!stat.isFile || !stat.size || stat.size > MAX_VIDEO_BYTES) return null;

        const bytes = await Deno.readFile(tempPath);
        return { type: "video", bytes, contentType: "video/mp4", extension: "mp4", sourceUrl: url };
    } catch {
        return null;
    } finally {
        if (tempPath) {
            try { await Deno.remove(tempPath); } catch {}
        }
    }
}

// Универсальный загрузчик медиа
async function downloadMedia(url, type) {
    if (!isHttpUrl(url)) return null;

    if (type === "video" && /\.m3u8(?:[?#]|$)/i.test(url)) {
        return await downloadHlsVideo(url);
    }

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(type === "video" ? 35000 : 15000),
        });
        if (!res.ok) return null;

        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (type === "video" && (contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl"))) {
            return await downloadHlsVideo(url);
        }

        const buf = new Uint8Array(await res.arrayBuffer());
        const limit = type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (buf.byteLength === 0 || buf.byteLength > limit) return null;

        return {
            type,
            bytes: buf,
            contentType: type === "video" ? "video/mp4" : "image/jpeg",
            extension: type === "video" ? "mp4" : "jpg",
            sourceUrl: url,
        };
    } catch {
        return null;
    }
}

// Поиск открытых видео в публичных каналах Telegram (без API, по открытым веб-зеркалам)
async function searchPublicTelegramVideo(headline) {
    const compactHeadline = headline.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, " ").slice(0, 80).trim();
    if (!compactHeadline) return null;

    for (const channel of PUBLIC_TELEGRAM_VIDEO_CHANNELS) {
        try {
            const res = await fetch(`https://t.me/s/${channel}`, {
                headers: { "User-Agent": USER_AGENT },
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) continue;
            const html = await res.text();

            for (const match of html.matchAll(/https?:\/\/[^"'<>\s]+?\.(?:mp4|mov)(?:\?[^"'<>\s]*)?/gi)) {
                const videoUrl = normalizeMediaUrl(match[0]);
                const downloaded = await downloadMedia(videoUrl, "video");
                if (downloaded) {
                    console.log(`Найдено открытое видео в канале @${channel}`);
                    return downloaded;
                }
            }
        } catch {}
    }
    return null;
}

// ============================================================
// EDITORIAL FILTER & SCORING (Формат «Прямой эфир»)
// ============================================================
// Отсекаем мелкие бытовые ДТП, локальные возгорания гаражей/сараев, скучную аналитику
const LOCAL_TRIVIAL_GARBAGE = [
    /(?:сарай|баня|гараж|мусор|трава|бытовка)\s+(?:сгорел|загорел|потушил)/i,
    /(?:столкнулись\s+(?:две|три)\s+легковушки|мелкое\s+дтп|притерлись|помяли\s+бампер)/i,
    /(?:гороскоп|курс\s+валют|погода\s+на|афиша|обзор\s+цен|как\s+сэкономить|гид\s+по|советы)/i,
];

function isTrivialGarbage(text) {
    return LOCAL_TRIVIAL_GARBAGE.some((p) => p.test(text));
}

function scoreNewsItem(item) {
    const text = normalizeForHash(`${item.title} ${item.description}`);
    let score = 0;

    // Свежесть
    const ageMinutes = (Date.now() - (Date.parse(item.pubDate) || Date.now())) / 60000;
    if (ageMinutes <= 20) score += 40;
    else if (ageMinutes <= 60) score += 25;
    else score += 10;

    // ВИДЕО-СИГНАЛЫ (Приоритет №1)
    if (/(?:видео|кадры|момент|очевидцы|появились\s+кадры|сняли\s+на\s+видео)/i.test(text)) {
        score += 50;
    }

    // Резонанс и масштаб
    if (/(?:путин|госдума|указ|закон|взрыв|атака|крушение|катастрофа|чп|рекорд|впервые|технологии|ии|космос)/i.test(text)) {
        score += 30;
    }

    // Минус за бытовой мусор
    if (isTrivialGarbage(text)) {
        score -= 200;
    }

    return { item, score };
}

// ============================================================
// GEMINI / AI GENERATION (Стиль Telegram «Прямой эфир»)
// ============================================================
function extractJson(text) {
    const cleaned = text.replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        const m = cleaned.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : null;
    }
}

async function callAI(item, pageHtml) {
    if (!GEMINI_API_KEY && !DASHSCOPE_API_KEY) return null;

    const prompt = `
Ты главный редактор топового Telegram-канала новостей в формате «Прямой эфир».

Сделай публикацию на основе новости:
ЗАГОЛОВОК: ${item.title}
ОПИСАНИЕ: ${item.description}

ПРАВИЛА СТИЛЯ «ПРЯМОЙ ЭФИР»:
1. Заголовок (headline): дерзкий, короткий, цепляющий, но строго правдивый (до 10-12 слов).
2. Текст (text): строго 1–2 динамичных предложения. Сразу суть: ЧТО произошло и ключевой факт (цифра, последствие, заявление). Никаких вводных слов вроде "стало известно", "сообщается", "как передает".
3. Читается за 3 секунды.

Верни ТОЛЬКО JSON:
{
  "headline": "Заголовок поста",
  "text": "1-2 коротких предложения сути без воды."
}
`;

    // 1. Попытка через Gemini
    if (GEMINI_API_KEY) {
        try {
            const res = await fetch(`[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){encodeURIComponent(GEMINI_API_KEY)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
                }),
                signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
                const data = await res.json();
                const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                const parsed = extractJson(raw);
                if (parsed?.headline && parsed?.text) return parsed;
            }
        } catch {}
    }

    // 2. Фоллбек через Qwen / DashScope
    if (DASHSCOPE_API_KEY) {
        try {
            const res = await fetch(`${QWEN_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: QWEN_MODEL,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.2,
                }),
                signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
                const data = await res.json();
                const raw = data?.choices?.[0]?.message?.content ?? "";
                const parsed = extractJson(raw);
                if (parsed?.headline && parsed?.text) return parsed;
            }
        } catch {}
    }

    return { headline: stripHtml(item.title), text: stripHtml(item.description || item.title) };
}

// ============================================================
// MAX API & UPLOADER
// ============================================================
async function maxFetch(path, options = {}) {
    if (!MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN missing");
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

async function uploadMediaToMax(media) {
    const initRes = await maxFetch(`/uploads?type=${encodeURIComponent(media.type)}`, { method: "POST" });
    const initData = await initRes.json();
    if (!initData.url) throw new Error("MAX upload URL missing");

    const form = new FormData();
    form.append("data", new Blob([media.bytes], { type: media.contentType }), `media.${media.extension}`);

    const uploadRes = await fetch(initData.url, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    const uploadText = await uploadRes.text();
    let uploadJson = null;
    try { uploadJson = JSON.parse(uploadText); } catch {}

    const token = initData.token || uploadJson?.token || uploadJson?.mediafile_token || uploadJson?.photos?.[0]?.token || uploadJson?.videos?.[0]?.token;
    if (!token) throw new Error(`Не получен токен медиа от MAX: ${uploadText.slice(0, 400)}`);

    return token;
}

async function publishToMax(text, mediaToken = null, mediaType = "image") {
    if (!TARGET_CHAT_ID) throw new Error("TARGET_CHAT_ID missing");

    const body = {
        text,
        format: "html",
        notify: true,
        disable_link_preview: true,
    };

    if (mediaToken) {
        body.attachments = [{
            type: mediaType,
            payload: { token: mediaToken },
        }];
    }

    const res = await maxFetch(`/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        throw new Error(`Ошибка публикации MAX: ${res.status} ${await res.text()}`);
    }
    return await res.json();
}

function buildPostMessage(headline, text, sourceUrl, sourceName) {
    const parts = [
        `<b>${escapeHtml(headline)}</b>`,
        "",
        escapeHtml(text),
    ];

    if (sourceUrl) {
        parts.push("", `🔗 <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceName || "Источник")}</a>`);
    }

    parts.push("", "⚡ <i>ФАКТОР</i>");
    return parts.join("\n");
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function run() {
    console.log("=== Запуск новостного пайплайна ФАКТОР (Direct Live) ===");
    const db = await getKV();

    // 1. Сбор RSS
    const feedsData = await Promise.all(RSS_FEEDS.map(loadRSS));
    const allItems = feedsData.flat().slice(0, MAX_RSS_ITEMS);
    console.log(`Собрано новостей из RSS: ${allItems.length}`);

    // 2. Скоринг и отсеивание
    const candidates = allItems
        .filter((item) => item.title && !isTrivialGarbage(item.title))
        .map(scoreNewsItem)
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, SCORE_CANDIDATES);

    console.log(`Отобрано перспективных кандидатов: ${candidates.length}`);

    for (const { item } of candidates) {
        const itemHash = await sha256(normalizeForHash(item.title));
        const alreadyPub = await db.get(["factor", "published", itemHash]);
        if (alreadyPub.value) continue;

        console.log(`\nОбработка новости: ${item.title}`);

        // Разрешаем реальный URL статьи
        const articleUrl = await resolveArticleUrl(item);
        let articleHtml = "";
        let pageVideos = [];
        let pageImages = [];

        if (articleUrl) {
            const page = await loadArticlePage(articleUrl);
            if (page) {
                articleHtml = page.html;
                pageVideos = collectVideoSourcesFromHtml(page.html, page.finalUrl);
                pageImages = collectImageCandidates(page.html, page.finalUrl);
            }
        }

        // --- МЕДИА-ПОИСК С ПРИОРИТЕТОМ НА ВИДЕО ---
        let selectedMedia = null;

        // 1. Проверяем видео со страницы статьи
        for (const vUrl of pageVideos) {
            console.log(`Пробуем видео со страницы СМИ: ${vUrl}`);
            const vid = await downloadMedia(vUrl, "video");
            if (vid) {
                selectedMedia = vid;
                break;
            }
        }

        // 2. Если нет видео на странице — ищем в открытых Telegram-каналах
        if (!selectedMedia) {
            console.log("Видео в статье не найдено, проверяем открытые Telegram-источники...");
            selectedMedia = await searchPublicTelegramVideo(item.title);
        }

        // 3. Если видео нигде нет — берём фото со страницы
        if (!selectedMedia && pageImages.length > 0) {
            console.log("Видео не найдено. Пробуем фото со страницы...");
            for (const imgUrl of pageImages) {
                const img = await downloadMedia(imgUrl, "image");
                if (img) {
                    selectedMedia = img;
                    break;
                }
            }
        }

        // Генерируем текст поста через AI
        const postData = await callAI(item, articleHtml);
        const postText = buildPostMessage(postData.headline, postData.text, articleUrl, item.source);

        // Публикация в MAX
        try {
            let mediaToken = null;
            if (selectedMedia) {
                console.log(`Загрузка медиа (${selectedMedia.type}, ${(selectedMedia.bytes.byteLength / 1024 / 1024).toFixed(2)} MB) в MAX...`);
                mediaToken = await uploadMediaToMax(selectedMedia);
            }

            console.log("Отправка поста в канал MAX...");
            await publishToMax(postText, mediaToken, selectedMedia?.type || "image");

            // Запоминаем, чтобы не дублировать
            await db.set(["factor", "published", itemHash], true, { expireIn: HISTORY_TTL_MS });
            await db.set(["factor", "state", "last_published"], Date.now());

            console.log(`✅ Успешно опубликовано: ${postData.headline}`);
            return; // За один цикл публикуем один лучший пост
        } catch (pubError) {
            console.error("Ошибка при публикации в MAX:", pubError);
            // Если упало с медиа — пробуем опубликовать чистым текстом
            try {
                console.log("Пробуем запасную публикацию чистым текстом...");
                await publishToMax(postText);
                await db.set(["factor", "published", itemHash], true, { expireIn: HISTORY_TTL_MS });
                console.log(`✅ Опубликовано текстом: ${postData.headline}`);
                return;
            } catch (textPubError) {
                console.error("Критическая ошибка публикации текста:", textPubError);
            }
        }
    }

    console.log("Новых подходящих событий для публикации в этом цикле не найдено.");
}

// Точка входа для GitHub Actions
await run();
