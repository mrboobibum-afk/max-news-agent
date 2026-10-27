// ============================================================
// MAX NEWS AGENT — «ФАКТОР» (Internal Loop v125 - Fixed AI Filter)
// ============================================================

import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";

const MAX_API = "https://platform-api2.max.ru";
const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") ?? "";
const TARGET_CHAT_ID = Deno.env.get("TARGET_CHAT_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DASHSCOPE_API_KEY = Deno.env.get("DASHSCOPE_API_KEY") ?? "";
const QWEN_MODEL = Deno.env.get("QWEN_MODEL") ?? "qwen3.8-max";
const QWEN_BASE_URL = Deno.env.get("QWEN_BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

const MAX_RUNTIME_MS = 4.5 * 60 * 60 * 1000; 
const LOOP_SLEEP_MIN_MS = 4 * 60 * 1000; 
const LOOP_SLEEP_MAX_MS = 6 * 60 * 1000; 
const POST_COOLDOWN_MS = 40 * 60 * 1000; 

const MAX_POST_AGE_MS = 3 * 60 * 60 * 1000; 
const MEDIA_PACKET_MAX = 10; 
const MIN_IMPORTANCE = 6; 
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STATE_MAX_ENTRIES = 300;
const STATE_KEEP_ENTRIES = 50; 

const RECENT_HISTORY_LIMIT = 20; 
const SIMILARITY_THRESHOLD = 0.25;

const MIN_IMAGE_BYTES = 10 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_VIDEO_BYTES = 50 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; 

const DOWNLOAD_TIMEOUT_MS = 60000; 
const LLM_TIMEOUT_MS = 40000; 

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
    } catch (e) { console.error("CA Init Error:", e); }
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
    "1tv_news", "ntvru", "izvestya", "rgru_news",
    "readovkanews", "bazabazon", "shot_shot", "mash"
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
    /(?:рэц|экспортер|клиентск|госуслуг|росреестр)/i, 
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
    /(?:пятница|пятницу|13 населенных|освободили|наша территория|фортуна|отворачивается|свои готовы)/i,
    /(?:илон маск|маск|илона маска)/i,
    /(?:ситуация требует внимания|следим за развитием событий|ситуация подчеркивает)/i,
    /(?:туристка|умерла|скончалась|потеряла равновесие|упала с высоты|сорвалась)/i,
    /(?:чемпионат|соревновани[яе]|турнир|учени[яе]|тактика дронов|эк-министр|финансовый спор)/i,
    /(?:внутренние разногласия|внешние угрозы|разобщенность властей)/i
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
        try {
            await Deno.writeTextFile(this.file, JSON.stringify(d, null, 2) + "\n");
        } catch (e) { console.error("Ошибка записи state:", e); }
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
        try {
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
        } catch (e) {
            console.error("Cleanup error:", e);
            return { removedExpired: 0, removedOld: 0, removedOverflow: 0, kept: 0 };
        }
    }
}

const kv = new FileKV();

function isGibberish(text: string): boolean {
    if (!text) return true;
    const badChars = (text.match(/�/g) || []).length;
    return badChars > 5 || (badChars > 0 && badChars / text.length > 0.1);
}

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
    t = t.replace(/([а-я])([А-Я])/g, "$1 $2");
    return t;
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
        if (fm >= 3 && titleRoots.length > 0) return true; 
    }
    return false;
}

async function getContentHash(text: string): Promise<string> {
    const clean = text.toLowerCase().replace(/[^a-zа-я0-9]/gi, "").slice(0, 100);
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
    if (low.includes(".mp4") || low.includes("telegram-cdn.org")) return false;
    return (
        low.includes("/card") || low.includes("textcard") || low.includes("share") ||
        low.includes("logo") || low.includes("avatar") || low.includes("stub") ||
        low.includes("1x1") || low.includes("pixel") || low.includes(".svg") ||
        low.includes("google.com") || low.includes("interfax.ru/ftproot") ||
        low.includes("data:image") || low.includes("base64,")
    );
}

async function downloadBuffer(url: string, isVideo = false): Promise<Uint8Array | null> {
    if (!url || isTrashUrl(url)) return null;

    const proxyUrls = isVideo 
        ? [url, `https://corsproxy.io/?${encodeURIComponent(url)}`]
        : [`https://corsproxy.io/?${encodeURIComponent(url)}`, url];
        
    const timeout = isVideo ? 120000 : DOWNLOAD_TIMEOUT_MS;

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
    
    h = h.replace(/\.+$/, "").replace(/…$/, "");

    if (h.length < 10 || h.endsWith("-") || h.endsWith(",")) return fallbackHead;
    
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

async function extractMediaFromUrl(url: string): Promise<{ video: string[], image: string[] }> {
    const res = { video: [] as string[], image: [] as string[] };
    if (!url) return res;
    try {
        const r = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return res;
        const html = await r.text();

        const vMatches = [
            ...html.matchAll(/https?:\/\/[^"'\s>]+?\.mp4(?:\?[^"'\s>]*)?/gi),
            ...html.matchAll(/<video[^>]+src=["']([^"']+)["']/gi),
            ...html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi),
            ...html.matchAll(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/gi)
        ].map(m => m[1] || m[0]);
        res.video = [...new Set(vMatches)].filter(u => !isTrashUrl(u));

        const imgMatches = [
            ...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi),
            ...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
        ].map(m => m[1]);
        res.image = [...new Set(imgMatches)].filter(u => !isTrashUrl(u));
    } catch(e) {}
    return res;
}

async function fetchTelegramLiveFeed(): Promise<any[]> {
    const liveItems: any[] = [];
    const now = Date.now();
    for (const ch of TG_LIVE_CHANNELS) {
        try {
            const res = await fetch(`https://t.me/s/${ch}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) continue;
            const html = await res.text();
            const posts = html.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|$)/gi) ?? [];
            
            for (const post of posts.slice(-15).reverse()) {
                const postDate = extractPostDate(post);
                if (postDate && (now - postDate) > MAX_POST_AGE_MS) continue;

                const textRaw = cleanText(post.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
                if (!textRaw || textRaw.length < 50 || textRaw.length > 2000) continue;
                if (isGibberish(textRaw)) continue;
                if (BORING_TOPICS.some(r => r.test(textRaw))) continue;

                const sanitized = sanitizeRawText(textRaw);
                const firstSentence = sanitized.split(/[.!?]\s/)[0] || sanitized;
                const truncatedTitle = firstSentence.slice(0, 90); 

                const postIdMatch = post.match(/data-post=["']([^"']+)["']/i);
                const postKey = postIdMatch ? postIdMatch[1] : "tg_" + simpleHash(sanitized);

                const images = [
                    ...post.matchAll(/<a[^>]+class="tgme_widget_message_photo_wrap[^"]*"[^>]+style="[^"]*background-image:url\('([^']+)'\)/gi),
                    ...post.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
                ].map(m => m[1]).filter(u => !isTrashUrl(u));

                let videos: string[] = [];
                const hasVideo = post.includes("tgme_widget_message_video_player") || post.includes("tgme_widget_message_roundvideo");

                if (hasVideo && postKey) {
                    try {
                        const embedUrl = `https://t.me/${postKey}?embed=1&mode=tme`;
                        const vRes = await fetch(embedUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
                        if (vRes.ok) {
                            const vHtml = await vRes.text();
                            videos = [
                                ...vHtml.matchAll(/<video[^>]+src=["']([^"']+)["']/gi),
                                ...vHtml.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)
                            ].map(m => m[1]);
                        }
                    } catch(e) {}
                }

                const mediaUrls: any[] = [];
                const uniqueVideos = [...new Set(videos)];
                const uniqueImages = [...new Set(images)];

                uniqueVideos.forEach(url => mediaUrls.push({ mediaUrl: url, mediaType: "video" }));
                uniqueImages.forEach(url => mediaUrls.push({ mediaUrl: url, mediaType: "image" }));

                if (mediaUrls.length > 0) {
                    mediaUrls.forEach(media => {
                        liveItems.push({ title: truncatedTitle, desc: sanitized, mediaUrl: media.mediaUrl, mediaType: media.mediaType, sourceName: ch, sourceType: "tg", postKey, postDate: postDate || 0 });
                    });
                } else {
                    liveItems.push({ title: truncatedTitle, desc: sanitized, mediaUrl: null, mediaType: "none", sourceName: ch, sourceType: "tg", postKey, postDate: postDate || 0 });
                }
            }
        } catch (e) { }
    }
    return liveItems;
}

async function fetchRssFeeds(): Promise<any[]> {
    const items: any[] = [];
    const now = Date.now();
    await Promise.all(NEWS_FEEDS.map(async (feed) => {
        try {
            const res = await fetch(feed.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (!res.ok) return;
            const xml = await res.text();
            for (const raw of (xml.match(/<item[\s\S]*?<\/item>/gi) ?? []).slice(0, 15)) {
                
                const pubDateMatch = raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
                if (pubDateMatch) {
                    const pubDate = Date.parse(pubDateMatch[1]);
                    if (isNaN(pubDate) || (now - pubDate) > MAX_POST_AGE_MS) continue;
                }

                const title = sanitizeRawText(raw.match(/<title[\s\S]*?>([\s\S]*?)<\/title>/i)?.[1] ?? "");
                const descHtml = raw.match(/<description[\s\S]*?>([\s\S]*?)<\/description>/i)?.[1] ?? "";
                const desc = sanitizeRawText(descHtml);
                const link = cleanText(raw.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);
                
                if (isGibberish(title) || isGibberish(desc)) continue;
                if (BORING_TOPICS.some(r => r.test(`${title} ${desc}`))) continue;
                if (!title || desc.endsWith("...") || desc.endsWith("…") || desc.length < 200) continue;

                const truncatedTitle = title.slice(0, 90);
                const postKey = `${feed.name.toLowerCase()}_${simpleHash(title + (link || ""))}`;
                
                const enclosureImg = raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1];
                const mediaContent = raw.match(/<media:content[^>]+url=["']([^"']+)["']/i)?.[1];
                const mediaThumbnail = raw.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1];
                const imgMatches = [...descHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
                
                let uniqueImages = [...new Set([enclosureImg, mediaContent, mediaThumbnail, ...imgMatches].filter(Boolean).filter(u => !isTrashUrl(u)))];
                let uniqueVideos: string[] = [];

                if (link) {
                    const deepMedia = await extractMediaFromUrl(link);
                    if (deepMedia.video.length > 0) uniqueVideos = deepMedia.video;
                    if (uniqueImages.length === 0 && deepMedia.image.length > 0) uniqueImages = deepMedia.image.slice(0, 5);
                }

                const mediaUrls: any[] = [];
                uniqueVideos.forEach(v => mediaUrls.push({ mediaUrl: v, mediaType: "video" }));
                uniqueImages.forEach(i => mediaUrls.push({ mediaUrl: i, mediaType: "image" }));

                if (mediaUrls.length > 0) {
                    mediaUrls.forEach(media => {
                        items.push({ title: truncatedTitle, desc, mediaUrl: media.mediaUrl, mediaType: media.mediaType, sourceName: feed.name, sourceType: "rss", postKey, postDate: pubDateMatch ? Date.parse(pubDateMatch[1]) : 0 });
                    });
                } else {
                    items.push({ title: truncatedTitle, desc, mediaUrl: null, mediaType: "none", sourceName: feed.name, sourceType: "rss", postKey, postDate: pubDateMatch ? Date.parse(pubDateMatch[1]) : 0 });
                }
            }
        } catch (e) { }
    }));
    return items;
}

async function formatNewsPost(title: string, desc: string): Promise<{ headline: string, body: string, insight: string, importance: number, is_ad: boolean, hashtag: string }> {
    try {
        let cleanDesc = sanitizeRawText(desc);
        const fallbackHeadline = sanitizeRawText(title).replace(/\s+[-—]\s+.*$/, "").slice(0, 90);
        
        if (cleanDesc.toLowerCase().startsWith(fallbackHeadline.toLowerCase())) {
            cleanDesc = cleanDesc.slice(fallbackHeadline.length).trim();
            cleanDesc = cleanDesc.replace(/^[-—:.\s]+/, ''); 
        }

        const prompt = `Ты — главный редактор аналитического канала «ФАКТОР». Твоя цель — давать сбалансированную картину мира: политика, экономика, международные отношения, технологии и важные события в России. Твой стиль — строго, информативно, с фактами. Пиши так же четко и по делу, как канал «Прямой Эфир».

ИСХОДНЫЙ ТЕКСТ:
${cleanDesc}

ТВОИ ЗАДАЧИ:
1. headline — заголовок (до 8 слов) с 1 эмодзи (⚡️, 📍, 📊, 💰, 🌍, ⚠️, 🚨). КАТЕГОРИЧЕСКИ БЕЗ МНОГОТОЧИЙ. Ярко и точно.
2. body — Оформи текст как список из 2-3 КОРОТКИХ пунктов (до 15 слов каждый). 
   - Каждый пункт начинай с маркера ▪️.
   - Включи ТОЛЬКО ключевые факты (имена, цифры).
   - Выдели главные акценты тегами <b>жирный шрифт</b>.
   - ПИШИ СТРОГО НА РУССКОМ ЯЗЫКЕ. Верни ОДНУ СТРОКУ с переносами \n. НЕ ОБРЫВАЙ ПРЕДЛОЖЕНИЯ.
3. insight — (Взгляд ФАКТОРА) — 1-2 предложения (до 20 слов). Оцени последствия для обычного человека: что будет с ценами, безопасностью или экономикой. БЕЗ ТЕГОВ HTML.
4. importance — целое 1-10. (9-10 экстренно, 7-8 политика/экономика, 1-6 бытовуха).
5. is_ad — true, если это реклама.
6. hashtag — выбери один тег по теме: #Политика, #Экономика, #Мир, #Происшествия, #Технологии, #Россия.

Верни ТОЛЬКО JSON: {"headline": "...", "body": "...", "insight": "...", "importance": 8, "is_ad": false, "hashtag": "#Политика"}`;

        let llmResult: any = null;

        if (GEMINI_API_KEY) {
            try {
                const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } }),
                    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
                });
                if (r.ok) {
                    const j = await r.json();
                    let text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) llmResult = JSON.parse(match[0]);
                }
            } catch (e) {}
        }

        if (!llmResult && DASHSCOPE_API_KEY) {
            try {
                const r = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DASHSCOPE_API_KEY}` },
                    body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
                    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
                });
                if (r.ok) {
                    const j = await r.json();
                    let text = j?.choices?.[0]?.message?.content ?? "";
                    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) llmResult = JSON.parse(match[0]);
                }
            } catch (e) {}
        }

        if (llmResult) {
            let headlineStr = String(llmResult.headline || "").trim();
            let bodyStr = llmResult.body;
            
            if (Array.isArray(bodyStr)) {
                bodyStr = bodyStr.map((b: any) => String(b).replace(/^[-*▪️\s]+/, "").trim()).join("\n▪️ ");
                if (bodyStr) bodyStr = "▪️ " + bodyStr;
            } else {
                bodyStr = String(bodyStr || "").trim();
            }
            
            const insightStr = String(llmResult.insight || "").replace(/<[^>]*>/g, "").trim();

            if (headlineStr && bodyStr) {
                const isEnglish = (bodyStr.match(/[a-zA-Z]/g) || []).length > (bodyStr.match(/[а-яА-Я]/g) || []).length;
                
                if (!isEnglish) {
                    return {
                        headline: validateHeadline(headlineStr, fallbackHeadline),
                        body: bodyStr,
                        insight: insightStr,
                        importance: Number(llmResult.importance) || 5,
                        is_ad: !!llmResult.is_ad,
                        hashtag: llmResult.hashtag || "#Новости"
                    };
                }
            }
        }

        return { headline: "", body: "", insight: "", importance: 0, is_ad: false, hashtag: "" };
    } catch (e) {
        return { headline: "", body: "", insight: "", importance: 0, is_ad: false, hashtag: "" };
    }
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
        signal: AbortSignal.timeout(120000)
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

let publishesSinceCommit = 0;

async function commitStateToGit() {
    try {
        const runGit = async (args: string[]) => {
            const p = new Deno.Command("git", { args, stdout: "piped", stderr: "piped" });
            return await p.output();
        };
        
        await runGit(["add", ".factor-state.json"]);
        const diff = await runGit(["diff", "--cached", "--quiet"]);
        if (diff.success) return; 

        await runGit(["config", "user.name", "github-actions[bot]"]);
        await runGit(["config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
        await runGit(["commit", "-m", "Update state [skip ci]", "--no-verify"]);
        
        const pull = await runGit(["pull", "--rebase", "origin", "main"]);
        if (!pull.success) console.error("Git pull failed:", new TextDecoder().decode(pull.stderr));
        
        const push = await runGit(["push", "origin", "main"]);
        if (!push.success) console.error("Git push failed:", new TextDecoder().decode(push.stderr));
        else console.log("💾 Прогресс сохранен в GitHub");
    } catch (e) {
        console.error("Ошибка коммита:", e);
    }
}

async function run(): Promise<boolean> {
    console.log("=== ФАКТОР v125: Запуск отбора событий (Fixed AI) ===");
    
    const lastPostTime = (await kv.get(["factor", "last_post_time"])).value || 0;
    const timeSinceLastPost = Date.now() - lastPostTime;
    
    if (timeSinceLastPost < POST_COOLDOWN_MS) {
        const waitMin = Math.round((POST_COOLDOWN_MS - timeSinceLastPost) / 60000);
        console.log(`⏳ Замок активен. Прошло ${Math.round(timeSinceLastPost/60000)} мин. Ждем еще ${waitMin} мин.`);
        return false;
    }

    try {
        const stat = await kv.cleanup();
        console.log(`Очистка state: удалено ${stat.removedExpired} просроченных, ${stat.removedOld} старых, ${stat.removedOverflow} лишних; оставлено ${stat.kept}`);
    } catch (e) { console.log("Очистка state не удалась, пропускаем..."); }

    const tgCandidates = await fetchTelegramLiveFeed();
    const rssCandidates = await fetchRssFeeds();
    console.log(`Кандидатов: TG ${tgCandidates.length}, RSS ${rssCandidates.length}`);

    tgCandidates.sort((a, b) => b.postDate - a.postDate);
    rssCandidates.sort((a, b) => b.postDate - a.postDate);
    
    const mixedCandidates: any[] = [];
    const maxLen = Math.max(tgCandidates.length, rssCandidates.length);
    for (let i = 0; i < maxLen; i++) {
        if (i < tgCandidates.length) mixedCandidates.push(tgCandidates[i]);
        if (i < rssCandidates.length) mixedCandidates.push(rssCandidates[i]);
    }

    const seenPostKeys = new Set<string>();
    const uniqueCandidates: any[] = [];
    for (const c of mixedCandidates) {
        const key = c.postKey || c.title;
        if (seenPostKeys.has(key)) continue;
        seenPostKeys.add(key);
        uniqueCandidates.push(c);
    }

    const topCandidates = uniqueCandidates.slice(0, 25);

    let skippedDup = 0, skippedImportance = 0, skippedNoMedia = 0, published = 0;

    const recentDescs: string[] = (await kv.get(["factor", "recent_descs"])).value || [];
    const recentBodies: string[] = (await kv.get(["factor", "recent_bodies"])).value || [];
    const recentTitles: string[] = (await kv.get(["factor", "recent_titles"])).value || [];

    for (const item of topCandidates) {
        try {
            if (isGibberish(item.title) || isGibberish(item.desc)) { skippedDup++; continue; }

            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title))))
                .map(b => b.toString(16).padStart(2, "0")).join("");

            if ((await kv.get(["factor", "pub", hash])).value) { skippedDup++; continue; }
            if (await isDuplicate(item.title, item.desc)) { skippedDup++; continue; }

            const contentHash = await getContentHash(item.desc);
            if (contentHash && (await kv.get(["factor", "content", contentHash])).value) { skippedDup++; continue; }

            let isSimilarFound = false;
            for (const pastDesc of recentDescs) {
                if (isSimilar(item.desc, pastDesc)) { isSimilarFound = true; break; }
            }
            if (isSimilarFound) { skippedDup++; continue; }

            console.log("\nОбработка: " + item.title);

            const mediaPacket = getMediaPacket(item, mixedCandidates);
            const post = await formatNewsPost(item.title, item.desc);

            if (post.is_ad) { skippedImportance++; continue; }

            if (!post.headline || !post.body || post.body.length < 30) {
                console.log(`❌ Пропуск: ИИ не смог сделать идеальный пост.`);
                skippedNoMedia++;
                continue;
            }

            let finalImportance = post.importance;
            const rawTextLower = item.desc.toLowerCase();
            if (/(?:путин|трамп|зеленск|бпла|дрон|атака|удар|погиб|пострадавш|цб|ставка|санкци|госдума|ушаков|лавров|мишустин|набиуллин)/i.test(rawTextLower)) {
                finalImportance = 8; 
            }

            // 🚀 УМНОЕ ПРАВИЛО МЕДИА: Если нет медиа, публикуем ТОЛЬКО если новость архиважная (8+)
            if (mediaPacket.length === 0 && finalImportance < 8) {
                console.log(`❌ Пропуск: нет медиа, и новость не экстренная (важность ${finalImportance}).`);
                skippedNoMedia++;
                continue;
            }

            if (finalImportance < MIN_IMPORTANCE) { skippedImportance++; continue; }

            let isTitleSimilar = false;
            for (const pastTitle of recentTitles) {
                if (isSimilar(post.headline, pastTitle)) { isTitleSimilar = true; break; }
            }
            if (isTitleSimilar) { skippedDup++; continue; }

            const textHash = await getTextHash(post.body);
            if ((await kv.get(["factor", "texthash", textHash])).value) { skippedDup++; continue; }

            const uploaded: Array<{ token: string; type: "image" | "video" }> = [];
            
            for (const media of mediaPacket) {
                let mediaBytes = await downloadBuffer(media.mediaUrl, media.mediaType === "video");
                if (!mediaBytes) continue;

                if (media.mediaType === "image") {
                    mediaBytes = await applyBrandOverlay(mediaBytes);
                }

                try {
                    const token = await uploadToMax(mediaBytes, media.mediaType);
                    if (token) uploaded.push({ token, type: media.mediaType });
                } catch (e) { console.error("Ошибка загрузки медиа:", e); }
                if (uploaded.length >= MEDIA_PACKET_MAX) break;
            }

            if (uploaded.length === 0 && mediaPacket.length > 0) {
                console.log(`⚠️ Медиа было, но не скачалось. Публикуем без него (важность ${finalImportance}).`);
            }

            let postHtml = `<b>${escapeHtml(post.headline)}</b>\n\n`;
            postHtml += `${post.body}\n\n`;
            
            if (post.insight) postHtml += `💡 <b>Взгляд ФАКТОРА:</b>\n${escapeHtml(post.insight)}\n\n`;
            
            postHtml += `⚡️ <b>ФАКТОР</b> | ${post.hashtag}`;

            const sent = await sendPostToMax(postHtml, uploaded);
            if (sent) {
                console.log("🔥 ОПУБЛИКОВАНО: " + post.headline);
                published++;
                publishesSinceCommit++;
                
                await kv.set(["factor", "last_post_time"], Date.now());

                await kv.set(["factor", "pub", hash], true, { expireIn: HISTORY_TTL_MS });
                await kv.set(["factor", "topic", hash], { title: item.title, roots: getRoots(item.title) }, { expireIn: HISTORY_TTL_MS });
                await kv.set(["factor", "texthash", textHash], true, { expireIn: HISTORY_TTL_MS });
                if (contentHash) await kv.set(["factor", "content", contentHash], true, { expireIn: HISTORY_TTL_MS });

                recentDescs.push(item.desc); if (recentDescs.length > RECENT_HISTORY_LIMIT) recentDescs.shift();
                await kv.set(["factor", "recent_descs"], recentDescs, { expireIn: HISTORY_TTL_MS });

                recentBodies.push(post.body); if (recentBodies.length > RECENT_HISTORY_LIMIT) recentBodies.shift();
                await kv.set(["factor", "recent_bodies"], recentBodies, { expireIn: HISTORY_TTL_MS });

                recentTitles.push(post.headline); if (recentTitles.length > RECENT_HISTORY_LIMIT) recentTitles.shift();
                await kv.set(["factor", "recent_titles"], recentTitles, { expireIn: HISTORY_TTL_MS });

                await commitStateToGit();
                publishesSinceCommit = 0;

                return true; 
            }
        } catch (itemError) {
            console.error("Ошибка при обработке новости:", itemError);
        }
    }
    console.log(`\nИтого: дублей ${skippedDup}, неважных ${skippedImportance}, без медиа ${skippedNoMedia}, опубликовано ${published}`);
    return false;
}

const startTime = Date.now();

while (Date.now() - startTime < MAX_RUNTIME_MS) {
    let posted = false;
    try {
        posted = await run();
    } catch (globalError) {
        console.error("🚨 ГЛОБАЛЬНАЯ ОШИБКА ЦИКЛА:", globalError);
    }

    if (publishesSinceCommit >= 3) {
        await commitStateToGit();
        publishesSinceCommit = 0;
    }

    if (posted) {
        console.log(`\n😴 Пост опубликован. Ждем завершения таймера (40 мин)...`);
        await new Promise(r => setTimeout(r, LOOP_SLEEP_MIN_MS));
    } else {
        const sleepMs = LOOP_SLEEP_MIN_MS + Math.random() * (LOOP_SLEEP_MAX_MS - LOOP_SLEEP_MIN_MS);
        console.log(`\n💤 Новых новостей нет. Ожидание ${Math.round(sleepMs / 60000)} мин...`);
        await new Promise(r => setTimeout(r, sleepMs));
    }
}

await commitStateToGit();
console.log("=== Время работы цикла истекло. Завершаем. ===");
Deno.exit(0);
