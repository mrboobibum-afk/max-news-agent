// ============================================================
// ФАКТОР — DENO DEPLOY V8
// RSS -> real article -> clean article text -> media search -> MAX
//
// MEDIA PRIORITY:
//
// 1. Видео исходной статьи
// 2. Видео, встроенное в исходную статью
//    (VK / OK / player / eyewitness embed)
// 3. Видео других СМИ по ЭТОЙ ЖЕ новости
// 4. Фото других СМИ по ЭТОЙ ЖЕ новости
// 5. Фото исходного СМИ
// 6. Текст без медиа
//
// SAFE DEFAULT:
// DRY_RUN=true
//
// Пока DRY_RUN=true:
// - ничего не публикуется в MAX
// - медиа не загружается в MAX
// - статья не помечается опубликованной
// - /run только показывает результат
// ============================================================


const MAX_API = "https://platform-api2.max.ru";

const MAX_BOT_TOKEN =
    Deno.env.get("MAX_BOT_TOKEN") ?? "";

const TARGET_CHAT_ID =
    Deno.env.get("TARGET_CHAT_ID") ?? "";

const GEMINI_API_KEY =
    Deno.env.get("GEMINI_API_KEY") ?? "";


// ============================================================
// SAFE MODE
// ============================================================

const DRY_RUN =
    (Deno.env.get("DRY_RUN") ?? "true")
        .toLowerCase() !== "false";


// ============================================================
// TIMERS
// ============================================================

const CRON_SCHEDULE =
    "*/5 * * * *";

const URGENT_INTERVAL_MS =
    5 * 60 * 1000;

const REGULAR_INTERVAL_MS =
    30 * 60 * 1000;

const HISTORY_TTL_MS =
    30 * 24 * 60 * 60 * 1000;

const LOCK_TTL_MS =
    8 * 60 * 1000;


// ============================================================
// MEDIA LIMITS
// ============================================================

const MAX_VIDEO_BYTES =
    Number(
        Deno.env.get("MAX_VIDEO_MB") ?? "200"
    ) * 1024 * 1024;

const MAX_IMAGE_BYTES =
    Number(
        Deno.env.get("MAX_IMAGE_MB") ?? "45"
    ) * 1024 * 1024;


// ============================================================
// PIPELINE LIMITS
// ============================================================

const RSS_LIMIT_PER_FEED = 30;

const MAX_RSS_ITEMS = 300;

const SCORE_CANDIDATES = 45;

const MAX_MEDIA_SEARCH_ARTICLES = 8;

const MAX_MEDIA_PAGE_FETCHES = 18;

const MAX_HISTORY_CHECKED = 300;

const MAX_POST_LENGTH = 3900;


// ============================================================
// USER AGENT
// ============================================================

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/140.0.0.0 Safari/537.36";


// ============================================================
// MAX CERTIFICATES
// ============================================================

const MAX_ROOT_CA_URL =
    "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";

const MAX_SUB_CA_URL =
    "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";

let maxHttpClient = null;

let maxHttpClientError = null;

const maxCaStatus = {
    loaded: false,
    root: false,
    sub: false,
    error: null,
};


// ============================================================
// RSS SOURCES
// ============================================================

const RSS_FEEDS = [
    [
        "МИР",
        "🌍",
        "world OR мир OR международные события",
    ],

    [
        "ПОЛИТИКА",
        "🏛️",
        "политика OR правительство OR президент",
    ],

    [
        "ЭКОНОМИКА",
        "📈",
        "экономика OR инфляция OR ставка OR рынки",
    ],

    [
        "БИЗНЕС",
        "💼",
        "бизнес OR компания OR корпорация OR инвестиции",
    ],

    [
        "ФИНАНСЫ",
        "💰",
        "финансы OR банки OR биржа OR рубль OR доллар",
    ],

    [
        "ПРАВО",
        "⚖️",
        "закон OR суд OR право OR законопроект",
    ],

    [
        "ПРОИСШЕСТВИЯ",
        "🚨",
        "происшествие OR ДТП OR пожар OR авария OR катастрофа",
    ],

    [
        "ТЕХНОЛОГИИ",
        "💻",
        "технологии OR ИИ OR искусственный интеллект OR кибербезопасность",
    ],

    [
        "ПРОМЫШЛЕННОСТЬ",
        "🏭",
        "промышленность OR производство OR энергетика",
    ],

    [
        "АВТО",
        "🚗",
        "авто OR автомобили OR транспорт",
    ],

].map(
    ([category, emoji, q]) => ({
        category,
        emoji,

        url:
            `https://news.google.com/rss/search?q=${
                encodeURIComponent(q)
            }&hl=ru&gl=RU&ceid=RU:ru`,
    })
);


// ============================================================
// DENO KV
// ============================================================

let kv = null;

async function getKV() {
    if (!kv) {
        kv = await Deno.openKv();
    }

    return kv;
}


// ============================================================
// BASIC UTILS
// ============================================================

function sleep(ms) {
    return new Promise(
        (resolve) => setTimeout(resolve, ms)
    );
}


function truncate(value, max) {
    const s =
        String(value ?? "").trim();

    if (s.length <= max) {
        return s;
    }

    return (
        s.slice(0, max - 1)
            .trimEnd() +
        "…"
    );
}


function isHttpUrl(url) {
    return /^https?:\/\//i.test(
        String(url ?? "")
    );
}


function absoluteUrl(value, base) {
    try {
        return new URL(
            value,
            base
        ).href;

    } catch {
        return "";
    }
}


function normalizeUrl(url) {
    try {
        const parsed =
            new URL(url);

        parsed.hash = "";

        for (
            const param of [
                "utm_source",
                "utm_medium",
                "utm_campaign",
                "utm_term",
                "utm_content",
                "gclid",
                "fbclid",
                "yclid",
                "mc_cid",
                "mc_eid",
            ]
        ) {
            parsed.searchParams.delete(
                param
            );
        }

        return parsed.href;

    } catch {
        return "";
    }
}


function decodeEntities(value) {

    return String(value ?? "")

        .replace(
            /&nbsp;/gi,
            " "
        )

        .replace(
            /&amp;/gi,
            "&"
        )

        .replace(
            /&quot;/gi,
            '"'
        )

        .replace(
            /&#39;/gi,
            "'"
        )

        .replace(
            /&#x27;/gi,
            "'"
        )

        .replace(
            /&lt;/gi,
            "<"
        )

        .replace(
            /&gt;/gi,
            ">"
        )

        .replace(
            /&#(\d+);/g,
            (_, n) =>
                String.fromCodePoint(
                    Number(n)
                )
        )

        .replace(
            /&#x([0-9a-f]+);/gi,
            (_, n) =>
                String.fromCodePoint(
                    parseInt(n, 16)
                )
        );
}


function stripHtml(value) {

    return decodeEntities(

        String(value ?? "")

            .replace(
                /<script[\s\S]*?<\/script>/gi,
                " "
            )

            .replace(
                /<style[\s\S]*?<\/style>/gi,
                " "
            )

            .replace(
                /<noscript[\s\S]*?<\/noscript>/gi,
                " "
            )

            .replace(
                /<[^>]+>/g,
                " "
            )

    )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}


function cleanText(value) {

    return stripHtml(
        String(value ?? "")
            .replace(
                /<!\[CDATA\[/gi,
                ""
            )
            .replace(
                /\]\]>/g,
                " "
            )
    );
}


function normalizeForHash(value) {

    return stripHtml(value)
        .toLowerCase()
        .replace(
            /ё/g,
            "е"
        )
        .replace(
            /[^a-zа-я0-9]+/gi,
            " "
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}


function escapeHtml(value) {

    return String(value ?? "")
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        );
}


async function sha256(value) {

    const hash =
        await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
                String(value)
            )
        );

    return [
        ...new Uint8Array(hash),
    ]
        .map(
            (b) =>
                b.toString(16).padStart(2, "0")
        )
        .join("");
}


// ============================================================
// URL VALIDATION
// ============================================================

function isGoogleNewsUrl(url) {

    try {

        const host =
            new URL(url)
                .hostname
                .toLowerCase();

        return (
            host === "news.google.com" ||
            host.endsWith(
                ".news.google.com"
            )
        );

    } catch {
        return false;
    }
}


const BAD_HOSTS = [
    "google.com",
    "googleusercontent.com",
    "gstatic.com",
    "ggpht.com",

    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "t.me",
    "vk.com",
    "ok.ru",
    "linkedin.com",
    "pinterest.com",
    "reddit.com",
];


const BAD_PATHS = [
    "/search",
    "/tag/",
    "/tags/",
    "/category/",
    "/categories/",
    "/author/",
    "/login",
    "/signin",
    "/signup",
    "/register",
    "/privacy",
    "/terms",
    "/about",
    "/contact",
];


function isBadHost(url) {

    try {

        const host =
            new URL(url)
                .hostname
                .toLowerCase();

        return BAD_HOSTS.some(
            (part) =>
                host === part ||
                host.endsWith(
                    "." + part
                )
        );

    } catch {
        return true;
    }
}


function isLikelyArticleUrl(url) {

    if (
        !isHttpUrl(url) ||
        isGoogleNewsUrl(url) ||
        isBadHost(url)
    ) {
        return false;
    }

    try {

        const parsed =
            new URL(url);

        const path =
            parsed.pathname
                .toLowerCase();

        if (
            path === "/" ||
            path.length < 7
        ) {
            return false;
        }

        if (
            BAD_PATHS.some(
                (part) =>
                    path.includes(part)
            )
        ) {
            return false;
        }

        if (
            /\.(jpg|jpeg|png|gif|webp|svg|mp4|mov|webm|m3u8|mpd)$/i.test(
                path
            )
        ) {
            return false;
        }

        return true;

    } catch {
        return false;
    }
}


function normalizeArticleUrl(url) {

    return isLikelyArticleUrl(url)
        ? normalizeUrl(url)
        : "";
}


function hostOf(url) {

    try {

        return new URL(url)
            .hostname
            .toLowerCase()
            .replace(
                /^www\./,
                ""
            );

    } catch {
        return "";
    }
}


// ============================================================
// TITLE MATCHING
// ============================================================

function articleTitleSimilarity(a, b) {

    const A =
        new Set(
            normalizeForHash(a)
                .split(" ")
                .filter(
                    (x) => x.length >= 4
                )
        );

    const B =
        new Set(
            normalizeForHash(b)
                .split(" ")
                .filter(
                    (x) => x.length >= 4
                )
        );

    if (
        !A.size ||
        !B.size
    ) {
        return 0;
    }

    let common = 0;

    for (const token of A) {

        if (B.has(token)) {
            common++;
        }
    }

    return (
        common /
        Math.max(
            A.size,
            B.size
        )
    );
}


function articleTitleMatches(a, b) {

    if (!b) {
        return false;
    }

    const A =
        normalizeForHash(a);

    const B =
        normalizeForHash(b);

    return (
        A === B ||
        A.includes(B) ||
        B.includes(A) ||
        articleTitleSimilarity(
            a,
            b
        ) >= 0.38
    );
}


// ============================================================
// RSS XML
// ============================================================

function xmlTag(xml, tag) {

    return (
        new RegExp(
            `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
            "i"
        )
            .exec(xml)
            ?. [1] ?? ""
    );
}


function xmlTagAttrs(xml, tag) {

    const match =
        new RegExp(
            `<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`,
            "i"
        ).exec(xml);

    return {
        attrs:
            match?.[1] ?? "",

        value:
            match?.[2] ?? "",
    };
}


function xmlAttr(attrs, name) {

    return (
        new RegExp(
            `${name}\\s*=\\s*["']([^"']+)["']`,
            "i"
        )
            .exec(attrs)
            ?. [1] ?? ""
    );
}


function parseRSS(xml, feed) {

    const items = [];

    const matches =
        xml.match(
            /<item\b[\s\S]*?<\/item>/gi
        ) ?? [];

    for (
        const itemXml of
        matches.slice(
            0,
            RSS_LIMIT_PER_FEED
        )
    ) {

        const title =
            cleanText(
                xmlTag(
                    itemXml,
                    "title"
                )
            );

        const link =
            cleanText(
                xmlTag(
                    itemXml,
                    "link"
                )
            ) ||
            cleanText(
                xmlTag(
                    itemXml,
                    "guid"
                )
            );

        const description =
            cleanText(
                xmlTag(
                    itemXml,
                    "description"
                )
            );

        const pubDate =
            cleanText(
                xmlTag(
                    itemXml,
                    "pubDate"
                )
            );

        const sourceTag =
            xmlTagAttrs(
                itemXml,
                "source"
            );

        const source =
            cleanText(
                sourceTag.value
            ) ||
            feed.category;

        const sourceUrl =
            decodeEntities(
                xmlAttr(
                    sourceTag.attrs,
                    "url"
                )
            );

        if (
            !title ||
            !link
        ) {
            continue;
        }

        items.push({
            title,
            link,
            description,
            pubDate,
            source,
            sourceUrl,
            category:
                feed.category,
            categoryEmoji:
                feed.emoji,
            sourceFeed:
                feed.url,
        });
    }

    return items;
}


async function loadRSS(feed) {

    try {

        const response =
            await fetch(
                feed.url,
                {
                    headers: {
                        "User-Agent":
                            USER_AGENT,

                        "Accept":
                            "application/rss+xml, application/xml, text/xml",
                    },

                    signal:
                        AbortSignal.timeout(
                            12000
                        ),
                }
            );

        if (
            !response.ok
        ) {
            return [];
        }

        return parseRSS(
            await response.text(),
            feed
        );

    } catch (error) {

        console.error(
            "RSS",
            feed.category,
            error?.message ??
                String(error)
        );

        return [];
    }
}


// ============================================================
// HTML META
// ============================================================

function findMeta(html, name) {

    const escaped =
        name.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );

    const patterns = [
        new RegExp(
            `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
            "i"
        ),

        new RegExp(
            `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
            "i"
        ),
    ];

    for (
        const pattern of patterns
    ) {

        const match =
            html.match(pattern);

        if (
            match?.[1]
        ) {
            return decodeEntities(
                match[1]
            );
        }
    }

    return "";
}


function extractCanonical(
    html,
    baseUrl
) {

    const match =
        html.match(
            /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i
        ) ||
        html.match(
            /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i
        );

    return match
        ? absoluteUrl(
            decodeEntities(
                match[1]
            ),
            baseUrl
        )
        : "";
}


function extractJsonLd(html) {

    const result = [];

    const blocks =
        html.match(
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
        ) ?? [];

    for (
        const block of blocks
    ) {

        let text =
            block
                .replace(
                    /<script[^>]*>/i,
                    ""
                )
                .replace(
                    /<\/script>\s*$/i,
                    ""
                )
                .trim()
                .replace(
                    /<\!\[CDATA\[/g,
                    ""
                )
                .replace(
                    /\]\]>/g,
                    ""
                );

        try {

            result.push(
                JSON.parse(text)
            );

        } catch {
            // ignore
        }
    }

    return result;
}


function collectJson(
    value,
    callback
) {

    if (
        Array.isArray(value)
    ) {

        for (
            const item of value
        ) {
            collectJson(
                item,
                callback
            );
        }

        return;
    }

    if (
        value &&
        typeof value ===
            "object"
    ) {

        callback(value);

        for (
            const child of
            Object.values(value)
        ) {

            if (
                child &&
                typeof child ===
                    "object"
            ) {
                collectJson(
                    child,
                    callback
                );
            }
        }
    }
}


function extractPageTitle(html) {

    return stripHtml(
        findMeta(
            html,
            "og:title"
        ) ||
        findMeta(
            html,
            "twitter:title"
        ) ||
        (
            html.match(
                /<title\b[^>]*>([\s\S]*?)<\/title>/i
            )?.[1] ?? ""
        )
    );
}


// ============================================================
// ARTICLE TEXT CLEANING
// ============================================================

function cleanArticleText(raw) {

    let text =
        stripHtml(raw);

    if (!text) {
        return "";
    }

    const junk = [
        /аудио создано при помощи технологий искусственного интеллекта/gi,
        /эта ссылка открывает доступ/gi,
        /ваш браузер не поддерживает/gi,
        /подписывайтесь на наш канал/gi,
        /все права защищены/gi,
        /оставить комментарий/gi,
        /добавить комментарий/gi,
        /отменить ответ/gi,
        /ваш адрес email/gi,
        /сохранить мое имя/gi,
        /политика конфиденциальности/gi,
        /cookie/gi,
        /меню/gi,
        /поиск по сайту/gi,
    ];

    for (
        const pattern of junk
    ) {
        text =
            text.replace(
                pattern,
                " "
            );
    }

    return text
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}


// ============================================================
// ARTICLE BODY
// ============================================================

function extractArticleBody(html) {

    // 1. JSON-LD articleBody

    for (
        const data of
        extractJsonLd(html)
    ) {

        let found = "";

        collectJson(
            data,
            (object) => {

                if (
                    !found &&
                    typeof object.articleBody ===
                        "string" &&
                    object.articleBody.length >
                        200
                ) {
                    found =
                        object.articleBody;
                }
            }
        );

        if (found) {

            return cleanArticleText(
                found
            ).slice(
                0,
                14000
            );
        }
    }


    // 2. <article>

    const articleHtml =
        html.match(
            /<article\b[^>]*>([\s\S]*?)<\/article>/i
        )?.[1] ?? "";

    if (
        articleHtml
    ) {

        const text =
            cleanArticleText(
                articleHtml
            );

        if (
            text.length > 250
        ) {
            return text.slice(
                0,
                14000
            );
        }
    }


    // 3. Paragraphs

    const chunks = [];

    for (
        const match of
        html.matchAll(
            /<p\b[^>]*>([\s\S]*?)<\/p>/gi
        )
    ) {

        const text =
            cleanArticleText(
                match[1]
            );

        if (
            text.length >= 40
        ) {
            chunks.push(text);
        }
    }


    const unique = [];

    const seen =
        new Set();

    for (
        const text of chunks
    ) {

        const key =
            normalizeForHash(
                text
            );

        if (
            key &&
            !seen.has(key)
        ) {

            seen.add(key);

            unique.push(
                text
            );
        }
    }

    return unique
        .join(" ")
        .slice(
            0,
            14000
        );
}


// ============================================================
// VIDEO EXTRACTION
// ============================================================

function isDirectVideoUrl(url) {

    const clean =
        String(url)
            .toLowerCase()
            .split("?")[0];

    return /\.(mp4|mov|webm|mkv)$/i.test(
        clean
    );
}


function collectVideoCandidates(
    html,
    baseUrl
) {

    const result = [];

    const add = (value) => {

        if (!value) {
            return;
        }

        const url =
            absoluteUrl(
                decodeEntities(
                    String(value)
                        .replace(
                            /\\\//g,
                            "/"
                        )
                        .replace(
                            /\\u002f/gi,
                            "/"
                        )
                        .replace(
                            /\\u0026/gi,
                            "&"
                        )
                ),
                baseUrl
            );

        if (
            url &&
            !result.includes(url) &&
            isDirectVideoUrl(url)
        ) {
            result.push(url);
        }
    };


    for (
        const name of [
            "og:video",
            "og:video:url",
            "og:video:secure_url",
            "twitter:player:stream",
        ]
    ) {

        add(
            findMeta(
                html,
                name
            )
        );
    }


    for (
        const match of
        html.matchAll(
            /<(?:video|source)[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi
        )
    ) {

        add(
            match[1]
        );
    }


    for (
        const match of
        html.matchAll(
            /(?:contentUrl|videoUrl|video_url|mediaUrl|file)\s*["']?\s*:\s*["']([^"']+)["']/gi
        )
    ) {

        add(
            match[1]
        );
    }


    for (
        const data of
        extractJsonLd(html)
    ) {

        collectJson(
            data,
            (object) => {

                for (
                    const key of [
                        "contentUrl",
                        "videoUrl",
                        "url",
                        "file",
                    ]
                ) {

                    if (
                        typeof object[key] ===
                            "string"
                    ) {
                        add(
                            object[key]
                        );
                    }
                }
            }
        );
    }


    return result.slice(
        0,
        20
    );
}


// ============================================================
// IMAGE EXTRACTION
// ============================================================

function isLikelyImageUrl(url) {

    const clean =
        String(url)
            .toLowerCase()
            .split("?")[0];

    return (
        /\.(jpg|jpeg|png|gif|webp|bmp|tiff|heic)$/i.test(
            clean
        ) ||
        /(image|photo|picture|upload|media|cdn)/i.test(
            clean
        )
    );
}


function collectImageCandidates(
    html,
    baseUrl
) {

    const result = [];

    const add = (value) => {

        if (!value) {
            return;
        }

        const url =
            absoluteUrl(
                decodeEntities(
                    String(value)
                        .replace(
                            /\\\//g,
                            "/"
                        )
                        .replace(
                            /\\u002f/gi,
                            "/"
                        )
                        .replace(
                            /\\u0026/gi,
                            "&"
                        )
                ),
                baseUrl
            );

        if (
            url &&
            !result.includes(url) &&
            isLikelyImageUrl(url)
        ) {
            result.push(url);
        }
    };


    for (
        const name of [
            "og:image",
            "og:image:url",
            "twitter:image",
            "twitter:image:src",
        ]
    ) {

        add(
            findMeta(
                html,
                name
            )
        );
    }


    for (
        const match of
        html.matchAll(
            /<img\b[^>]+(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["'][^>]*>/gi
        )
    ) {

        add(
            match[1]
        );
    }


    for (
        const data of
        extractJsonLd(html)
    ) {

        collectJson(
            data,
            (object) => {

                for (
                    const key of [
                        "image",
                        "thumbnailUrl",
                        "contentUrl",
                    ]
                ) {

                    const value =
                        object[key];

                    if (
                        typeof value ===
                            "string"
                    ) {

                        add(value);

                    } else if (
                        Array.isArray(
                            value
                        )
                    ) {

                        for (
                            const item of
                            value
                        ) {

                            if (
                                typeof item ===
                                    "string"
                            ) {
                                add(item);
                            }
                        }
                    }
                }
            }
        );
    }


    return result.slice(
        0,
        30
    );
}


// ============================================================
// IFRAMES / EMBEDDED VIDEO
// ============================================================

function extractIframeUrls(
    html,
    baseUrl
) {

    const result = [];

    for (
        const match of
        html.matchAll(
            /<(?:iframe|embed)[^>]+(?:src|data-src)=["']([^"']+)["']/gi
        )
    ) {

        const url =
            absoluteUrl(
                decodeEntities(
                    match[1]
                ),
                baseUrl
            );

        if (
            url &&
            !result.includes(url) &&
            isHttpUrl(url)
        ) {
            result.push(url);
        }
    }

    return result.slice(
        0,
        12
    );
}


// ============================================================
// LOAD HTML PAGE
// ============================================================

async function fetchPage(
    url,
    timeout = 18000
) {

    try {

        const response =
            await fetch(
                url,
                {
                    redirect:
                        "follow",

                    headers: {
                        "User-Agent":
                            USER_AGENT,

                        "Accept":
                            "text/html,application/xhtml+xml,*/*;q=0.5",
                    },

                    signal:
                        AbortSignal.timeout(
                            timeout
                        ),
                }
            );

        if (
            !response.ok
        ) {
            return null;
        }

        const contentType =
            (
                response
                    .headers
                    .get(
                        "content-type"
                    ) ?? ""
            ).toLowerCase();

        if (
            contentType &&
            !contentType.includes(
                "text/html"
            ) &&
            !contentType.includes(
                "xhtml"
            )
        ) {
            return null;
        }

        const html =
            await response.text();

        if (
            html.length < 500
        ) {
            return null;
        }

        return {
            finalUrl:
                normalizeUrl(
                    response.url ||
                        url
                ) || url,

            html,
        };

    } catch {
        return null;
    }
}


// ============================================================
// GOOGLE NEWS -> REAL ARTICLE
// ============================================================

async function resolveArticleUrl(item) {

    const raw =
        normalizeUrl(
            item.link
        );

    if (
        !isGoogleNewsUrl(raw)
    ) {

        return isLikelyArticleUrl(
            raw
        )
            ? raw
            : "";
    }


    const googlePage =
        await fetchPage(
            raw,
            18000
        );

    if (
        !googlePage
    ) {
        return "";
    }


    const candidates = [];

    const add = (url) => {

        const normalized =
            normalizeUrl(url);

        if (
            normalized &&
            isLikelyArticleUrl(
                normalized
            ) &&
            !candidates.includes(
                normalized
            )
        ) {

            candidates.push(
                normalized
            );
        }
    };


    add(
        extractCanonical(
            googlePage.html,
            googlePage.finalUrl
        )
    );

    add(
        findMeta(
            googlePage.html,
            "og:url"
        )
    );

    add(
        googlePage.finalUrl
    );


    for (
        const match of
        googlePage.html.matchAll(
            /<a\b[^>]+href=["']([^"']+)["']/gi
        )
    ) {

        const url =
            absoluteUrl(
                decodeEntities(
                    match[1]
                ),
                googlePage.finalUrl
            );

        if (
            url &&
            isLikelyArticleUrl(
                url
            )
        ) {

            add(url);
        }

        if (
            candidates.length >= 20
        ) {
            break;
        }
    }


    const preferredHost =
        hostOf(
            item.sourceUrl
        );


    candidates.sort(
        (a, b) =>
            (
                hostOf(b) ===
                preferredHost
                    ? 100
                    : 0
            ) -
            (
                hostOf(a) ===
                preferredHost
                    ? 100
                    : 0
            )
    );


    for (
        const candidateUrl of
        candidates.slice(
            0,
            12
        )
    ) {

        const page =
            await fetchPage(
                candidateUrl,
                16000
            );

        if (!page) {
            continue;
        }

        const title =
            extractPageTitle(
                page.html
            );

        if (
            articleTitleMatches(
                item.title,
                title
            )
        ) {

            return page.finalUrl;
        }
    }


    return "";
}


// ============================================================
// EXTRACT ARTICLE
// ============================================================

async function extractArticle(
    item
) {

    const articleUrl =
        await resolveArticleUrl(
            item
        );

    if (!articleUrl) {

        return {
            articleUrl: "",
            rejectedReason:
                "bad_url",
        };
    }


    const page =
        await fetchPage(
            articleUrl,
            20000
        );

    if (!page) {

        return {
            articleUrl: "",
            rejectedReason:
                "page_unavailable",
        };
    }


    const pageTitle =
        extractPageTitle(
            page.html
        );

    if (
        pageTitle &&
        !articleTitleMatches(
            item.title,
            pageTitle
        )
    ) {

        return {
            articleUrl: "",
            rejectedReason:
                "title_mismatch",

            pageTitle,
        };
    }


    const videos =
        collectVideoCandidates(
            page.html,
            page.finalUrl
        );

    const images =
        collectImageCandidates(
            page.html,
            page.finalUrl
        );

    const body =
        extractArticleBody(
            page.html
        );

    const description =
        cleanArticleText(
            findMeta(
                page.html,
                "og:description"
            ) ||
            findMeta(
                page.html,
                "description"
            )
        );


    return {
        articleUrl:
            page.finalUrl,

        title:
            pageTitle ||
            item.title,

        description,

        body,

        sourceName:
            cleanText(
                findMeta(
                    page.html,
                    "og:site_name"
                ) ||
                item.source
            ),

        videos,

        images,

        iframes:
            extractIframeUrls(
                page.html,
                page.finalUrl
            ),

        html:
            page.html,
    };
}


// ============================================================
// MEDIA DOWNLOAD
// ============================================================

function extensionFromType(
    type,
    contentType,
    url
) {

    const ct =
        contentType.toLowerCase();

    if (
        type === "video"
    ) {

        if (
            ct.includes("webm")
        ) {
            return "webm";
        }

        if (
            ct.includes("quicktime")
        ) {
            return "mov";
        }

        if (
            ct.includes("matroska")
        ) {
            return "mkv";
        }

        return "mp4";
    }


    if (
        ct.includes("png")
    ) {
        return "png";
    }

    if (
        ct.includes("gif")
    ) {
        return "gif";
    }

    if (
        ct.includes("webp")
    ) {
        return "webp";
    }


    try {

        const match =
            new URL(url)
                .pathname
                .match(
                    /\.([a-z0-9]{2,5})$/i
                );

        if (match) {
            return match[1]
                .toLowerCase();
        }

    } catch {
        // ignore
    }


    return "jpg";
}


async function downloadMedia(
    url,
    type
) {

    try {

        if (
            !isHttpUrl(url)
        ) {
            return null;
        }


        const response =
            await fetch(
                url,
                {
                    redirect:
                        "follow",

                    headers: {
                        "User-Agent":
                            USER_AGENT,

                        "Accept":
                            type === "video"
                                ? "video/mp4,video/webm,video/quicktime,video/*;q=0.9,*/*;q=0.2"
                                : "image/avif,image/webp,image/*,*/*;q=0.5",
                    },

                    signal:
                        AbortSignal.timeout(
                            type === "video"
                                ? 50000
                                : 25000
                        ),
                }
            );


        if (
            !response.ok
        ) {
            return null;
        }


        const contentType =
            (
                response
                    .headers
                    .get(
                        "content-type"
                    ) ?? ""
            ).toLowerCase();


        if (
            contentType.includes(
                "mpegurl"
            ) ||
            contentType.includes(
                "dash"
            ) ||
            contentType.includes(
                "m3u8"
            )
        ) {

            return null;
        }


        const limit =
            type === "video"
                ? MAX_VIDEO_BYTES
                : MAX_IMAGE_BYTES;


        const contentLength =
            Number(
                response
                    .headers
                    .get(
                        "content-length"
                    ) ?? 0
            );


        if (
            contentLength > limit
        ) {
            return null;
        }


        const bytes =
            new Uint8Array(
                await response.arrayBuffer()
            );


        if (
            bytes.byteLength > limit
        ) {
            return null;
        }


        const finalUrl =
            response.url ||
            url;


        if (
            type === "video" &&
            !contentType.startsWith(
                "video/"
            ) &&
            !isDirectVideoUrl(
                finalUrl
            )
        ) {
            return null;
        }


        if (
            type === "image" &&
            !contentType.startsWith(
                "image/"
            ) &&
            !isLikelyImageUrl(
                finalUrl
            )
        ) {
            return null;
        }


        return {
            type,

            bytes,

            contentType:
                contentType ||
                (
                    type === "video"
                        ? "video/mp4"
                        : "image/jpeg"
                ),

            extension:
                extensionFromType(
                    type,
                    contentType,
                    finalUrl
                ),

            sourceUrl:
                finalUrl,
        };

    } catch (error) {

        console.log(
            "media download rejected",
            type,
            url,
            error?.message ??
                String(error)
        );

        return null;
    }
}


// ============================================================
// SEARCH OTHER SOURCES FOR SAME STORY
//
// Google News is used ONLY as a discovery layer.
// We then open the real article and verify its title.
//
// This prevents:
// - random video
// - random image
// - unrelated article
// ============================================================

function makeSearchQueries(
    title
) {

    const t =
        truncate(
            stripHtml(title),
            180
        );

    return [
        `"${t}" видео`,
        `${t} видео очевидцы`,
        `${t} кадры`,
        `${t} фото`,
    ];
}


async function googleNewsSearch(
    query
) {

    const url =
        `https://news.google.com/rss/search?q=${
            encodeURIComponent(query)
        }&hl=ru&gl=RU&ceid=RU:ru`;

    try {

        const response =
            await fetch(
                url,
                {
                    headers: {
                        "User-Agent":
                            USER_AGENT,

                        "Accept":
                            "application/rss+xml, application/xml, text/xml",
                    },

                    signal:
                        AbortSignal.timeout(
                            12000
                        ),
                }
            );

        if (
            !response.ok
        ) {
            return [];
        }

        return parseRSS(
            await response.text(),
            {
                category:
                    "SEARCH",

                emoji: "",

                url,
            }
        );

    } catch {
        return [];
    }
}


async function collectExternalMedia(
    item,
    article
) {

    const candidates = [];

    const seen =
        new Set();

    let pageFetches = 0;


    const addPage =
        async (
            candidate
        ) => {

            if (
                pageFetches >=
                MAX_MEDIA_PAGE_FETCHES
            ) {
                return;
            }


            const url =
                normalizeUrl(
                    candidate.link
                );


            if (
                !url ||
                isGoogleNewsUrl(url) ||
                seen.has(url)
            ) {
                return;
            }


            seen.add(url);

            pageFetches++;


            const page =
                await fetchPage(
                    url,
                    14000
                );

            if (!page) {
                return;
            }


            const title =
                extractPageTitle(
                    page.html
                );


            if (
                !articleTitleMatches(
                    item.title,
                    title
                )
            ) {
                return;
            }


            for (
                const video of
                collectVideoCandidates(
                    page.html,
                    page.finalUrl
                )
            ) {

                candidates.push({
                    kind:
                        "external_video",

                    url:
                        video,

                    source:
                        title ||
                        candidate.source,

                    articleUrl:
                        page.finalUrl,
                });
            }


            for (
                const image of
                collectImageCandidates(
                    page.html,
                    page.finalUrl
                )
            ) {

                candidates.push({
                    kind:
                        "external_image",

                    url:
                        image,

                    source:
                        title ||
                        candidate.source,

                    articleUrl:
                        page.finalUrl,
                });
            }


            for (
                const iframe of
                extractIframeUrls(
                    page.html,
                    page.finalUrl
                )
            ) {

                if (
                    pageFetches >=
                    MAX_MEDIA_PAGE_FETCHES
                ) {
                    break;
                }


                const iframePage =
                    await fetchPage(
                        iframe,
                        10000
                    );

                if (
                    !iframePage
                ) {
                    continue;
                }


                pageFetches++;


                const iframeTitle =
                    extractPageTitle(
                        iframePage.html
                    );


                if (
                    !articleTitleMatches(
                        item.title,
                        iframeTitle
                    ) &&
                    !/video|player|embed/i.test(
                        iframe
                    )
                ) {
                    continue;
                }


                for (
                    const video of
                    collectVideoCandidates(
                        iframePage.html,
                        iframePage.finalUrl
                    )
                ) {

                    candidates.push({
                        kind:
                            "external_video",

                        url:
                            video,

                        source:
                            title ||
                            candidate.source,

                        articleUrl:
                            page.finalUrl,
                    });
                }
            }
        };


    for (
        const query of
        makeSearchQueries(
            item.title
        )
    ) {

        const results =
            await googleNewsSearch(
                query
            );


        for (
            const result of
            results.slice(
                0,
                MAX_MEDIA_SEARCH_ARTICLES
            )
        ) {

            if (
                hostOf(
                    result.link
                ) ===
                hostOf(
                    article.articleUrl
                )
            ) {
                continue;
            }


            await addPage(
                result
            );
        }
    }


    return candidates;
}


// ============================================================
// EMBEDDED VIDEO FROM ORIGINAL ARTICLE
//
// This is important for VK / OK / custom players.
// The article itself may not expose MP4 directly, but iframe does.
// ============================================================

async function collectEmbeddedVideos(
    article
) {

    const result = [];

    for (
        const iframe of
        article.iframes ?? []
    ) {

        const page =
            await fetchPage(
                iframe,
                10000
            );

        if (!page) {
            continue;
        }


        for (
            const video of
            collectVideoCandidates(
                page.html,
                page.finalUrl
            )
        ) {

            result.push({
                url:
                    video,

                source:
                    iframe,

                page:
                    article.articleUrl,
            });
        }


        if (
            result.length >= 12
        ) {
            break;
        }
    }


    return result;
}


// ============================================================
// FINAL MEDIA PRIORITY
// ============================================================

async function findBestMedia(
    item,
    article
) {

    // --------------------------------------------------------
    // A. ORIGINAL ARTICLE VIDEO
    // --------------------------------------------------------

    for (
        const url of
        article.videos ?? []
    ) {

        const media =
            await downloadMedia(
                url,
                "video"
            );

        if (media) {

            return {
                ...media,

                mediaSource:
                    "article_video",

                mediaPage:
                    article.articleUrl,
            };
        }
    }


    // --------------------------------------------------------
    // B. VIDEO EMBEDDED IN ORIGINAL ARTICLE
    // VK / OK / player / eyewitness embed
    // --------------------------------------------------------

    const embeddedVideos =
        await collectEmbeddedVideos(
            article
        );


    for (
        const candidate of
        embeddedVideos
    ) {

        const media =
            await downloadMedia(
                candidate.url,
                "video"
            );

        if (media) {

            return {
                ...media,

                mediaSource:
                    "embedded_video",

                mediaPage:
                    candidate.page,

                mediaSourceName:
                    candidate.source,
            };
        }
    }


    // --------------------------------------------------------
    // C. VIDEO FROM OTHER MEDIA
    // --------------------------------------------------------

    const external =
        await collectExternalMedia(
            item,
            article
        );


    for (
        const candidate of
        external.filter(
            (x) =>
                x.kind ===
                "external_video"
        )
    ) {

        const media =
            await downloadMedia(
                candidate.url,
                "video"
            );

        if (media) {

            return {
                ...media,

                mediaSource:
                    "external_video",

                mediaPage:
                    candidate.articleUrl,

                mediaSourceName:
                    candidate.source,
            };
        }
    }


    // --------------------------------------------------------
    // D. PHOTO FROM OTHER MEDIA
    // --------------------------------------------------------

    for (
        const candidate of
        external.filter(
            (x) =>
                x.kind ===
                "external_image"
        )
    ) {

        const media =
            await downloadMedia(
                candidate.url,
                "image"
            );

        if (media) {

            return {
                ...media,

                mediaSource:
                    "external_image",

                mediaPage:
                    candidate.articleUrl,

                mediaSourceName:
                    candidate.source,
            };
        }
    }


    // --------------------------------------------------------
    // E. PHOTO FROM ORIGINAL ARTICLE
    // --------------------------------------------------------

    for (
        const url of
        article.images ?? []
    ) {

        const media =
            await downloadMedia(
                url,
                "image"
            );

        if (media) {

            return {
                ...media,

                mediaSource:
                    "article_image",

                mediaPage:
                    article.articleUrl,
            };
        }
    }


    // --------------------------------------------------------
    // F. NO MEDIA
    // --------------------------------------------------------

    return null;
}


// ============================================================
// GEMINI
// ============================================================

function extractJson(text) {

    try {

        return JSON.parse(
            text
                .replace(
                    /^```json/i,
                    ""
                )
                .replace(
                    /^```/i,
                    ""
                )
                .replace(
                    /```$/i,
                    ""
                )
                .trim()
        );

    } catch {

        const match =
            text.match(
                /\{[\s\S]*\}/
            );

        try {

            return match
                ? JSON.parse(
                    match[0]
                )
                : null;

        } catch {

            return null;
        }
    }
}


async function callGemini(
    item,
    article
) {

    if (
        !GEMINI_API_KEY
    ) {
        return null;
    }


    const sourceText =
        truncate(
            cleanArticleText(
                article.body ||
                article.description ||
                item.description
            ),
            12000
        );


    if (
        sourceText.length < 80
    ) {
        return null;
    }


    const prompt = `
Ты редактор новостного канала ФАКТОР.

Работай ТОЛЬКО с текстом статьи ниже.

НЕ ДОБАВЛЯЙ факты из памяти.
НЕ ПРИДУМЫВАЙ цифры.
НЕ ПРИДУМЫВАЙ причины.
НЕ ПРИДУМЫВАЙ последствия.
НЕ ПРИДУМЫВАЙ имена.
НЕ ПРИДУМЫВАЙ даты.

Удали служебные элементы сайта,
рекламу,
формы комментариев,
AI-аудио,
меню,
футер
и технический мусор.

ЗАГОЛОВОК RSS:
${item.title}

ЗАГОЛОВОК СТАТЬИ:
${article.title}

ИСТОЧНИК:
${article.sourceName || item.source}

ТЕКСТ СТАТЬИ:
${sourceText}

Верни ТОЛЬКО JSON:

{
  "headline": "точный заголовок",
  "short": "содержательный текст новости",
  "main": [
    "факт 1",
    "факт 2",
    "факт 3"
  ],
  "important": "важный факт или пустая строка",
  "urgent": false
}

ПРАВИЛА:

1. headline должен относиться к ТОЙ ЖЕ новости.
2. Не используй кликбейт.
3. Не используй вопросительные заголовки.
4. Не пиши "стало известно".
5. Не пиши "ситуация развивается".
6. Не добавляй рекламные формулировки.
7. Не повторяй одну мысль.
8. main может содержать 0-3 пункта.
9. urgent=true только если событие действительно срочное.
10. Не меняй смысл исходной статьи.
11. Не добавляй факты, которых нет в статье.
12. short должен содержать реальную суть новости,
    а не две общие фразы.
13. Если статья содержит конкретные цифры,
    даты, имена и обстоятельства —
    используй их, если они важны для понимания новости.
`;


    try {

        const response =
            await fetch(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
                    encodeURIComponent(
                        GEMINI_API_KEY
                    ),
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body:
                        JSON.stringify({
                            contents: [
                                {
                                    parts: [
                                        {
                                            text:
                                                prompt,
                                        },
                                    ],
                                },
                            ],

                            generationConfig: {
                                temperature:
                                    0.1,

                                responseMimeType:
                                    "application/json",
                            },
                        }),

                    signal:
                        AbortSignal.timeout(
                            25000
                        ),
                }
            );


        if (
            !response.ok
        ) {

            console.error(
                "Gemini",
                response.status
            );

            return null;
        }


        const data =
            await response.json();


        const text =
            data
                ?.candidates?.[0]
                ?.content?.parts
                ?.map(
                    (part) =>
                        part.text ??
                        ""
                )
                .join("")
                .trim();


        const json =
            text
                ? extractJson(text)
                : null;


        if (!json) {
            return null;
        }


        const headline =
            stripHtml(
                String(
                    json.headline ||
                    article.title ||
                    item.title
                )
            );


        if (
            !articleTitleMatches(
                item.title,
                headline
            )
        ) {
            return null;
        }


        return {

            headline,

            short:
                stripHtml(
                    String(
                        json.short ||
                        sourceText.slice(
                            0,
                            1200
                        )
                    )
                ),

            main:
                Array.isArray(
                    json.main
                )
                    ? json.main
                        .map(
                            (x) =>
                                stripHtml(
                                    String(x)
                                )
                        )
                        .filter(Boolean)
                        .slice(
                            0,
                            3
                        )
                    : [],

            important:
                stripHtml(
                    String(
                        json.important ||
                        ""
                    )
                ),

            urgent:
                Boolean(
                    json.urgent
                ) ||
                detectUrgency(
                    item
                ),
        };

    } catch (error) {

        console.error(
            "Gemini",
            error?.message ??
                String(error)
        );

        return null;
    }
}


// ============================================================
// FALLBACK STORY
// ============================================================

function makeFallbackStory(
    item,
    article
) {

    const body =
        cleanArticleText(
            article.body ||
            article.description ||
            item.description
        );


    return {

        headline:
            stripHtml(
                article.title ||
                item.title
            ),

        short:
            truncate(
                body ||
                item.title,
                1600
            ),

        main: [],

        important: "",

        urgent:
            detectUrgency(
                item
            ),
    };
}


// ============================================================
// BUILD POST
// ============================================================

function buildPost(
    item,
    story,
    sourceName,
    articleUrl,
    media
) {

    const headline =
        stripHtml(
            truncate(
                story.headline ||
                item.title,
                260
            )
        );


    const short =
        stripHtml(
            truncate(
                story.short ||
                item.description ||
                item.title,
                1600
            )
        );


    const parts = [

        story.urgent
            ? "🔴"
            : "🔵",

        `<b>${escapeHtml(
            headline
        )}</b>`,

        "",

        escapeHtml(
            short
        ),
    ];


    const main =
        (story.main || [])
            .map(
                (item) =>
                    stripHtml(
                        truncate(
                            item,
                            350
                        )
                    )
            )
            .filter(Boolean)
            .slice(
                0,
                3
            );


    if (
        main.length
    ) {

        parts.push(
            "",

            ...main.map(
                (text) =>
                    `• ${escapeHtml(
                        text
                    )}`
            )
        );
    }


    if (
        story.important
    ) {

        parts.push(
            "",

            `<b>Важно:</b> ${escapeHtml(
                truncate(
                    story.important,
                    450
                )
            )}`
        );
    }


    parts.push(
        "",

        `🔗 <a href="${escapeHtml(
            articleUrl
        )}">${escapeHtml(
            sourceName
        )}</a>`
    );


    if (
        media?.mediaSourceName &&
        media.mediaSource !==
            "article_video" &&
        media.mediaSource !==
            "article_image"
    ) {

        parts.push(
            `📹 Медиа: ${escapeHtml(
                media.mediaSourceName
            )}`
        );
    }


    let result =
        parts.join(
            "\n"
        );


    if (
        result.length >
        MAX_POST_LENGTH
    ) {

        result =
            result
                .slice(
                    0,
                    MAX_POST_LENGTH - 1
                )
                .trimEnd() +
            "…";
    }


    return result;
}


// ============================================================
// URGENCY
// ============================================================

const URGENT = [
    "погиб",
    "погибли",
    "погибла",
    "погибло",
    "убит",
    "взрыв",
    "пожар",
    "дтп",
    "авария",
    "катастроф",
    "обруш",
    "землетряс",
    "цунами",
    "обстрел",
    "ракет",
    "санкции",
    "эвакуац",
    "захват",
    "теракт",
    "чрезвычайн",
    "массовое отключение",
];


function detectUrgency(item) {

    const text =
        normalizeForHash(
            `${item.title} ${item.description}`
        );

    return URGENT.some(
        (pattern) =>
            text.includes(pattern)
    );
}


// ============================================================
// NEWS SCORE
// ============================================================

function scoreNewsItem(item) {

    const timestamp =
        Date.parse(
            item.pubDate
        ) || Date.now();

    const ageMinutes =
        Math.max(
            0,
            (
                Date.now() -
                timestamp
            ) / 60000
        );


    let score;

    if (
        ageMinutes <= 15
    ) {
        score = 30;

    } else if (
        ageMinutes <= 30
    ) {
        score = 27;

    } else if (
        ageMinutes <= 60
    ) {
        score = 23;

    } else if (
        ageMinutes <= 120
    ) {
        score = 18;

    } else if (
        ageMinutes <= 360
    ) {
        score = 10;

    } else {
        score = 2;
    }


    const urgent =
        detectUrgency(
            item
        );


    if (
        urgent
    ) {
        score += 30;
    }


    const combined =
        normalizeForHash(
            `${item.title} ${item.description}`
        );


    for (
        const pattern of [
            "закон",
            "ставка",
            "инфляция",
            "санкции",
            "банк",
            "биржа",
            "рынок",
            "инвестиции",
            "миллиард",
            "компания",
            "акции",
            "нефть",
            "газ",
            "суд",
            "правительство",
            "президент",
            "министр",
            "парламент",
            "авария",
            "катастрофа",
            "технологии",
            "искусственный интеллект",
        ]
    ) {

        if (
            combined.includes(
                pattern
            )
        ) {
            score += 2;
        }
    }


    if (
        combined.length > 35 &&
        combined.length < 220
    ) {
        score += 8;
    }


    return {
        item,
        score,
        urgency: urgent,
    };
}


// ============================================================
// DEDUPLICATION
// ============================================================

async function publishedKey(
    item,
    url
) {

    return sha256(
        `${normalizeForHash(
            item.title
        )}|${normalizeArticleUrl(
            url
        )}`
    );
}


async function semanticKey(
    item
) {

    const words =
        normalizeForHash(
            `${item.title} ${item.description}`
        )
            .split(" ")
            .filter(
                (x) =>
                    x.length >= 5
            )
            .sort();


    return sha256(
        words.join("|")
    );
}


async function getRecentTitles(
    limit = 300
) {

    const db =
        await getKV();

    const result = [];

    for await (
        const entry of
        db.list(
            {
                prefix: [
                    "factor",
                    "recent_title",
                ],
            },
            {
                limit,
            }
        )
    ) {

        if (
            typeof entry.value ===
                "string"
        ) {

            result.push(
                entry.value
            );
        }
    }


    return result;
}


async function isAlreadyPublished(
    item,
    articleUrl = ""
) {

    const db =
        await getKV();


    if (
        articleUrl
    ) {

        const key =
            await publishedKey(
                item,
                articleUrl
            );

        const exact =
            await db.get([
                "factor",
                "published_v2",
                key,
            ]);


        if (
            exact.value ===
                true
        ) {
            return true;
        }
    }


    const storyKey =
        await semanticKey(
            item
        );


    const semantic =
        await db.get([
            "factor",
            "published_story_v4",
            storyKey,
        ]);


    if (
        semantic.value ===
            true
    ) {
        return true;
    }


    const recent =
        await getRecentTitles(
            100
        );


    for (
        const oldTitle of recent
    ) {

        if (
            articleTitleSimilarity(
                item.title,
                oldTitle
            ) >= 0.78
        ) {
            return true;
        }
    }


    return false;
}


async function markPublished(
    item,
    articleUrl
) {

    const db =
        await getKV();


    const exactKey =
        await publishedKey(
            item,
            articleUrl
        );


    await db.set(
        [
            "factor",
            "published_v2",
            exactKey,
        ],
        true,
        {
            expireIn:
                HISTORY_TTL_MS,
        }
    );


    const storyKey =
        await semanticKey(
            item
        );


    await db.set(
        [
            "factor",
            "published_story_v4",
            storyKey,
        ],
        true,
        {
            expireIn:
                HISTORY_TTL_MS,
        }
    );


    await db.set(
        [
            "factor",
            "recent_title",
            Date.now().toString(),
        ],
        item.title,
        {
            expireIn:
                HISTORY_TTL_MS,
        }
    );
}


// ============================================================
// DIAGNOSTICS
// ============================================================

function createDiagnostics() {

    return {

        rss_total: 0,

        scored: 0,

        duplicate: 0,

        article_url_rejected: 0,

        article_page_rejected: 0,

        article_title_rejected: 0,

        text_rejected: 0,

        media_video_article: 0,

        media_video_external: 0,

        media_image_external: 0,

        media_image_article: 0,

        media_none: 0,

        selected: 0,

        top_rejections: [],
    };
}


// ============================================================
// MAX HTTP CLIENT
// ============================================================

async function initMaxHttpClient() {

    if (
        maxHttpClient
    ) {
        return maxHttpClient;
    }


    if (
        maxHttpClientError
    ) {
        return null;
    }


    try {

        const rootResponse =
            await fetch(
                MAX_ROOT_CA_URL,
                {
                    headers: {
                        "User-Agent":
                            USER_AGENT,
                    },

                    signal:
                        AbortSignal.timeout(
                            15000
                        ),
                }
            );


        if (
            !rootResponse.ok
        ) {
            throw new Error(
                `Root CA HTTP ${rootResponse.status}`
            );
        }


        const rootCa =
            await rootResponse.text();


        const subResponse =
            await fetch(
                MAX_SUB_CA_URL,
                {
                    headers: {
                        "User-Agent":
                            USER_AGENT,
                    },

                    signal:
                        AbortSignal.timeout(
                            15000
                        ),
                }
            );


        if (
            !subResponse.ok
        ) {
            throw new Error(
                `Sub CA HTTP ${subResponse.status}`
            );
        }


        const subCa =
            await subResponse.text();


        maxCaStatus.root =
            true;

        maxCaStatus.sub =
            true;


        maxHttpClient =
            Deno.createHttpClient(
                {
                    caCerts: [
                        rootCa,
                        subCa,
                    ],
                }
            );


        maxCaStatus.loaded =
            true;


        return maxHttpClient;

    } catch (error) {

        maxHttpClientError =
            error?.message ??
            String(error);

        maxCaStatus.error =
            maxHttpClientError;

        return null;
    }
}


// ============================================================
// MAX API
// ============================================================

async function maxFetch(
    path,
    options = {}
) {

    if (
        !MAX_BOT_TOKEN
    ) {
        throw new Error(
            "MAX_BOT_TOKEN is missing"
        );
    }


    const headers =
        new Headers(
            options.headers ?? {}
        );


    headers.set(
        "Authorization",
        MAX_BOT_TOKEN
    );

    headers.set(
        "Accept",
        "application/json"
    );


    return fetch(
        `${MAX_API}${path}`,
        {
            ...options,

            client:
                await initMaxHttpClient(),

            headers,
        }
    );
}


async function maxJson(
    path,
    options = {}
) {

    const response =
        await maxFetch(
            path,
            options
        );


    const text =
        await response.text();


    let data;


    try {

        data =
            text
                ? JSON.parse(text)
                : null;

    } catch {

        data = {
            raw: text,
        };
    }


    if (
        !response.ok
    ) {

        throw new Error(
            `MAX ${response.status}: ${JSON.stringify(
                data
            )}`
        );
    }


    return data;
}


// ============================================================
// MAX UPLOAD
// ============================================================

async function uploadMedia(
    media
) {

    const init =
        await maxJson(
            `/uploads?type=${encodeURIComponent(
                media.type
            )}`,
            {
                method:
                    "POST",
            }
        );


    if (
        !init.url
    ) {

        throw new Error(
            "MAX upload URL missing"
        );
    }


    const form =
        new FormData();


    form.append(
        "data",

        new Blob(
            [
                media.bytes,
            ],
            {
                type:
                    media.contentType,
            }
        ),

        `factor.${media.extension}`
    );


    const response =
        await fetch(
            init.url,
            {
                method:
                    "POST",

                body:
                    form,

                signal:
                    AbortSignal.timeout(
                        180000
                    ),
            }
        );


    const text =
        await response.text();


    if (
        !response.ok
    ) {

        throw new Error(
            `MAX upload ${response.status}: ${text.slice(
                0,
                1000
            )}`
        );
    }


    let result = {};

    try {

        result =
            text
                ? JSON.parse(text)
                : {};

    } catch {
        // ignore
    }


    const token =
        init.token ||
        result.token ||
        result.mediafile_token ||
        result.photos?.photoIds?.token;


    if (
        !token
    ) {

        throw new Error(
            `MAX media token missing: ${text.slice(
                0,
                1000
            )}`
        );
    }


    return token;
}


// ============================================================
// MAX PUBLISH
// ============================================================

async function publishToMax(
    text,
    mediaInfo
) {

    if (
        !TARGET_CHAT_ID
    ) {
        throw new Error(
            "TARGET_CHAT_ID is missing"
        );
    }


    const body = {

        text,

        format:
            "html",

        notify:
            true,

        disable_link_preview:
            true,
    };


    if (
        mediaInfo
    ) {

        body.attachments = [
            {
                type:
                    mediaInfo.type,

                payload: {
                    token:
                        mediaInfo.token,
                },
            },
        ];
    }


    return maxJson(
        `/messages?chat_id=${encodeURIComponent(
            TARGET_CHAT_ID
        )}`,
        {
            method:
                "POST",

            headers: {
                "Content-Type":
                    "application/json",
            },

            body:
                JSON.stringify(
                    body
                ),
        }
    );
}


// ============================================================
// MAX MEDIA PROCESSING RETRY
// ============================================================

async function publishWithMediaRetry(
    text,
    mediaInfo
) {

    let lastError =
        null;


    for (
        const delay of [
            0,
            4000,
            8000,
            15000,
        ]
    ) {

        if (
            delay
        ) {
            await sleep(
                delay
            );
        }


        try {

            return await publishToMax(
                text,
                mediaInfo
            );

        } catch (error) {

            lastError =
                error;


            const message =
                error?.message ??
                String(error);


            if (
                !/attachment\.not\.ready|not\.processed|processing/i.test(
                    message
                )
            ) {

                throw error;
            }
        }
    }


    throw lastError;
}


// ============================================================
// CANDIDATE SELECTION
// ============================================================

async function chooseCandidate(
    items,
    urgentAllowed,
    regularAllowed,
    diagnostics
) {

    const scored =
        items

            .filter(
                (item) =>
                    item.title.length >=
                    15
            )

            .map(
                scoreNewsItem
            )

            .filter(
                (candidate) =>
                    candidate.urgency
                        ? urgentAllowed
                        : regularAllowed
            )

            .sort(
                (a, b) =>
                    b.score -
                    a.score
            )

            .slice(
                0,
                SCORE_CANDIDATES
            );


    diagnostics.scored =
        scored.length;


    for (
        const candidate of
        scored
    ) {

        const item =
            candidate.item;


        // ----------------------------------------------------
        // DUPLICATE BEFORE ARTICLE
        // ----------------------------------------------------

        if (
            await isAlreadyPublished(
                item
            )
        ) {

            diagnostics.duplicate++;

            continue;
        }


        // ----------------------------------------------------
        // REAL ARTICLE
        // ----------------------------------------------------

        const article =
            await extractArticle(
                item
            );


        if (
            !article.articleUrl
        ) {

            if (
                article.rejectedReason ===
                    "page_unavailable"
            ) {

                diagnostics.article_page_rejected++;

            } else if (
                article.rejectedReason ===
                    "title_mismatch"
            ) {

                diagnostics.article_title_rejected++;

            } else {

                diagnostics.article_url_rejected++;
            }

            continue;
        }


        // ----------------------------------------------------
        // DUPLICATE AFTER REAL ARTICLE
        // ----------------------------------------------------

        if (
            await isAlreadyPublished(
                item,
                article.articleUrl
            )
        ) {

            diagnostics.duplicate++;

            continue;
        }


        // ----------------------------------------------------
        // TEXT
        // ----------------------------------------------------

        let story =
            await callGemini(
                item,
                article
            );


        if (
            !story
        ) {

            story =
                makeFallbackStory(
                    item,
                    article
                );
        }


        story.urgent =
            story.urgent ||
            candidate.urgency;


        if (
            !articleTitleMatches(
                item.title,
                story.headline
            )
        ) {

            diagnostics.text_rejected++;

            continue;
        }


        return {
            item,

            article,

            story,

            score:
                candidate.score,
        };
    }


    return null;
}


// ============================================================
// PIPELINE LOCK
// ============================================================

async function acquireLock() {

    const db =
        await getKV();

    const token =
        crypto.randomUUID();


    const result =
        await db
            .atomic()

            .check({
                key: [
                    "factor",
                    "lock",
                ],

                versionstamp:
                    null,
            })

            .set(
                [
                    "factor",
                    "lock",
                ],
                {
                    token,

                    created_at:
                        Date.now(),
                },
                {
                    expireIn:
                        LOCK_TTL_MS,
                }
            )

            .commit();


    return result.ok
        ? token
        : null;
}


async function releaseLock(
    token
) {

    const db =
        await getKV();


    const current =
        await db.get([
            "factor",
            "lock",
        ]);


    if (
        current.value?.token !==
            token
    ) {
        return;
    }


    await db
        .atomic()

        .check({
            key: [
                "factor",
                "lock",
            ],

            versionstamp:
                current.versionstamp,
        })

        .delete([
            "factor",
            "lock",
        ])

        .commit();
}


// ============================================================
// RUN PIPELINE
// ============================================================

async function runPipeline(
    manual = false
) {

    const token =
        await acquireLock();


    if (
        !token
    ) {

        return {
            ok:
                false,

            skipped:
                true,

            reason:
                "pipeline already running",
        };
    }


    try {

        return await executePipeline(
            manual
        );

    } finally {

        await releaseLock(
            token
        );
    }
}


// ============================================================
// EXECUTE PIPELINE
// ============================================================

async function executePipeline(
    manual = false
) {

    const db =
        await getKV();

    const started =
        Date.now();


    try {

        // ----------------------------------------------------
        // RSS
        // ----------------------------------------------------

        const feedResults =
            await Promise.all(
                RSS_FEEDS.map(
                    loadRSS
                )
            );


        const items =
            feedResults
                .flat()
                .sort(
                    (a, b) =>
                        (
                            Date.parse(
                                b.pubDate
                            ) || 0
                        ) -
                        (
                            Date.parse(
                                a.pubDate
                            ) || 0
                        )
                )
                .slice(
                    0,
                    MAX_RSS_ITEMS
                );


        // ----------------------------------------------------
        // INTERVALS
        // ----------------------------------------------------

        const now =
            Date.now();


        const lastRegular =
            (
                await db.get([
                    "factor",
                    "state",
                    "last_regular",
                ])
            ).value ?? null;


        const lastUrgent =
            (
                await db.get([
                    "factor",
                    "state",
                    "last_urgent",
                ])
            ).value ?? null;


        const urgentAllowed =
            manual ||
            lastUrgent === null ||
            now -
                lastUrgent >=
                URGENT_INTERVAL_MS;


        const regularAllowed =
            manual ||
            lastRegular === null ||
            now -
                lastRegular >=
                REGULAR_INTERVAL_MS;


        if (
            !manual &&
            !urgentAllowed &&
            !regularAllowed
        ) {

            return {
                ok:
                    true,

                selected:
                    0,

                reason:
                    "publication intervals not reached",

                rss_total:
                    items.length,

                dry_run:
                    DRY_RUN,
            };
        }


        // ----------------------------------------------------
        // SELECT CANDIDATE
        // ----------------------------------------------------

        const diagnostics =
            createDiagnostics();


        diagnostics.rss_total =
            items.length;


        const candidate =
            await chooseCandidate(
                items,
                urgentAllowed,
                regularAllowed,
                diagnostics
            );


        if (
            !candidate
        ) {

            const result = {

                ok:
                    true,

                selected:
                    0,

                reason:
                    "no new valid candidate",

                rss_total:
                    items.length,

                selection_diagnostics:
                    diagnostics,

                dry_run:
                    DRY_RUN,

                duration_ms:
                    Date.now() -
                    started,
            };


            await db.set(
                [
                    "factor",
                    "state",
                    "last_pipeline",
                ],
                result
            );


            return result;
        }


        const {
            item,
            article,
            story,
            score,
        } = candidate;


        // ----------------------------------------------------
        // MEDIA
        // ----------------------------------------------------

        const media =
            await findBestMedia(
                item,
                article
            );


        if (
            media?.mediaSource ===
                "article_video"
        ) {

            diagnostics.media_video_article++;

        } else if (
            media?.mediaSource ===
                "external_video" ||
            media?.mediaSource ===
                "embedded_video"
        ) {

            diagnostics.media_video_external++;

        } else if (
            media?.mediaSource ===
                "external_image"
        ) {

            diagnostics.media_image_external++;

        } else if (
            media?.mediaSource ===
                "article_image"
        ) {

            diagnostics.media_image_article++;

        } else {

            diagnostics.media_none++;
        }


        // ----------------------------------------------------
        // SOURCE
        // ----------------------------------------------------

        const sourceName =
            cleanText(
                article.sourceName ||
                item.source ||
                "Источник"
            );


        // ----------------------------------------------------
        // POST
        // ----------------------------------------------------

        const text =
            buildPost(
                item,
                story,
                sourceName,
                article.articleUrl,
                media
            );


        diagnostics.selected =
            1;


        // ----------------------------------------------------
        // RESULT
        // ----------------------------------------------------

        const result = {

            ok:
                true,

            selected:
                1,

            dry_run:
                DRY_RUN,

            urgent:
                story.urgent,

            manual,

            score,

            rss_total:
                items.length,

            item: {

                title:
                    item.title,

                source:
                    sourceName,

                article_url:
                    article.articleUrl,

                category:
                    item.category,
            },


            article: {

                title:
                    article.title,

                body_chars:
                    article.body?.length ??
                    0,
            },


            media:
                media
                    ? {

                        type:
                            media.type,

                        mode:
                            media.mediaSource,

                        source_url:
                            media.sourceUrl,

                        source_name:
                            media.mediaSourceName ??
                            sourceName,

                    }
                    : null,


            post_preview:
                text,


            selection_diagnostics:
                diagnostics,


            duration_ms:
                Date.now() -
                started,
        };


        // ----------------------------------------------------
        // DRY RUN
        // ----------------------------------------------------

        if (
            DRY_RUN
        ) {

            await db.set(
                [
                    "factor",
                    "state",
                    "last_pipeline",
                ],
                result
            );


            return result;
        }


        // ----------------------------------------------------
        // UPLOAD MEDIA
        // ----------------------------------------------------

        let mediaInfo;


        if (
            media
        ) {

            const token =
                await uploadMedia(
                    media
                );


            mediaInfo = {

                type:
                    media.type,

                token,
            };
        }


        // ----------------------------------------------------
        // PUBLISH
        // ----------------------------------------------------

        const publication =
            mediaInfo
                ? await publishWithMediaRetry(
                    text,
                    mediaInfo
                )
                : await publishToMax(
                    text
                );


        // ----------------------------------------------------
        // MARK PUBLISHED
        // ----------------------------------------------------

        await markPublished(
            item,
            article.articleUrl
        );


        await db.set(
            [
                "factor",
                "state",
                story.urgent
                    ? "last_urgent"
                    : "last_regular",
            ],
            now
        );


        result.publication =
            publication;


        await db.set(
            [
                "factor",
                "state",
                "last_pipeline",
            ],
            result
        );


        return result;


    } catch (error) {

        const result = {

            ok:
                false,

            error:
                error?.message ??
                String(error),

            dry_run:
                DRY_RUN,

            duration_ms:
                Date.now() -
                started,
        };


        await db.set(
            [
                "factor",
                "state",
                "last_pipeline",
            ],
            result
        );


        console.error(
            "PIPELINE ERROR",
            error
        );


        return result;
    }
}


// ============================================================
// STATE
// ============================================================

async function getState() {

    const db =
        await getKV();


    const lock =
        await db.get([
            "factor",
            "lock",
        ]);


    const lastPipeline =
        (
            await db.get([
                "factor",
                "state",
                "last_pipeline",
            ])
        ).value ?? null;


    const lastRegular =
        (
            await db.get([
                "factor",
                "state",
                "last_regular",
            ])
        ).value ?? null;


    const lastUrgent =
        (
            await db.get([
                "factor",
                "state",
                "last_urgent",
            ])
        ).value ?? null;


    return {

        running:
            Boolean(
                lock.value
            ),

        dry_run:
            DRY_RUN,

        cron:
            CRON_SCHEDULE,

        last_pipeline:
            lastPipeline,

        last_regular:
            lastRegular,

        last_urgent:
            lastUrgent,

        max_connection:
            maxCaStatus,

        media_priority:
            "article video -> embedded/eyewitness video -> external video -> external image -> article image -> text",
    };
}


// ============================================================
// CRON
// ============================================================

Deno.cron(
    "FAKTOR news pipeline",
    CRON_SCHEDULE,
    {
        backoffSchedule: [
            5000,
            15000,
            30000,
        ],
    },

    async () => {

        console.log(
            "CRON",
            new Date().toISOString(),
            "DRY_RUN",
            DRY_RUN
        );


        const result =
            await runPipeline(
                false
            );


        console.log(
            JSON.stringify(
                result
            )
        );
    }
);


// ============================================================
// HTTP SERVER
// ============================================================

Deno.serve(
    async (request) => {

        const url =
            new URL(
                request.url
            );


        const path =
            url.pathname.replace(
                /\/$/,
                ""
            ) || "/";


        try {

            // ------------------------------------------------
            // ROOT
            // ------------------------------------------------

            if (
                request.method ===
                    "GET" &&
                path === "/"
            ) {

                return Response.json({

                    ok:
                        true,

                    service:
                        "FAKTOR V8",

                    runtime:
                        "Deno Deploy",

                    dry_run:
                        DRY_RUN,

                    cron:
                        CRON_SCHEDULE,

                    endpoints: [
                        "/status",
                        "/run",
                        "/pipeline-state",
                        "/publish-test",
                    ],
                });
            }


            // ------------------------------------------------
            // STATUS
            // ------------------------------------------------

            if (
                request.method ===
                    "GET" &&
                path === "/status"
            ) {

                return Response.json({

                    ok:
                        true,

                    service:
                        "FAKTOR V8",

                    dry_run:
                        DRY_RUN,

                    config: {

                        max_token:
                            Boolean(
                                MAX_BOT_TOKEN
                            ),

                        target_chat:
                            Boolean(
                                TARGET_CHAT_ID
                            ),

                        gemini:
                            Boolean(
                                GEMINI_API_KEY
                            ),
                    },

                    ...await getState(),
                });
            }


            // ------------------------------------------------
            // PIPELINE STATE
            // ------------------------------------------------

            if (
                request.method ===
                    "GET" &&
                path ===
                    "/pipeline-state"
            ) {

                return Response.json({

                    ok:
                        true,

                    ...await getState(),
                });
            }


            // ------------------------------------------------
            // MANUAL RUN
            // ------------------------------------------------

            if (
                (
                    request.method ===
                        "GET" ||
                    request.method ===
                        "POST"
                ) &&
                path === "/run"
            ) {

                return Response.json(
                    await runPipeline(
                        true
                    )
                );
            }


            // ------------------------------------------------
            // TEST PUBLISH
            // ------------------------------------------------

            if (
                request.method ===
                    "GET" &&
                path ===
                    "/publish-test"
            ) {

                if (
                    DRY_RUN
                ) {

                    return Response.json(
                        {
                            ok:
                                false,

                            dry_run:
                                true,

                            reason:
                                "Set DRY_RUN=false before publishing a test message",
                        },
                        {
                            status:
                                409,
                        }
                    );
                }


                return Response.json({

                    ok:
                        true,

                    response:
                        await publishToMax(
                            "🔴 <b>ФАКТОР • ТЕСТ</b>\n\nСистема MAX работает."
                        ),
                });
            }


            // ------------------------------------------------
            // 404
            // ------------------------------------------------

            return Response.json(
                {
                    ok:
                        false,

                    error:
                        "Endpoint not found",

                    path,
                },
                {
                    status:
                        404,
                }
            );


        } catch (error) {

            return Response.json(
                {
                    ok:
                        false,

                    error:
                        error?.message ??
                        String(error),

                    path,
                },
                {
                    status:
                        500,
                }
            );
        }
    }
);
