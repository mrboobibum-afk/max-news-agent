// ============================================================
// MAX NEWS AGENT — «ПРЯМОЙ ЭФИР» (Live Video/Action Edition v26)
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const REGULAR_MIN_INTERVAL_MS = 2 * 60 * 1000;
const REGULAR_MAX_INTERVAL_MS = 15 * 60 * 1000;
const MEDIA_PACKET_MAX = 5;
const HISTORY_TTL_MS = 72 * 60 * 60 * 1000;
const MIN_IMPORTANCE_FOR_TEXT_ONLY = 7;
const MIN_IMPORTANCE_WITH_MEDIA = 5;

const MIN_IMAGE_BYTES = 15 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_VIDEO_BYTES = 50 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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

const TG_LIVE_CHANNELS = ["shot_shot", "bazabazon", "novosti_efir", "readovkanews", "mash"];

const NEWS_FEEDS = [
    { name: "РБК", cat: "ГЛАВНОЕ", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
    { name: "Lenta.ru", cat: "ПРОИСШЕСТВИЯ", url: "https://lenta.ru/rss/news" },
    { name: "РИА Новости", cat: "ГЛАВНОЕ", url: "https://ria.ru/export/rss2/archive/index.xml" },
    { name: "Коммерсантъ", cat: "ЭКОНОМИКА", url: "https://www.kommersant.ru/RSS/news.xml" },
];

const BORING_TOPICS = [
    /(?:сесси[яи]|форум|круглый\s+стол|конференци[яи]|совещани[ея]|заседани[ея]|брифинг)/i,
    /(?:рэц|экспортер|клиентск|госуслуг|росреестр|минфин|ведомств)/i,
    /(?:напомнил|отметил|заявил\s+о\s+важности|подчеркнул|выразил\s+надежду)/i,
    /(?:гороскоп|погода|курс\s+валют|скидк|выходн)/i,
    /(?:запускаем|представляем)\s+(?:карту|сервис|бот|приложение|проект|вашему)/i,
    /(?:наш|этот)\s+(?:телеграм[- ]?канал|канал|проект)\s+(?:представля|запуска|открыва)/i,
    /мини[- ]?приложени/i,
    /подписывайтесь\s+(?:на|по)/i,
    /переходите\s+по\s+ссылк/i,
    /скачать\s+(?:бот|приложение|по\s+ссылк)/i,
    /перейти\s+в\s+(?:бот|канал|сервис)/i,
    /подробнее\s+(?:в|по)\s+(?:канале|ссылке|описании)/i,
    /реклама\s*[.:!]/i,
    /промокод/i,
    /по\s+промокоду/i,
    /спецпредложени/i,
    /партнёрск(?:ий|ого)\s+материал/i,
];

class FileKV {
    private file = ".factor-state.json";
    private data: any = null;
    async load() {
        if (this.data) return this.data;
        try { this.data = JSON.parse(await Deno.readTextFile(this.file)); }
        catch { this.data = { version: 1, entries: {} }; }
        return this.data;
    }
    async get(key: any[]) {
        const d = await this.load();
        return { value: d.entries[JSON.stringify(key)]?.value ?? null };
    }
    async set(key: any[], value: any, options: { expireIn?: number } = {}) {
        const d = await this.load();
        d.entries[JSON.stringify(key)] = { key, value, expiresAt: options?.expireIn ? Date.now() + options.expireIn : null };
        await Deno.writeTextFile(this.file, JSON.stringify(d, null, 2) + "\n");
    }
    async getAllTopics() {
        const d = await this.load();
        const now = Date.now();
        const res: any[] = [];
        for (const [k, v] of Object.entries<any>(d.entries)) {
            // Поддерживаем оба формата: новый "topic" и старый "published_topic"
            if ((k.startsWith('["factor","topic",') || k.startsWith('["factor","published_topic",')) && v?.value) {
                if (!v.expiresAt || v.expiresAt > now) res.push(v.value);
            }
        }
        return res;
    }
}
const kv = new FileKV();

function cleanText(val: any): string {
    return String(val ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").replace(/&laquo;/gi, "«").replace(/&raquo;/gi, "»").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function escapeHtml(val: any): string {
    return String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function getRoots(str: string): string[] {
    const stops = new Set(["россия","москва","сегодня","вчера","сообщили","после","видео","новости","словам","данный","момент","стало","известно"]);
    return cleanText(str).toLowerCase().replace(/[^a-zа-я0-9]+/gi, " ").split(" ").filter(w => w.length >= 4 && !stops.has(w)).map(w => w.slice(0, 5));
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
    return low.includes("card")||low.includes("textcard")||low.includes("share")||low.includes("logo")||low.includes("avatar")||low.includes("stub")||low.includes("1x1")||low.includes("pixel")||low.includes(".svg")||low.includes("google")||low.includes("interfax.ru/ftproot");
}
async function downloadBuffer(url: string, isVideo = false): Promise<Uint8Array | null> {
    if (!url || isTrashUrl(url)) return null;
    try {
        const headers: Record<string, string> = { "User-Agent": USER_AGENT };
        if (/telesco\.pe|telegram\.org|cdn.*\.t\.me|t\.me/i.test(url)) {
            headers["Referer"] = "https://t.me/";
            headers["Accept"] = "*/*";
        }
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(isVideo ? 35000 : 12000) });
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        const min = isVideo ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
        const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (buf.byteLength < min || buf.byteLength > max) return null;
        const head = new TextDecoder().decode(buf.subarray(0, 30)).toLowerCase();
        if (head.includes("<html")||head.includes("<!doctype")||head.includes("<?xml")) return null;
        return buf;
    } catch { return null; }
}
function sanitizeRawText(raw: string): string {
    let t = cleanText(raw);
    t = t.replace(/(?:данные|информация|источник|по данным|сообщает|сообщил)\s+(?:shot|mash|baza|база|риа|тасс|чп)[\s\S]*?[.—:]\s*/gi, "");
    t = t.replace(/по\s+нашей\s+информации,?\s*/gi, "");
    t = t.replace(/как\s+стало\s+известно,?\s*/gi, "");
    t = t.replace(/(?:подписывайтесь|подробнее|эксклюзив|видео)\b[\s\S]*$/gi, "");
    t = t.replace(/—\s*данные\s+[A-Za-zА-Яа-я0-9_]+/gi, "");
    return t.trim();
}

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
                if (BORING_TOPICS.some(r => r.test(textRaw))) continue;
                const emojiCount = (textRaw.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
                if (emojiCount > 6 && textRaw.length < 250) continue;
                const videoMatches = [...post.matchAll(/https?:\/\/[^"'<>\s]+?\.(?:mp4)(?:\?[^"'<>\s]*)?/gi)].map(m => m[0]);
                const imageMatches = [...post.matchAll(/background-image:url\('([^']+)'\)/gi)].map(m => m[1]).filter(u => !isTrashUrl(u));
                const sanitized = sanitizeRawText(textRaw);
                const firstSentence = sanitized.split(/[.!?]\s/)[0] || sanitized;
                const mediaUrls = [
                    ...videoMatches.map(mediaUrl => ({ mediaUrl, mediaType: "video" })),
                    ...imageMatches.map(mediaUrl => ({ mediaUrl, mediaType: "image" })),
                ];
                for (const media of mediaUrls) {
                    liveItems.push({ title: firstSentence.slice(0, 90), desc: sanitized, mediaUrl: media.mediaUrl, mediaType: media.mediaType, sourceName: "Прямой эфир" });
                }
            }
        } catch {}
    }
    return liveItems;
}

async function fetchRssFeeds(): Promise<any[]> {
    const items: any[] = [];
    await Promise.all(NEWS_FEEDS.map(async (feed) => {
        try {
            const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) return;
            const xml = await res.text();
            for (const item of (xml.match(/<item[\s\S]*?<\/item>/gi) ?? []).slice(0, 10)) {
                const title = cleanText(item.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1]);
                const desc = cleanText(item.match(/<description[\s\S]*?>([\s\S]*?)<\/description>/i)?.[1]);
                let encImg = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1];
                if (!encImg) {
                    const imgMatch = item.match(/<img[^>]+src=["']([^"']+)["']/i);
                    encImg = imgMatch?.[1];
                }
                if (BORING_TOPICS.some(r => r.test(`${title} ${desc}`))) continue;
                if (title && encImg && !isTrashUrl(encImg)) {
                    items.push({ title, desc, mediaUrl: encImg, mediaType: "image", sourceName: feed.name });
                }
            }
        } catch {}
    }));
    return items;
}

function cutToSentence(text: string, maxLen = 220): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxLen) return trimmed;
    const sub = trimmed.slice(0, maxLen);
    const lastPunct = Math.max(sub.lastIndexOf("."), sub.lastIndexOf("!"), sub.lastIndexOf("?"));
    if (lastPunct > 50) return sub.slice(0, lastPunct + 1);
    const lastSpace = sub.lastIndexOf(" ");
    return (lastSpace > 0 ? sub.slice(0, lastSpace) : sub) + "...";
}

async function formatNewsPost(title: string, desc: string): Promise<{ headline: string, text: string, importance: number, is_ad: boolean }> {
    const cleanDesc = sanitizeRawText(desc);
    const prompt = `Ты шеф-редактор телеграм-канала новостей «Прямой эфир».
Сделай чёткий новостной пост по событию:
ТЕКСТ: ${cleanDesc}

СТРОГИЕ ПРАВИЛА:
1. Заголовок (headline): до 7 слов, громкий, передаёт суть события. Добавь 1-2 подходящих эмодзи (например 🔥, ⚡, 🚨, 💥) в начало или конец заголовка.
2. Текст (text): 2-4 законченных предложения. Добавь контекст: масштаб, детали, последствия. Обязательно закончи мысль точкой. НЕ повторяй слово в слово заголовок.
3. Удали любые упоминания источников ("SHOT", "Mash", "Baza", "по нашей информации").
4. importance — целое число от 1 до 10, насколько событие важно для широкой аудитории:
   10 — экстренно (война, крупный теракт, катастрофа, покушение).
   7-9 — очень важно (крупное ЧП, удар по инфраструктуре, решение власти, массовые жертвы).
   4-6 — заметно, но не срочно.
   1-3 — рутина, протокольные встречи, курьёзы, реклама.
5. is_ad — true, если это реклама, анонс сервиса, промо-пост канала, приглашение подписаться, реклама приложения/бота/канала. false, если это настоящая новость.
Верни ТОЛЬКО JSON: {"headline": "...", "text": "...", "importance": 7, "is_ad": false}`;

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
                if (p.headline && p.text) return { headline: p.headline, text: p.text, importance: Number(p.importance) || 5, is_ad: !!p.is_ad };
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
                    if (p.headline && p.text) return { headline: p.headline, text: p.text, importance: Number(p.importance) || 5, is_ad: !!p.is_ad };
                }
            }
        } catch {}
    }
    const sentences = cleanDesc.split(/(?<=[.!?])\s+/).filter(Boolean);
    const bodyText = sentences.length > 1 ? sentences.slice(1, 3).join(" ") : sentences[0];
    return { headline: cleanText(title).replace(/\s+[-—]\s+.*$/, ""), text: cutToSentence(bodyText || cleanDesc), importance: 5, is_ad: false };
}

async function uploadToMax(bytes: Uint8Array, type: "image" | "video"): Promise<string> {
    const client = await initMaxHttpClient();
    const upInit = await fetch(`${MAX_API}/uploads?type=${type}`, { method: "POST", headers: { "Authorization": MAX_BOT_TOKEN, "Accept": "application/json" }, client: client ?? undefined });
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

async function sendPostToMax(text: string, media: Array<{ token: string, type: "image" | "video" }>) {
    const client = await initMaxHttpClient();
    const body: any = { text, format: "html", notify: true, disable_link_preview: true, attachments: media.map(item => ({ type: item.type, payload: { token: item.token } })) };
    const res = await fetch(MAX_API + "/messages?chat_id=" + encodeURIComponent(TARGET_CHAT_ID), { method: "POST", headers: { "Authorization": MAX_BOT_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(body), client: client ?? undefined });
    return res.ok;
}

function getMediaPacket(item: any, candidates: any[]): any[] {
    const baseRoots = new Set(getRoots(item.title));
    const scored = candidates.map(candidate => {
        if (!candidate.mediaUrl || isTrashUrl(candidate.mediaUrl)) return { candidate, score: -1 };
        const roots = getRoots(candidate.title);
        const overlap = roots.filter((r: string) => baseRoots.has(r)).length;
        const sameTitle = candidate.title === item.title;
        const score = sameTitle ? 100 : (overlap >= 4 ? overlap * 10 : -1);
        return { candidate, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const packet: any[] = [];
    const seen = new Set<string>();
    for (const { candidate } of scored) {
        if (seen.has(candidate.mediaUrl)) continue;
        seen.add(candidate.mediaUrl);
        packet.push(candidate);
        if (packet.length >= MEDIA_PACKET_MAX) break;
    }
    return packet;
}

async function run() {
    console.log("=== ЭФИР v26: Запуск отбора событий ===");
    const now = Date.now();
    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;
    let nextDelay = (await kv.get(["factor", "next_regular_delay"])).value;
    if (!nextDelay) { nextDelay = REGULAR_MIN_INTERVAL_MS; await kv.set(["factor", "next_regular_delay"], nextDelay); }
    if (now - lastRegular < nextDelay) {
        console.log("Пауза вещания активна: следующая публикация примерно через " + Math.ceil((nextDelay - (now - lastRegular)) / 60000) + " мин.");
        return;
    }

    let candidates = await fetchTelegramLiveFeed();
    if (candidates.length === 0) {
        candidates = await fetchRssFeeds();
    }

    for (const item of candidates) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title)))).map(b => b.toString(16).padStart(2, "0")).join("");
        if ((await kv.get(["factor", "pub", hash])).value) continue;
        if (await isDuplicate(item.title)) continue;

        console.log("\nОбработка: " + item.title);
        const mediaPacket = getMediaPacket(item, candidates);
        const uploaded: Array<{ token: string, type: "image" | "video" }> = [];
        for (const media of mediaPacket) {
            const mediaBytes = await downloadBuffer(media.mediaUrl, media.mediaType === "video");
            if (!mediaBytes) continue;
            try {
                const token = await uploadToMax(mediaBytes, media.mediaType);
                if (token) uploaded.push({ token, type: media.mediaType });
            } catch (e) { console.error("Ошибка загрузки медиа:", e); }
            if (uploaded.length >= MEDIA_PACKET_MAX) break;
        }

        const post = await formatNewsPost(item.title, item.desc);
        const hasMedia = uploaded.length > 0;
        const importance = Number(post.importance) || 5;

        if (post.is_ad) {
            console.log(`Пропуск: реклама/промо (важность ${importance})`);
            continue;
        }

        if (!hasMedia && importance < MIN_IMPORTANCE_FOR_TEXT_ONLY) {
            console.log(`Пропуск: нет медиа, важность ${importance} < ${MIN_IMPORTANCE_FOR_TEXT_ONLY}`);
            continue;
        }

        if (hasMedia && importance < MIN_IMPORTANCE_WITH_MEDIA) {
            console.log(`Пропуск: важность ${importance} < ${MIN_IMPORTANCE_WITH_MEDIA}`);
            continue;
        }

        const postHtml = "<b>" + escapeHtml(post.headline) + "</b>\n\n" + escapeHtml(post.text) + "\n\n⚡ <i>ФАКТОР</i>\n\n#ФАКТОР";
        const sent = await sendPostToMax(postHtml, uploaded);
        if (sent) {
            console.log("🔥 ОПУБЛИКОВАНО (медиа: " + uploaded.length + ", важность: " + importance + "): " + post.headline);
            await kv.set(["factor", "pub", hash], true, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "topic", hash], { title: item.title, roots: getRoots(item.title) }, { expireIn: HISTORY_TTL_MS });
            const nextDelay = Math.floor(REGULAR_MIN_INTERVAL_MS + Math.random() * (REGULAR_MAX_INTERVAL_MS - REGULAR_MIN_INTERVAL_MS + 1));
            await kv.set(["factor", "next_regular_delay"], nextDelay);
            await kv.set(["factor", "last_regular"], now);
            return;
        }
    }
    console.log("Подходящих событий пока нет.");
}

await run();
