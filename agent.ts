// ============================================================
// MAX NEWS AGENT — ФАКТОР (Universal Video Edition v7)
// GITHUB ACTIONS RUNTIME
// ============================================================
// Особенности:
//   - Загрузка видео через yt-dlp (VK, RuTube, СМИ, открытый веб)
//   - Глубокий поиск видео в публичных Telegram-каналах (до 40 постов)
//   - Жёсткий фильтр возраста новостей (не старше 12 часов)
//   - Сетка вещания: 3 мин (молнии), 8 мин (обычные)
//   - Приоритет медиа: ВИДЕО (yt-dlp / прямые ссылки) -> ФОТО -> ТЕКСТ
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const URGENT_INTERVAL_MS = 3 * 60 * 1000;      // 3 минуты для молний
const REGULAR_INTERVAL_MS = 8 * 60 * 1000;     // 8 минут для обычной повестки
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NEWS_AGE_MS = 12 * 60 * 60 * 1000;   // Отсекать новости старше 12 часов

const MAX_VIDEO_BYTES = Number(Deno.env.get("MAX_VIDEO_MB") ?? "50") * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(Deno.env.get("MAX_IMAGE_MB") ?? "15") * 1024 * 1024;

const RSS_LIMIT_PER_FEED = 40;
const MAX_RSS_ITEMS = 400;

const PUBLIC_TELEGRAM_VIDEO_CHANNELS = (Deno.env.get("PUBLIC_TELEGRAM_VIDEO_CHANNELS") ?? "shot_shot,mash,breakingmash,bazabazon,novosti_efir")
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
    { category: "РОССИЯ", emoji: "🇷🇺", url: "https://news.google.com/rss/search?q=Россия+OR+Москва+OR+Петербург&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "МИР", emoji: "🌍", url: "https://news.google.com/rss/search?q=world+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ТЕХНОЛОГИИ", emoji: "💻", url: "https://news.google.com/rss/search?q=технологии+OR+ИИ+OR+роботы+OR+космос&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ИНЦИДЕНТЫ", emoji: "🚨", url: "https://news.google.com/rss/search?q=ЧП+OR+крушение+OR+стихия+OR+спасение&hl=ru&gl=RU&ceid=RU:ru" },
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
        .replace(/<!\[CDATA\[/gi, "")         .replace(/\]\]>/gi, "")
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
    const stopWords = new Set(["россия", "москва", "сегодня", "вчера", "стало", "известно", "сообщили", "после", "видео", "кадры", "новость", "своей"]);
    return normalizeForHash(text)
        .split(" ")
        .filter((w) => w.length >= 4 && !stopWords.has(w))
        .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
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

        // Отсекаем новости старше 12 часов
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
// YT-DLP & DIRECT VIDEO DOWNLOADER
// ============================================================
// Загрузка через yt-dlp для любых платформ (VK, RuTube, СМИ, плееры)
async function downloadWithYtDlp(targetUrl) {
    if (!isHttpUrl(targetUrl) || isGoogleAsset(targetUrl)) return null;
    let tempPath = "";
    try {
        tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
        const command = new Deno.Command("yt-dlp", {
            args: [
                "--no-warnings",
                "--quiet",
                "-f", "mp4/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "--max-filesize", `${MAX_VIDEO_BYTES}`,
                "-o", tempPath,
                targetUrl,
            ],
            stdout: "null",
            stderr: "piped",
        });

        const res = await command.output();
        if (!res.success) return null;

        const stat = await Deno.stat(tempPath);
        if (!stat.size || stat.size > MAX_VIDEO_BYTES) return null;

        return {
            type: "video",
            bytes: await Deno.readFile(tempPath),
            contentType: "video/mp4",
            extension: "mp4",
            sourceUrl: targetUrl,
        };
    } catch {
        return null;
    } finally {
        if (tempPath) {
            try { await Deno.remove(tempPath); } catch {}
        }
    }
}

// Загрузка HLS потоков через ffmpeg
async function downloadHlsVideo(url) {
    let tempPath = "";
    try {
        tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
        const command = new Deno.Command("ffmpeg", {
            args: ["-hide_banner", "-loglevel", "error", "-y", "-user_agent", USER_AGENT, "-i", url, "-t", "90", "-c", "copy", "-movflags", "+faststart", tempPath],
            stdout: "null",
            stderr: "piped",
        });
        const res = await command.output();
        if (!res.success) return null;

        const stat = await Deno.stat(tempPath);
        if (!stat.size || stat.size > MAX_VIDEO_BYTES) return null;

        return { type: "video", bytes: await Deno.readFile(tempPath), contentType: "video/mp4", extension: "mp4" };
    } catch {
        return null;
    } finally {
        if (tempPath) {
            try { await Deno.remove(tempPath); } catch {}
        }
    }
}

async function downloadMedia(url, type) {
    if (!url || !isHttpUrl(url) || isGoogleAsset(url)) return null;

    if (type === "video") {
        if (/\.m3u8(?:[?#]|$)/i.test(url)) return await downloadHlsVideo(url);
        // Пробуем универсальный загрузчик yt-dlp для любых веб-плееров
        const ytdlpResult = await downloadWithYtDlp(url);
        if (ytdlpResult) return ytdlpResult;
    }

    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(type === "video" ? 35000 : 15000) });
        if (!res.ok) return null;

        const buf = new Uint8Array(await res.arrayBuffer());
        const limit = type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (buf.byteLength === 0 || buf.byteLength > limit) return null;

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

function extractVideoFromArticleHtml(html) {
    const directMatches = [];
    for (const m of html.matchAll(/<(?:video|source)\b[^>]*?(?:src|data-src|data-video)=["']([^"']+)["']/gi)) {
        const u = m[1];
        if (isHttpUrl(u) && !isGoogleAsset(u)) directMatches.push(u);
    }
    const ogVideo = html.match(/<meta[^>]+(?:property|name)=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)?.[1];
    if (ogVideo && isHttpUrl(ogVideo) && !isGoogleAsset(ogVideo)) directMatches.push(ogVideo);

    for (const m of html.matchAll(/["'](?:video_url|videoUrl|file|stream|hls|m3u8)["']\s*:\s*["']([^"']+)["']/gi)) {
        const u = m[1].replace(/\\\//g, "/");
        if (isHttpUrl(u) && !isGoogleAsset(u)) directMatches.push(u);
    }

    return directMatches.filter((u) => u.includes(".mp4") || u.includes(".m3u8") || u.includes("vk.com") || u.includes("rutube.ru"));
}

// ============================================================
// MEDIA RELEVANCE CHECK (Поиск в публичных Telegram-каналах)
// ============================================================
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

            // Проверяем последние 40 постов
            const postBlocks = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? [];
            for (const block of postBlocks.slice(-40).reverse()) {
                const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
                const caption = textMatch ? cleanText(textMatch[1]) : "";
                if (!caption || !isContextMatching(newsTitle, caption)) continue;

                const videoMatch = block.match(/https?:\/\/[^"'<>\s]+?\.(?:mp4|mov)(?:\?[^"'<>\s]*)?/i);
                if (videoMatch) {
                    const downloaded = await downloadMedia(videoMatch[0], "video");
                    if (downloaded) {
                        console.log(`✅ Найдено видео в @${channel}: ${caption.slice(0, 50)}...`);
                        return downloaded;
                    }
                }
            }
        } catch {}
    }
    return null;
}

// ============================================================
// EDITORIAL & AI (Формат «Прямой эфир»)
// ============================================================
const TRIVIAL_GARBAGE = [
    /(?:сарай|баня|гараж|мусор|трава|бытовка)\s+(?:сгорел|загорел)/i,
    /(?:столкнулись\s+(?:две|три)\s+легковушки|мелкое\s+дтп|притерлись)/i,
    /(?:гороскоп|курс\s+валют|погода\s+на|афиша|обзор\s+цен|как\s+сэкономить)/i,
];

function evaluateNewsItem(item) {
    const text = normalizeForHash(`${item.title} ${item.description}`);
    if (TRIVIAL_GARBAGE.some((p) => p.test(text))) return { item, score: -100, urgent: false };

    let score = 20;
    let urgent = false;

    if (/(?:путин|госдума|указ|закон|взрыв|атака|крушение|катастрофа|чп|эвакуация|землетрясение|теракт|танкер)/i.test(text)) {
        score += 50;
        urgent = true;
    }

    if (/(?:видео|кадры|момент|очевидцы|появились\s+кадры)/i.test(text)) {
        score += 40;
    }

    return { item, score, urgent };
}

async function callAI(item) {
    const prompt = `
Ты редактор топового Telegram-канала новостей в формате «Прямой эфир».
Сделай пост строго по новости:
ЗАГОЛОВОК: ${item.title}
СУТЬ: ${item.description}

ПРАВИЛА:
1. Заголовок (headline): короткий, мощный, передаёт суть события.
2. Текст (text): строго 1–2 динамичных предложения. Никаких водных фраз ("как стало известно", "сообщается") и списков.
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

    return {
        headline: stripHtml(item.title).replace(/\s+-\s+.*$/, ""),
        text: stripHtml(item.description).slice(0, 250) + "…",
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
    console.log("=== Запуск новостного пайплайна ФАКТОР (Live Speed v7) ===");
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
        if (!alreadyPub.value) {
            freshCandidates.push({ ...cand, hash: itemHash });
        }
        if (freshCandidates.length >= 25) break;
    }

    freshCandidates.sort((a, b) => b.score - a.score);

    for (const { item, urgent, hash } of freshCandidates) {
        console.log(`\nОбработка: ${item.title}`);
        const realArticleUrl = await resolveArticleUrl(item);
        let selectedMedia = null;

        // 1. Поиск видео на странице статьи (прямые ссылки или yt-dlp)
        if (realArticleUrl) {
            try {
                const res = await fetch(realArticleUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
                if (res.ok) {
                    const html = await res.text();
                    const articleVideos = extractVideoFromArticleHtml(html);
                    for (const vUrl of articleVideos) {
                        const downloaded = await downloadMedia(vUrl, "video");
                        if (downloaded) {
                            console.log(`✅ Найдено видео на сайте СМИ: ${vUrl}`);
                            selectedMedia = downloaded;
                            break;
                        }
                    }

                    // Если видео нет, пробуем получить исходную страницу через yt-dlp напрямую
                    if (!selectedMedia) {
                        const directPageVideo = await downloadWithYtDlp(realArticleUrl);
                        if (directPageVideo) {
                            console.log(`✅ yt-dlp извлек видео со страницы статьи`);
                            selectedMedia = directPageVideo;
                        }
                    }

                    // Если видео так и не найдено, сохраняем фото статьи
                    if (!selectedMedia) {
                        const ogImg = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
                        if (ogImg && isHttpUrl(ogImg) && !isGoogleAsset(ogImg)) {
                            selectedMedia = await downloadMedia(ogImg, "image");
                        }
                    }
                }
            } catch {}
        }

        // 2. Глубокий поиск видео очевидцев в Telegram
        if (!selectedMedia || selectedMedia.type !== "video") {
            const tgVideo = await searchVerifiedTelegramVideo(item.title);
            if (tgVideo) {
                selectedMedia = tgVideo;
            }
        }

        // 3. Формирование текста поста
        const postData = await callAI(item);
        const postText = buildPostMessage(postData.headline, postData.text, realArticleUrl, item.source);

        try {
            let mediaToken = null;
            if (selectedMedia) {
                console.log(`Загрузка медиа (${selectedMedia.type})...`);
                mediaToken = await uploadMediaToMax(selectedMedia);
            }

            console.log("Публикация в MAX...");
            await publishToMax(postText, mediaToken, selectedMedia?.type || "image");

            await kv.set(["factor", "published", hash], true, { expireIn: HISTORY_TTL_MS });
            if (urgent) await kv.set(["factor", "last_urgent"], now);
            else await kv.set(["factor", "last_regular"], now);

            console.log(`✅ Успешно опубликовано: ${postData.headline}`);
            return;
        } catch (err) {
            console.error("Ошибка при публикации с медиа, пробуем чистый текст:", err);
            try {
                await publishToMax(postText);
                await kv.set(["factor", "published", hash], true, { expireIn: HISTORY_TTL_MS });
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
