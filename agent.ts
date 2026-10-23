// ============================================================
// MAX NEWS AGENT — «ФАКТОР» (Bulletproof Text Fallback v87)
// ============================================================

import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const REGULAR_MIN_INTERVAL_MS = 15 * 60 * 1000;
const REGULAR_MAX_INTERVAL_MS = 25 * 60 * 1000;
const HARD_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MAX_POST_AGE_MS = 3 * 60 * 60 * 1000;

const MEDIA_PACKET_MAX = 6;
const MIN_IMPORTANCE = 6; 
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STATE_MAX_ENTRIES = 300;
const STATE_KEEP_ENTRIES = 100;

const RECENT_HISTORY_LIMIT = 100;
const SIMILARITY_THRESHOLD = 0.35; 

const MIN_IMAGE_BYTES = 10 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_VIDEO_BYTES = 50 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 10000; 

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

const TG_LIVE_CHANNELS = [
    "government_rus", "news_kremlin", "kremlinpress",
    "mod_russia", "mchs_official", "mediamvd", "MID_Russia", "sledcom_press",
    "genprocru", "rosgvardofficial",
    "duma_gov_ru", "sovfedofficial", "centralbank_russia", "minfin", "minec_russia",
    "mintsifry", "minenergo_official", "minpromtorg_ru", "mcx_ru", "mintrudrf",
    "minstroyrf", "minzdrav_ru", "minobrnaukiofficial", "minsport_russia",
    "mincultrussia", "mintransrussia", "prirodovedenie_rus", "minvostok",
    "rostecnews", "rosatominfo", "rzdtg", "GazpromNews", "rosneftinfo",
    "rian_ru", "tass_agency", "rbc_news", "vesti_news", "rt_russian",
    "1tv_news", "ntvru", "izvestya", "rgru_news"
];

const NEWS_FEEDS = [
    { name: "ТАСС", url: "https://tass.ru/rss/v2.xml" },
    { name: "РИА Новости", url: "https://ria.ru/export/rss2/archive/index.xml" },
    { name: "Интерфакс", url: "https://www.interfax.ru/rss.asp" },
    { name: "РБК", url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss" },
    { name: "Российская газета", url: "https://rg.ru/xml/index.xml" },
    { name: "АиФ", url: "https://aif.ru/rss/news.php" },
    { name: "Коммерсантъ", url: "https://www.kommersant.ru/RSS/main.xml" },
    { name: "Ведомости", url: "https://www.vedomosti.ru/rss/news" },
    { name: "Известия", url: "https://iz.ru/xml/rss/all.xml" },
    { name: "RT на русском", url: "https://russian.rt.com/rss" },
    { name: "Газета.Ru", url: "https://www.gazeta.ru/export/rss/lenta.xml" },
    { name: "Взгляд", url: "https://vz.ru/rss.xml" },
    { name: "Вести", url: "https://www.vesti.ru/vesti.rss" },
    { name: "НТВ", url: "https://www.ntv.ru/novosti/rss/" },
    { name: "Первый канал", url: "https://www.1tv.ru/rss/news" },
    { name: "Life.ru", url: "https://life.ru/s/rss/news" },
    { name: "КП", url: "https://www.kp.ru/rss/allsections.xml" },
    { name: "News.ru", url: "https://news.ru/rss/" },
    { name: "360tv", url: "https://360tv.ru/rss/" },
    { name: "РЕН ТВ", url: "https://ren.tv/rss" },
    { name: "БФМ", url: "https://www.bfm.ru/rss.xml" },
    { name: "URA.ру", url: "https://ura.news/rss" },
    { name: "Правда.ру", url: "https://www.pravda.ru/export.xml" },
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
    /(?:собак|кошк|котят|щенят|ши-тцу|животн|питомц|зоозащит)/i,
    /(?:пылесос|розетк|бытов|квартир[аеу].*пожар|пожар.*квартир|кухн[яе].*пожар|закурил|уснул\s+с\s+сигарет)/i,
    /(?:гороскоп|астролог|экстрасенс|таролог|гадан)/i,
    /(?:измен[аи]|изменил|любовн|скандал.*звезд|инстаграм|тикток)/i,
    /(?:спасение\s+(?:кота|собаки|животного))/i,
    /(?:турист|учител|коммунальн|ЖКХ|убийц|отсудил|полици[яи].*задерж|Макаревич|Пугачев|Киркоров|Бузова)/i,
    /(?:автобус|троллейбус|трамвай|штраф|аренд|гектар|Минсельхоз|господдержк|субсиди|льготн.*лизинг|теплич|букмекер|урожай)/i,
    /(?:автоваз|lada|ростех|пресс-релиз|интервью журналу|автомобиль.*комфорт|электронная.*карта)/i,
    /(?:главное в штурме|дождаться своего часа|когда на кону|действовать нужно с умом|пошли на хитрость|работали дроны противника)/i,
    /(?:среди вернувшихся|обмене бойцов|предстоит лечение|сообщила Лантратова|реабилитация)/i,
    /(?:трек|релиз|альбом|певец|музыкант|рэпер|клип|анонс|концерт|фестиваль|туры|билет|bones|исполнител)/i,
    /(?:пятница|пятницу|13 населенных|освободили|наша территория|фортуна|отворачивается|свои готовы)/i
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
            key, value,
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

    async cleanup(): Promise<{ removedExpired: number; removedOld: number; removedOverflow: number; kept: number }> {
        const d = await this.load();
        const now = Date.now();
        const entries = d.entries as Record<string, any>;
        let removedExpired = 0, removedOld = 0;
        const survivors: Array<{ key: string; entry: any }> = [];

        for (const [k, v] of Object.entries<any>(entries)) {
            if (v?.expiresAt && v.expiresAt < now) { removedExpired++; continue; }
            const ts = v?.expiresAt ? v.expiresAt - HISTORY_TTL_MS : null;
            if (ts && (now - ts) > STATE_MAX_AGE_MS) { removedOld++; continue; }
            survivors.push({ key: k, entry: v });
        }

        let removedOverflow = 0;
        if (survivors.length > STATE_MAX_ENTRIES) {
            survivors.sort((a, b) => (b.entry?.expiresAt ?? 0) - (a.entry?.expiresAt ?? 0));
            removedOverflow = survivors.slice(STATE_KEEP_ENTRIES).length;
            const keep = survivors.slice(0, STATE_KEEP_ENTRIES);
            d.entries = {};
            for (const { key, entry } of keep) d.entries[key] = entry;
        } else {
            d.entries = {};
            for (const { key, entry } of survivors) d.entries[key] = entry;
        }

        await Deno.writeTextFile(this.file, JSON.stringify(d, null, 2) + "\n");
        return { removedExpired, removedOld, removedOverflow, kept: Object.keys(d.entries).length };
    }
}

const kv = new FileKV();

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#0*39;/g, "'")
        .replace(/&nbsp;/gi, " ").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
        .replace(/&laquo;/gi, "«").replace(/&raquo;/gi, "»").replace(/&hellip;/gi, "…")
        .replace(/&amp;/gi, "&")
        .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch { return ""; } })
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; } });
}

function cleanText(val: any): string {
    let t = String(val ?? "");
    t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
    t = decodeHtmlEntities(t); t = decodeHtmlEntities(t);
    t = t.replace(/<[^>]+>/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
}

function sanitizeHtml(html: string): string {
    return html.replace(/<[^>]*>/g, ""); 
}

function escapeHtml(val: any): string {
    return String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getRoots(str: string): string[] {
    const stops = new Set(["россия", "москва", "сегодня", "вчера", "сообщили", "после", "видео", "новости", "словам", "данный", "момент", "стало", "известно", "заявил", "сообщил", "рассказал"]);
    return cleanText(str).toLowerCase().replace(/[^a-zа-я0-9]+/gi, " ").split(" ")
        .filter(w => w.length >= 5 && !stops.has(w))
        .map(w => w.slice(0, 6));
}

function getWordSet(text: string): Set<string> {
    const words = text.toLowerCase().replace(/[^a-zа-я0-9]/gi, " ").split(" ").filter(w => w.length >= 4);
    return new Set(words);
}

function isSimilar(text1: string, text2: string): boolean {
    const set1 = getWordSet(text1);
    const set2 = getWordSet(text2);
    if (set1.size === 0 || set2.size === 0) return false;
    
    let intersectionSize = 0;
    for (const w of set1) {
        if (set2.has(w)) intersectionSize++;
    }
    const similarity = intersectionSize / Math.min(set1.size, set2.size);
    return similarity > SIMILARITY_THRESHOLD;
}

async function isDuplicate(title: string, desc?: string): Promise<boolean> {
    const titleRoots = getRoots(title);
    const allRoots = [...new Set([...titleRoots, ...(desc ? getRoots(desc) : [])])];
    if (!allRoots.length) return false;
    const past = await kv.getAllTopics();
    for (const item of past) {
        const set = new Set(item.roots || []);
        let tm = 0;
        for (const r of titleRoots) if (set.has(r)) tm++;
        if (tm >= 2) return true;
        let fm = 0;
        for (const r of allRoots) if (set.has(r)) fm++;
        if (fm >= 4 && titleRoots.length > 0) return true;
    }
    return false;
}

async function getContentHash(text: string): Promise<string> {
    const clean = text.toLowerCase().replace(/[^a-zа-я0-9]/gi, "").slice(0, 150);
    if (!clean) return "";
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getTextHash(text: string): Promise<string> {
    const normalized = text.toLowerCase().replace(/[^a-zа-я0-9]/gi, "").trim();
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function isTrashUrl(url: string): boolean {
    const low = url.toLowerCase();
    return (
        low.includes("/card") || low.includes("textcard") || low.includes("share") ||
        low.includes("logo") || low.includes("avatar") || low.includes("stub") ||
        low.includes("1x1") || low.includes("pixel") || low.includes(".svg") ||
        low.includes("google.com") || low.includes("interfax.ru/ftproot") ||
        low.includes("data:image") || low.includes("base64,")
    );
}

function buildProxyUrls(url: string): string[] {
    const enc = encodeURIComponent(url);
    return [
        `https://corsproxy.io/?${enc}`,
        url,
    ];
}

async function downloadBuffer(url: string, isVideo = false): Promise<Uint8Array | null> {
    if (!url || isTrashUrl(url)) return null;

    const proxyUrls = buildProxyUrls(url);
    const timeout = DOWNLOAD_TIMEOUT_MS;

    for (const candidateUrl of proxyUrls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(candidateUrl, {
                method: "GET",
                headers: {
                    "User-Agent": USER_AGENT,
                    "Referer": "https://t.me/",
                    "Accept": "*/*",
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) continue;

            const buf = new Uint8Array(await response.arrayBuffer());
            const min = isVideo ? MIN_VIDEO_BYTES : MIN_IMAGE_BYTES;
            const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;

            if (buf.byteLength < min || buf.byteLength > max) continue;

            const head = new TextDecoder().decode(buf.subarray(0, 30)).toLowerCase();
            if (head.includes("<html") || head.includes("<!doctype") || head.includes("<?xml")) continue;

            return buf;
        } catch {
            continue; 
        }
    }
    return null;
}

function fixBrandNames(text: string): string {
    return text
        .replace(/Старшилд/gi, "Старлинк")
        .replace(/Starshield/gi, "Starlink");
}

function validateHeadline(llmHead: string, fallbackHead: string): string {
    let h = (llmHead || "").trim();
    if (h.length < 10 || h.endsWith("-") || h.endsWith(",") || h.endsWith("...")) return fallbackHead;
    const words = h.split(/\s+/).filter(w => w.length > 2);
    if (words.length < 3) return fallbackHead;
    const vaguePhrases = ["работа сделана", "дело тонкое", "к ответу", "на частоте", "всем известно", "без комментариев", "шокирующая", "свершилось"];
    if (vaguePhrases.some(p => h.toLowerCase().includes(p))) return fallbackHead;
    if (!/[a-zA-Zа-яА-Я0-9]/.test(h)) return fallbackHead;
    return fixBrandNames(h.charAt(0).toUpperCase() + h.slice(1));
}

function sanitizeRawText(raw: string): string {
    let t = cleanText(raw);

    t = t.replace(/(?:Как выяснил|Как выяснила|Как узнал|Как узнала|Как рассказал|Как рассказали|По данным|Об этом сообщает|Об этом сообщило|Об этом пишет)\s*[«"']?(?:SHOT|Mash|База|Баз[ыуе]|Readovka|ТАСС|РИА Новости|Интерфакс|Минобороны России)[»"']?/gi, "");
    t = t.replace(/[«"']?(?:SHOT|Mash|База|Баз[ыуе]|Readovka)[»"']?/gi, "");
    t = t.replace(/#[a-zA-Zа-яА-Я0-9_]+/g, "");
    
    t = t.replace(/Новость дополняется/gi, "");
    t = t.replace(/Об этом сообщил[а-я]*/gi, "");
    t = t.replace(/Об этом заявил[а-я]*/gi, "");

    const markers = [
        "Подписаться", "Подпишись", "Подписывайтесь", "Мы в Максе", 'Мы в "Максе"', "Мы в «Максе»", 
        "Наш канал в Максе", "Читайте нас в Максе", "Читайте в Максе", "Канал Минобороны", 
        "Канал в МАКС", "Больше новостей", "Читайте также", "только для своих", 
        "Источник:", "Фото:", "Видео:", "Прислать новость", "Предложить новость"
    ];
    
    for (const m of markers) {
        const idx = t.toLowerCase().indexOf(m.toLowerCase());
        if (idx > 10) { t = t.slice(0, idx); break; }
    }

    t = t.replace(/📢\s*Прямой Эфир/gi, "");
    t = t.replace(/⚡\s*ФАКТОР/gi, "");
    t = t.replace(/[\s◆♦●○■▪▫▶➡⬛⬜⭐✔☑«»"'.,;:!?/\-–—]+$/g, "");

    return fixBrandNames(t.trim());
}

async function applyBrandOverlay(bytes: Uint8Array): Promise<Uint8Array> {
    try {
        const img = await Image.decode(bytes);
        const logo = await Image.decode(await Deno.readFile("./logo.png"));
        const logoW = Math.floor(img.width * 0.15);
        const logoH = Math.floor(logo.height * (logoW / logo.width));
        img.composite(logo.resize(logoW, logoH), img.width - logoW - 10, 10);
        return await img.encode();
    } catch {
        return bytes;
    }
}

function extractPostDate(postHtml: string): number | null {
    const m = postHtml.match(/<time[^>]+datetime=["']([^"']+)["']/i);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return isNaN(t) ? null : t;
}

function simpleHash(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
}

async function fetchTelegramLiveFeed(): Promise<any[]> {
    const liveItems: any[] = [];
    const now = Date.now();
    for (const ch of TG_LIVE_CHANNELS) {
        let found = 0;
        try {
            const res = await fetch(`https://t.me/s/${ch}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) { console.log(`  [${ch}] HTTP ${res.status}`); continue; }
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

                const mediaUrls = videoMatches.length > 0 
                    ? videoMatches.map(mediaUrl => ({ mediaUrl, mediaType: "video" }))
                    : imageMatches.map(mediaUrl => ({ mediaUrl, mediaType: "image" }));

                if (mediaUrls.length > 0) {
                    for (const media of mediaUrls) {
                        liveItems.push({ 
                            title: firstSentence.slice(0, 90), 
                            desc: sanitized, 
                            mediaUrl: media.mediaUrl, 
                            mediaType: media.mediaType, 
                            sourceName: ch, 
                            sourceType: "tg", 
                            postKey,
                            postDate: postDate || 0 
                        });
                    }
                    found++;
                }
            }
            console.log(`  [${ch}] постов с медиа: ${found}`);
        } catch (e) { console.log(`  [${ch}] ошибка: ${String(e)}`); }
    }
    return liveItems;
}

async function fetchRssFeeds(): Promise<any[]> {
    const items: any[] = [];
    let totalFound = 0;
    await Promise.all(NEWS_FEEDS.map(async (feed) => {
        try {
            const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) { console.log(`  [RSS: ${feed.name}] HTTP ${res.status}`); return; }
            const xml = await res.text();
            let feedFound = 0;
            for (const raw of (xml.match(/<item[\s\S]*?<\/item>/gi) ?? []).slice(0, 15)) {
                const title = sanitizeRawText(raw.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1] ?? "");
                const descHtml = raw.match(/<description[\s\S]*?>([\s\S]*?)<\/description>/i)?.[1] ?? "";
                const desc = sanitizeRawText(descHtml);
                const link = cleanText(raw.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);
                if (BORING_TOPICS.some(r => r.test(`${title} ${desc}`))) continue;
                if (!title) continue;

                const postKey = `${feed.name.toLowerCase()}_${simpleHash(title + (link || ""))}`;
                const enclosureImg = raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1];
                const mediaContent = raw.match(/<media:content[^>]+url=["']([^"']+)["']/i)?.[1];
                const mediaThumbnail = raw.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1];
                const imgMatches = [...descHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
                const allImages = [enclosureImg, mediaContent, mediaThumbnail, ...imgMatches].filter(Boolean).filter(u => !isTrashUrl(u));
                const uniqueImages = [...new Set(allImages)];

                if (uniqueImages.length > 0) {
                    for (const img of uniqueImages) {
                        items.push({ title, desc, mediaUrl: img, mediaType: "image", sourceName: feed.name, sourceType: "rss", postKey, postDate: 0 });
                    }
                    feedFound++;
                }
            }
            console.log(`  [RSS: ${feed.name}] постов с медиа: ${feedFound}`);
            totalFound += feedFound;
        } catch (e) { console.log(`  [RSS: ${feed.name}] ошибка: ${String(e)}`); }
    }));
    console.log(`RSS-источники: собрано ${totalFound} постов с медиа`);
    return items;
}

async function formatNewsPost(title: string, desc: string): Promise<{ headline: string, body: string, insight: string, importance: number, is_ad: boolean }> {
    const cleanDesc = sanitizeRawText(desc);
    const fallbackHeadline = sanitizeRawText(title).replace(/\s+[-—]\s+.*$/, "").slice(0, 90);
    
    // 🛠 УМНЫЙ FALLBACK: Берем оригинальный текст, если ИИ не справится
    const fallbackBody = cleanDesc.slice(0, 350) + (cleanDesc.length > 350 ? "..." : "");

    const prompt = `Ты — главный редактор новостного канала «ФАКТОР». Твой стиль — сухо, четко, структурно, с эмодзи. Никакой воды и канцелярита.

ИСХОДНЫЙ ТЕКСТ:
${cleanDesc}

ПРИМЕР ИДЕАЛЬНОГО ПОСТА:
Заголовок: ЦБ сохранил ключевую ставку на уровне 14% 📉
Текст: Банк России принял решение сохранить ключевую ставку на уровне <b>14%</b> второй раз подряд. Это решение было ожидаемым для рынка.
🟢 Базовый сценарий предполагает среднюю ставку 12,5–13,5% в 2027 году.
🟢 Годовая инфляция в России по итогам года сложится в диапазоне 7,1–7,6%.
Что это значит: Высокая ставка сдержит рост цен, но кредиты и ипотека останутся дорогими для людей.

ТВОИ ЗАДАЧИ:
1. headline — конкретный заголовок (до 7 слов) с ОДНИМ эмодзи. ТОЛЬКО СУХИЕ ФАКТЫ. 
2. body — ПЕРЕПИШИ текст КОРОТКО (максимум 2-3 абзаца). 
   - СРАЗУ ПЕРЕХОДИ К СУТИ. НЕ ПОВТОРЯЙ заголовок в первом предложении.
   - Если есть перечисления — используй ТОЛЬКО маркеры: 🟢, 🔴, 📌.
   - Выдели главное тегами <b>жирный текст</b>.
   - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать патриотические лозунги. Если в тексте сухая сводка — ставь важность 1 и не пиши лишнего.
3. insight — ОБЪЯСНИ ПРОСТЫМ ЯЗЫКОМ (1-2 предложения, до 25 слов). БЕЗ ТЕГОВ HTML. НЕ начинай со слов "Это значит". Сразу пиши суть: к чему это приведет, как коснется жизни людей.
4. importance — целое 1-10 (8-10 экстренно, 6-7 важно, 1-5 скучно/военный пиар).
5. is_ad — true, если это реклама.

Верни ТОЛЬКО JSON: {"headline": "...", "body": "...", "insight": "...", "importance": 8, "is_ad": false}`;

    let llmResult: any = null;

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
                const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                const match = text.match(/\{[\s\S]*\}/);
                if (match) llmResult = JSON.parse(match[0]);
            }
        } catch {}
    }

    if (!llmResult && DASHSCOPE_API_KEY) {
        try {
            const r = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DASHSCOPE_API_KEY}` },
                body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
                signal: AbortSignal.timeout(15000),
            });
            if (r.ok) {
                const j = await r.json();
                const text = j?.choices?.[0]?.message?.content ?? "";
                const match = text.match(/\{[\s\S]*\}/);
                if (match) llmResult = JSON.parse(match[0]);
            }
        } catch {}
    }

    if (llmResult && llmResult.headline && llmResult.body) {
        const isEnglish = (llmResult.body.match(/[a-zA-Z]/g) || []).length > (llmResult.body.match(/[а-яА-Я]/g) || []).length;
        if (isEnglish) {
            return { headline: fallbackHeadline, body: fallbackBody, insight: "", importance: 6, is_ad: false };
        }

        return {
            headline: validateHeadline(llmResult.headline, fallbackHeadline),
            body: sanitizeHtml(String(llmResult.body).trim()), 
            insight: sanitizeHtml(String(llmResult.insight || "").trim()),
            importance: Number(llmResult.importance) || 6,
            is_ad: !!llmResult.is_ad,
        };
    }
    
    // 🛠 Возвращаем fallback (оригинальный текст), а не пустоту
    return { headline: fallbackHeadline, body: fallbackBody, insight: "", importance: 6, is_ad: false };
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
    
    const res = await fetch(initData.url, { 
        method: "POST", 
        body: form, 
        client: client ?? undefined, 
        signal: AbortSignal.timeout(60000) 
    });
    
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch {}
    return initData.token || json?.token || json?.photos?.[0]?.token || json?.videos?.[0]?.token;
}

async function sendPostToMax(text: string, media: Array<{ token: string, type: "image" | "video" }>) {
    const client = await initMaxHttpClient();
    const body: any = {
        text, format: "html", notify: true, disable_link_preview: true,
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

function getMediaPacket(item: any, candidates: any[]): any[] {
    const packet: any[] = [];
    const seen = new Set<string>();

    if (!item.postKey) return [];

    const samePost = candidates.filter(c => c.postKey === item.postKey);
    const ordered = [
        ...samePost.filter(c => c.mediaType === "video"),
        ...samePost.filter(c => c.mediaType === "image"),
    ];

    for (const c of ordered) {
        if (!c.mediaUrl || isTrashUrl(c.mediaUrl)) continue;
        if (seen.has(c.mediaUrl)) continue;
        seen.add(c.mediaUrl);
        packet.push(c);
        if (packet.length >= MEDIA_PACKET_MAX) break;
    }

    return packet;
}

async function run() {
    console.log("=== ФАКТОР v87: Запуск отбора событий ===");
    const now = Date.now();

    try {
        const stat = await kv.cleanup();
        console.log(`Очистка state: удалено просроченных ${stat.removedExpired}, старых ${stat.removedOld}, лишних ${stat.removedOverflow}; оставлено ${stat.kept}`);
    } catch (e) { console.log("Очистка state не удалась:", String(e)); }

    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;
    if (now - lastRegular < HARD_MIN_INTERVAL_MS) {
        console.log(`Жёсткий интервал: ждём ещё ${Math.ceil((HARD_MIN_INTERVAL_MS - (now - lastRegular)) / 1000)} сек.`);
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
    const tgCandidates = await fetchTelegramLiveFeed();
    console.log(`Всего кандидатов из TG: ${tgCandidates.length}`);

    console.log("\nИсточники (RSS):");
    const rssCandidates = await fetchRssFeeds();

    const candidates = [...tgCandidates, ...rssCandidates];
    console.log(`Всего кандидатов: ${candidates.length}`);

    candidates.sort((a, b) => b.postDate - a.postDate);

    const seenPostKeys = new Set<string>();
    const uniqueCandidates: any[] = [];
    for (const c of candidates) {
        const key = c.postKey || c.title;
        if (seenPostKeys.has(key)) continue;
        seenPostKeys.add(key);
        uniqueCandidates.push(c);
    }
    console.log(`Уникальных постов: ${uniqueCandidates.length}`);

    const topCandidates = uniqueCandidates.slice(0, 25);
    console.log(`К обработке принято: ${topCandidates.length}`);

    let skippedDup = 0, skippedImportance = 0, skippedNoMedia = 0, published = 0;

    const recentDescs: string[] = (await kv.get(["factor", "recent_descs"])).value || [];
    const recentBodies: string[] = (await kv.get(["factor", "recent_bodies"])).value || [];
    const recentTitles: string[] = (await kv.get(["factor", "recent_titles"])).value || [];

    for (const item of topCandidates) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title))))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        if ((await kv.get(["factor", "pub", hash])).value) { skippedDup++; continue; }
        if (await isDuplicate(item.title, item.desc)) { skippedDup++; continue; }

        const contentHash = await getContentHash(item.desc);
        if (contentHash && (await kv.get(["factor", "content", contentHash])).value) {
            skippedDup++;
            continue;
        }

        let isSimilarFound = false;
        for (const pastDesc of recentDescs) {
            if (isSimilar(item.desc, pastDesc)) {
                isSimilarFound = true;
                break;
            }
        }
        if (isSimilarFound) {
            console.log(`❌ Пропуск: исходный текст похож на недавний.`);
            skippedDup++;
            continue;
        }

        console.log("\nОбработка: " + item.title);

        const mediaPacket = getMediaPacket(item, candidates);
        // Если медиа вообще нет в посте, мы все равно пытаемся его обработать (текст опубликуем)

        const post = await formatNewsPost(item.title, item.desc);

        if (post.is_ad) { skippedImportance++; continue; }
        if (post.importance < MIN_IMPORTANCE) {
            console.log(`Пропуск: важность ${post.importance} < ${MIN_IMPORTANCE}`);
            skippedImportance++;
            continue;
        }

        if (!post.headline || !post.body || post.body.length < 20) {
            console.log(`❌ Пропуск: ИИ вернул пустой текст и нет фолбэка.`);
            skippedNoMedia++;
            continue;
        }

        const cleanBody = post.body.toLowerCase().replace(/[^a-zа-я0-9]/g, "");
        const cleanHead = post.headline.toLowerCase().replace(/[^a-zа-я0-9]/g, "");
        if (cleanBody.includes(cleanHead) && cleanBody.length < cleanHead.length + 20) {
            console.log(`❌ Пропуск: тело поста дублирует заголовок.`);
            skippedNoMedia++;
            continue;
        }

        let isTitleSimilar = false;
        for (const pastTitle of recentTitles) {
            if (isSimilar(post.headline, pastTitle)) {
                isTitleSimilar = true;
                break;
            }
        }
        if (isTitleSimilar) {
            console.log(`❌ Пропуск: заголовок совпадает с недавним.`);
            skippedDup++;
            continue;
        }

        let isBodySimilar = false;
        for (const pastBody of recentBodies) {
            if (isSimilar(post.body, pastBody)) {
                isBodySimilar = true;
                break;
            }
        }
        if (isBodySimilar) {
            console.log(`❌ Пропуск: текст ИИ совпадает с недавним.`);
            skippedDup++;
            continue;
        }

        const textHash = await getTextHash(post.body);
        if ((await kv.get(["factor", "texthash", textHash])).value) {
            console.log(`❌ Пропуск: такой текст уже был опубликован.`);
            skippedDup++;
            continue;
        }

        const uploaded: Array<{ token: string; type: "image" | "video" }> = [];
        
        for (const media of mediaPacket) {
            let mediaBytes = await downloadBuffer(media.mediaUrl, media.mediaType === "video");
            
            if (!mediaBytes && media.mediaType === "video") {
                const fallbackImg = candidates.find(c => c.postKey === item.postKey && c.mediaType === "image");
                if (fallbackImg) {
                    mediaBytes = await downloadBuffer(fallbackImg.mediaUrl, false);
                }
            }
            
            if (!mediaBytes) continue;

            if (media.mediaType === "image") {
                mediaBytes = await applyBrandOverlay(mediaBytes);
            }

            try {
                const token = await uploadToMax(mediaBytes, media.mediaType);
                if (token) uploaded.push({ token, type: media.mediaType });
            } catch (e) { 
                console.error("Ошибка загрузки медиа:", e); 
            }
            if (uploaded.length >= MEDIA_PACKET_MAX) break;
        }

        // 🛠 ГЛАВНОЕ ИЗМЕНЕНИЕ: Если медиа не скачалось, мы НЕ ПРОПУСКАЕМ новость!
        if (!uploaded.length) {
            console.log(`⚠️ Медиа не скачалось, публикуем только текст.`);
        } else {
            const videos = uploaded.filter(u => u.type === "video").length;
            const images = uploaded.filter(u => u.type === "image").length;
            console.log(`✅ Медиапакет: ${uploaded.length} (видео: ${videos}, фото: ${images})`);
        }

        let postHtml = "<b>" + escapeHtml(post.headline) + "</b>\n\n" + post.body;
        if (post.insight && post.importance >= MIN_INSIGHT_IMPORTANCE) {
            postHtml += "\n\n💡 <i>Что это значит:</i> " + post.insight;
        }
        postHtml += "\n\n⚡ <b>ФАКТОР</b>\n#ФАКТОР";

        const sent = await sendPostToMax(postHtml, uploaded);
        if (sent) {
            console.log("🔥 ОПУБЛИКОВАНО: " + post.headline);
            published++;
            
            await kv.set(["factor", "pub", hash], true, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "topic", hash], { title: item.title, roots: getRoots(item.title) }, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "texthash", textHash], true, { expireIn: HISTORY_TTL_MS });
            if (contentHash) {
                await kv.set(["factor", "content", contentHash], true, { expireIn: HISTORY_TTL_MS });
            }

            recentDescs.push(item.desc);
            if (recentDescs.length > RECENT_HISTORY_LIMIT) recentDescs.shift();
            await kv.set(["factor", "recent_descs"], recentDescs, { expireIn: HISTORY_TTL_MS });

            recentBodies.push(post.body);
            if (recentBodies.length > RECENT_HISTORY_LIMIT) recentBodies.shift();
            await kv.set(["factor", "recent_bodies"], recentBodies, { expireIn: HISTORY_TTL_MS });

            recentTitles.push(post.headline);
            if (recentTitles.length > RECENT_HISTORY_LIMIT) recentTitles.shift();
            await kv.set(["factor", "recent_titles"], recentTitles, { expireIn: HISTORY_TTL_MS });

            const nextDelay = Math.floor(REGULAR_MIN_INTERVAL_MS + Math.random() * (REGULAR_MAX_INTERVAL_MS - REGULAR_MIN_INTERVAL_MS + 1));
            await kv.set(["factor", "next_regular_delay"], nextDelay);
            await kv.set(["factor", "last_regular"], now);
            return;
        }
    }

    console.log(`\nИтого: дублей ${skippedDup}, неважных ${skippedImportance}, без медиа ${skippedNoMedia}, опубликовано ${published}`);
    console.log("Подходящих событий нет.");
}

await run();
