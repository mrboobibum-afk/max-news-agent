// ============================================================
// MAX NEWS AGENT — «ПРЯМОЙ ЭФИР» / ФАКТОР v18
// ПОЛНЫЙ МУЛЬТИСОРСИНГ ПО ВСЕМ СМИ РФ И TELEGRAM
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const URGENT_INTERVAL_MS = 2 * 60 * 1000;
const REGULAR_INTERVAL_MS = 4 * 60 * 1000;
const HISTORY_TTL_MS = 48 * 60 * 60 * 1000;

const MIN_IMAGE_BYTES = 5 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_VIDEO_BYTES = 50 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Сертификаты Минцифры РФ для MAX
const MAX_ROOT_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";
const MAX_SUB_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";
let maxHttpClient: Deno.HttpClient | null = null;

async function initMaxHttpClient() {
    if (maxHttpClient) return maxHttpClient;
    try {
        const [r1, r2] = await Promise.all([
            fetch(MAX_ROOT_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) }),
            fetch(MAX_SUB_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) }),
        ]);
        if (r1.ok && r2.ok) {
            maxHttpClient = Deno.createHttpClient({ caCerts: [await r1.text(), await r2.text()] });
        }
    } catch {}
    return maxHttpClient;
}

// ------------------------------------------------------------
// ШИРОКАЯ СЕТЬ ИСТОЧНИКОВ (ПРЯМЫЕ ЛЕНТЫ РФ + ТЕМАТИЧЕСКИЕ ПОТОКИ)
// ------------------------------------------------------------
const DIRECT_FEEDS = [
    // Федеральные первоисточники
    { name: "РИА Новости", cat: "ГЛАВНОЕ", url: "https://ria.ru/export/rss2/archive/index.xml" },
    { name: "ТАСС", cat: "ГЛАВНОЕ", url: "https://tass.ru/rss/v2.xml" },
    { name: "РБК", cat: "ГЛАВНОЕ", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
    { name: "Lenta.ru", cat: "РОССИЯ", url: "https://lenta.ru/rss/news" },
    { name: "Коммерсантъ", cat: "ЭКОНОМИКА", url: "https://www.kommersant.ru/RSS/news.xml" },
    { name: "Известия", cat: "ГЛАВНОЕ", url: "https://iz.ru/xml/rss/all.xml" },
    { name: "Интерфакс", cat: "ГЛАВНОЕ", url: "https://www.interfax.ru/rss.asp" },
    { name: "BFM.ru", cat: "ЭКОНОМИКА", url: "https://www.bfm.ru/news.rss" },
    // Потоки инцидентов и ЧП
    { name: "ЧП и Происшествия", cat: "ИНЦИДЕНТЫ", url: "https://news.google.com/rss/search?q=ЧП+OR+БПЛА+OR+пожар+OR+взрыв+OR+МЧС&hl=ru&gl=RU&ceid=RU:ru" },
    // Технологии и наука
    { name: "Технологии", cat: "ТЕХНОЛОГИИ", url: "https://news.google.com/rss/search?q=технологии+OR+гаджеты+OR+наука+OR+космос&hl=ru&gl=RU&ceid=RU:ru" },
    // Международка
    { name: "Мир", cat: "МИР", url: "https://news.google.com/rss/search?q=мир+OR+США+OR+Китай+OR+переговоры&hl=ru&gl=RU&ceid=RU:ru" },
];

// Оперативные открытые каналы для видеоподтверждений
const TG_PUBLIC_CHANNELS = ["shot_shot", "mash", "breakingmash", "bazabazon", "novosti_efir", "readovkanews", "mchs_official"];

// ------------------------------------------------------------
// БАЗА СОСТОЯНИЯ (Исключение повторов)
// ------------------------------------------------------------
class FileKV {
    private file = ".factor-state.json";
    private data: any = null;

    async load() {
        if (this.data) return this.data;
        try {
            this.data = JSON.parse(await Deno.readTextFile(this.file));
        } catch {
            this.data = { version: 1, entries: {} };
        }
        return this.data;
    }

    async get(key: any[]) {
        const d = await this.load();
        return { value: d.entries[JSON.stringify(key)]?.value ?? null };
    }

    async set(key: any[], value: any, options: { expireIn?: number } = {}) {
        const d = await this.load();
        d.entries[JSON.stringify(key)] = {
            key,
            value,
            expiresAt: options?.expireIn ? Date.now() + options.expireIn : null,
        };
        await Deno.writeTextFile(this.file, JSON.stringify(d, null, 2) + "\n");
    }

    async getAllTopics() {
        const d = await this.load();
        const now = Date.now();
        const res: any[] = [];
        for (const [k, v] of Object.entries<any>(d.entries)) {
            if (k.startsWith('["factor","topic",') && v?.value) {
                if (!v.expiresAt || v.expiresAt > now) res.push(v.value);
            }
        }
        return res;
    }
}

const kv = new FileKV();

// ------------------------------------------------------------
// ОЧИСТКА И ФИЛЬТРАЦИЯ ДУБЛЕЙ
// ------------------------------------------------------------
function cleanText(val: any): string {
    return String(val ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHtml(val: any): string {
    return String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getRoots(str: string): string[] {
    const stops = new Set(["россия", "москва", "сегодня", "вчера", "сообщили", "после", "видео", "новости", "словам", "данный", "момент"]);
    return cleanText(str).toLowerCase().replace(/[^a-zа-я0-9]+/gi, " ").split(" ")
        .filter(w => w.length >= 4 && !stops.has(w))
        .map(w => w.slice(0, 5));
}

async function isDuplicate(title: string): Promise<boolean> {
    const roots = getRoots(title);
    if (!roots.length) return false;
    const past = await kv.getAllTopics();
    for (const item of past) {
        const set = new Set(item.roots || []);
        let match = 0;
        for (const r of roots) if (set.has(r)) match++;
        if (match >= 2) return true;
    }
    return false;
}

// ------------------------------------------------------------
// ИЗВЛЕЧЕНИЕ МЕДИА (ОТОВСЮДУ: СТАТЬИ, ТЕЛЕГРАМ, СЕТЬ)
// ------------------------------------------------------------
async function downloadMediaBuffer(url: string, isVideo = false): Promise<Uint8Array | null> {
    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(isVideo ? 35000 : 12000) });
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        const min = isVideo ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
        const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (buf.byteLength < min || buf.byteLength > max) return null;
        return buf;
    } catch {
        return null;
    }
}

function extractImageFromHtml(html: string, base: string): string | null {
    // 1. Метатеги og:image / twitter:image
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/i)?.[1]
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image(?::src)?)["']/i)?.[1]
           || html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)?.[1];
    
    if (m && !m.includes(".svg")) {
        try { return new URL(m, base).href; } catch {}
    }

    // 2. Теги <img> статьи
    for (const img of html.matchAll(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/gi)) {
        const src = img[1];
        if (src && !src.includes("logo") && !src.includes("avatar") && !src.includes("1x1") && !src.includes(".svg")) {
            try { return new URL(src, base).href; } catch {}
        }
    }
    return null;
}

async function findTelegramMedia(newsTitle: string): Promise<{ bytes: Uint8Array, type: "image" | "video" } | null> {
    const roots = getRoots(newsTitle).slice(0, 3);
    if (!roots.length) return null;

    for (const ch of TG_PUBLIC_CHANNELS) {
        try {
            const res = await fetch(`https://t.me/s/${ch}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;
            const html = await res.text();

            for (const post of (html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? []).slice(-25).reverse()) {
                const text = cleanText(post.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
                let matches = 0;
                for (const r of roots) if (text.toLowerCase().includes(r)) matches++;
                if (matches < 2) continue;

                // Видео в посте
                const vMatch = post.match(/https?:\/\/[^"'<>\s]+?\.(?:mp4)(?:\?[^"'<>\s]*)?/i)?.[0];
                if (vMatch) {
                    const buf = await downloadMediaBuffer(vMatch, true);
                    if (buf) return { bytes: buf, type: "video" };
                }

                // Фото в посте
                const imgMatch = post.match(/background-image:url\('([^']+)'\)/i)?.[1];
                if (imgMatch) {
                    const buf = await downloadMediaBuffer(imgMatch, false);
                    if (buf) return { bytes: buf, type: "image" };
                }
            }
        } catch {}
    }
    return null;
}

// ------------------------------------------------------------
// РЕДАКЦИЯ: ЧИСТЫЙ СТИЛЬ «ПРЯМОЙ ЭФИР»
// ------------------------------------------------------------
async function formatNewsPost(title: string, desc: string): Promise<{ headline: string, text: string }> {
    const cleanDesc = cleanText(desc).replace(/^(?:тасс|риа новости|лента|rbc|коммерсантъ|bfm).*?[-—:]\s*/i, "");
    const prompt = `Ты шеф-редактор канала «Прямой эфир».
Сделай срочную молнию:
НОВОСТЬ: ${title}
ДЕТАЛИ: ${cleanDesc}

СТРОГИЕ ПРАВИЛА:
1. Заголовок (headline): максимум 7-8 слов, громкий, чёткий, суть события.
2. Текст (text): строго 1-2 предложения. Без воды. Удали все упоминания названий СМИ.
Верни ТОЛЬКО JSON: {"headline": "...", "text": "..."}`;

    if (GEMINI_API_KEY) {
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
                signal: AbortSignal.timeout(10000),
            });
            if (r.ok) {
                const j = await r.json();
                const p = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
                if (p.headline && p.text) return p;
            }
        } catch {}
    }

    if (DASHSCOPE_API_KEY) {
        try {
            const r = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DASHSCOPE_API_KEY}` },
                body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
                signal: AbortSignal.timeout(10000),
            });
            if (r.ok) {
                const j = await r.json();
                const match = (j?.choices?.[0]?.message?.content ?? "").match(/\{[\s\S]*\}/);
                if (match) {
                    const p = JSON.parse(match[0]);
                    if (p.headline && p.text) return p;
                }
            }
        } catch {}
    }

    return {
        headline: cleanText(title).replace(/\s+[-—]\s+.*$/, ""),
        text: cleanDesc.slice(0, 160) + ".",
    };
}

// ------------------------------------------------------------
// MAX ПУБЛИКАЦИЯ
// ------------------------------------------------------------
async function uploadToMax(bytes: Uint8Array, type: "image" | "video"): Promise<string> {
    const client = await initMaxHttpClient();
    const upInit = await fetch(`${MAX_API}/uploads?type=${type}`, {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Accept": "application/json" },
        client: client ?? undefined,
    });
    const initData = await upInit.json();
    if (!initData.url) throw new Error("Upload URL not provided by MAX");

    const form = new FormData();
    form.append("data", new Blob([bytes], { type: type === "video" ? "video/mp4" : "image/jpeg" }), `file.${type === "video" ? "mp4" : "jpg"}`);

    const res = await fetch(initData.url, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch {}
    return initData.token || json?.token || json?.photos?.[0]?.token || json?.videos?.[0]?.token;
}

async function sendPostToMax(text: string, mediaToken: string | null, mediaType: "image" | "video") {
    const client = await initMaxHttpClient();
    const body: any = { text, format: "html", notify: true, disable_link_preview: true };
    if (mediaToken) body.attachments = [{ type: mediaType, payload: { token: mediaToken } }];

    const res = await fetch(`${MAX_API}/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`, {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        client: client ?? undefined,
    });
    return res.ok;
}

// ------------------------------------------------------------
// ОСНОВНОЙ ЦИКЛ ПРЯМОГО ЭФИРА
// ------------------------------------------------------------
async function run() {
    console.log("=== ЭФИР: Сбор новостей со всех СМИ и Telegram ===");
    const now = Date.now();

    const lastUrgent = (await kv.get(["factor", "last_urgent"])).value ?? 0;
    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;
    const lastSource = (await kv.get(["factor", "last_source"])).value ?? "";

    if (now - lastUrgent < URGENT_INTERVAL_MS && now - lastRegular < REGULAR_INTERVAL_MS) {
        console.log("Пауза между постами активна.");
        return;
    }

    // 1. Опрашиваем все ленты параллельно
    const allCandidates: any[] = [];
    await Promise.all(DIRECT_FEEDS.map(async (feed) => {
        try {
            const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) return;
            const xml = await res.text();
            for (const item of (xml.match(/<item[\s\S]*?<\/item>/gi) ?? []).slice(0, 15)) {
                const title = cleanText(item.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1]);
                const link = cleanText(item.match(/<link[\s\S]*?>([\s\S]*?)<\/link>/i)?.[1]);
                const desc = cleanText(item.match(/<description[\s\S]*?>([\s\S]*?)<\/description>/i)?.[1]);
                // Прямой захват enclosure картинки из RSS, если есть
                const enclosureImg = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1];

                if (title && link) {
                    allCandidates.push({ title, link, desc, sourceName: feed.name, category: feed.cat, enclosureImg });
                }
            }
        } catch {}
    }));

    // 2. Чередуем источники, чтобы лента была разнородной
    allCandidates.sort(() => Math.random() - 0.5);

    for (const item of allCandidates) {
        // Защита от монополии одного СМИ подряд
        if (item.sourceName === lastSource && allCandidates.length > 5) continue;

        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title))))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        if ((await kv.get(["factor", "pub", hash])).value) continue;
        if (await isDuplicate(item.title)) continue;

        console.log(`\nВыбрано событие: [${item.sourceName}] ${item.title}`);

        let mediaData: { bytes: Uint8Array, type: "image" | "video" } | null = null;

        // ШАГ А: Проверяем оперативное видео/фото в Telegram
        const tgMedia = await findTelegramMedia(item.title);
        if (tgMedia) {
            mediaData = tgMedia;
            console.log(`✅ Найдено оперативное медиа (${mediaData.type}) в Telegram`);
        }

        // ШАГ Б: Если в Telegram нет — берём фото из первоисточника статьи
        if (!mediaData && item.enclosureImg) {
            const b = await downloadMediaBuffer(item.enclosureImg, false);
            if (b) mediaData = { bytes: b, type: "image" };
        }

        if (!mediaData) {
            try {
                const pageRes = await fetch(item.link, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000), redirect: "follow" });
                if (pageRes.ok) {
                    const html = await pageRes.text();
                    const imgUrl = extractImageFromHtml(html, pageRes.url || item.link);
                    if (imgUrl) {
                        const b = await downloadMediaBuffer(imgUrl, false);
                        if (b) mediaData = { bytes: b, type: "image" };
                    }
                }
            } catch {}
        }

        // ШАГ В: В «Прямом эфире» пост без медиа не выходит — пропускаем, если нет картинки
        if (!mediaData) {
            console.log("Нет подтверждённого медиа, переходим к следующему событию...");
            continue;
        }

        // Оформление поста
        const post = await formatNewsPost(item.title, item.desc);
        const postHtml = `<b>${escapeHtml(post.headline)}</b>\n\n${escapeHtml(post.text)}\n\n🔗 <a href="${escapeHtml(item.link)}">${escapeHtml(item.sourceName)}</a>\n\n⚡ <i>ФАКТОР</i>`;

        let token: string | null = null;
        try {
            token = await uploadToMax(mediaData.bytes, mediaData.type);
        } catch (e) {
            console.error("Ошибка аплоада в MAX:", e);
            continue;
        }

        const sent = await sendPostToMax(postHtml, token, mediaData.type);
        if (sent) {
            console.log(`🔥 ОПУБЛИКОВАНО: ${post.headline}`);
            await kv.set(["factor", "pub", hash], true, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "topic", hash], { title: item.title, roots: getRoots(item.title) }, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "last_source"], item.sourceName, { expireIn: 3600 * 1000 });
            await kv.set(["factor", "last_regular"], now);
            return;
        }
    }

    console.log("В этом цикле новых подходящих событий с медиа не появилось.");
}

await run();
