// ============================================================
// MAX NEWS AGENT — ФАКТОР (Direct Live Edition v15)
// GITHUB ACTIONS RUNTIME
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const URGENT_INTERVAL_MS = 3 * 60 * 1000;
const REGULAR_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_NEWS_AGE_MS = 12 * 60 * 60 * 1000;

const MIN_IMAGE_BYTES = 10 * 1024;
const MIN_VIDEO_BYTES = 50 * 1024;
const MAX_VIDEO_BYTES = Number(Deno.env.get("MAX_VIDEO_MB") ?? "50") * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(Deno.env.get("MAX_IMAGE_MB") ?? "15") * 1024 * 1024;

const RSS_LIMIT_PER_FEED = 40;
const MAX_RSS_ITEMS = 400;

const PUBLIC_TELEGRAM_VIDEO_CHANNELS = (Deno.env.get("PUBLIC_TELEGRAM_VIDEO_CHANNELS") ?? "shot_shot,mash,breakingmash,bazabazon,novosti_efir,readovkanews")
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

async function initMaxHttpClient() {
    if (maxHttpClient) return maxHttpClient;
    try {
        const [rootRes, subRes] = await Promise.all([
            fetch(MAX_ROOT_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }),
            fetch(MAX_SUB_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }),
        ]);
        if (!rootRes.ok || !subRes.ok) throw new Error("CA fetch error");
        maxHttpClient = Deno.createHttpClient({ caCerts: [await rootRes.text(), await subRes.text()] });
        return maxHttpClient;
    } catch {
        return null;
    }
}

// ============================================================
// RSS FEEDS
// ============================================================
const RSS_FEEDS = [
    { category: "ГЛАВНОЕ", emoji: "⚡", url: "https://news.google.com/rss?hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ВИДЕО_ЭФИР", emoji: "🎥", url: "https://news.google.com/rss/search?q=видео+OR+кадры+OR+момент+OR+очевидцы&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "РОССИЯ", emoji: "🇷🇺", url: "https://news.google.com/rss/search?q=Россия+OR+Москва+OR+Краснодар+OR+Татарстан&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "МИР", emoji: "🌍", url: "https://news.google.com/rss/search?q=world+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ИНЦИДЕНТЫ", emoji: "🚨", url: "https://news.google.com/rss/search?q=ЧП+OR+крушение+OR+стихия+OR+БПЛА+OR+взрыв+OR+сбой&hl=ru&gl=RU&ceid=RU:ru" },
];

// ============================================================
// STATE STORAGE
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
            this.data = JSON.parse(text);
        } catch {
            this.data = { version: 1, entries: {} };
        }
        return this.data;
    }

    async get(key) {
        const data = await this.load();
        const entry = data.entries[JSON.stringify(key)];
        return { value: entry?.value ?? null };
    }

    async set(key, value, options = {}) {
        const data = await this.load();
        data.entries[JSON.stringify(key)] = {
            key,
            value,
            expiresAt: options?.expireIn ? Date.now() + options.expireIn : null,
        };
        await Deno.writeTextFile(this.filePath, JSON.stringify(data, null, 2) + "\n");
    }

    async getAllPublishedTopics() {
        const data = await this.load();
        const topics = [];
        const now = Date.now();
        for (const [k, v] of Object.entries(data.entries)) {
            if (k.startsWith('["factor","published_topic",') && v?.value) {
                if (!v.expiresAt || v.expiresAt > now) {
                    topics.push(v.value);
                }
            }
        }
        return topics;
    }
}

const kv = new FileKV();

// ============================================================
// TEXT & HTML SANITIZATION
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
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
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
    return cleanText(value).replace(/[*_]/g, "").trim();
}

function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizeForHash(value) {
    return stripHtml(value).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim();
}

async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extractKeyRoots(text) {
    const stopWords = new Set(["россия", "москва", "сегодня", "вчера", "стало", "известно", "сообщили", "после", "видео", "кадры", "новость", "своей", "словам"]);
    return normalizeForHash(text)
        .split(" ")
        .filter((w) => w.length >= 4 && !stopWords.has(w))
        .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}

async function isSemanticallyDuplicate(title) {
    const currentRoots = extractKeyRoots(title);
    if (currentRoots.length === 0) return false;

    const previousTopics = await kv.getAllPublishedTopics();
    for (const prev of previousTopics) {
        const prevSet = new Set(prev.roots || []);
        let overlap = 0;
        for (const root of currentRoots) {
            if (prevSet.has(root)) overlap++;
        }
        if (overlap >= 3 || (currentRoots.length <= 3 && overlap >= 2)) {
            console.log(`⚠️ Отсеян смысловой повтор: "${title}" похожа на "${prev.title}"`);
            return true;
        }
    }
    return false;
}

function sanitizeDescriptionText(desc) {
    let text = stripHtml(desc);
    text = text.replace(/^(?:bfm\.ru|интерфакс|тасс|риа\s+новости|lenta\.ru|rbc\.ru|коммерсантъ|ведомости|бизнес\s+online)\s*[:-]?\s*/gi, "");
    text = text.replace(/\s+(?:интерфакс|тасс|риа|bfm\.ru|astra|rtvi|mash|shot)\b[\s\S]*$/i, "");
    return text.trim();
}

// ============================================================
// URL PROCESSING & GOOGLE NEWS DECODER
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

function isGoogleAsset(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.includes("gstatic") || host.includes("googleusercontent") || host.includes("ggpht");
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

function resolveRelativeUrl(relativeOrFull, baseUrl) {
    if (!relativeOrFull) return null;
    try {
        return new URL(relativeOrFull, baseUrl).href;
    } catch {
        return null;
    }
}

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
                const res = await fetch(pageUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
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
            const candidate = raw.replace(/\\\\u003d/gi, "=").replace(/\\\\u0026/gi, "&").replace(/\\\\\//g, "/");
            if (isHttpUrl(candidate) && !isGoogleNewsUrl(candidate) && !isGoogleAsset(candidate)) {
                return normalizeUrl(candidate);
            }
        }
        return "";
    } catch {
        return "";
    }
}

async function resolveArticleUrl(item) {
    const original = normalizeUrl(item.link);
    if (!isGoogleNewsUrl(original)) return original;
    const decoded = await decodeGoogleNewsArticleUrl(original);
    if (decoded && !isGoogleNewsUrl(decoded)) return decoded;
    return "";
}

// ============================================================
// RSS FETCHING
// ============================================================
function parseRSS(xml, feed) {
    const items = [];
    const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
    const now = Date.now();

    for (const itemXml of matches.slice(0, RSS_LIMIT_PER_FEED)) {
        const titleMatch = itemXml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const linkMatch = itemXml.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
        const descMatch = itemXml.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
        const dateMatch = itemXml.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);

        const title = cleanText(titleMatch?.[1]);
        const link = cleanText(linkMatch?.[1]);
        const pubDateRaw = cleanText(dateMatch?.[1]);
        const pubTimestamp = Date.parse(pubDateRaw) || now;

        if (now - pubTimestamp > MAX_NEWS_AGE_MS) {
            continue;
        }

        if (!title || !link) continue;

        items.push({
            title,
            link,
            description: cleanText(descMatch?.[1]),
            pubDate: pubDateRaw,
            category: feed.category,
            source: feed.category,
        });
    }
    return items;
}

async function loadRSS(feed) {
    try {
        const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12000) });
        if (!res.ok) return [];
        return parseRSS(await res.text(), feed);
    } catch {
        return [];
    }
}

// ============================================================
// MEDIA SIGNATURE VALIDATION
// ============================================================
function validateMediaSignature(bytes, type) {
    if (!bytes || bytes.length < 16) return false;

    const prefixStr = new TextDecoder().decode(bytes.subarray(0, 30)).toLowerCase();
    if (prefixStr.includes("<!doctype") || prefixStr.includes("<html") || prefixStr.includes("<?xml") || prefixStr.includes("{")) {
        console.warn("⚠️ Файл отклонён: получен HTML/текст вместо медиа");
        return false;
    }

    if (type === "image") {
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
            const webpSig = new TextDecoder().decode(bytes.subarray(8, 12));
            if (webpSig === "WEBP") return true;
        }
        return false;
    }

    if (type === "video") {
        const ftyp = new TextDecoder().decode(bytes.subarray(4, 8));
        if (ftyp === "ftyp") return true;
        if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
        return false;
    }

    return false;
}

// ============================================================
// MEDIA DOWNLOADERS
// ============================================================
async function downloadMedia(url, type) {
    if (!url || !isHttpUrl(url) || isGoogleAsset(url)) return null;

    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(type === "video" ? 35000 : 15000) });
        if (!res.ok) return null;

        const buf = new Uint8Array(await res.arrayBuffer());
        const minSize = type === "video" ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
        const maxSize = type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

        if (buf.byteLength < minSize || buf.byteLength > maxSize) return null;
        if (!validateMediaSignature(buf, type)) return null;

        return {
            type,
            bytes: buf,
            contentType: type === "video" ? "video/mp4" : "image/jpeg",
            extension: type === "video" ? "mp4" : "jpg",
        };
    } catch {
        return null;
    }
}

// Извлечение чистого изображения статьи (с защитой от реверсивных атрибутов и плашек)
function extractCleanImage(html, baseUrl) {
    const isStub = (u) => {
        const low = u.toLowerCase();
        return /(?:bfm_share|logo|avatar|1x1|pixel|banner|advert|stub|placeholder|default_og|share_fb|social_preview|interfax_share|interfax.*card|img\.interfax\.ru\/.*card)/i.test(low);
    };

    // 1. Метатег og:image (поддержка любого порядка атрибутов)
    const ogMatch = html.match(/<meta\b[^>]*?(?:property|name)=["']og:image["'][^>]*?content=["']([^"']+)["']/i) ||
                    html.match(/<meta\b[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']og:image["']/i);
    const ogImg = resolveRelativeUrl(ogMatch?.[1], baseUrl);
    if (ogImg && isHttpUrl(ogImg) && !isGoogleAsset(ogImg) && !isStub(ogImg)) {
        return ogImg;
    }

    // 2. Метатег twitter:image
    const twMatch = html.match(/<meta\b[^>]*?(?:property|name)=["']twitter:image(?::src)?["'][^>]*?content=["']([^"']+)["']/i) ||
                    html.match(/<meta\b[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']twitter:image(?::src)?["']/i);
    const twImg = resolveRelativeUrl(twMatch?.[1], baseUrl);
    if (twImg && isHttpUrl(twImg) && !isGoogleAsset(twImg) && !isStub(twImg)) {
        return twImg;
    }

    // 3. Изображения из контента статьи
    for (const m of html.matchAll(/<img\b[^>]*?(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi)) {
        const fullUrl = resolveRelativeUrl(m[1], baseUrl);
        if (fullUrl && isHttpUrl(fullUrl) && !isGoogleAsset(fullUrl) && !isStub(fullUrl)) {
            return fullUrl;
        }
    }
    return null;
}

function isContextMatching(title, context) {
    const titleRoots = extractKeyRoots(title);
    const contextRoots = new Set(extractKeyRoots(context));
    let matched = 0;
    for (const root of titleRoots) {
        if (contextRoots.has(root)) matched++;
    }
    return matched >= 2;
}

async function searchVerifiedTelegramVideo(newsTitle) {
    for (const channel of PUBLIC_TELEGRAM_VIDEO_CHANNELS) {
        try {
            const res = await fetch(`https://t.me/s/${channel}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) continue;
            const html = await res.text();

            const postBlocks = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? [];
            for (const block of postBlocks.slice(-40).reverse()) {
                const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
                const caption = textMatch ? cleanText(textMatch[1]) : "";
                if (!caption || !isContextMatching(newsTitle, caption)) continue;

                const videoMatch = block.match(/https?:\/\/[^"'<>\s]+?\.(?:mp4|mov)(?:\?[^"'<>\s]*)?/i);
                if (videoMatch) {
                    const downloaded = await downloadMedia(videoMatch[0], "video");
                    if (downloaded) {
                        console.log(`✅ Найдено тематическое видео в @${channel}: ${caption.slice(0, 50)}...`);
                        return downloaded;
                    }
                }
            }
        } catch {}
    }
    return null;
}

async function searchWebEyewitnessVideo(newsTitle) {
    const roots = extractKeyRoots(newsTitle).slice(0, 4).join(" ");
    if (!roots) return null;

    const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(roots + " видео")}&hl=ru&gl=RU&ceid=RU:ru`;
    try {
        const res = await fetch(searchUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        const xml = await res.text();
        const items = parseRSS(xml, { category: "ВИДЕО" });

        for (const item of items.slice(0, 3)) {
            const realUrl = await resolveArticleUrl(item);
            if (!realUrl) continue;

            const pageRes = await fetch(realUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!pageRes.ok) continue;
            const pageHtml = await pageRes.text();

            const ogVideoRaw = pageHtml.match(/<meta[^>]+(?:property|name)=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)?.[1];
            const ogVideo = resolveRelativeUrl(ogVideoRaw, realUrl);
            if (ogVideo && isHttpUrl(ogVideo) && !isGoogleAsset(ogVideo) && ogVideo.includes(".mp4")) {
                const downloaded = await downloadMedia(ogVideo, "video");
                if (downloaded) {
                    console.log(`✅ Найдено прямое видео очевидцев: ${ogVideo}`);
                    return downloaded;
                }
            }
        }
    } catch {}
    return null;
}

// ============================================================
// EDITORIAL & AI
// ============================================================
const TRIVIAL_GARBAGE = [
    /(?:сарай|баня|гараж|мусор|трава|бытовка)\s+(?:сгорел|загорел)/i,
    /(?:столкнулись\s+(?:две|три)\s+легковушки|мелкое\s+дтп|притерлись)/i,
    /(?:гороскоп|курс\s+валют|погода\s+на|афиша|обзор\s+цен|как\s+сэкономить)/i,
    /(?:что\s+пишут\s+мировые\s+сми|дайджест|главное\s+к\s+этому\s+часу|обзор\s+прессы|картина\s+дня|главные\s+новости\s+к)/i,
];

function evaluateNewsItem(item) {
    const text = normalizeForHash(`${item.title} ${item.description}`);
    if (TRIVIAL_GARBAGE.some((p) => p.test(text))) return { item, score: -100, urgent: false };

    let score = 20;
    let urgent = false;

    if (/(?:путин|госдума|указ|закон|взрыв|атака|крушение|катастрофа|чп|эвакуация|землетрясение|теракт|танкер|трамп|бпла|сбой|яндекс|фсб)/i.test(text)) {
        score += 50;
        urgent = true;
    }

    if (/(?:видео|кадры|момент|очевидцы|появились\s+кадры)/i.test(text)) {
        score += 40;
    }

    return { item, score, urgent };
}

async function callAI(item) {
    const sanitizedDesc = sanitizeDescriptionText(item.description);
    const prompt = `
Ты редактор топового Telegram-канала новостей в формате «Прямой эфир».
Сделай пост строго по новости:
ЗАГОЛОВОК: ${item.title}
СУТЬ: ${sanitizedDesc}

СТРОГИЕ ПРАВИЛА:
1. ОДИН ПОСТ = ОДНО СОБЫТИЕ. Удали чужие бренды СМИ ("Интерфакс", "BFM", "БИЗНЕС Online", "ТАСС").
2. Заголовок (headline): короткий, мощный, передаёт суть только одного события.
3. Текст (text): строго 1–2 динамичных предложения.
Верни ТОЛЬКО JSON: {"headline": "...", "text": "..."}
`;

    if (GEMINI_API_KEY) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }),
                signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
                const data = await res.json();
                const parsed = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
                if (parsed.headline && parsed.text) return parsed;
            }
        } catch {}
    }

    if (DASHSCOPE_API_KEY) {
        try {
            const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DASHSCOPE_API_KEY}` },
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
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.headline && parsed.text) return parsed;
                }
            }
        } catch {}
    }

    const cleanHeadline = stripHtml(item.title).replace(/\s+-\s+.*$/, "").replace(/^«\vert{}»$/g, "");
    const firstSentence = sanitizedDesc.split(/[.!?]\s/)[0] || sanitizedDesc;

    return {
        headline: cleanHeadline,
        text: firstSentence.slice(0, 180) + ".",
    };
}

// ============================================================
// MAX API
// ============================================================
async function maxFetch(path, options = {}) {
    if (!MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN missing");
    const headers = new Headers(options.headers ?? {});
    headers.set("Authorization", MAX_BOT_TOKEN);
    headers.set("Accept", "application/json");

    const client = await initMaxHttpClient();
    return await fetch(`${MAX_API}${path}`, { ...options, client: client ?? undefined, headers });
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
    if (!token) throw new Error("Не получен токен медиа от MAX");
    return token;
}

async function publishToMax(text, mediaToken = null, mediaType = "image") {
    if (!TARGET_CHAT_ID) throw new Error("TARGET_CHAT_ID missing");
    const body = { text, format: "html", notify: true, disable_link_preview: true };
    if (mediaToken) body.attachments = [{ type: mediaType, payload: { token: mediaToken } }];

    const res = await maxFetch(`/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ошибка MAX: ${res.status}`);
    return await res.json();
}

function buildPostMessage(headline, text, sourceUrl, sourceName) {
    const parts = [`<b>${escapeHtml(headline)}</b>`, "", escapeHtml(text)];
    if (sourceUrl && isHttpUrl(sourceUrl) && !isGoogleNewsUrl(sourceUrl)) {
        parts.push("", `🔗 <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceName || "Источник")}</a>`);
    }
    parts.push("", "⚡ <i>ФАКТОР</i>");
    return parts.join("\n");
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function run() {
    console.log("=== Запуск новостного пайплайна ФАКТОР (Live Speed v15) ===");
    const now = Date.now();

    const lastUrgent = (await kv.get(["factor", "last_urgent"])).value ?? 0;
    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;

    const urgentAllowed = now - lastUrgent >= URGENT_INTERVAL_MS;
    const regularAllowed = now - lastRegular >= REGULAR_INTERVAL_MS;

    console.log(`Таймеры вещания: Молния=${urgentAllowed}, Обычные=${regularAllowed}`);
    if (!urgentAllowed && !regularAllowed) {
        console.log("Интервал между публикациями ещё не истёк.");
        return;
    }

    const feedsData = await Promise.all(RSS_FEEDS.map(loadRSS));
    const allItems = feedsData.flat().slice(0, MAX_RSS_ITEMS);

    const evaluated = allItems
        .map(evaluateNewsItem)
        .filter((c) => c.score > 0)
        .filter((c) => (c.urgent ? urgentAllowed : regularAllowed));

    const freshCandidates = [];
    for (const cand of evaluated) {
        const itemHash = await sha256(normalizeForHash(cand.item.title));
        const alreadyPub = await kv.get(["factor", "published", itemHash]);
        if (alreadyPub.value) continue;

        const isDuplicateTopic = await isSemanticallyDuplicate(cand.item.title);
        if (isDuplicateTopic) continue;

        freshCandidates.push({ ...cand, hash: itemHash });
        if (freshCandidates.length >= 25) break;
    }

    freshCandidates.sort((a, b) => b.score - a.score);

    for (const { item, urgent, hash } of freshCandidates) {
        console.log(`\nОбработка: ${item.title}`);
        const realArticleUrl = await resolveArticleUrl(item);
        let selectedMedia = null;
        let articleHtml = "";

        // 1. Загрузка страницы статьи для анализа
        if (realArticleUrl) {
            try {
                const res = await fetch(realArticleUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
                if (res.ok) {
                    articleHtml = await res.text();
                }
            } catch {}
        }

        // 2. ПРИОРИТЕТ: Главное фото статьи (og:image, twitter:image, контентные фото)
        if (articleHtml && realArticleUrl) {
            const photoUrl = extractCleanImage(articleHtml, realArticleUrl);
            if (photoUrl) {
                selectedMedia = await downloadMedia(photoUrl, "image");
                if (selectedMedia) {
                    console.log(`✅ Захвачено главное фото статьи: ${photoUrl}`);
                }
            }
        }

        // 3. Если фото статьи не нашлось — проверяем проверенные Telegram-каналы на точное совпадение темы
        if (!selectedMedia) {
            const tgVideo = await searchVerifiedTelegramVideo(item.title);
            if (tgVideo) {
                selectedMedia = tgVideo;
            }
        }

        // 4. Если медиа всё ещё нет — проверяем видео очевидцев через прямой поиск
        if (!selectedMedia) {
            const webVideo = await searchWebEyewitnessVideo(item.title);
            if (webVideo) {
                selectedMedia = webVideo;
            }
        }

        // 5. Текст поста
        const postData = await callAI(item);
        const postText = buildPostMessage(postData.headline, postData.text, realArticleUrl, item.source);

        try {
            let mediaToken = null;
            if (selectedMedia) {
                console.log(`Загрузка медиа (${selectedMedia.type}, ${selectedMedia.bytes.byteLength} байт)...`);
                mediaToken = await uploadMediaToMax(selectedMedia);
            }

            console.log("Публикация в MAX...");
            await publishToMax(postText, mediaToken, selectedMedia?.type || "image");

            await kv.set(["factor", "published", hash], true, { expireIn: HISTORY_TTL_MS });
            await kv.set(
                ["factor", "published_topic", hash],
                { title: item.title, roots: extractKeyRoots(item.title) },
                { expireIn: HISTORY_TTL_MS }
            );

            if (urgent) await kv.set(["factor", "last_urgent"], now);
            else await kv.set(["factor", "last_regular"], now);

            console.log(`✅ Успешно опубликовано: ${postData.headline}`);
            return;
        } catch (err) {
            console.error("Ошибка при публикации с медиа, пробуем чистый текст:", err);
            try {
                await publishToMax(postText);
                await kv.set(["factor", "published", hash], true, { expireIn: HISTORY_TTL_MS });
                await kv.set(
                    ["factor", "published_topic", hash],
                    { title: item.title, roots: extractKeyRoots(item.title) },
                    { expireIn: HISTORY_TTL_MS }
                );

                if (urgent) await kv.set(["factor", "last_urgent"], now);
                else await kv.set(["factor", "last_regular"], now);
                console.log(`✅ Опубликовано текстом: ${postData.headline}`);
                return;
            } catch (textErr) {
                console.error("Критическая ошибка публикации текста:", textErr);
            }
        }
    }

    console.log("Подходящих новых событий в этом цикле нет.");
}

await run();
