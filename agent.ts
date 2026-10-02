// ============================================================
// MAX NEWS AGENT — ФАКТОР
// FIX v2: Google News HTML/URL sanitization + encoded RSS HTML cleanup
// DENO DEPLOY
// ============================================================
//
// АВТОМАТИЧЕСКАЯ СИСТЕМА НОВОСТЕЙ
//
// Cron:
//   каждые 5 минут
//
// Логика:
//   RSS
//    ↓
//   локальная дедупликация
//    ↓
//   News Score
//    ↓
//   TOP кандидаты
//    ↓
//   определение реального URL СМИ
//    ↓
//   проверка статьи
//    ↓
//   Gemini
//    ↓
//   VIDEO → IMAGE → TEXT
//    ↓
//   MAX /uploads
//    ↓
//   ожидание обработки media
//    ↓
//   MAX /messages
//    ↓
//   Deno KV
//
// ВАЖНО:
//   Google News URL НИКОГДА не публикуется.
//   Если реальный URL СМИ не найден — кандидат отбрасывается.
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
const MAX_VIDEO_BYTES = Number(Deno.env.get("MAX_VIDEO_MB") ?? "60") * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(Deno.env.get("MAX_IMAGE_MB") ?? "15") * 1024 * 1024;
const RSS_LIMIT_PER_FEED = 30;
const MAX_RSS_ITEMS = 300;
const SCORE_CANDIDATES = 45;
const GEMINI_CANDIDATES = 10;
const MAX_HISTORY_CHECKED = 300;
const MAX_POST_LENGTH = 3900;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/140.0.0.0 Safari/537.36";
// ============================================================
// MAX CERTIFICATES
// ============================================================
const MAX_ROOT_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";
const MAX_SUB_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";
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
        maxHttpClient =
            Deno.createHttpClient({
                caCerts: [
                    rootCa,
                    subCa,
                ],
            });
        maxCaStatus.loaded = true;
        return maxHttpClient;
    }
    catch (error) {
        maxHttpClientError =
            error instanceof Error
                ? error.message
                : String(error);
        maxCaStatus.error =
            maxHttpClientError;
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
// STATE STORAGE
// ============================================================
// Deno Deploy uses Deno KV. GitHub Actions has no persistent Deno KV
// between runs, so in GitHub Actions mode the same KV-like interface
// is backed by .factor-state.json. The workflow commits that file only
// when persistent state actually changes.

const GITHUB_ACTIONS_MODE =
    Deno.env.get("GITHUB_ACTIONS") === "true";

let kv = null;

class FileKV {
    constructor(filePath = ".factor-state.json") {
        this.filePath = filePath;
        this.data = null;
        this.loading = null;
    }

    async load() {
        if (this.data) return this.data;
        if (this.loading) return await this.loading;

        this.loading = (async () => {
            try {
                const text = await Deno.readTextFile(this.filePath);
                const parsed = JSON.parse(text);
                this.data =
                    parsed &&
                    typeof parsed === "object" &&
                    parsed.entries &&
                    typeof parsed.entries === "object"
                        ? parsed
                        : { version: 1, entries: {} };
            } catch {
                this.data = { version: 1, entries: {} };
            }
            return this.data;
        })();

        try {
            return await this.loading;
        } finally {
            this.loading = null;
        }
    }

    keyId(key) {
        return JSON.stringify(key);
    }

    cleanupExpired(data) {
        const now = Date.now();
        let changed = false;

        for (const [id, entry] of Object.entries(data.entries)) {
            if (
                entry &&
                entry.expiresAt &&
                Number(entry.expiresAt) <= now
            ) {
                delete data.entries[id];
                changed = true;
            }
        }

        return changed;
    }

    async persist() {
        await Deno.writeTextFile(
            this.filePath,
            JSON.stringify(this.data, null, 2) + "\n",
        );
    }

    async get(key) {
        const data = await this.load();

        if (this.cleanupExpired(data)) {
            await this.persist();
        }

        const entry = data.entries[this.keyId(key)];

        return {
            value: entry?.value ?? null,
            versionstamp: entry?.versionstamp ?? null,
        };
    }

    async set(key, value, options = {}) {
        const data = await this.load();
        const expireIn = Number(options?.expireIn ?? 0);

        data.entries[this.keyId(key)] = {
            key,
            value,
            expiresAt:
                expireIn > 0
                    ? Date.now() + expireIn
                    : null,
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

        if (this.cleanupExpired(data)) {
            await this.persist();
        }

        const prefix = Array.isArray(options.prefix)
            ? options.prefix
            : [];

        const rows = Object.values(data.entries)
            .filter((entry) => {
                if (!entry || !Array.isArray(entry.key)) return false;
                if (entry.key.length < prefix.length) return false;

                return prefix.every(
                    (value, index) =>
                        JSON.stringify(entry.key[index]) ===
                        JSON.stringify(value),
                );
            })
            .sort((a, b) => {
                const ak = JSON.stringify(a.key);
                const bk = JSON.stringify(b.key);
                return ak < bk ? -1 : ak > bk ? 1 : 0;
            });

        if (options.reverse) rows.reverse();

        for (const entry of rows) {
            yield {
                key: entry.key,
                value: entry.value,
                versionstamp: entry.versionstamp ?? null,
            };
        }
    }

    atomic() {
        const operations = [];
        let checkOperation = null;

        const chain = {
            check: (check) => {
                checkOperation = check;
                return chain;
            },

            set: (key, value, options = {}) => {
                operations.push({
                    type: "set",
                    key,
                    value,
                    options,
                });
                return chain;
            },

            delete: (key) => {
                operations.push({
                    type: "delete",
                    key,
                });
                return chain;
            },

            commit: async () => {
                const data = await this.load();

                if (checkOperation?.key) {
                    const id = this.keyId(checkOperation.key);
                    const existing = data.entries[id];

                    if (checkOperation.versionstamp === null) {
                        if (existing) return { ok: false };
                    } else if (
                        !existing ||
                        existing.versionstamp !==
                            checkOperation.versionstamp
                    ) {
                        return { ok: false };
                    }
                }

                for (const operation of operations) {
                    if (operation.type === "delete") {
                        delete data.entries[
                            this.keyId(operation.key)
                        ];
                        continue;
                    }

                    const expireIn = Number(
                        operation.options?.expireIn ?? 0,
                    );

                    data.entries[
                        this.keyId(operation.key)
                    ] = {
                        key: operation.key,
                        value: operation.value,
                        expiresAt:
                            expireIn > 0
                                ? Date.now() + expireIn
                                : null,
                        versionstamp: crypto.randomUUID(),
                    };
                }

                await this.persist();
                return { ok: true };
            },
        };

        return chain;
    }
}

async function getKV() {
    if (!kv) {
        kv = GITHUB_ACTIONS_MODE
            ? new FileKV()
            : await Deno.openKv();
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
            .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
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
    return cleanText(value)
        .replace(/\*\*/g, "")
        .replace(/__+/g, "")
        .trim();
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
    return Array
        .from(new Uint8Array(hash))
        .map((b) => b
        .toString(16)
        .padStart(2, "0"))
        .join("");
}
function truncate(value, max) {
    const s = value.trim();
    if (s.length <= max) {
        return s;
    }
    return (s
        .slice(0, max - 1)
        .trimEnd() +
        "…");
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
        const host = new URL(url)
            .hostname
            .toLowerCase();
        return (host ===
            "news.google.com" ||
            host.endsWith(".news.google.com"));
    }
    catch {
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
    }
    catch {
        return "";
    }
}
function isUsableArticleUrl(url) {
    if (!isHttpUrl(url) ||
        isGoogleNewsUrl(url)) {
        return false;
    }
    try {
        const parsed = new URL(url);
        if (![
            "http:",
            "https:",
        ].includes(parsed.protocol)) {
            return false;
        }
        const host = parsed.hostname
            .toLowerCase();
        if (host === "google.com" ||
            host.endsWith(".google.com") ||
            host.includes("googleusercontent")) {
            return false;
        }
        return true;
    }
    catch {
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
    }
    catch {
        return null;
    }
}
function normalizeMediaUrl(value) {
    return decodeHtmlEntities(value
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003A/gi, ":")
        .replace(/\\u002F/gi, "/")
        .trim());
}
// ============================================================
// RSS XML
// ============================================================
function extractXmlTag(xml, tag) {
    const pattern = `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`;
    const match = new RegExp(pattern, "i").exec(xml);
    return (match?.[1] ?? "");
}
function extractXmlTagWithAttrs(xml, tag) {
    const match = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
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
        const link = cleanText(extractXmlTag(itemXml, "link")) ||
            cleanText(extractXmlTag(itemXml, "guid"));
        const description = cleanText(extractXmlTag(itemXml, "description"));
        const pubDate = cleanText(extractXmlTag(itemXml, "pubDate"));
        const sourceTag = extractXmlTagWithAttrs(itemXml, "source");
        const source = cleanText(sourceTag.value) ||
            feed.category;
        const sourceUrl = decodeHtmlEntities(extractAttr(sourceTag.attrs, "url"));
        if (!title ||
            !link) {
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
        });
    }
    return items;
}
async function loadRSS(feed) {
    try {
        const response = await fetch(feed.url, {
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "application/rss+xml, application/xml, text/xml",
            },
            signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
            console.error(`RSS ${feed.category}: HTTP ${response.status}`);
            return [];
        }
        const xml = await response.text();
        return parseRSS(xml, feed);
    }
    catch (error) {
        console.error(`RSS ${feed.category}:`, error instanceof Error
            ? error.message
            : String(error));
        return [];
    }
}
// ============================================================
// HTML META
// ============================================================
function findMeta(html, property) {
    const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
        new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "i"),
        new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, "i"),
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
    const canonical = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i)?.[1];
    if (!canonical) {
        return null;
    }
    return absoluteUrl(decodeHtmlEntities(canonical), baseUrl);
}
function extractJsonLd(html) {
    const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
    const result = [];
    for (const block of blocks) {
        const jsonText = block
            .replace(/<script[^>]*>/i, "")
            .replace(/<\/script>\s*$/i, "")
            .trim();
        try {
            const data = JSON.parse(jsonText);
            result.push(data);
        }
        catch {
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
    if (!value ||
        typeof value !== "object") {
        return;
    }
    const type = value["@type"];
    if (type === "NewsArticle" ||
        type === "Article" ||
        (Array.isArray(type) &&
            (type.includes("NewsArticle") ||
                type.includes("Article")))) {
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
];
function isBadHost(url) {
    try {
        const host = new URL(url)
            .hostname
            .toLowerCase();
        return BAD_HOST_PARTS.some((part) => host === part ||
            host.endsWith("." + part));
    }
    catch {
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
        const path = parsed.pathname
            .toLowerCase();
        if (BAD_PATH_PARTS.some((part) => path.includes(part))) {
            return false;
        }
        if (path === "/" ||
            path.length < 8) {
            return false;
        }
        // Reject namespace/technical URLs such as http://www.w3.org/2000/svg
        // even when they superficially look like a multi-segment article URL.
        if (/(?:^|\/)2000\/svg(?:$|\/)|(?:^|\/)1999\/(?:xhtml|xlink)(?:$|\/)/i.test(path)) {
            return false;
        }
        return true;
    }
    catch {
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
        if (sourceHost &&
            parsed.hostname
                .toLowerCase() ===
                sourceHost) {
            score += 50;
        }
        if (path.length >= 20) {
            score += 10;
        }
        if (path.split("/")
            .filter(Boolean)
            .length >= 2) {
            score += 10;
        }
        if (/\d{4,}/.test(path)) {
            score += 5;
        }
        if (/[a-zа-я]{4,}[-_][a-zа-я]{4,}/i.test(path)) {
            score += 5;
        }
        return score;
    }
    catch {
        return -1000;
    }
}
function extractExternalLinks(html, baseUrl, preferredHost) {
    const scored = [];
    const seen = new Set();
    for (const match of html.matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
        const raw = decodeHtmlEntities(match[1]);
        const url = absoluteUrl(raw, baseUrl);
        if (!url ||
            !isLikelyArticleUrl(url)) {
            continue;
        }
        const normalized = normalizeUrl(url);
        if (!normalized ||
            seen.has(normalized)) {
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
        .sort((a, b) => b.score -
        a.score)
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
    if (!preferredHost)
        return false;
    try {
        const host = normalizeHost(new URL(url).hostname);
        const preferred = normalizeHost(preferredHost);
        return (host === preferred ||
            host.endsWith("." + preferred) ||
            preferred.endsWith("." + host));
    }
    catch {
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
        const decoded = decodeHtmlEntities(String(rawValue)
            .replace(/\\\//g, "/")
            .replace(/\\u002f/gi, "/")
            .replace(/\\u003a/gi, ":")
            .replace(/\\u0026/gi, "&")
            .replace(/\\u003d/gi, "=")
            .replace(/\\u003f/gi, "?")
            .replace(/\\u0025/gi, "%"));
        const absolute = absoluteUrl(decoded, baseUrl);
        if (!absolute || !isLikelyArticleUrl(absolute))
            continue;
        const normalized = normalizeUrl(absolute);
        if (!normalized || seen.has(normalized) || isBadHost(normalized))
            continue;
        seen.add(normalized);
        let score = articleLinkScore(normalized, preferredHost);
        if (hostMatches(normalized, preferredHost))
            score += 100;
        if (score > 0)
            scored.push({ url: normalized, score });
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((entry) => entry.url);
}
// ============================================================
// GOOGLE NEWS RESOLUTION
// ============================================================
function extractPageTitle(html) {
    const metaTitle = findMeta(html, "og:title") || findMeta(html, "twitter:title");
    if (metaTitle) return stripHtml(metaTitle);
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return match ? stripHtml(match[1]) : "";
}
function articleTitleSimilarity(sourceTitle, pageTitle) {
    const a = storyTokens(sourceTitle);
    const b = storyTokens(pageTitle);
    if (a.size === 0 || b.size === 0) return 0;
    let common = 0;
    for (const token of a) {
        if (b.has(token)) common++;
    }
    return common / Math.max(a.size, b.size);
}
function articleTitleMatches(itemTitle, pageTitle) {
    if (!pageTitle) return false;
    const a = normalizeForHash(itemTitle);
    const b = normalizeForHash(pageTitle);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    return articleTitleSimilarity(itemTitle, pageTitle) >= 0.45;
}
async function resolveArticleUrl(item) {
    const originalUrl = normalizeUrl(item.link);
    if (!isGoogleNewsUrl(originalUrl)) {
        return isLikelyArticleUrl(originalUrl) ? originalUrl : "";
    }
    let preferredHost = null;
    if (item.sourceUrl) {
        try {
            preferredHost = normalizeHost(new URL(item.sourceUrl).hostname);
        }
        catch {
            preferredHost = null;
        }
    }
    try {
        const response = await fetch(originalUrl, {
            redirect: "follow",
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(15000),
        });
        const finalUrl = normalizeUrl(response.url || "");
        const html = await response.text();
        const candidates = new Set();
        const addCandidate = (url) => {
            const normalized = normalizeUrl(url || "");
            if (normalized && isLikelyArticleUrl(normalized)) candidates.add(normalized);
        };
        addCandidate(finalUrl);
        addCandidate(extractCanonical(html, originalUrl));
        const ogUrl = findMeta(html, "og:url");
        if (ogUrl) addCandidate(absoluteUrl(ogUrl, originalUrl));
        const jsonLd = extractJsonLd(html);
        const articles = [];
        for (const block of jsonLd) collectArticleJsonLd(block, articles);
        for (const article of articles) {
            for (const candidate of [article.url, article.mainEntityOfPage]) {
                let raw = "";
                if (typeof candidate === "string") raw = candidate;
                else if (candidate && typeof candidate === "object") raw = String(candidate["@id"] ?? candidate.url ?? "");
                if (raw) addCandidate(absoluteUrl(raw, originalUrl));
            }
        }
        for (const url of extractGoogleNewsUrlCandidates(html, originalUrl, preferredHost)) addCandidate(url);
        for (const url of extractExternalLinks(html, originalUrl, preferredHost)) addCandidate(url);
        const ranked = [...candidates].sort((a, b) => {
            const ah = hostMatches(a, preferredHost) ? 1 : 0;
            const bh = hostMatches(b, preferredHost) ? 1 : 0;
            if (ah !== bh) return bh - ah;
            return articleLinkScore(b, preferredHost) - articleLinkScore(a, preferredHost);
        });
        for (const candidateUrl of ranked.slice(0, 8)) {
            const page = await loadArticlePage(candidateUrl);
            if (!page) continue;
            const pageTitle = extractPageTitle(page.html);
            if (articleTitleMatches(item.title, pageTitle)) return page.finalUrl;
            console.warn("Rejected resolver title mismatch:", item.title, "=>", pageTitle, candidateUrl);
        }
        // Google News: если заголовок не совпал, новость НЕ публикуем.
        return "";
    }
    catch (error) {
        console.error("Google News resolve:", error instanceof Error ? error.message : String(error));
    }
    return "";
}
// ============================================================
// ARTICLE PAGE
// ============================================================
async function loadArticlePage(articleUrl) {
    if (!isLikelyArticleUrl(articleUrl)) {
        return null;
    }
    try {
        const response = await fetch(articleUrl, {
            redirect: "follow",
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) {
            return null;
        }
        const finalUrl = normalizeUrl(response.url ||
            articleUrl);
        if (!isLikelyArticleUrl(finalUrl)) {
            return null;
        }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (!contentType.includes("text/html") &&
            !contentType.includes("application/xhtml+xml")) {
            return null;
        }
        const html = await response.text();
        if (html.length < 500) {
            return null;
        }
        return {
            finalUrl,
            html,
        };
    }
    catch (error) {
        console.error("Article page:", error instanceof Error
            ? error.message
            : String(error));
        return null;
    }
}
// ============================================================
// VIDEO EXTRACTION
// ============================================================
function isDirectVideoUrl(url) {
    const lower = url.toLowerCase();
    if (lower.includes(".m3u8") ||
        lower.includes(".mpd")) {
        return false;
    }
    return (lower.includes(".mp4") ||
        lower.includes(".mov") ||
        lower.includes(".webm") ||
        lower.includes(".mkv"));
}
function collectVideoUrls(value, result) {
    if (typeof value ===
        "string") {
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
    if (value &&
        typeof value ===
            "object") {
        for (const [key, item,] of Object.entries(value)) {
            if ([
                "contentUrl",
                "videoUrl",
                "video_url",
                "url",
                "file",
            ].includes(key)) {
                collectVideoUrls(item, result);
            }
            if (key === "@graph" ||
                key === "video" ||
                key === "content" ||
                key === "associatedMedia") {
                collectVideoUrls(item, result);
            }
        }
    }
}
function findVideoFromHtml(html, baseUrl) {
    const candidates = [];
    const add = (rawUrl, priority = 0) => {
        const url = absoluteUrl(normalizeMediaUrl(rawUrl), baseUrl);
        if (!url || !isDirectVideoUrl(url)) return;
        if (candidates.some((x) => x.url === url)) return;
        candidates.push({ url, priority });
    };
    // Prefer videos explicitly exposed by the article itself over generic
    // social/player metadata. This still supports publisher CDNs.
    for (const match of html.matchAll(/<video[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
        add(match[1], 100);
    }
    for (const match of html.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
        add(match[1], 90);
    }
    for (const match of html.matchAll(/["'](?:contentUrl|videoUrl|video_url|file)["']\s*:\s*["']([^"']+)["']/gi)) {
        add(match[1], 80);
    }
    const metaNames = [
        "og:video",
        "og:video:url",
        "og:video:secure_url",
        "twitter:player:stream",
    ];
    for (const name of metaNames) {
        const value = findMeta(html, name);
        if (value) add(value, 50);
    }
    const jsonLd = extractJsonLd(html);
    for (const data of jsonLd) {
        const urls = [];
        collectVideoUrls(data, urls);
        for (const rawUrl of urls) add(rawUrl, 70);
    }
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0]?.url ?? null;
}

function mediaUrlLooksGeneric(url) {
    if (!url) return true;
    const value = url.toLowerCase();
    return /(?:logo|avatar|favicon|icon|sprite|placeholder|default|banner|advert|promo|social|share|author|profile)/i.test(value) ||
        /(?:1x1|pixel|transparent|blank)\b/i.test(value);
}

function mediaContextLooksGeneric(context) {
    if (!context) return false;
    return /(?:logo|аватар|иконк|favicon|баннер|реклама|реклам|заглушк|placeholder|promo|соцсет|поделиться|автор)/i.test(context);
}

function findImageCandidatesFromHtml(html, baseUrl) {
    const candidates = [];
    const seen = new Set();
    const add = (rawUrl, priority, context = "", source = "article") => {
        const url = absoluteUrl(normalizeMediaUrl(rawUrl), baseUrl);
        if (!url || seen.has(url) || mediaUrlLooksGeneric(url) || mediaContextLooksGeneric(context)) return;
        if (!/^https?:\/\//i.test(url)) return;
        seen.add(url);
        candidates.push({ url, priority, context: cleanText(stripHtml(context)).slice(0, 500), source });
    };

    // Images physically present in the article are preferred. Capture a
    // little nearby text (alt/title/figcaption) so the validator has context.
    for (const match of html.matchAll(/<(?:figure|img)\b[\s\S]{0,1200}?/gi)) {
        const block = match[0];
        const src = block.match(/\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i)?.[1];
        if (!src) continue;
        const alt = block.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
        const title = block.match(/\btitle=["']([^"']*)["']/i)?.[1] ?? "";
        add(src, 120, `${alt} ${title}`, "article_body");
    }

    // JSON-LD NewsArticle image is generally more trustworthy than a generic
    // site image, but still gets relevance validation below.
    const jsonLd = extractJsonLd(html);
    const articles = [];
    for (const block of jsonLd) collectArticleJsonLd(block, articles);
    for (const article of articles) {
        const images = article?.image;
        const values = Array.isArray(images) ? images : [images];
        for (const value of values) {
            if (typeof value === "string") add(value, 110, "NewsArticle image", "jsonld");
            else if (value && typeof value === "object") add(value.url ?? value.contentUrl ?? "", 110, "NewsArticle image", "jsonld");
        }
    }

    const imageSrc = findMeta(html, "image") || findMeta(html, "og:image") || findMeta(html, "twitter:image");
    if (imageSrc) add(imageSrc, 60, "OpenGraph image", "meta");

    // rel=image_src is an additional publisher-provided fallback.
    const relImage = html.match(/<link[^>]+rel=["'][^"']*image_src[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*image_src[^"']*["']/i)?.[1];
    if (relImage) add(relImage, 55, "article image", "link");

    return candidates.sort((a, b) => b.priority - a.priority).slice(0, 12);
}
// ============================================================
// ARTICLE MEDIA
// ============================================================
async function extractArticleMedia(item) {
    const articleUrl = await resolveArticleUrl(item);
    if (!isLikelyArticleUrl(articleUrl)) {
        return {
            articleUrl: "",
            imageUrl: null,
            videoUrl: null,
            sourceName: null,
            title: null,
            description: null,
            rejectedReason: "bad_url",
        };
    }
    const page = await loadArticlePage(articleUrl);
    if (!page) {
        // Страница недоступна: не подменяем её RSS-заголовком и не даём
        // Gemini придумать содержание другой страницы.
        return {
            articleUrl: "",
            imageUrl: null,
            videoUrl: null,
            sourceName: item.source || null,
            title: null,
            description: null,
            rejectedReason: "page_unavailable",
        };
    }
    const { finalUrl, html } = page;
    const pageTitle = extractPageTitle(html);
    if (pageTitle && !articleTitleMatches(item.title, pageTitle)) {
        console.warn("Rejected article title mismatch:", item.title, "=>", pageTitle, finalUrl);
        return {
            articleUrl: "",
            imageUrl: null,
            videoUrl: null,
            sourceName: null,
            title: pageTitle,
            description: null,
            rejectedReason: "article_title_mismatch",
        };
    }
    const imageCandidates = findImageCandidatesFromHtml(html, finalUrl);
    const imageUrl = imageCandidates[0]?.url ?? null;
    const videoUrl = findVideoFromHtml(html, finalUrl);
    const sourceName = findMeta(html, "og:site_name") || findMeta(html, "application-name");
    const pageDescription = findMeta(html, "og:description") || findMeta(html, "description");
    return {
        articleUrl: finalUrl,
        imageUrl,
        imageCandidates,
        videoUrl,
        sourceName,
        title: pageTitle || item.title,
        description: pageDescription,
        rejectedReason: "",
    };
}
// ============================================================
// MEDIA DOWNLOAD
// ============================================================
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
    try {
        const path = new URL(url)
            .pathname;
        const match = path.match(/\.([a-z0-9]{2,5})$/i);
        if (match) {
            return match[1]
                .toLowerCase();
        }
    }
    catch {
        // ignore
    }
    return "jpg";
}
async function downloadMedia(url, type) {
    try {
        if (!isHttpUrl(url)) {
            return null;
        }
        const response = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": type === "video"
                    ? "video/mp4,video/quicktime,video/webm,video/*;q=0.9,*/*;q=0.3"
                    : "image/avif,image/webp,image/apng,image/*,*/*;q=0.5",
            },
            signal: AbortSignal.timeout(type === "video"
                ? 40000
                : 20000),
        });
        if (!response.ok) {
            return null;
        }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.includes("mpegurl") ||
            contentType.includes("dash") ||
            contentType.includes("application/vnd.apple.mpegurl")) {
            return null;
        }
        const contentLength = Number(response.headers.get("content-length") ?? "0");
        const limit = type === "video"
            ? MAX_VIDEO_BYTES
            : MAX_IMAGE_BYTES;
        if (contentLength > 0 &&
            contentLength > limit) {
            console.log("Media too large:", contentLength);
            return null;
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength >
            limit) {
            return null;
        }
        const finalUrl = response.url ||
            url;
        if (type === "video" &&
            !contentType.startsWith("video/")) {
            if (!isDirectVideoUrl(finalUrl)) {
                return null;
            }
        }
        if (type === "image" &&
            !contentType.startsWith("image/")) {
            if (!/\.(jpg|jpeg|png|gif|webp|tiff|bmp|heic)(?:\?|$)/i.test(finalUrl)) {
                return null;
            }
        }
        const extension = extensionFromType(type, contentType, finalUrl);
        const normalizedContentType = type === "video"
            ? (contentType.startsWith("video/")
                ? contentType
                : extension === "webm"
                    ? "video/webm"
                    : extension === "mov"
                        ? "video/quicktime"
                        : extension === "mkv"
                            ? "video/x-matroska"
                            : "video/mp4")
            : (contentType.startsWith("image/")
                ? contentType
                : extension === "png"
                    ? "image/png"
                    : extension === "webp"
                        ? "image/webp"
                        : extension === "gif"
                            ? "image/gif"
                            : "image/jpeg");
        return {
            type,
            bytes: buffer,
            contentType: normalizedContentType,
            extension,
            sourceUrl: finalUrl,
        };
    }
    catch (error) {
        console.error("Download media:", error instanceof Error
            ? error.message
            : String(error));
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
    const headers = new Headers(options.headers ??
        {});
    headers.set("Authorization", MAX_BOT_TOKEN);
    headers.set("Accept", "application/json");
    const client = await initMaxHttpClient();
    return await fetch(`${MAX_API}${path}`, {
        ...options,
        client: client ??
            undefined,
        headers,
    });
}
async function maxJson(path, options = {}) {
    const response = await maxFetch(path, options);
    const text = await response.text();
    let data;
    try {
        data =
            text
                ? JSON.parse(text)
                : null;
    }
    catch {
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
    const init = await maxJson(`/uploads?type=${encodeURIComponent(media.type)}`, {
        method: "POST",
        headers: {
            "Accept": "application/json",
        },
    });
    if (!init.url) {
        throw new Error(`MAX upload URL missing for ${media.type}`);
    }
    const form = new FormData();
    const blob = new Blob([
        media.bytes,
    ], {
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
        throw new Error(`Media upload HTTP ${uploadResponse.status}: ${uploadText.slice(0, 1500)}`);
    }
    let uploadResult = null;
    try {
        uploadResult =
            uploadText
                ? JSON.parse(uploadText)
                : null;
    }
    catch {
        // ignore
    }
    const finalToken = init.token ||
        uploadResult?.token ||
        uploadResult?.mediafile_token ||
        uploadResult?.photos?.photoIds?.token ||
        null;
    if (typeof finalToken !==
        "string" ||
        !finalToken) {
        throw new Error(`MAX media token missing for ${media.type}. ` +
            `Upload response: ${uploadText.slice(0, 1500)}`);
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
        body.attachments = [
            {
                type: mediaToken.type,
                payload: {
                    token: mediaToken.token,
                },
            },
        ];
    }
    return await maxJson(`/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body: JSON.stringify(body),
    });
}
// ============================================================
// DEDUPLICATION
// ============================================================
function normalizeArticleUrl(url) {
    if (!isUsableArticleUrl(url))
        return "";
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();
        // Never treat Google News logos/images or generic media files as articles.
        if (host === "gstatic.com" ||
            host.endsWith(".gstatic.com") ||
            host === "ggpht.com" ||
            host.endsWith(".ggpht.com") ||
            /(^|\/)(google_news|google-news|logo)[^\/]*\.(png|jpg|jpeg|webp|gif)$/i.test(path) ||
            /\.(png|jpe?g|webp|gif|svg|mp4|webm|m3u8|mpd)$/i.test(path)) {
            return "";
        }
    }
    catch {
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
    "это", "этот", "эта", "эти", "после", "перед", "когда",
    "который", "которая", "которые", "также", "стало", "стали",
    "сообщил", "сообщили", "рассказал", "рассказали", "заявил",
    "заявили", "известно", "новости", "новость", "сегодня",
    "вчера", "теперь", "против", "согласно", "сообщает",
]);
function storyTokens(value) {
    const normalized = normalizeForHash(value);
    const words = normalized.split(" ").filter((w) => w.length >= 4);
    const tokens = new Set();
    for (const word of words) {
        if (STORY_STOP_WORDS.has(word))
            continue;
        // Prefix normalization catches simple Russian inflections:
        // погиб / погибла / погибли, столкновение / столкновении, etc.
        tokens.add(word.length > 6 ? word.slice(0, 6) : word);
    }
    return tokens;
}
function storySimilarity(a, b) {
    const aw = storyTokens(a);
    const bw = storyTokens(b);
    if (aw.size === 0 || bw.size === 0)
        return 0;
    let common = 0;
    for (const token of aw) {
        if (bw.has(token))
            common++;
    }
    return common / Math.max(aw.size, bw.size);
}
async function semanticStoryKey(item) {
    const title = normalizeForHash(item.title);
    const desc = normalizeForHash(item.description);
    const tokens = [...storyTokens(`${title} ${desc}`)].sort();
    return sha256(tokens.join("|"));
}

// ============================================================
// EVENT / STORY CLUSTER DEDUP
// ============================================================
// URL/title dedup is not enough: one real-world event can generate
// many different articles (for example: ДТП -> пробка -> причина ДТП,
// or пожар -> возможная причина пожара).  Persist a compact event
// fingerprint and compare new candidates against recently published
// events before allowing publication.
//
// This layer is deliberately deterministic and cheap. Gemini remains
// the content editor; it is not used as the only duplicate detector.
const EVENT_HISTORY_TTL_MS = 48 * 60 * 60 * 1000;
const EVENT_RECENT_LIMIT = 150;

const EVENT_STOP_WORDS = new Set([
    ...STORY_STOP_WORDS,
    "пожар", "пожара", "пожаре", "пожаром",
    "авария", "аварии", "аварией",
    "дтп", "смертельная", "смертельную", "смертельном",
    "погиб", "погибли", "погибло", "погибших",
    "человек", "людей", "пробка", "пробки",
    "причина", "причиной", "причину", "причин",
    "произошло", "произошла", "произошел",
    "сегодня", "вчера", "утром", "днем", "вечером", "ночью",
    "сообщает", "сообщили", "данным", "данные", "словам",
    "россия", "россии", "российский", "российская",
]);

const EVENT_FAMILY_RULES = [
    ["fire", /(пожар|возгора|загорел|загорелась|горит|горел|сгорел|огонь|дым)/i],
    ["accident", /(дтп|авари|столкнов|наезд|съезд|перевернул|машин|автомобил)/i],
    ["explosion", /(взрыв|взорвал|взорвалась|взрывной)/i],
    ["crime", /(убий|убит|напад|ограб|похищ|задержан|задержали|преступ)/i],
    ["military", /(обстрел|ракет|дрон|беспилот|военн|боев|атака|удар)/i],
    ["disaster", /(землетряс|цунами|наводнен|наводн|ураган|смерч|ополз|лавин|катастроф)/i],
    ["politics", /(президент|правительств|министр|парламент|депутат|госдум|выбор|политик|путин)/i],
    ["law", /(суд|иск|приговор|закон|законопроект|прокуратур|следств|дело)/i],
    ["economy", /(ставк|инфляц|рубл|доллар|евро|банк|бирж|рынок|нефт|газ|экономик|финанс)/i],
    ["business", /(компани|корпорац|сделк|инвестиц|бизнес|предприят|завод)/i],
    ["transport", /(пробк|движени|дорог|мост|метро|поезд|самолет|рейс|аэропорт)/i],
    ["technology", /(технолог|ии\b|искусственн|кибер|хакер|интернет|программ)/i],
];

function detectEventFamily(value, category = "") {
    const text = normalizeForHash(`${category} ${value}`);
    for (const [family, pattern] of EVENT_FAMILY_RULES) {
        if (pattern.test(text)) return family;
    }
    return normalizeForHash(category || "other") || "other";
}

function eventAnchorTokens(value) {
    const normalized = normalizeForHash(value);
    const result = new Set();
    for (const word of normalized.split(" ")) {
        if (word.length < 4 || EVENT_STOP_WORDS.has(word)) continue;
        // Four-character prefixes make Russian inflections match:
        // Рязани/Рязань -> ряза, Миллера/Миллер -> милл.
        result.add(word.slice(0, 4));
    }
    return result;
}

function eventProfile(item, articleMedia = null) {
    const title = stripHtml(
        articleMedia?.title ||
        item?.title ||
        "",
    );
    const description = stripHtml(
        `${item?.description || ""} ${articleMedia?.description || ""}`,
    );
    const combined = `${title} ${description}`;
    return {
        category: item?.category || "",
        family: detectEventFamily(combined, item?.category || ""),
        anchors: [...eventAnchorTokens(combined)].slice(0, 40),
        title: title.slice(0, 500),
        description: description.slice(0, 1000),
        published_at: Date.now(),
        article_url: item?.articleUrl || "",
    };
}

function eventAnchorOverlap(a, b) {
    const aa = new Set(a?.anchors || []);
    const bb = new Set(b?.anchors || []);
    let common = 0;
    for (const token of aa) {
        if (bb.has(token)) common++;
    }
    return common;
}

function eventProfilesMatch(candidate, previous) {
    if (!candidate || !previous) return false;

    const familyA = candidate.family || "other";
    const familyB = previous.family || "other";

    // Explicit event families must agree. "other" is allowed to compare
    // by text anchors, but never overrides a known conflicting family.
    if (familyA !== "other" && familyB !== "other" && familyA !== familyB) {
        return false;
    }

    const ageMs = Math.max(
        0,
        Date.now() - Number(previous.published_at || 0),
    );
    if (ageMs > EVENT_HISTORY_TTL_MS) return false;

    const common = eventAnchorOverlap(candidate, previous);
    if (common >= 2) return true;

    // For fast-moving incidents, one strong location/object anchor inside
    // a short time window is enough. This catches:
    // "ДТП на Солотчинском мосту" -> "авария ... пробка ... в Рязани".
    const incidentFamily = [
        "fire",
        "accident",
        "explosion",
        "crime",
        "military",
        "disaster",
    ].includes(familyA) || [
        "fire",
        "accident",
        "explosion",
        "crime",
        "military",
        "disaster",
    ].includes(familyB);

    if (common >= 1 && incidentFamily && ageMs <= 3 * 60 * 60 * 1000) {
        return true;
    }

    // For non-incident stories require stronger overlap.
    if (common >= 3) return true;

    return false;
}

async function getRecentPublishedEvents(limit = EVENT_RECENT_LIMIT) {
    const db = await getKV();
    const events = [];
    for await (const entry of db.list({
        prefix: [
            "factor",
            "published_event_v4",
        ],
        reverse: true,
    })) {
        if (entry.value && typeof entry.value === "object") {
            events.push(entry.value);
        }
        if (events.length >= limit) break;
    }
    return events;
}

async function isSamePublishedEvent(item, articleMedia = null) {
    const candidate = eventProfile(item, articleMedia);
    const recentEvents = await getRecentPublishedEvents();

    for (const previous of recentEvents) {
        if (eventProfilesMatch(candidate, previous)) {
            console.log(
                "Rejected: same published event:",
                candidate.family,
                candidate.title,
                "<=>",
                previous.title,
            );
            return true;
        }
    }

    // Backward compatibility for posts published before event profiles
    // existed. Use the existing recent-title history as a conservative
    // final check for obvious incident repeats.
    const recentTitles = await getRecentTitleEntries(MAX_HISTORY_CHECKED);
    for (const recent of recentTitles) {
        const previous = {
            family: detectEventFamily(recent.title, item?.category || ""),
            anchors: [...eventAnchorTokens(recent.title)],
            published_at: recent.published_at,
            title: recent.title,
        };
        if (eventProfilesMatch(candidate, previous)) {
            console.log(
                "Rejected: same recent event title:",
                candidate.title,
                "<=>",
                recent.title,
            );
            return true;
        }
    }

    return false;
}

async function rememberPublishedEvent(item, story, articleMedia, articleUrl) {
    const db = await getKV();
    const profile = eventProfile(
        {
            ...item,
            title: story?.headline || item.title,
            description: `${item.description || ""} ${story?.short || ""}`,
            articleUrl,
        },
        articleMedia,
    );
    profile.published_at = Date.now();
    profile.article_url = normalizeArticleUrl(articleUrl);

    const id = await sha256(
        `${profile.published_at}|${profile.family}|${profile.title}|${profile.article_url}`,
    );

    await db.set(
        ["factor", "published_event_v4", id],
        profile,
        { expireIn: EVENT_HISTORY_TTL_MS },
    );
}

async function isAlreadyPublished(item, articleUrl = "") {
    const db = await getKV();
    if (articleUrl) {
        const key = await publishedKey(item, articleUrl);
        const result = await db.get([
            "factor",
            "published_v2",
            key,
        ]);
        if (result.value === true) {
            return true;
        }
    }
    // Exact legacy key.
    const oldKey = await legacyPublishedKey(item);
    const legacy = await db.get([
        "factor",
        "published",
        oldKey,
    ]);
    if (legacy.value === true)
        return true;
    // Semantic duplicate protection: same event, different RSS source/title/URL.
    const semanticKey = await semanticStoryKey(item);
    if (semanticKey) {
        const semantic = await db.get([
            "factor",
            "published_story_v3",
            semanticKey,
        ]);
        if (semantic.value === true)
            return true;
    }
    // Last line of defence for slightly different headlines.
    const recent = await getRecentTitles(MAX_HISTORY_CHECKED);
    const candidateTitle = item.title.trim();
    for (const oldTitle of recent) {
        if (storySimilarity(candidateTitle, oldTitle) >= 0.78) {
            return true;
        }
    }
    return false;
}
async function markPublished(item, articleUrl) {
    const db = await getKV();
    const normalizedUrl = normalizeArticleUrl(articleUrl);
    const key = await publishedKey(item, normalizedUrl);
    await db.set([
        "factor",
        "published_v2",
        key,
    ], true, {
        expireIn: HISTORY_TTL_MS,
    });
    const oldKey = await legacyPublishedKey(item);
    await db.set([
        "factor",
        "published",
        oldKey,
    ], true, {
        expireIn: HISTORY_TTL_MS,
    });
    // Persist a source-independent story key. This is what prevents
    // the same event from returning through another RSS feed.
    const semanticKey = await semanticStoryKey(item);
    if (semanticKey) {
        await db.set([
            "factor",
            "published_story_v3",
            semanticKey,
        ], true, {
            expireIn: HISTORY_TTL_MS,
        });
    }
}
// ============================================================
// RECENT TITLES
// ============================================================
async function getRecentTitleEntries(limit = MAX_HISTORY_CHECKED) {
    const db = await getKV();
    const entries = [];
    for await (const entry of db.list({
        prefix: [
            "factor",
            "recent_title_v2",
        ],
        reverse: true,
    })) {
        if (entry.value) {
            const key = Array.isArray(entry.key) ? entry.key : [];
            const timestamp = Number(key[2] || 0);
            entries.push({
                title: String(entry.value),
                published_at: Number.isFinite(timestamp) ? timestamp : 0,
            });
        }
        if (entries.length >= limit) {
            break;
        }
    }
    return entries;
}

async function getRecentTitles(limit = MAX_HISTORY_CHECKED) {
    const entries = await getRecentTitleEntries(limit);
    return entries.map((entry) => entry.title);
}
async function rememberTitle(title) {
    const db = await getKV();
    const id = await sha256(normalizeForHash(title));
    await db.set([
        "factor",
        "recent_title_v2",
        Date.now(),
        id,
    ], title, {
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
    const ageMinutes = timestamp > 0
        ? Math.max(0, (Date.now() -
            timestamp) /
            60000)
        : 180;
    if (ageMinutes <= 15) {
        score += 30;
    }
    else if (ageMinutes <= 30) {
        score += 27;
    }
    else if (ageMinutes <= 60) {
        score += 23;
    }
    else if (ageMinutes <= 120) {
        score += 18;
    }
    else if (ageMinutes <= 360) {
        score += 10;
    }
    else {
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
    if (title.length >= 35 &&
        title.length <= 180) {
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
    }
    catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) {
            return null;
        }
        try {
            return JSON.parse(match[0]);
        }
        catch {
            return null;
        }
    }
}
async function callGemini(item, articleMedia) {
    if (!GEMINI_API_KEY) {
        return null;
    }
    const prompt = `

Ты редактор новостного канала ФАКТОР.

Работай ТОЛЬКО с информацией,
которая присутствует в исходных данных.

НЕ ДОБАВЛЯЙ факты из памяти.
НЕ ДОДУМЫВАЙ причины.
НЕ ДОДУМЫВАЙ последствия.
НЕ ПРИДУМЫВАЙ цифры.

ИСХОДНЫЙ ЗАГОЛОВОК:
${item.title}

ИСТОЧНИК:
${item.source}

ЗАГОЛОВОК СТРАНИЦЫ:
${articleMedia.title ?? ""}

ОПИСАНИЕ RSS:
${stripHtml(item.description)}

ОПИСАНИЕ СТРАНИЦЫ:
${stripHtml(articleMedia.description ?? "")}

Верни ТОЛЬКО JSON:

{
  "headline": "короткий точный заголовок",
  "short": "одно короткое предложение о событии",
  "main": [
    "конкретный факт 1",
    "конкретный факт 2",
    "конкретный факт 3"
  ],
  "important": "конкретная информация, которую читателю важно знать",
  "urgent": false
}

ПРАВИЛА:

1. Никаких выдуманных фактов.
2. headline должен описывать именно событие.
3. Не используй кликбейт.
4. Не используй вопросительные заголовки.
5. Не пиши "стало известно".
6. Не пиши "ситуация развивается".
7. Не пиши рекламные формулировки.
8. Не повторяй одну мысль в разных блоках.
9. Если фактов мало — используй меньше пунктов.
10. main может содержать от 0 до 3 пунктов.
11. urgent=true только если событие действительно срочное.
12. Не делай выводов, которых нет в исходных данных.
13. Не меняй смысл новости.
14. Не добавляй географию, даты, цифры или имена, которых нет в исходных данных.

`;
    try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
            encodeURIComponent(GEMINI_API_KEY), {
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
        });
        if (!response.ok) {
            console.error("Gemini HTTP:", response.status, (await response.text()).slice(0, 1000));
            return null;
        }
        const data = await response.json();
        const text = data
            ?.candidates?.[0]
            ?.content?.parts
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
            headline: stripHtml(String(json.headline ||
                item.title)),
            short: stripHtml(String(json.short ||
                item.description ||
                item.title)),
            main: Array.isArray(json.main)
                ? json.main
                    .map((x) => stripHtml(String(x)))
                    .filter(Boolean)
                    .slice(0, 3)
                : [],
            important: stripHtml(String(json.important ||
                "")),
            urgent: Boolean(json.urgent) ||
                detectUrgency(item),
        };
    }
    catch (error) {
        console.error("Gemini:", error instanceof Error
            ? error.message
            : String(error));
        return null;
    }
}
// ============================================================
// FALLBACK
// ============================================================
function makeFallbackStory(item, articleMedia) {
    const short = truncate(stripHtml(articleMedia.description ||
        item.description ||
        item.title), 500);
    return {
        headline: stripHtml(articleMedia.title ||
            item.title),
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
    return new Set(normalizeForHash(value)
        .split(" ")
        .filter((word) => word.length >= 5));
}
function similarity(a, b) {
    const aw = textWords(a);
    const bw = textWords(b);
    if (aw.size === 0 ||
        bw.size === 0) {
        return 0;
    }
    let common = 0;
    for (const word of aw) {
        if (bw.has(word)) {
            common++;
        }
    }
    return (common /
        Math.max(aw.size, bw.size));
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
    const candidate = articleMedia.sourceName ||
        source ||
        "Источник";
    return cleanText(candidate
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, ""));
}
// ============================================================
// POST
// ============================================================
function buildPost(item, story, sourceName, articleUrl) {
    const header = story.urgent
        ? "🔴 <b>ФАКТОР • ОПЕРАТИВНО</b>"
        : "🔵 <b>ФАКТОР • ГЛАВНОЕ</b>";
    const category = `${item.categoryEmoji} <b>${escapeHtml(item.category)}</b>`;
    const headlineText = stripHtml(truncate(story.headline || item.title, 260));
    const shortText = stripHtml(truncate(story.short || item.description || item.title, 500));
    const mainItems = [];
    for (const raw of story.main || []) {
        const text = stripHtml(truncate(String(raw || ""), 350));
        if (!text)
            continue;
        if (storySimilarity(text, headlineText) >= 0.72)
            continue;
        if (storySimilarity(text, shortText) >= 0.72)
            continue;
        if (mainItems.some((x) => storySimilarity(x, text) >= 0.80))
            continue;
        mainItems.push(text);
        if (mainItems.length >= 3)
            break;
    }
    const importantText = stripHtml(truncate(story.important || "", 400));
    const uniqueImportant = importantText &&
        storySimilarity(importantText, headlineText) < 0.72 &&
        storySimilarity(importantText, shortText) < 0.72 &&
        !mainItems.some((x) => storySimilarity(x, importantText) >= 0.72)
        ? importantText
        : "";
    const time = new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Moscow",
    }).format(new Date());
    const sourceLine = isLikelyArticleUrl(articleUrl)
        ? `🔗 <a href="${escapeHtml(articleUrl)}">${escapeHtml(sourceName)}</a>`
        : "";
    const parts = [
        header,
        "",
        category,
        "",
        `<b>${escapeHtml(headlineText)}</b>`,
        "",
        "<b>КРАТКО</b>",
        escapeHtml(shortText),
    ];
    if (mainItems.length > 0) {
        parts.push("", "<b>ГЛАВНОЕ</b>");
        for (const text of mainItems) {
            parts.push(`• ${escapeHtml(text)}`);
        }
    }
    if (uniqueImportant) {
        parts.push("", "<b>ЧТО ВАЖНО</b>", escapeHtml(uniqueImportant));
    }
    parts.push("", `🕒 ${time}`);
    if (sourceLine)
        parts.push(sourceLine);
    parts.push("", "<i>ФАКТОР</i>");
    let result = parts.join("\n");
    if (result.length > MAX_POST_LENGTH) {
        result = result.slice(0, MAX_POST_LENGTH - 1).trimEnd() + "…";
    }
    return result;
}
// ============================================================
// MEDIA
// ============================================================
async function validateImageRelevance(item, story, candidate, media) {
    if (!GEMINI_API_KEY || !media) return true;
    try {
        let binary = "";
        const bytes = media.bytes;
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        const prompt = `
Ты проверяешь фотографию для новостного канала.

Новость:
${item.title}

Текст новости:
${stripHtml(story?.short || item.description || "")}

Заголовок статьи:
${stripHtml(story?.headline || "")}

Подпись/контекст изображения:
${candidate.context || "нет"}

Определи ТОЛЬКО визуальную релевантность.
true = изображение явно связано с описываемым событием/объектом/людьми/местом новости.
false = логотип, баннер, портрет автора, общая иллюстрация, архивная/сторонняя картинка, реклама, либо изображение явно относится к другой теме.
Не пытайся установить юридическую или абсолютную достоверность фотографии.

Верни ТОЛЬКО JSON: {"relevant":true,"reason":"коротко"}
`;
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(GEMINI_API_KEY), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: media.contentType || "image/jpeg", data: base64 } },
                    ],
                }],
                generationConfig: { temperature: 0, responseMimeType: "application/json" },
            }),
            signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) return true;
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
        const json = text ? extractJson(text) : null;
        if (!json || typeof json.relevant !== "boolean") return true;
        console.log("Image relevance:", candidate.url, json.relevant, json.reason || "");
        return json.relevant;
    } catch (error) {
        console.error("Image relevance check:", error instanceof Error ? error.message : String(error));
        // A validator outage must not destroy an otherwise valid publication.
        return true;
    }
}

async function findBestMedia(articleMedia, item, story, diagnostics = null) {
    // ----------------------------------------------------------
    // 1. VIDEO — only publisher/article video, never stock media.
    // ----------------------------------------------------------
    if (articleMedia.videoUrl) {
        if (diagnostics) diagnostics.video_candidates = 1;
        console.log("Trying article video:", articleMedia.videoUrl);
        const video = await downloadMedia(articleMedia.videoUrl, "video");
        if (video) {
            if (diagnostics) diagnostics.media_selected = "video";
            return video;
        }
        if (diagnostics) diagnostics.media_rejected = "video_download_failed";
    }

    // ----------------------------------------------------------
    // 2. IMAGE — article images first, generic OG image last.
    //    Relevance validation prevents a technically valid but wrong
    //    image (logo/illustration/unrelated archive photo) from being sent.
    // ----------------------------------------------------------
    const candidates = Array.isArray(articleMedia.imageCandidates) && articleMedia.imageCandidates.length
        ? articleMedia.imageCandidates
        : (articleMedia.imageUrl ? [{ url: articleMedia.imageUrl, priority: 50, context: "", source: "meta" }] : []);

    if (diagnostics) diagnostics.image_candidates = candidates.length;
    let checked = 0;
    for (const candidate of candidates.slice(0, 5)) {
        checked++;
        if (diagnostics) diagnostics.media_checked = checked;
        console.log("Trying article image candidate:", candidate.source, candidate.url);
        const image = await downloadMedia(candidate.url, "image");
        if (!image) continue;
        const relevant = await validateImageRelevance(item, story, candidate, image);
        if (!relevant) {
            if (diagnostics) diagnostics.media_rejected = "image_not_relevant";
            continue;
        }
        if (diagnostics) {
            diagnostics.media_selected = "image";
            diagnostics.selected_media_source = candidate.source;
        }
        return image;
    }

    // ----------------------------------------------------------
    // 3. TEXT — better no image than a wrong image.
    // ----------------------------------------------------------
    if (diagnostics) diagnostics.media_rejected = "no_relevant_media";
    return null;
}
// ============================================================
// CANDIDATE SELECTION
// ============================================================
async function chooseCandidate(items, urgentAllowed, regularAllowed, diagnostics = null) {
    // ----------------------------------------------------------
    // STEP 1 — LOCAL SCORE
    // ----------------------------------------------------------
    const scored = items
        .filter((item) => {
            if (item.title.length < 15) {
                diagnostics && diagnostics.short_title++;
                return false;
            }
            return true;
        })
        .map(scoreNewsItem)
        .filter((candidate) => {
            if (candidate.urgency && !urgentAllowed) {
                diagnostics && diagnostics.urgent_interval++;
                return false;
            }
            if (!candidate.urgency && !regularAllowed) {
                diagnostics && diagnostics.regular_interval++;
                return false;
            }
            return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, SCORE_CANDIDATES);

    if (diagnostics) {
        diagnostics.scored = scored.length;
    }

    console.log("Scored candidates:", scored.length);

    // ----------------------------------------------------------
    // STEP 2 — REAL ARTICLE URL
    // ----------------------------------------------------------
    let checked = 0;

    for (const candidate of scored) {
        checked++;
        const { item, score } = candidate;

        // Fast event duplicate rejection before expensive article/Gemini work.
        if (await isSamePublishedEvent(item)) {
            diagnostics && diagnostics.event_duplicate_before_article++;
            console.log("Rejected: same event before article fetch:", item.title);
            continue;
        }

        // Fast URL/title duplicate rejection.
        if (await isAlreadyPublished(item)) {
            diagnostics && diagnostics.duplicate_before_article++;
            console.log("Rejected: semantic duplicate before article fetch:", item.title);
            continue;
        }

        const articleMedia = await extractArticleMedia(item);
        const articleUrl = articleMedia.articleUrl;

        if (articleMedia.rejectedReason === "article_title_mismatch") {
            diagnostics && diagnostics.article_title_mismatch++;
            continue;
        }

        if (!isLikelyArticleUrl(articleUrl)) {
            diagnostics && diagnostics.bad_url++;
            console.log("Rejected: no real article URL:", item.title);
            continue;
        }

        // --------------------------------------------------------
        // STEP 3 — EVENT DEDUP
        // --------------------------------------------------------
        // This is the important fix: different articles about the same
        // real-world event must not become separate channel posts.
        if (await isSamePublishedEvent(item, articleMedia)) {
            diagnostics && diagnostics.event_duplicate_after_article++;
            console.log("Rejected: same event after article:", item.title);
            continue;
        }

        // --------------------------------------------------------
        // STEP 4 — DEDUP
        // --------------------------------------------------------
        if (await isAlreadyPublished(item, articleUrl)) {
            diagnostics && diagnostics.duplicate_after_article++;
            console.log("Rejected: published:", item.title);
            continue;
        }

        // --------------------------------------------------------
        // STEP 5 — GEMINI
        // --------------------------------------------------------
        let story = null;

        if (checked <= GEMINI_CANDIDATES) {
            story = await callGemini(item, articleMedia);
        }

        if (!story) {
            diagnostics && diagnostics.gemini_fallback++;
            story = makeFallbackStory(item, articleMedia);
        }

        // Защита от перекрёстного ответа Gemini: заголовок модели
        // обязан относиться к той же новости, что и RSS.
        if (!articleTitleMatches(item.title, story.headline)) {
            diagnostics && diagnostics.gemini_title_mismatch++;
            console.warn(
                "Rejected Gemini title mismatch:",
                item.title,
                "=>",
                story.headline,
            );
            story = makeFallbackStory(item, articleMedia);
        }

        if (!articleTitleMatches(item.title, story.headline)) {
            diagnostics && diagnostics.gemini_title_mismatch++;
            console.warn(
                "Rejected fallback title mismatch:",
                item.title,
                "=>",
                story.headline,
            );
            continue;
        }

        story.urgent = story.urgent || candidate.urgency;

        if (story.urgent && !urgentAllowed) {
            diagnostics && diagnostics.urgent_interval_after_gemini++;
            continue;
        }

        if (!story.urgent && !regularAllowed) {
            diagnostics && diagnostics.regular_interval_after_gemini++;
            continue;
        }

        // --------------------------------------------------------
        // STEP 5 — TEXT DUPLICATE
        // --------------------------------------------------------
        if (await isRepeatedStoryText(story)) {
            diagnostics && diagnostics.text_duplicate++;
            console.log("Rejected: text duplicate:", story.headline);
            continue;
        }

        diagnostics && diagnostics.accepted++;
        return {
            item,
            story,
            articleMedia,
            score,
        };
    }

    return null;
}

// ============================================================
// DIAGNOSTICS
// ============================================================
function createDiagnostics() {
    return {
        rss_total: 0,
        scored: 0,
        accepted: 0,

        short_title: 0,
        urgent_interval: 0,
        regular_interval: 0,

        duplicate_before_article: 0,
        event_duplicate_before_article: 0,
        bad_url: 0,
        article_title_mismatch: 0,
        duplicate_after_article: 0,
        event_duplicate_after_article: 0,

        gemini_fallback: 0,
        gemini_title_mismatch: 0,
        urgent_interval_after_gemini: 0,
        regular_interval_after_gemini: 0,
        text_duplicate: 0,

        video_candidates: 0,
        image_candidates: 0,
        media_checked: 0,
        media_selected: null,
        selected_media_source: null,
        media_rejected: null,

        top_candidates: [],
    };
}

// ============================================================
// ATOMIC KV LOCK
// ============================================================
const PIPELINE_LOCK_KEY = [
    "factor",
    "lock",
];
async function acquirePipelineLock() {
    const db = await getKV();
    const token = crypto.randomUUID();
    const result = await db
        .atomic()
        .check({
        key: PIPELINE_LOCK_KEY,
        versionstamp: null,
    })
        .set(PIPELINE_LOCK_KEY, {
        token,
        created_at: Date.now(),
    }, {
        expireIn: LOCK_TTL_MS,
    })
        .commit();
    if (!result.ok) {
        return null;
    }
    return token;
}
async function releasePipelineLock(token) {
    const db = await getKV();
    const current = await db.get(PIPELINE_LOCK_KEY);
    if (current.value?.token !==
        token) {
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
    const regular = (await db.get([
        "factor",
        "state",
        "last_regular",
    ])).value ?? null;
    const urgent = (await db.get([
        "factor",
        "state",
        "last_urgent",
    ])).value ?? null;
    const lastPipeline = (await db.get([
        "factor",
        "state",
        "last_pipeline",
    ])).value ?? null;
    const lock = await db.get(PIPELINE_LOCK_KEY);
    const running = Boolean(lock.value);
    const now = Date.now();
    return {
        running,
        cron: CRON_SCHEDULE,
        regular: {
            interval_minutes: 30,
            last: regular,
            can_publish: regular === null ||
                now -
                    regular >=
                    REGULAR_INTERVAL_MS,
        },
        urgent: {
            interval_minutes: 5,
            last: urgent,
            can_publish: urgent === null ||
                now -
                    urgent >=
                    URGENT_INTERVAL_MS,
        },
        media: {
            max_video_mb: MAX_VIDEO_BYTES /
                1024 /
                1024,
            max_image_mb: MAX_IMAGE_BYTES /
                1024 /
                1024,
            priority: "video -> image -> text",
        },
        dedup: {
            persistent: true,
            ttl_days: 30,
            max_history_checked: MAX_HISTORY_CHECKED,
            event_cluster_ttl_hours: EVENT_HISTORY_TTL_MS / 3600000,
            event_cluster_key: "published_event_v4",
        },
        lock: {
            atomic: true,
            ttl_minutes: LOCK_TTL_MS /
                60000,
        },
        last_pipeline: lastPipeline,
    };
}
// ============================================================
// MEDIA PROCESSING RETRY
// ============================================================
async function publishWithMediaRetry(text, mediaInfo) {
    const delays = [
        5000,
        10000,
        20000,
        30000,
    ];
    let lastError = null;
    for (let attempt = 0; attempt <=
        delays.length; attempt++) {
        if (attempt > 0) {
            await sleep(delays[attempt - 1]);
        }
        try {
            console.log(`MAX media publish attempt ${attempt + 1}`);
            return await publishToMax(text, mediaInfo);
        }
        catch (error) {
            lastError =
                error;
            const message = error instanceof Error
                ? error.message
                : String(error);
            console.error("MAX media publish:", message);
            const retryable = message.includes("attachment.not.ready") ||
                message.includes("not.processed") ||
                message.includes("processing");
            if (!retryable) {
                throw error;
            }
        }
    }
    throw (lastError instanceof Error
        ? lastError
        : new Error(String(lastError)));
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
    }
    finally {
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
            return (bd - ad);
        })
            .slice(0, MAX_RSS_ITEMS);
        console.log("RSS items:", items.length);
        // --------------------------------------------------------
        // INTERVALS
        // --------------------------------------------------------
        const now = Date.now();
        const lastRegular = (await db.get([
            "factor",
            "state",
            "last_regular",
        ])).value ?? null;
        const lastUrgent = (await db.get([
            "factor",
            "state",
            "last_urgent",
        ])).value ?? null;
        const urgentAllowed = manual ||
            lastUrgent === null ||
            now -
                lastUrgent >=
                URGENT_INTERVAL_MS;
        const regularAllowed = manual ||
            lastRegular === null ||
            now -
                lastRegular >=
                REGULAR_INTERVAL_MS;
        if (!urgentAllowed &&
            !regularAllowed) {
            const result = {
                ok: true,
                selected: 0,
                reason: "publication intervals not reached",
                rss_total: items.length,
                duration_ms: Date.now() -
                    startedAt,
            };
            if (!GITHUB_ACTIONS_MODE) {

                await db.set([

                    "factor",

                    "state",

                    "last_pipeline",

                ], result);

            }
            return result;
        }
        // --------------------------------------------------------
        // CANDIDATE
        // --------------------------------------------------------
        const diagnostics = createDiagnostics();
        diagnostics.rss_total = items.length;

        const candidate = await chooseCandidate(
            items,
            urgentAllowed,
            regularAllowed,
            diagnostics,
        );

        if (!candidate) {
            const result = {
                ok: true,
                selected: 0,
                reason: "no new valid candidate",
                rss_total: items.length,
                diagnostics,
                duration_ms: Date.now() -
                    startedAt,
            };
            if (!GITHUB_ACTIONS_MODE) {

                await db.set([

                    "factor",

                    "state",

                    "last_pipeline",

                ], result);

            }
            return result;
        }
        const { item, story, articleMedia, score, } = candidate;
        const urgent = story.urgent ||
            detectUrgency(item);
        if (urgent &&
            !urgentAllowed &&
            !manual) {
            return {
                ok: true,
                selected: 0,
                reason: "urgent interval not reached",
            };
        }
        if (!urgent &&
            !regularAllowed &&
            !manual) {
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
        if (!isLikelyArticleUrl(finalArticleUrl)) {
            return {
                ok: true,
                selected: 0,
                reason: "real article URL missing",
            };
        }
        // --------------------------------------------------------
        // FINAL EVENT DEDUP
        // --------------------------------------------------------
        if (await isSamePublishedEvent(item, articleMedia)) {
            diagnostics.event_duplicate_after_article++;
            return {
                ok: true,
                selected: 0,
                reason: "same event already published",
                diagnostics,
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
                diagnostics,
            };
        }
        // --------------------------------------------------------
        // MEDIA
        // --------------------------------------------------------
        const media = await findBestMedia(articleMedia, item, story, diagnostics);
        const sourceName = cleanSourceName(item.source, articleMedia);
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
                console.log("Uploading media:", media.type, media.bytes.byteLength);
                const token = await uploadMedia(media);
                mediaInfo = {
                    type: media.type,
                    token,
                };
            }
            catch (error) {
                console.error("Media upload failed:", error instanceof Error
                    ? error.message
                    : String(error));
                mediaInfo =
                    undefined;
            }
        }
        // --------------------------------------------------------
        // PUBLISH
        // --------------------------------------------------------
        let publication;
        if (mediaInfo) {
            try {
                publication =
                    await publishWithMediaRetry(text, mediaInfo);
            }
            catch (error) {
                console.error("Media publication failed. " +
                    "Falling back to text:", error instanceof Error
                    ? error.message
                    : String(error));
                publication =
                    await publishToMax(text);
            }
        }
        else {
            publication =
                await publishToMax(text);
        }
        // --------------------------------------------------------
        // MARK AS PUBLISHED
        // --------------------------------------------------------
        await markPublished(item, finalArticleUrl);
        await rememberTitle(story.headline);
        await rememberPublishedEvent(
            item,
            story,
            articleMedia,
            finalArticleUrl,
        );
        if (urgent) {
            await db.set([
                "factor",
                "state",
                "last_urgent",
            ], now);
        }
        else {
            await db.set([
                "factor",
                "state",
                "last_regular",
            ], now);
        }
        const result = {
            ok: true,
            selected: 1,
            urgent,
            manual,
            score,
            rss_total: items.length,
            diagnostics,
            item: {
                title: item.title,
                source: sourceName,
                article_url: finalArticleUrl,
                category: item.category,
            },
            media: media
                ? {
                    type: media.type,
                    source_url: media.sourceUrl,
                }
                : null,
            publication,
            duration_ms: Date.now() -
                startedAt,
        };
        if (!GITHUB_ACTIONS_MODE) {

            await db.set([

                "factor",

                "state",

                "last_pipeline",

            ], result);

        }
        return result;
    }
    catch (error) {
        const result = {
            ok: false,
            error: error instanceof Error
                ? error.message
                : String(error),
            duration_ms: Date.now() -
                startedAt,
        };
        if (!GITHUB_ACTIONS_MODE) {

            await db.set([

                "factor",

                "state",

                "last_pipeline",

            ], result);

        }
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
        `🕒 ${new Intl.DateTimeFormat("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Moscow",
        }).format(new Date())}`,
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
// RUNTIME ENTRYPOINT
// ============================================================
//
// Deno Deploy:
//   persistent Deno.cron + HTTP server.
//
// GitHub Actions:
//   one pipeline execution per workflow run.
//   Schedule lives in .github/workflows/faktor.yml.

if (GITHUB_ACTIONS_MODE) {
    console.log("FAKTOR: GitHub Actions mode");

    try {
        const result = await runPipeline(false);
        console.log(
            "FAKTOR: pipeline finished",
            JSON.stringify(result),
        );
    } catch (error) {
        console.error("FAKTOR: pipeline failed:", error);
        Deno.exit(1);
    }
} else {
    // ============================================================
    // CRON
    // ============================================================
    Deno.cron("FAKTOR news pipeline", CRON_SCHEDULE, {
        backoffSchedule: [
            5000,
            15000,
            30000,
        ],
    }, async () => {
        console.log("CRON: starting pipeline");
        try {
            const result = await runPipeline(false);
            console.log(
                "CRON: finished",
                JSON.stringify(result),
            );
        } catch (error) {
            console.error("CRON ERROR:", error);
            throw error;
        }
    });

    // ============================================================
    // HTTP SERVER
    // ============================================================
    Deno.serve(async (request) => {
        const url = new URL(request.url);
        const path =
            url.pathname.replace(/\/$/, "") || "/";

        try {
            if (
                request.method === "GET" &&
                path === "/"
            ) {
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

            if (
                request.method === "GET" &&
                path === "/status"
            ) {
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

            if (
                request.method === "GET" &&
                path === "/pipeline-state"
            ) {
                return json({
                    ok: true,
                    ...(await getState()),
                });
            }

            if (
                (
                    request.method === "GET" ||
                    request.method === "POST"
                ) &&
                path === "/run"
            ) {
                const result = await runPipeline(true);
                return json(result);
            }

            if (
                request.method === "GET" &&
                path === "/publish-test"
            ) {
                const result = await publishTest();
                return json({
                    ok: true,
                    provider: "MAX",
                    operation: "publish-test",
                    chat_id: TARGET_CHAT_ID,
                    response: result,
                });
            }

            if (
                request.method === "GET" &&
                path === "/me"
            ) {
                const me = await maxJson("/me", {
                    method: "GET",
                });
                return json({
                    ok: true,
                    max_me: me,
                });
            }

            if (
                request.method === "POST" &&
                path === "/webhook"
            ) {
                const body = await request.text();
                console.log(
                    "WEBHOOK:",
                    body.slice(0, 2000),
                );
                return json({
                    ok: true,
                    received: true,
                });
            }

            return json({
                ok: false,
                error: "Endpoint not found",
                path,
            }, 404);
        } catch (error) {
            console.error("HTTP ERROR:", error);
            return json({
                ok: false,
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
                path,
            }, 500);
        }
    });
}
