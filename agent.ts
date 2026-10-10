// ============================================================
// MAX NEWS AGENT — «ПРЯМОЙ ЭФИР» (Live Video/Action Edition v29)
// ============================================================

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const REGULAR_MIN_INTERVAL_MS = 3 * 60 * 1000;
const REGULAR_MAX_INTERVAL_MS = 20 * 60 * 1000;
const HARD_MIN_INTERVAL_MS = 3 * 60 * 1000;
const MAX_POST_AGE_MS = 3 * 60 * 60 * 1000;

const MEDIA_PACKET_MAX = 6;
const MIN_IMPORTANCE = 6;
const HISTORY_TTL_MS = 72 * 60 * 60 * 1000;

const MIN_IMAGE_BYTES = 10 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_VIDEO_BYTES = 50 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

const MAX_BODY_LEN = 500;

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

// ДОБАВЛЕНЫ официальные каналы — у них всегда есть медиа к важным новостям.
const TG_LIVE_CHANNELS = [
    "mod_russia",     // Минобороны РФ (официальные сводки)
    "rian_ru",        // РИА Новости
    "tass_agency",    // ТАСС
    "rbc_news",       // РБК
    "shot_shot",      // SHOT
    "bazabazon",      // База
    "readovkanews",   // Readovka
    "mash",           // Mash
];

const NEWS_FEEDS = [
    { name: "РБК", cat: "ГЛАВНОЕ", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
    { name: "Lenta.ru", cat: "ПРОИСШЕСТВИЯ", url: "https://lenta.ru/rss/news" },
    { name: "РИА Новости", cat: "ГЛАВНОЕ", url: "https://ria.ru/export/rss2/archive/index.xml" },
    { name: "Коммерсантъ", cat: "ЭКОНОМИКА", url: "https://www.kommersant.ru/RSS/news.xml" },
];

const BORING_TOPICS = [
    /(?:сесси[яи]|форум|круглый\s+стол|конференци[яи]|совещани[ея]|заседани[ея]|брифинг)/i,
    /(?:рэц|экспортер|клиентск|госуслуг|росреестр|минфин|ведомств)/i,
    /(?:гороскоп|погода|курс\s+валют|скидк|выходн)/i,
    /(?:запускаем|представляем)\s+(?:карту|сервис|бот|приложение|проект)/i,
    /(?:наш|этот)\s+(?:телеграм[- ]?канал|канал|проект)\s+(?:представля|запуска|открыва)/i,
    /мини[- ]?приложени/i,
    /подписывайтесь\s+(?:на|по)/i,
    /переходите\s+по\s+ссылк/i,
    /промокод/i,
    /спецпредложени/i,
    /реклама\s*[.:!]/i,
    /партнёрск(?:ий|ого)\s+материал/i,
    /(?:введены|новые)\s+(?:правила|требования|инструкци|регламент)/i,
    /(?:правила|требования|инструкци|регламент)\s+(?:для|к)\s+(?:постов|новостей|заголовков|текст)/i,
    /(?:заголовок|текст)\s+(?:до|не\s+более)\s+\d+/i,
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

async function isDuplicate(title: string, desc?: string): Promise<boolean> {
    const roots = [...new Set([...getRoots(title), ...(desc ? getRoots(desc) : [])])];
    if (!roots.length) return false;
    const past = await kv.getAllTopics();
    for (const item of past) {
        const set = new Set(item.roots || []);
        let match = 0;
        for (const r of roots) if (set.has(r)) match++;
        const needed = title.length > 60 ? 2 : 1;
        if (match >= needed) return true;
    }
    return false;
}

function isTrashUrl(url: string): boolean {
    const low = url.toLowerCase();
    return (
        low.includes("/card") || low.includes("textcard") || low.includes("share") ||
        low.includes("logo") || low.includes("avatar") || low.includes("stub") ||
        low.includes("1x1") || low.includes("pixel") || low.includes(".svg") ||
        low.includes("google.com") || low.includes("interfax.ru/ftproot")
    );
}

async function downloadBuffer(url: string, isVideo = false): Promise<Uint8Array | null> {
    if (!url || isTrashUrl(url)) return null;
    const strategies: Array<Record<string, string>> = [
        { "User-Agent": USER_AGENT, "Referer": "https://t.me/", "Accept": "*/*" },
        { "User-Agent": USER_AGENT, "Referer": "https://t.me/s/shot_shot", "Accept": "image/*,*/*" },
        { "User-Agent": USER_AGENT, "Referer": "https://t.me/s/mod_russia", "Accept": "image/*,*/*" },
        { "User-Agent": USER_AGENT },
    ];
    for (const headers of strategies) {
        try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(isVideo ? 35000 : 15000) });
            if (!res.ok) continue;
            const buf = new Uint8Array(await res.arrayBuffer());
            const min = isVideo ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
            const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
            if (buf.byteLength < min || buf.byteLength > max) continue;
            const head = new TextDecoder().decode(buf.subarray(0, 30)).toLowerCase();
            if (head.includes("<html") || head.includes("<!doctype") || head.includes("<?xml")) continue;
            return buf;
        } catch { continue; }
    }
    return null;
}

function sanitizeRawText(raw: string): string {
    let t = cleanText(raw);
    t = t.replace(/(?:данные|информация|источник|по данным|сообщает|сообщил)\s+(?:shot|mash|baza|база|риа|тасс|чп)[\s\S]*?[.—:]\s*/gi, "");
    t = t.replace(/по\s+нашей\s+информации,?\s*/gi, "");
    t = t.replace(/как\s+стало\s+известно,?\s*/gi, "");
    t = t.replace(/(?:подписывайтесь|подробнее|эксклюзив)\b[\s\S]*$/gi, "");
    t = t.replace(/—\s*данные\s+[A-Za-zА-Яа-я0-9_]+/gi, "");
    t = t.replace(/📢\s*Прямой Эфир/gi, "");
    t = t.replace(/⚡\s*ФАКТОР/gi, "");
    t = t.replace(/◆\s*Подписаться[\s\S]*$/gi, "");
    return t.trim();
}

function extractPostDate(postHtml: string): number | null {
    const m = postHtml.match(/<time[^>]+datetime=["']([^"']+)["']/i);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return isNaN(t) ? null : t;
}

function simpleHash(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
}

async function fetchTelegramLiveFeed(): Promise<any[]> {
    const liveItems: any[] = [];
    const now = Date.now();
    for (const ch of TG_LIVE_CHANNELS) {
        let found = 0;
        try {
            const res = await fetch(`https://t.me/s/${ch}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) {
                console.log(`  [${ch}] HTTP ${res.status}`);
                continue;
            }
            const html = await res.text();
            const posts = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? [];
            for (const post of posts.slice(-15).reverse()) {
                const postDate = extractPostDate(post);
                if (postDate && (now - postDate) > MAX_POST_AGE_MS) continue;

                const textRaw = cleanText(post.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
                if (!textRaw || textRaw.length < 30 || textRaw.length > 2000) continue;

                if (BORING_TOPICS.some(r => r.test(textRaw))) continue;

                const videoMatches = [...post.matchAll(/https?:\/\/[^"'<>\s]+?\.(?:mp4)(?:\?[^"'<>\s]*)?/gi)].map(m => m[0]);
                const bgImages = [...post.matchAll(/background-image:url\('([^']+)'\)/gi)].map(m => m[1]);
                const imgTags = [...post.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
                const imageMatches = [...bgImages, ...imgTags].filter(u => !isTrashUrl(u));

                const sanitized = sanitizeRawText(textRaw);
                const firstSentence = sanitized.split(/[.!?]\s/)[0] || sanitized;
                const postKey = "tg_" + simpleHash(sanitized);

                const mediaUrls = [
                    ...videoMatches.map(mediaUrl => ({ mediaUrl, mediaType: "video" })),
                    ...imageMatches.map(mediaUrl => ({ mediaUrl, mediaType: "image" })),
                ];

                if (mediaUrls.length === 0) {
                    liveItems.push({ title: firstSentence.slice(0, 90), desc: sanitized, mediaUrl: "", mediaType: "image", sourceName: ch, postKey });
                } else {
                    for (const media of mediaUrls) {
                        liveItems.push({ title: firstSentence.slice(0, 90), desc: sanitized, mediaUrl: media.mediaUrl, mediaType: media.mediaType, sourceName: ch, postKey });
                    }
                }
                found++;
            }
            console.log(`  [${ch}] постов: ${found}`);
        } catch (e) {
            console.log(`  [${ch}] ошибка: ${String(e)}`);
        }
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
            for (const raw of (xml.match(/<item[\s\S]*?<\/item>/gi) ?? []).slice(0, 10)) {
                const title = cleanText(raw.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1]);
                const descHtml = raw.match(/<description[\s\S]*?>([\s\S]*?)<\/description>/i)?.[1] ?? "";
                const desc = cleanText(descHtml);
                const link = cleanText(raw.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);

                if (BORING_TOPICS.some(r => r.test(`${title} ${desc}`))) continue;
                if (!title) continue;

                const postKey = `${feed.name.toLowerCase()}_${simpleHash(title + (link || ""))}`;

                const enclosureImg = raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1];
                const mediaContent = raw.match(/<media:content[^>]+url=["']([^"']+)["']/i)?.[1];
                const imgMatches = [...descHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
                const allImages = [enclosureImg, mediaContent, ...imgMatches].filter(Boolean).filter(u => !isTrashUrl(u));
                const uniqueImages = [...new Set(allImages)];

                if (uniqueImages.length === 0) {
                    items.push({ title, desc, mediaUrl: "", mediaType: "image", sourceName: feed.name, postKey });
                } else {
                    for (const img of uniqueImages) {
                        items.push({ title, desc, mediaUrl: img, mediaType: "image", sourceName: feed.name, postKey });
                    }
                }
            }
        } catch {}
    }));
    return items;
}

function cutBody(text: string, maxLen = MAX_BODY_LEN): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxLen) return trimmed;
    const sub = trimmed.slice(0, maxLen);
    const lastPunct = Math.max(sub.lastIndexOf("."), sub.lastIndexOf("!"), sub.lastIndexOf("?"));
    if (lastPunct > 80) return sub.slice(0, lastPunct + 1);
    const lastSpace = sub.lastIndexOf(" ");
    return (lastSpace > 0 ? sub.slice(0, lastSpace) : sub) + "...";
}

async function formatNewsPost(title: string, desc: string): Promise<{ headline: string, text: string, importance: number, is_ad: boolean }> {
    const cleanDesc = sanitizeRawText(desc);
    const bodyText = cutBody(cleanDesc);
    const fallbackHeadline = cleanText(title).replace(/\s+[-—]\s+.*$/, "").slice(0, 100);

    const prompt = `Ты редактор новостного канала. Ниже — текст новости.
Сделай ТОЛЬКО ЗАГОЛОВОК и оценку важности.

ТЕКСТ НОВОСТИ:
${cleanDesc}

СТРОГИЕ ПРАВИЛА:
1. headline — заголовок до 7 слов, громкий, передаёт суть события. Обязательно 1-2 эмодзи (⚡ 🔥 🚨 💥 ⚠️) в начало или конец.
   ЗАПРЕЩЕНО менять цифры, возраст, имена, названия городов и организаций.
   ЗАПРЕЩЕНО добавлять факты, которых нет в тексте.
2. importance — целое число 1–10:
   10 — экстренно (война, теракт, катастрофа, удар по инфраструктуре, массовые протесты).
   8-9 — очень важно (крупное ЧП с жертвами, решение власти, знаковая фигура, международные протесты).
   7 — важно (политическое/экономическое событие, крупные удары, санкции).
   6 — заметно (международная политика, заявления лидеров, крупный бизнес).
   4-5 — средне (региональное ЧП без жертв, спорт, мелкий бизнес).
   1-3 — НЕ ВАЖНО (бытовуха, ДТП без жертв, курьёзы, погода).
3. is_ad — true, если это реклама, анонс сервиса, промо-пост, приглашение подписаться.
Верни ТОЛЬКО JSON: {"headline": "⚡ ...", "importance": 6, "is_ad": false}`;

    if (GEMINI_API_KEY) {
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
                signal: AbortSignal.timeout(15000),
            });
            if (r.ok) {
                const j = await r.json();
                const p = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
                if (p.headline) return { headline: p.headline, text: bodyText, importance: Number(p.importance) || 5, is_ad: !!p.is_ad };
            }
        } catch {}
    }

    if (DASHSCOPE_API_KEY) {
        try {
            const r = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DASHSCOPE_API_KEY}` },
                body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
                signal: AbortSignal.timeout(15000),
            });
            if (r.ok) {
                const j = await r.json();
                const match = (j?.choices?.[0]?.message?.content ?? "").match(/\{[\s\S]*\}/);
                if (match) {
                    const p = JSON.parse(match[0]);
                    if (p.headline) return { headline: p.headline, text: bodyText, importance: Number(p.importance) || 5, is_ad: !!p.is_ad };
                }
            }
        } catch {}
    }

    return { headline: fallbackHeadline, text: bodyText, importance: 5, is_ad: false };
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

async function sendPostToMax(text: string, media: Array<{ token: string, type: "image" | "video" }>) {
    const client = await initMaxHttpClient();
    const body: any = {
        text,
        format: "html",
        notify: true,
        disable_link_preview: true,
        attachments: media.map(item => ({ type: item.type, payload: { token: item.token } }))
    };

    const res = await fetch(MAX_API + "/messages?chat_id=" + encodeURIComponent(TARGET_CHAT_ID), {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        client: client ?? undefined,
    });
    return res.ok;
}

// Сбор медиапакета.
// 1) Сначала — все медиа из того же поста (postKey).
// 2) Если их нет — FALLBACK: ищем медиа по 3+ общим корням в заголовке
//    (жёсткий порог, чтобы не подтянуть "пляжи" к "Рыбарю").
function getMediaPacket(item: any, candidates: any[]): any[] {
    const packet: any[] = [];
    const seen = new Set<string>();

    // Приоритет 1: медиа из того же поста
    if (item.postKey) {
        const samePost = candidates.filter(c => c.postKey === item.postKey);
        const videos = samePost.filter(c => c.mediaType === "video");
        const images = samePost.filter(c => c.mediaType === "image");
        for (const c of [...videos, ...images]) {
            if (!c.mediaUrl || isTrashUrl(c.mediaUrl)) continue;
            if (seen.has(c.mediaUrl)) continue;
            seen.add(c.mediaUrl);
            packet.push(c);
            if (packet.length >= MEDIA_PACKET_MAX) return packet;
        }
    }

    // Приоритет 2: fallback — медиа по 3+ общим корням (новость, но из другого канала)
    if (packet.length === 0) {
        const baseRoots = new Set(getRoots(item.title));
        const scored = candidates
            .filter(c => c.mediaUrl && !isTrashUrl(c.mediaUrl))
            .map(c => {
                const roots = getRoots(c.title);
                const overlap = roots.filter((r: string) => baseRoots.has(r)).length;
                return { candidate: c, overlap };
            })
            .filter(x => x.overlap >= 3)
            .sort((a, b) => b.overlap - a.overlap);

        for (const { candidate } of scored) {
            if (seen.has(candidate.mediaUrl)) continue;
            seen.add(candidate.mediaUrl);
            packet.push(candidate);
            if (packet.length >= MEDIA_PACKET_MAX) break;
        }
    }

    return packet;
}

async function run() {
    console.log("=== ЭФИР v29: Запуск отбора событий ===");
    const now = Date.now();

    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;

    if (now - lastRegular < HARD_MIN_INTERVAL_MS) {
        const secondsLeft = Math.ceil((HARD_MIN_INTERVAL_MS - (now - lastRegular)) / 1000);
        console.log(`Жёсткий интервал: ждём ещё ${secondsLeft} сек.`);
        return;
    }

    let nextDelay = (await kv.get(["factor", "next_regular_delay"])).value;
    if (!nextDelay || nextDelay > REGULAR_MAX_INTERVAL_MS) {
        nextDelay = REGULAR_MIN_INTERVAL_MS;
        await kv.set(["factor", "next_regular_delay"], nextDelay);
    }
    if (now - lastRegular < nextDelay) {
        console.log("Пауза вещания активна: следующая публикация примерно через " + Math.ceil((nextDelay - (now - lastRegular)) / 60000) + " мин.");
        return;
    }

    console.log("\nИсточники (Telegram):");
    let candidates = await fetchTelegramLiveFeed();
    console.log(`Всего кандидатов из TG: ${candidates.length}`);

    if (candidates.length === 0) {
        console.log("Переключаемся на RSS...");
        candidates = await fetchRssFeeds();
        console.log(`Всего кандидатов из RSS: ${candidates.length}`);
    }

    const seenPostKeys = new Set<string>();
    const uniqueCandidates: any[] = [];
    for (const c of candidates) {
        const key = c.postKey || c.title;
        if (seenPostKeys.has(key)) continue;
        seenPostKeys.add(key);
        uniqueCandidates.push(c);
    }
    console.log(`Уникальных постов: ${uniqueCandidates.length}`);

    for (const item of uniqueCandidates) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title))))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        if ((await kv.get(["factor", "pub", hash])).value) continue;
        if (await isDuplicate(item.title, item.desc)) continue;

        console.log("\nОбработка: " + item.title);

        const post = await formatNewsPost(item.title, item.desc);

        if (post.is_ad) {
            console.log(`Пропуск: реклама`);
            continue;
        }
        if (post.importance < MIN_IMPORTANCE) {
            console.log(`Пропуск: важность ${post.importance} < ${MIN_IMPORTANCE}`);
            continue;
        }

        const mediaPacket = getMediaPacket(item, candidates);
        const uploaded: Array<{ token: string, type: "image" | "video" }> = [];
        for (const media of mediaPacket) {
            const mediaBytes = await downloadBuffer(media.mediaUrl, media.mediaType === "video");
            if (!mediaBytes) continue;
            try {
                const token = await uploadToMax(mediaBytes, media.mediaType);
                if (token) uploaded.push({ token, type: media.mediaType });
            } catch (e) {
                console.error("Ошибка загрузки медиа:", e);
            }
            if (uploaded.length >= MEDIA_PACKET_MAX) break;
        }

        if (!uploaded.length) {
            console.log("Медиа не найдено — публикуем текстом");
        } else {
            const videos = uploaded.filter(u => u.type === "video").length;
            const images = uploaded.filter(u => u.type === "image").length;
            console.log(`Медиапакет: ${uploaded.length} (видео: ${videos}, фото: ${images})`);
        }

        const postHtml = "<b>" + escapeHtml(post.headline) + "</b>\n\n" + escapeHtml(post.text) + "\n\n⚡ <i>ФАКТОР</i>\n\n#ФАКТОР";
        const sent = await sendPostToMax(postHtml, uploaded);
        if (sent) {
            console.log("🔥 ОПУБЛИКОВАНО (медиа: " + uploaded.length + ", важность: " + post.importance + "): " + post.headline);
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
