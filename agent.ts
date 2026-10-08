// ============================================================
// MAX NEWS AGENT — ФАКТОР (Чистый прямой эфир)
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

const MIN_IMAGE_BYTES = 3 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const RSS_FEEDS = [
    { category: "ГЛАВНОЕ", url: "https://news.google.com/rss?hl=ru&gl=RU&ceid=RU:ru" },
    { category: "РОССИЯ", url: "https://news.google.com/rss/search?q=Россия+OR+Москва+OR+Казань+OR+Сибирь&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "ИНЦИДЕНТЫ", url: "https://news.google.com/rss/search?q=ЧП+OR+крушение+OR+стихия+OR+БПЛА+OR+пожар&hl=ru&gl=RU&ceid=RU:ru" },
    { category: "МИР", url: "https://news.google.com/rss/search?q=мир+OR+США+OR+Китай+OR+Европа&hl=ru&gl=RU&ceid=RU:ru" },
];

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Сертификаты MAX
const MAX_ROOT_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";
const MAX_SUB_CA_URL = "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";
let maxHttpClient: Deno.HttpClient | null = null;

async function initMaxHttpClient() {
    if (maxHttpClient) return maxHttpClient;
    try {
        const [rootRes, subRes] = await Promise.all([
            fetch(MAX_ROOT_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) }),
            fetch(MAX_SUB_CA_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) }),
        ]);
        if (rootRes.ok && subRes.ok) {
            maxHttpClient = Deno.createHttpClient({ caCerts: [await rootRes.text(), await subRes.text()] });
        }
    } catch {}
    return maxHttpClient;
}

// База данных состояния
class FileKV {
    private filePath = ".factor-state.json";
    private data: any = null;

    async load() {
        if (this.data) return this.data;
        try {
            this.data = JSON.parse(await Deno.readTextFile(this.filePath));
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
        await Deno.writeTextFile(this.filePath, JSON.stringify(d, null, 2) + "\n");
    }

    async getAllTopics() {
        const d = await this.load();
        const now = Date.now();
        const res = [];
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
    const stops = new Set(["россия", "москва", "сегодня", "вчера", "сообщили", "после", "видео", "новости", "словам"]);
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

// Загрузка фото без лишних блокировок
async function fetchCleanImage(url: string): Promise<Uint8Array | null> {
    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12000) });
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength < MIN_IMAGE_BYTES || buf.byteLength > MAX_IMAGE_BYTES) return null;
        return buf;
    } catch {
        return null;
    }
}

function findImageUrl(html: string, base: string): string | null {
    // 1. Метатеги og:image или twitter:image
    const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i)?.[1];
    if (meta && !meta.includes(".svg")) {
        try { return new URL(meta, base).href; } catch {}
    }

    // 2. Первое подходящее фото из статьи
    for (const m of html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi)) {
        const src = m[1];
        if (src && !src.includes("logo") && !src.includes("icon") && !src.includes(".svg") && !src.includes("1x1")) {
            try { return new URL(src, base).href; } catch {}
        }
    }
    return null;
}

// Декодирование Google News в реальную ссылку статьи
async function getRealUrl(link: string): Promise<string> {
    if (!link.includes("news.google.com")) return link;
    try {
        const res = await fetch(link, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000), redirect: "follow" });
        return res.url || link;
    } catch {
        return link;
    }
}

async function makePostText(title: string, desc: string): Promise<{ headline: string, text: string }> {
    const cleanDesc = cleanText(desc).replace(/^(?:тасс|риа|lenta|bfm|gorod55).*?[-—:]\s*/i, "");
    const prompt = `Ты редактор прямого эфира. Сделай молнию по новости:
ЗАГОЛОВОК: ${title}
СУТЬ: ${cleanDesc}
Правила: 1-2 ёмких предложения. Удали все названия сайтов и СМИ.
Формат строго JSON: {"headline": "...", "text": "..."}`;

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

    return {
        headline: cleanText(title).replace(/\s+-\s+.*$/, ""),
        text: cleanDesc.slice(0, 150) + ".",
    };
}

async function uploadToMax(bytes: Uint8Array): Promise<string> {
    const client = await initMaxHttpClient();
    const initRes = await fetch(`${MAX_API}/uploads?type=image`, {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Accept": "application/json" },
        client: client ?? undefined,
    });
    const initData = await initRes.json();
    if (!initData.url) throw new Error("Upload URL error");

    const form = new FormData();
    form.append("data", new Blob([bytes], { type: "image/jpeg" }), "photo.jpg");

    const upRes = await fetch(initData.url, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const text = await upRes.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch {}
    return initData.token || json?.token || json?.photos?.[0]?.token;
}

async function sendMaxMessage(text: string, mediaToken: string | null) {
    const client = await initMaxHttpClient();
    const body: any = { text, format: "html", notify: true, disable_link_preview: true };
    if (mediaToken) body.attachments = [{ type: "image", payload: { token: mediaToken } }];

    const res = await fetch(`${MAX_API}/messages?chat_id=${encodeURIComponent(TARGET_CHAT_ID)}`, {
        method: "POST",
        headers: { "Authorization": MAX_BOT_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        client: client ?? undefined,
    });
    return res.ok;
}

async function run() {
    console.log("=== Старт цикла эфира ===");
    const now = Date.now();

    const lastUrgent = (await kv.get(["factor", "last_urgent"])).value ?? 0;
    const lastRegular = (await kv.get(["factor", "last_regular"])).value ?? 0;
    const canUrgent = now - lastUrgent >= URGENT_INTERVAL_MS;
    const canRegular = now - lastRegular >= REGULAR_INTERVAL_MS;

    if (!canUrgent && !canRegular) {
        console.log("Таймаут эфира активен.");
        return;
    }

    // Собираем новости
    const allItems: any[] = [];
    for (const f of RSS_FEEDS) {
        try {
            const r = await fetch(f.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
            const xml = await r.text();
            for (const item of xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []) {
                const title = cleanText(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
                const link = cleanText(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);
                const desc = cleanText(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1]);
                if (title && link) allItems.push({ title, link, desc, cat: f.category });
            }
        } catch {}
    }

    // Ищем первое уникальное событие
    for (const item of allItems) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.title))))
            .map(b => b.toString(16).padStart(2, "0")).join("");

        if ((await kv.get(["factor", "pub", hash])).value) continue;
        if (await isDuplicate(item.title)) continue;

        console.log(`Обработка новости: ${item.title}`);
        const realUrl = await getRealUrl(item.link);
        let photoBytes: Uint8Array | null = null;

        try {
            const pageRes = await fetch(realUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
            if (pageRes.ok) {
                const html = await pageRes.text();
                const imgUrl = findImageUrl(html, realUrl);
                if (imgUrl) photoBytes = await fetchCleanImage(imgUrl);
            }
        } catch {}

        // Если фото нет на сайте, переходим к следующей новости, чтобы не публиковать «голый» текст
        if (!photoBytes) {
            console.log("Нет подходящего фото для статьи, ищем новость с фото...");
            continue;
        }

        const post = await makePostText(item.title, item.desc);
        const finalHtml = `<b>${escapeHtml(post.headline)}</b>\n\n${escapeHtml(post.text)}\n\n🔗 <a href="${escapeHtml(realUrl)}">${escapeHtml(item.cat)}</a>\n\n⚡ <i>ФАКТОР</i>`;

        let mediaToken: string | null = null;
        try {
            mediaToken = await uploadToMax(photoBytes);
        } catch (e) {
            console.error("Ошибка загрузки фото в MAX:", e);
        }

        const ok = await sendMaxMessage(finalHtml, mediaToken);
        if (ok) {
            console.log(`✅ Вышло в эфир: ${post.headline}`);
            await kv.set(["factor", "pub", hash], true, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "topic", hash], { title: item.title, roots: getRoots(item.title) }, { expireIn: HISTORY_TTL_MS });
            await kv.set(["factor", "last_regular"], now);
            return;
        }
    }

    console.log("Новых событий с готовым медиа не обнаружено.");
}

await run();
