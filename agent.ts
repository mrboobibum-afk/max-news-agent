// ============================================================
// MAX NEWS AGENT — «ПРЯМОЙ ЭФИР» (Strict Live Video/Action Edition)
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
const HISTORY_TTL_MS = 72 * 60 * 60 * 1000;

const MIN_IMAGE_BYTES = 15 * 1024;
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

// Оперативные Telegram-каналы (первый приоритет эфира)
const TG_LIVE_CHANNELS = ["shot_shot", "bazabazon", "novosti_efir", "readovkanews", "mash"];

// Вторичные новостные ленты
const NEWS_FEEDS = [
    { name: "РБК", cat: "ГЛАВНОЕ", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
    { name: "Lenta.ru", cat: "ПРОИСШЕСТВИЯ", url: "https://lenta.ru/rss/news" },
    { name: "РИА Новости", cat: "ГЛАВНОЕ", url: "https://ria.ru/export/rss2/archive/index.xml" },
    { name: "Коммерсантъ", cat: "ЭКОНОМИКА", url: "https://www.kommersant.ru/RSS/news.xml" },
];

// СТОП-ЛИСТ СКУЧНЫХ И ПРОТОКОЛЬНЫХ ТЕМ
const BORING_TOPICS = [
    /(?:сесси[яи]|форум|круглый\s+стол|конференци[яи]|совещани[ея]|заседани[ея]|брифинг)/i,
    /(?:рэц|экспортер|клиентск|госуслуг|росреестр|минфин|ведомств)/i,
    /(?:напомнил|отметил|заявил\s+о\s+важности|подчеркнул|выразил\s+надежду)/i,
    /(?:гороскоп|погода|курс\s+валют|скидк|выходн)/i
];

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

function cleanText(val: any): string {
    return String(val ?? "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
        .replace(/&laquo;/gi, "«")
        .replace(/&raquo;/gi, "»")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&nbsp;/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeHtml(val: any): string {
    return String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getRoots(str: string): string[] {
    const stops = new Set(["россия", "москва", "сегодня", "вчера", "сообщили", "после", "видео", "новости", "словам", "данный", "момент", "стало", "известно"]);
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

function isTrashUrl(url: string): boolean {
    const low = url.toLowerCase();
    return (
        low.includes("card") || low.includes("textcard") || low.includes("share") ||
        low.includes("logo") || low.includes("avatar") || low.includes("stub") ||
        low.includes("1x1") || low.includes("pixel") || low.includes(".svg") ||
        low.includes("google") || low.includes("interfax.ru/ftproot")
    );
}

async function downloadBuffer(url: string, isVideo = false): Promise<Uint8Array | null> {
    if (!url || isTrashUrl(url)) return null;
    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(isVideo ? 35000 : 12000) });
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        const min = isVideo ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
        const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (buf.byteLength < min || buf.byteLength > max) return null;

        const head = new TextDecoder().decode(buf.subarray(0, 30)).toLowerCase();
        if (head.includes("<html") || head.includes("<!doctype") || head.includes("<?xml")) return null;

        return buf;
    } catch {
        return null;
    }
}

// ПАРСИНГ ЖИВОГО ЭФИРА ИЗ TELEGRAM
async function fetchTelegramLiveFeed(): Promise<any[]> {
    const liveItems: any[] = [];
    for (const ch of TG_LIVE_CHANNELS) {
        try {
            const res = await fetch(`https://t.me/s/${ch}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;
            const html = await res.text();

            const posts = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? [];
            for (const post of posts.slice(-10).reverse()) {
                const textRaw = cleanText(post.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
                if (!textRaw || textRaw.length < 30 || textRaw.length > 500) continue;

                // Проверка на скучные темы
                if (BORING_TOPICS.some(r => r.test(textRaw))) continue;

                const vMatch = post.match(/https?:\/\/[^"'<>\s]+?\.(?:mp4)(?:\?[^"'<>\s]*)?/i)?.[0];
                const imgMatch = post.match(/background-image:url\('([^']+)'\)/i)?.[1];

                if (vMatch) {
                    liveItems.push({ title: textRaw.slice(0, 80), desc: textRaw, mediaUrl: vMatch, mediaType: "video", sourceName: "Прямой эфир" });
                } else if (imgMatch && !isTrashUrl(imgMatch)) {
                    liveItems.push({ title: textRaw.slice(0, 80), desc: textRaw, mediaUrl: imgMatch, mediaType: "image", sourceName: "Прямой эфир" });
                }
            }
        } catch {}
    }
    return liveItems;
}

async function formatNewsPost(title: string, desc: string): Promise<{ headline: string, text: string }> {
    const prompt = `Ты шеф-редактор телеграм-канала «Прямой эфир».
Сделай яркий, динамичный новостной пост:
ТЕКСТ: ${desc}

СТРОГИЕ ПРАВИЛА:
1. Заголовок (headline): до 6-8 слов, громкий, суть события (без кавычек).
2. Текст (text): строго 1-2 предложения, динамично, факты. Никакой бюрократии.
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
        headline: cleanText(title),
        text: cleanText(desc).slice(0, 150) + ".",
    };
}

async function uploadToMax(bytes: Uint8Array, type: "image" | "video"): Promise<string> {
    const client = await initMaxHttpClient();
    const upInit = await fetch(`${MAX_API}/uploads?type=${type}`, {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Accept": "application/json" },
        client: client ?? undefined,
    });
    const initData = await upInit.json();
    if (!initData.url) throw new Error("Upload URL error");

    const form = new FormData();
    form.append("data", new Blob([bytes], { type: type === "video" ? "video/mp4" : "image/jpeg" }), `file.${type === "video" ? "mp4" : "jpg"}`);

    const res = await fetch(initData.url, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch {}
    return initData.token || json?.token || json?.photos?.[0]?.token || json?.videos?.[0]?.token;
}

async function sendPostToMax(text: string, mediaToken: string, mediaType: "image" | "video") {
    const client = await initMaxHttpClient();
    const body: any = {
        text,
        format: "html",
        notify: true,
        disable_link_preview: true,
        attachments: [{ type: mediaType, payload: { token: mediaToken } }]
    };

    const res = await fetch(`${MAX_API}/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`, {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        client: client ?? undefined,
    });
    return res.ok;
}

async function run() {
    console.log("=== ЭФИР: Сбор экстренных и живых событий ===");
    const now = Date.now();

    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;
    if (now - lastRegular < REGULAR_INTERVAL_MS) {
        console.log("Пауза вещания активна.");
        return;
    }

    // 1. СНАЧАЛА ПРОВЕРЯЕМ ОПЕРАТИВНЫЕ TELEGRAM-КАНАЛЫ (Видео и ЧП)
    const candidates = await fetchTelegramLiveFeed();

    // 2. ЕСЛИ В TG ТИШИНА, СМОТРИМ СМИ (НО С ФИЛЬТРОМ СКУЧНЫХ ТЕМ)
    if (candidates.length === 0) {
        await Promise.all(NEWS_FEEDS.map(async (feed) => {
            try {
                const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
                if (!res.ok) return;
                const xml = await res.text();
                for (const item of (xml.match(/<item[\s\S]*?<\/item>/gi) ?? []).slice(0, 10)) {
                    const title = cleanText(item.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1]);
                    const desc = cleanText(item.match(/<description[\s\S]*?>([\s\S]*?)<\/description>/i)?.[1]);
                    const link = cleanText(item.match(/<link[\s\S]*?>([\s\S]*?)<\/link>/i)?.[1]);
                    const encImg = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1];

                    if (BORING_TOPICS.some(r => r.test(`${title} ${desc}`))) continue;

                    if (title && encImg && !isTrashUrl(encImg)) {
                        candidates.push({ title, desc, mediaUrl: encImg, mediaType: "image", sourceName: feed.name, link });
                    }
                }
            } catch {}
        }));
    }

    // Обработка кандидатов
    for (const item of candidates) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title))))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        if ((await kv.get(["factor", "pub", hash])).value) continue;
        if (await isDuplicate(item.title)) continue;

        console.log(`\nВыбрано событие: ${item.title}`);
        const mediaBytes = await downloadBuffer(item.mediaUrl, item.mediaType === "video");
        if (!mediaBytes) continue;

        const post = await formatNewsPost(item.title, item.desc);
        const postHtml = `<b>${escapeHtml(post.headline)}</b>\n\n${escapeHtml(post.text)}\n\n⚡ <i>ФАКТОР</i>`;

        let token: string | null = null;
        try {
            token = await uploadToMax(mediaBytes, item.mediaType);
        } catch (e) {
            console.error("Ошибка загрузки медиа:", e);
            continue;
        }

        if (!token) continue;

        const sent = await sendPostToMax(postHtml, token, item.mediaType);
        if (sent) {
            console.log(`🔥 ВЫШЛО В ЭФИР (${item.mediaType}): ${post.headline}`);
            await kv.set(["factor", "pub", hash], true, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "topic", hash], { title: item.title, roots: getRoots(item.title) }, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "last_regular"], now);
            return;
        }
    }

    console.log("Подходящих живых событий пока нет.");
}

await run();
