// ============================================================
// MAX NEWS AGENT — ФАКТОР (Direct Live Edition v3)
// GITHUB ACTIONS RUNTIME
// ============================================================
// Динамическая сетка:
//   - Срочные / Резонансные (Молнии): каждые 5-7 минут
//   - Обычные новости: раз в 25-30 минут (макс 3 поста в час)
//   - Приоритет медиа: ТОЧНОЕ ВИДЕО -> ФОТО -> ТЕКСТ
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

// Интервалы вещания «Прямого эфира»
const URGENT_INTERVAL_MS = 5 * 60 * 1000;      // 5 минут для молний / резонанса
const REGULAR_INTERVAL_MS = 25 * 60 * 1000;    // 25 минут для обычной повестки
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_VIDEO_BYTES = Number(Deno.env.get("MAX_VIDEO_MB") ?? "50") * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(Deno.env.get("MAX_IMAGE_MB") ?? "15") * 1024 * 1024;

const RSS_LIMIT_PER_FEED = 35;
const MAX_RSS_ITEMS = 350;
const SCORE_CANDIDATES = 25;

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
// STATE STORAGE (GitHub Actions persistent state)
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
            .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)));
    }
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

// Извлечение ключевых корней для сверки видео
function extractKeyRoots(text) {
    const stopWords = new Set(["россия", "москва", "сегодня", "вчера", "стало", "известно", "сообщили", "после", "время", "видео", "кадры", "новость", "своей"]);
    return normalizeForHash(text)
        .split(" ")
        .filter((w) => w.length >= 4 && !stopWords.has(w))
        .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}

// ============================================================
// RSS PARSER
// ============================================================
function parseRSS(xml, feed) {
    const items = [];
    const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
    for (const itemXml of matches.slice(0, RSS_LIMIT_PER_FEED)) {
        const titleMatch = itemXml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const linkMatch = itemXml.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
        const descMatch = itemXml.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
        const dateMatch = itemXml.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);

        const title = cleanText(titleMatch?.[1]);
        const link = cleanText(linkMatch?.[1]);
        if (!title || !link) continue;

        items.push({
            title,
            link,
            description: cleanText(descMatch?.[1]),
            pubDate: cleanText(dateMatch?.[1]),
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
// MEDIA DOWNLOAD (FFmpeg & Direct MP4)
// ============================================================
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
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (type === "video" && /\.m3u8(?:[?#]|$)/i.test(url)) return await downloadHlsVideo(url);

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

// ============================================================
// ВАЛИДАЦИЯ ВИДЕО (Защита от чужих роликов)
// ============================================================
async function verifyMediaRelevance(newsTitle, mediaCaption) {
    const newsRoots = extractKeyRoots(newsTitle);
    const mediaRoots = new Set(extractKeyRoots(mediaCaption));
    let matches = 0;
    for (const root of newsRoots) {
        if (mediaRoots.has(root)) matches++;
    }

    // Если нет даже 1 прямого совпадения ключевых корней — видео чужое
    if (matches < 1) return false;

    // Контрольная проверка смысла через Gemini
    if (GEMINI_API_KEY) {
        try {
            const prompt = `Ответь ТОЛЬКО "YES" или "NO". Относится ли видео с подписью "${mediaCaption.slice(0, 300)}" к новости "${newsTitle}"?`;
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
                signal: AbortSignal.timeout(8000),
            });
            if (res.ok) {
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
                return text === "YES";
            }
        } catch {}
    }

    return matches >= 2;
}

async function searchVerifiedTelegramVideo(newsTitle) {
    for (const channel of PUBLIC_TELEGRAM_VIDEO_CHANNELS) {
        try {
            const res = await fetch(`https://t.me/s/${channel}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) continue;
            const html = await res.text();

            const postBlocks = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? [];
            for (const block of postBlocks.slice(-15).reverse()) {
                const textMatch = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
                const caption = textMatch ? cleanText(textMatch[1]) : "";
                if (!caption) continue;

                // Строгая проверка темы
                const isRelevant = await verifyMediaRelevance(newsTitle, caption);
                if (!isRelevant) continue;

                const videoMatch = block.match(/https?:\/\/[^"'<>\s]+?\.(?:mp4|mov)(?:\?[^"'<>\s]*)?/i);
                if (videoMatch) {
                    const downloaded = await downloadMedia(videoMatch[0], "video");
                    if (downloaded) {
                        console.log(`✅ Найдено подтверждённое видео (@${channel}): ${caption.slice(0, 50)}...`);
                        return downloaded;
                    }
                }
            }
        } catch {}
    }
    return null;
}

// ============================================================
// СКОРИНГ И ОПРЕДЕЛЕНИЕ СРОЧНОСТИ
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

    // Маркеры срочности (Молния)
    if (/(?:путин|госдума|указ|закон|взрыв|атака|крушение|катастрофа|чп|эвакуация|смерч|землетрясение|теракт)/i.test(text)) {
        score += 50;
        urgent = true;
    }

    // Видео-сигнал повышает рейтинг
    if (/(?:видео|кадры|момент|очевидцы|появились\s+кадры)/i.test(text)) {
        score += 40;
    }

    return { item, score, urgent };
}

// ============================================================
// AI РЕДАКТОР (Стиль «Прямой эфир»)
// ============================================================
async function callAI(item) {
    const prompt = `
Ты редактор топового Telegram-канала новостей в формате «Прямой эфир».
Сделай пост по новости:
ЗАГОЛОВОК: ${item.title}
ОПИСАНИЕ: ${item.description}

ПРАВИЛА:
1. Заголовок (headline): короткий, цепляющий, передаёт главное событие без кликбейта.
2. Текст (text): строго 1–2 динамичных предложения сути. Без вступительных фраз вроде "как стало известно", "сообщается".
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

    return { headline: stripHtml(item.title), text: stripHtml(item.description || item.title) };
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
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
        parts.push("", `🔗 <a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceName || "Источник")}</a>`);
    }
    parts.push("", "⚡ <i>ФАКТОР</i>");
    return parts.join("\n");
}

// ============================================================
// MAIN PIPELINE
// ============================================================
async function run() {
    console.log("=== Запуск новостного пайплайна ФАКТОР (Сетка «Прямого эфира») ===");
    const now = Date.now();

    // Проверка интервалов вещания
    const lastUrgent = (await kv.get(["factor", "last_urgent"])).value ?? 0;
    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;

    const urgentAllowed = now - lastUrgent >= URGENT_INTERVAL_MS;
    const regularAllowed = now - lastRegular >= REGULAR_INTERVAL_MS;

    console.log(`Интервалы: Молния доступна=${urgentAllowed}, Обычные новости доступны=${regularAllowed}`);

    if (!urgentAllowed && !regularAllowed) {
        console.log("Интервал между публикациями ещё не истёк. Пропуск запуска.");
        return;
    }

    const feedsData = await Promise.all(RSS_FEEDS.map(loadRSS));
    const allItems = feedsData.flat().slice(0, MAX_RSS_ITEMS);

    const candidates = allItems
        .map(evaluateNewsItem)
        .filter((c) => c.score > 0)
        .filter((c) => (c.urgent ? urgentAllowed : regularAllowed))
        .sort((a, b) => b.score - a.score)
        .slice(0, SCORE_CANDIDATES);

    for (const { item, urgent } of candidates) {
        const itemHash = await sha256(normalizeForHash(item.title));
        const alreadyPub = await kv.get(["factor", "published", itemHash]);
        if (alreadyPub.value) continue;

        console.log(`\nОбработка события (${urgent ? "МОЛНИЯ" : "ОБЫЧНОЕ"}): ${item.title}`);
        let selectedMedia = null;

        // 1. Поиск строго проверенного видео в Telegram
        selectedMedia = await searchVerifiedTelegramVideo(item.title);

        // 2. Если видео не найдено — берём фото со страницы
        if (!selectedMedia) {
            try {
                const res = await fetch(item.link, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
                if (res.ok) {
                    const html = await res.text();
                    const ogImg = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
                    if (ogImg && /^https?:\/\//i.test(ogImg)) {
                        selectedMedia = await downloadMedia(ogImg, "image");
                    }
                }
            } catch {}
        }

        // 3. Формирование поста в стиле «Прямого эфира»
        const postData = await callAI(item);
        const postText = buildPostMessage(postData.headline, postData.text, item.link, item.source);

        try {
            let mediaToken = null;
            if (selectedMedia) {
                console.log(`Загрузка медиа (${selectedMedia.type})...`);
                mediaToken = await uploadMediaToMax(selectedMedia);
            }

            console.log("Публикация в MAX...");
            await publishToMax(postText, mediaToken, selectedMedia?.type || "image");

            // Фиксируем публикацию и обновляем таймеры
            await kv.set(["factor", "published", itemHash], true, { expireIn: HISTORY_TTL_MS });
            if (urgent) {
                await kv.set(["factor", "last_urgent"], now);
            } else {
                await kv.set(["factor", "last_regular"], now);
            }

            console.log(`✅ Опубликовано: ${postData.headline}`);
            return;
        } catch (err) {
            console.error("Ошибка при публикации с медиа, пробуем чистый текст:", err);
            try {
                await publishToMax(postText);
                await kv.set(["factor", "published", itemHash], true, { expireIn: HISTORY_TTL_MS });
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
