// ============================================================
// MAX NEWS AGENT — ФАКТОР
// DENO DEPLOY
// ============================================================
//
// АВТОМАТИЧЕСКАЯ СИСТЕМА НОВОСТЕЙ
//
// 1. Cron — каждые 5 минут.
// 2. RSS — мир, политика, экономика, бизнес, финансы,
//    право, происшествия, технологии, промышленность, авто.
// 3. Срочная новость — не чаще 1 раза в 5 минут.
// 4. Обычная новость — не чаще 1 раза в 30 минут.
// 5. Deno KV — история публикаций 30 дней.
// 6. Атомарный KV-lock против параллельных запусков.
// 7. Дедупликация по заголовку + реальному URL.
// 8. Поддержка старых ключей дедупликации.
// 9. Google News URL НЕ публикуется как источник.
// 10. Сначала определяется реальная страница СМИ.
// 11. Медиа берётся со страницы СМИ:
//       VIDEO -> IMAGE -> TEXT
// 12. Медиа скачивается на сервер агента.
// 13. Медиа загружается в MAX через /uploads.
// 14. Пост отправляется через /messages.
// 15. HTML-формат публикации.
// 16. Root CA + Sub CA для MAX.
// 17. Gemini 2.5 Flash для редакторской обработки.
// 18. Без Gemini работает fallback.
// 19. /status
// 20. /pipeline-state
// 21. /run
// 22. /publish-test
// 23. /me
// 24. /webhook
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const MAX_API =
  "https://platform-api2.max.ru";

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") ?? "";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") ?? "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? "";

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

const MAX_VIDEO_BYTES =
  Number(
    Deno.env.get("MAX_VIDEO_MB") ?? "60",
  ) * 1024 * 1024;

const MAX_IMAGE_BYTES =
  Number(
    Deno.env.get("MAX_IMAGE_MB") ?? "15",
  ) * 1024 * 1024;

const RSS_LIMIT_PER_FEED =
  30;

const MAX_RSS_ITEMS =
  300;

const MAX_HISTORY_CHECKED =
  300;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140 Safari/537.36";


// ============================================================
// MAX CERTIFICATES
// ============================================================

const MAX_ROOT_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";

const MAX_SUB_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";

let maxHttpClient: Deno.HttpClient | null = null;

let maxHttpClientError: string | null = null;

const maxCaStatus = {
  loaded: false,
  root: false,
  sub: false,
  error: null as string | null,
};


async function initMaxHttpClient(): Promise<Deno.HttpClient | null> {
  if (maxHttpClient) {
    return maxHttpClient;
  }

  if (maxHttpClientError) {
    return null;
  }

  try {
    const rootResponse = await fetch(
      MAX_ROOT_CA_URL,
      {
        headers: {
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!rootResponse.ok) {
      throw new Error(
        `Root CA HTTP ${rootResponse.status}`,
      );
    }

    const rootCa =
      await rootResponse.text();

    if (!rootCa.includes("BEGIN CERTIFICATE")) {
      throw new Error(
        "Root CA certificate content is invalid",
      );
    }

    maxCaStatus.root = true;

    const subResponse = await fetch(
      MAX_SUB_CA_URL,
      {
        headers: {
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!subResponse.ok) {
      throw new Error(
        `Sub CA HTTP ${subResponse.status}`,
      );
    }

    const subCa =
      await subResponse.text();

    if (!subCa.includes("BEGIN CERTIFICATE")) {
      throw new Error(
        "Sub CA certificate content is invalid",
      );
    }

    maxCaStatus.sub = true;

    maxHttpClient =
      Deno.createHttpClient({
        caCerts: [
          rootCa,
          subCa,
        ],
      });

    maxCaStatus.loaded = true;

    return maxHttpClient;
  } catch (error) {
    maxHttpClientError =
      error instanceof Error
        ? error.message
        : String(error);

    maxCaStatus.error =
      maxHttpClientError;

    console.error(
      "MAX CA initialization failed:",
      maxHttpClientError,
    );

    return null;
  }
}


// ============================================================
// RSS FEEDS
// ============================================================

const RSS_FEEDS = [
  {
    category: "МИР",
    emoji: "🌍",
    url:
      "https://news.google.com/rss/search?q=world+OR+мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ПОЛИТИКА",
    emoji: "🏛️",
    url:
      "https://news.google.com/rss/search?q=политика+OR+правительство+OR+президент&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ЭКОНОМИКА",
    emoji: "📈",
    url:
      "https://news.google.com/rss/search?q=экономика+OR+инфляция+OR+ставка+OR+рынки&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "БИЗНЕС",
    emoji: "💼",
    url:
      "https://news.google.com/rss/search?q=бизнес+OR+компания+OR+корпорация+OR+инвестиции&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ФИНАНСЫ",
    emoji: "💰",
    url:
      "https://news.google.com/rss/search?q=финансы+OR+банки+OR+биржа+OR+рубль+OR+доллар&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ПРАВО",
    emoji: "⚖️",
    url:
      "https://news.google.com/rss/search?q=закон+OR+суд+OR+право+OR+законопроект&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ПРОИСШЕСТВИЯ",
    emoji: "🚨",
    url:
      "https://news.google.com/rss/search?q=происшествие+OR+ДТП+OR+пожар+OR+авария+OR+катастрофа&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ТЕХНОЛОГИИ",
    emoji: "💻",
    url:
      "https://news.google.com/rss/search?q=технологии+OR+ИИ+OR+искусственный+интеллект+OR+кибербезопасность&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ПРОМЫШЛЕННОСТЬ",
    emoji: "🏭",
    url:
      "https://news.google.com/rss/search?q=промышленность+OR+производство+OR+энергетика&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "АВТО",
    emoji: "🚗",
    url:
      "https://news.google.com/rss/search?q=авто+OR+автомобили+OR+транспорт&hl=ru&gl=RU&ceid=RU:ru",
  },
];


// ============================================================
// TYPES
// ============================================================

type NewsItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  source: string;
  category: string;
  categoryEmoji: string;
  sourceFeed: string;
};

type ArticleMedia = {
  articleUrl: string;
  imageUrl: string | null;
  videoUrl: string | null;
  sourceName: string | null;
};

type DownloadedMedia = {
  type: "video" | "image";
  bytes: Uint8Array;
  contentType: string;
  extension: string;
  sourceUrl: string;
};

type AIStory = {
  headline: string;
  short: string;
  main: string[];
  important: string;
  urgent: boolean;
};

type PipelineState = {
  running: boolean;
  cron: string;

  regular: {
    interval_minutes: number;
    last: number | null;
    can_publish: boolean;
  };

  urgent: {
    interval_minutes: number;
    last: number | null;
    can_publish: boolean;
  };

  media: {
    max_video_mb: number;
    max_image_mb: number;
    priority: string;
  };

  dedup: {
    persistent: boolean;
    ttl_days: number;
    max_history_checked: number;
  };

  lock: {
    atomic: boolean;
    ttl_minutes: number;
  };

  last_pipeline: unknown;
};


// ============================================================
// DENO KV
// ============================================================

let kv: Deno.Kv | null = null;


async function getKV(): Promise<Deno.Kv> {
  if (!kv) {
    kv = await Deno.openKv();
  }

  return kv;
}


// ============================================================
// TEXT UTILS
// ============================================================

function cleanText(
  value: unknown,
): string {
  return String(value ?? "")
    .replace(/<!\[CDATA\[/gi, "")
    .replace(/\]\]>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCodePoint(
          Number(code),
        ),
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCodePoint(
          parseInt(code, 16),
        ),
    )
    .replace(/\s+/g, " ")
    .trim();
}


function stripHtml(
  value: string,
): string {
  return cleanText(value)
    .replace(/\*\*/g, "")
    .replace(/__+/g, "")
    .trim();
}


function escapeHtml(
  value: string,
): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function normalizeForHash(
  value: string,
): string {
  return stripHtml(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"“”'`]/g, "")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}


async function sha256(
  value: string,
): Promise<string> {
  const data =
    new TextEncoder().encode(
      value,
    );

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      data,
    );

  return Array
    .from(new Uint8Array(hash))
    .map(
      (b) =>
        b
          .toString(16)
          .padStart(2, "0"),
    )
    .join("");
}


function truncate(
  value: string,
  max: number,
): string {
  const s =
    value.trim();

  if (s.length <= max) {
    return s;
  }

  return (
    s
      .slice(0, max - 1)
      .trimEnd() +
    "…"
  );
}


// ============================================================
// URL UTILS
// ============================================================

function isHttpUrl(
  url: string,
): boolean {
  return /^https?:\/\//i.test(
    url,
  );
}


function isGoogleNewsUrl(
  url: string,
): boolean {
  try {
    const host =
      new URL(url)
        .hostname
        .toLowerCase();

    return (
      host === "news.google.com" ||
      host.endsWith(".news.google.com")
    );
  } catch {
    return false;
  }
}


function isUsableArticleUrl(
  url: string,
): boolean {
  if (!isHttpUrl(url)) {
    return false;
  }

  if (isGoogleNewsUrl(url)) {
    return false;
  }

  try {
    const parsed =
      new URL(url);

    if (
      !["http:", "https:"].includes(
        parsed.protocol,
      )
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}


function decodeHtmlEntities(
  value: string,
): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}


function absoluteUrl(
  value: string,
  baseUrl: string,
): string | null {
  try {
    return new URL(
      value,
      baseUrl,
    ).href;
  } catch {
    return null;
  }
}


function normalizeMediaUrl(
  value: string,
): string {
  return decodeHtmlEntities(
    value
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003A/gi, ":")
      .replace(/\\u002F/gi, "/")
      .trim(),
  );
}


// ============================================================
// RSS
// ============================================================

function extractXmlTag(
  xml: string,
  tag: string,
): string {
  const pattern =
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`;

  const match =
    new RegExp(
      pattern,
      "i",
    ).exec(xml);

  return match?.[1] ?? "";
}


function parseRSS(
  xml: string,
  feed: typeof RSS_FEEDS[number],
): NewsItem[] {
  const items: NewsItem[] = [];

  const matches =
    xml.match(
      /<item\b[\s\S]*?<\/item>/gi,
    ) ?? [];

  for (
    const itemXml of matches.slice(
      0,
      RSS_LIMIT_PER_FEED,
    )
  ) {
    const title =
      cleanText(
        extractXmlTag(
          itemXml,
          "title",
        ),
      );

    const link =
      cleanText(
        extractXmlTag(
          itemXml,
          "link",
        ),
      ) ||
      cleanText(
        extractXmlTag(
          itemXml,
          "guid",
        ),
      );

    const description =
      cleanText(
        extractXmlTag(
          itemXml,
          "description",
        ),
      );

    const pubDate =
      cleanText(
        extractXmlTag(
          itemXml,
          "pubDate",
        ),
      );

    const source =
      cleanText(
        extractXmlTag(
          itemXml,
          "source",
        ),
      ) ||
      feed.category;

    if (!title || !link) {
      continue;
    }

    items.push({
      title,
      link,
      description,
      pubDate,
      source,
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


async function loadRSS(
  feed: typeof RSS_FEEDS[number],
): Promise<NewsItem[]> {
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
              12000,
            ),
        },
      );

    if (!response.ok) {
      console.error(
        `RSS ${feed.category}: HTTP ${response.status}`,
      );

      return [];
    }

    const xml =
      await response.text();

    return parseRSS(
      xml,
      feed,
    );
  } catch (error) {
    console.error(
      `RSS ${feed.category}:`,
      error instanceof Error
        ? error.message
        : String(error),
    );

    return [];
  }
}


// ============================================================
// HTML META
// ============================================================

function findMeta(
  html: string,
  property: string,
): string | null {
  const escaped =
    property.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`,
      "i",
    ),
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      html.match(pattern);

    if (match?.[1]) {
      return decodeHtmlEntities(
        cleanText(match[1]),
      );
    }
  }

  return null;
}


function extractCanonical(
  html: string,
  baseUrl: string,
): string | null {
  const canonical =
    html.match(
      /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i,
    )?.[1];

  if (!canonical) {
    return null;
  }

  return absoluteUrl(
    decodeHtmlEntities(
      canonical,
    ),
    baseUrl,
  );
}


function extractExternalLinks(
  html: string,
  baseUrl: string,
): string[] {
  const result: string[] = [];

  const seen =
    new Set<string>();

  for (
    const match of html.matchAll(
      /<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi,
    )
  ) {
    const raw =
      decodeHtmlEntities(
        match[1],
      );

    const url =
      absoluteUrl(
        raw,
        baseUrl,
      );

    if (!url) {
      continue;
    }

    if (
      !isUsableArticleUrl(url)
    ) {
      continue;
    }

    try {
      const host =
        new URL(url)
          .hostname
          .toLowerCase();

      if (
        host.includes("google.")
      ) {
        continue;
      }
    } catch {
      continue;
    }

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push(url);

    if (result.length >= 30) {
      break;
    }
  }

  return result;
}


// ============================================================
// GOOGLE NEWS RESOLUTION
// ============================================================

async function resolveArticleUrl(
  originalUrl: string,
): Promise<string> {
  if (
    !isGoogleNewsUrl(
      originalUrl,
    )
  ) {
    return originalUrl;
  }

  try {
    const response =
      await fetch(
        originalUrl,
        {
          redirect:
            "follow",

          headers: {
            "User-Agent":
              USER_AGENT,

            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },

          signal:
            AbortSignal.timeout(
              15000,
            ),
        },
      );

    const finalUrl =
      response.url;

    if (
      finalUrl &&
      isUsableArticleUrl(
        finalUrl,
      )
    ) {
      return finalUrl;
    }

    const html =
      await response.text();

    const canonical =
      extractCanonical(
        html,
        originalUrl,
      );

    if (
      canonical &&
      isUsableArticleUrl(
        canonical,
      )
    ) {
      return canonical;
    }

    const ogUrl =
      findMeta(
        html,
        "og:url",
      );

    if (ogUrl) {
      const resolved =
        absoluteUrl(
          ogUrl,
          originalUrl,
        );

      if (
        resolved &&
        isUsableArticleUrl(
          resolved,
        )
      ) {
        return resolved;
      }
    }

    const links =
      extractExternalLinks(
        html,
        originalUrl,
      );

    if (links.length > 0) {
      return links[0];
    }
  } catch (error) {
    console.error(
      "Google News resolve:",
      error instanceof Error
        ? error.message
        : String(error),
    );
  }

  // НИКОГДА не возвращаем Google News
  return "";
}


// ============================================================
// VIDEO EXTRACTION
// ============================================================

function isDirectVideoUrl(
  url: string,
): boolean {
  const lower =
    url.toLowerCase();

  if (
    lower.includes(".m3u8") ||
    lower.includes(".mpd")
  ) {
    return false;
  }

  return (
    lower.includes(".mp4") ||
    lower.includes(".mov") ||
    lower.includes(".webm") ||
    lower.includes(".mkv")
  );
}


function collectVideoUrls(
  value: unknown,
  result: string[],
): void {
  if (
    typeof value === "string"
  ) {
    if (
      isDirectVideoUrl(value)
    ) {
      result.push(value);
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectVideoUrls(
        item,
        result,
      );
    }

    return;
  }

  if (
    value &&
    typeof value === "object"
  ) {
    for (
      const [
        key,
        item,
      ] of Object.entries(
        value as Record<
          string,
          unknown
        >,
      )
    ) {
      if (
        [
          "contentUrl",
          "videoUrl",
          "video_url",
          "url",
          "file",
        ].includes(key)
      ) {
        collectVideoUrls(
          item,
          result,
        );
      }

      if (
        key === "@graph" ||
        key === "video" ||
        key === "content" ||
        key === "associatedMedia"
      ) {
        collectVideoUrls(
          item,
          result,
        );
      }
    }
  }
}


function findVideoFromHtml(
  html: string,
  baseUrl: string,
): string | null {
  const candidates: string[] = [];

  const metaNames = [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "twitter:player:stream",
  ];

  for (
    const name of metaNames
  ) {
    const value =
      findMeta(
        html,
        name,
      );

    if (value) {
      candidates.push(value);
    }
  }

  for (
    const match of html.matchAll(
      /<video[^>]+src=["']([^"']+)["'][^>]*>/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  for (
    const match of html.matchAll(
      /<source[^>]+src=["']([^"']+)["'][^>]*>/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  for (
    const match of html.matchAll(
      /["'](?:contentUrl|videoUrl|video_url|file)["']\s*:\s*["']([^"']+)["']/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  for (
    const candidate of candidates
  ) {
    const url =
      absoluteUrl(
        normalizeMediaUrl(
          candidate,
        ),
        baseUrl,
      );

    if (
      url &&
      isDirectVideoUrl(url)
    ) {
      return url;
    }
  }

  const jsonLdBlocks =
    html.match(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
    ) ?? [];

  for (
    const block of jsonLdBlocks
  ) {
    const jsonText =
      block
        .replace(
          /<script[^>]*>/i,
          "",
        )
        .replace(
          /<\/script>\s*$/i,
          "",
        )
        .trim();

    try {
      const data =
        JSON.parse(
          jsonText,
        );

      const urls: string[] = [];

      collectVideoUrls(
        data,
        urls,
      );

      for (
        const rawUrl of urls
      ) {
        const url =
          absoluteUrl(
            normalizeMediaUrl(
              rawUrl,
            ),
            baseUrl,
          );

        if (
          url &&
          isDirectVideoUrl(url)
        ) {
          return url;
        }
      }
    } catch {
      // JSON-LD может быть некорректным
    }
  }

  return null;
}


// ============================================================
// ARTICLE MEDIA
// ============================================================

async function extractArticleMedia(
  originalUrl: string,
): Promise<ArticleMedia> {
  const articleUrl =
    await resolveArticleUrl(
      originalUrl,
    );

  if (
    !isUsableArticleUrl(
      articleUrl,
    )
  ) {
    return {
      articleUrl: "",
      imageUrl: null,
      videoUrl: null,
      sourceName: null,
    };
  }

  try {
    const response =
      await fetch(
        articleUrl,
        {
          redirect:
            "follow",

          headers: {
            "User-Agent":
              USER_AGENT,

            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },

          signal:
            AbortSignal.timeout(
              20000,
            ),
        },
      );

    if (!response.ok) {
      return {
        articleUrl,
        imageUrl: null,
        videoUrl: null,
        sourceName: null,
      };
    }

    const finalArticleUrl =
      response.url || articleUrl;

    if (
      !isUsableArticleUrl(
        finalArticleUrl,
      )
    ) {
      return {
        articleUrl: "",
        imageUrl: null,
        videoUrl: null,
        sourceName: null,
      };
    }

    const html =
      await response.text();

    const imageMeta =
      findMeta(
        html,
        "og:image",
      ) ||
      findMeta(
        html,
        "twitter:image",
      );

    const imageUrl =
      imageMeta
        ? absoluteUrl(
            normalizeMediaUrl(
              imageMeta,
            ),
            finalArticleUrl,
          )
        : null;

    const videoUrl =
      findVideoFromHtml(
        html,
        finalArticleUrl,
      );

    const sourceName =
      findMeta(
        html,
        "og:site_name",
      ) ||
      findMeta(
        html,
        "application-name",
      );

    return {
      articleUrl:
        finalArticleUrl,

      imageUrl,

      videoUrl,

      sourceName,
    };
  } catch (error) {
    console.error(
      "Article media:",
      error instanceof Error
        ? error.message
        : String(error),
    );

    return {
      articleUrl,
      imageUrl: null,
      videoUrl: null,
      sourceName: null,
    };
  }
}


// ============================================================
// MEDIA DOWNLOAD
// ============================================================

function extensionFromType(
  type:
    | "video"
    | "image",
  contentType: string,
  url: string,
): string {
  const ct =
    contentType.toLowerCase();

  if (type === "video") {
    if (ct.includes("webm")) {
      return "webm";
    }

    if (ct.includes("quicktime")) {
      return "mov";
    }

    if (ct.includes("matroska")) {
      return "mkv";
    }

    return "mp4";
  }

  if (ct.includes("png")) {
    return "png";
  }

  if (ct.includes("gif")) {
    return "gif";
  }

  if (ct.includes("webp")) {
    return "webp";
  }

  try {
    const path =
      new URL(url).pathname;

    const match =
      path.match(
        /\.([a-z0-9]{2,5})$/i,
      );

    if (match) {
      return match[1].toLowerCase();
    }
  } catch {
    // ignore
  }

  return "jpg";
}


async function downloadMedia(
  url: string,
  type:
    | "video"
    | "image",
): Promise<DownloadedMedia | null> {
  try {
    if (!isHttpUrl(url)) {
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
                ? "video/mp4,video/quicktime,video/webm,video/*;q=0.9,*/*;q=0.3"
                : "image/avif,image/webp,image/apng,image/*,*/*;q=0.5",
          },

          signal:
            AbortSignal.timeout(
              type === "video"
                ? 30000
                : 15000,
            ),
        },
      );

    if (!response.ok) {
      return null;
    }

    const contentType =
      (
        response.headers.get(
          "content-type",
        ) ?? ""
      ).toLowerCase();

    if (
      contentType.includes(
        "mpegurl",
      ) ||
      contentType.includes(
        "dash",
      ) ||
      contentType.includes(
        "application/vnd.apple.mpegurl",
      )
    ) {
      return null;
    }

    const contentLength =
      Number(
        response.headers.get(
          "content-length",
        ) ?? "0",
      );

    const limit =
      type === "video"
        ? MAX_VIDEO_BYTES
        : MAX_IMAGE_BYTES;

    if (
      contentLength > 0 &&
      contentLength > limit
    ) {
      console.log(
        "Media too large:",
        contentLength,
      );

      return null;
    }

    const buffer =
      new Uint8Array(
        await response.arrayBuffer(),
      );

    if (
      buffer.byteLength > limit
    ) {
      return null;
    }

    const finalUrl =
      response.url || url;

    if (
      type === "video" &&
      !contentType.startsWith(
        "video/",
      )
    ) {
      if (
        !isDirectVideoUrl(
          finalUrl,
        )
      ) {
        return null;
      }
    }

    if (
      type === "image" &&
      !contentType.startsWith(
        "image/",
      )
    ) {
      if (
        !/\.(jpg|jpeg|png|gif|webp|tiff|bmp|heic)(?:\?|$)/i.test(
          finalUrl,
        )
      ) {
        return null;
      }
    }

    return {
      type,

      bytes:
        buffer,

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
          finalUrl,
        ),

      sourceUrl:
        finalUrl,
    };
  } catch (error) {
    console.error(
      "Download media:",
      error instanceof Error
        ? error.message
        : String(error),
    );

    return null;
  }
}


// ============================================================
// MAX API
// ============================================================

async function maxFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (!MAX_BOT_TOKEN) {
    throw new Error(
      "MAX_BOT_TOKEN is missing",
    );
  }

  const headers =
    new Headers(
      options.headers ?? {},
    );

  headers.set(
    "Authorization",
    MAX_BOT_TOKEN,
  );

  headers.set(
    "Accept",
    "application/json",
  );

  const client =
    await initMaxHttpClient();

  return await fetch(
    `${MAX_API}${path}`,
    {
      ...options,

      client:
        client ?? undefined,

      headers,
    },
  );
}


async function maxJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response =
    await maxFetch(
      path,
      options,
    );

  const text =
    await response.text();

  let data: any;

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

  if (!response.ok) {
    throw new Error(
      `MAX ${response.status}: ${JSON.stringify(
        data,
      )}`,
    );
  }

  return data as T;
}


// ============================================================
// MAX UPLOAD
// ============================================================

async function uploadMedia(
  media: DownloadedMedia,
): Promise<string> {
  const init =
    await maxJson<{
      url: string;
      token?: string;
    }>(
      `/uploads?type=${encodeURIComponent(
        media.type,
      )}`,
      {
        method: "POST",

        headers: {
          "Accept":
            "application/json",
        },
      },
    );

  if (!init.url) {
    throw new Error(
      `MAX upload URL missing for ${media.type}`,
    );
  }

  const form =
    new FormData();

  const blob =
    new Blob(
      [media.bytes],
      {
        type:
          media.contentType,
      },
    );

  form.append(
    "data",
    blob,
    `factor.${media.extension}`,
  );

  const uploadResponse =
    await fetch(
      init.url,
      {
        method: "POST",

        body:
          form,

        signal:
          AbortSignal.timeout(
            90000,
          ),
      },
    );

  const uploadText =
    await uploadResponse.text();

  if (!uploadResponse.ok) {
    throw new Error(
      `Media upload HTTP ${
        uploadResponse.status
      }: ${uploadText.slice(
        0,
        1500,
      )}`,
    );
  }

  let uploadResult: any = null;

  try {
    uploadResult =
      uploadText
        ? JSON.parse(
            uploadText,
          )
        : null;
  } catch {
    // Некоторые upload endpoints могут вернуть не JSON.
  }

  const finalToken =
    init.token ||
    uploadResult?.token ||
    uploadResult?.mediafile_token ||
    uploadResult?.photos?.photoIds?.token ||
    null;

  if (
    typeof finalToken !== "string" ||
    !finalToken
  ) {
    throw new Error(
      `MAX media token missing for ${media.type}. ` +
        `Upload response: ${uploadText.slice(
          0,
          1500,
        )}`,
    );
  }

  return finalToken;
}


// ============================================================
// MAX PUBLISH
// ============================================================

async function publishToMax(
  text: string,
  mediaToken?: {
    type:
      | "video"
      | "image";

    token: string;
  },
): Promise<any> {
  if (!TARGET_CHAT_ID) {
    throw new Error(
      "TARGET_CHAT_ID is missing",
    );
  }

  const body: any = {
    text,

    format:
      "html",

    notify:
      true,
  };

  if (mediaToken) {
    body.attachments = [
      {
        type:
          mediaToken.type,

        payload: {
          token:
            mediaToken.token,
        },
      },
    ];
  }

  return await maxJson(
    `/messages?chat_id=${encodeURIComponent(
      TARGET_CHAT_ID,
    )}`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "Accept":
          "application/json",
      },

      body:
        JSON.stringify(
          body,
        ),
    },
  );
}


// ============================================================
// DEDUPLICATION
// ============================================================

function normalizeArticleUrl(
  url: string,
): string {
  if (!isUsableArticleUrl(url)) {
    return "";
  }

  try {
    const parsed =
      new URL(url);

    const removeParams = [
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
    ];

    for (
      const param of removeParams
    ) {
      parsed.searchParams.delete(
        param,
      );
    }

    parsed.hash = "";

    return parsed.href;
  } catch {
    return "";
  }
}


async function publishedKey(
  item: NewsItem,
  articleUrl: string,
): Promise<string> {
  const normalizedTitle =
    normalizeForHash(
      item.title,
    );

  const normalizedUrl =
    normalizeArticleUrl(
      articleUrl,
    );

  return await sha256(
    `${normalizedTitle}|${normalizedUrl}`,
  );
}


async function legacyPublishedKey(
  item: NewsItem,
): Promise<string> {
  return await sha256(
    normalizeForHash(
      `${item.title}|${item.source}`,
    ),
  );
}


async function isAlreadyPublished(
  item: NewsItem,
  articleUrl = "",
): Promise<boolean> {
  const db =
    await getKV();

  // Новая схема: title + real URL
  if (articleUrl) {
    const key =
      await publishedKey(
        item,
        articleUrl,
      );

    const result =
      await db.get<boolean>(
        [
          "factor",
          "published_v2",
          key,
        ],
      );

    if (result.value === true) {
      return true;
    }
  }

  // Старая схема: title + source
  const oldKey =
    await legacyPublishedKey(
      item,
    );

  const legacy =
    await db.get<boolean>(
      [
        "factor",
        "published",
        oldKey,
      ],
    );

  return legacy.value === true;
}


async function markPublished(
  item: NewsItem,
  articleUrl: string,
): Promise<void> {
  const db =
    await getKV();

  const normalizedUrl =
    normalizeArticleUrl(
      articleUrl,
    );

  const key =
    await publishedKey(
      item,
      normalizedUrl,
    );

  await db.set(
    [
      "factor",
      "published_v2",
      key,
    ],
    true,
    {
      expireIn:
        HISTORY_TTL_MS,
    },
  );

  // Сохраняем также старый формат.
  const oldKey =
    await legacyPublishedKey(
      item,
    );

  await db.set(
    [
      "factor",
      "published",
      oldKey,
    ],
    true,
    {
      expireIn:
        HISTORY_TTL_MS,
    },
  );
}


async function getRecentTitles(
  limit = MAX_HISTORY_CHECKED,
): Promise<string[]> {
  const db =
    await getKV();

  const titles: string[] = [];

  for await (
    const entry of db.list<string>(
      {
        prefix: [
          "factor",
          "recent_title",
        ],
        reverse: true,
      },
    )
  ) {
    if (entry.value) {
      titles.push(
        entry.value,
      );
    }

    if (
      titles.length >=
      limit
    ) {
      break;
    }
  }

  return titles;
}


async function rememberTitle(
  title: string,
): Promise<void> {
  const db =
    await getKV();

  const id =
    await sha256(
      normalizeForHash(
        title,
      ),
    );

  await db.set(
    [
      "factor",
      "recent_title",
      id,
    ],
    title,
    {
      expireIn:
        HISTORY_TTL_MS,
    },
  );
}


// ============================================================
// URGENCY
// ============================================================

function detectUrgency(
  item: NewsItem,
): boolean {
  const text =
    normalizeForHash(
      `${item.title} ${item.description}`,
    );

  const urgentPatterns = [
    "теракт",
    "террорист",
    "атака",
    "взрыв",
    "взрыва",
    "пожар",
    "землетрясение",
    "цунами",
    "катастроф",
    "авария",
    "крушение",
    "самолет разбился",
    "самолет потерпел",
    "погиб",
    "погибли",
    "убит",
    "убиты",
    "захват заложников",
    "военные действия",
    "началась война",
    "обстрел",
    "ракетн",
    "санкции",
    "чрезвычайное положение",
    "эвакуация",
    "прорыв дамбы",
    "массовое отключение",
  ];

  return urgentPatterns.some(
    (pattern) =>
      text.includes(pattern),
  );
}


// ============================================================
// GEMINI
// ============================================================

function extractJson(
  text: string,
): any | null {
  const cleaned =
    text
      .replace(
        /^```json/i,
        "",
      )
      .replace(
        /^```/i,
        "",
      )
      .replace(
        /```$/i,
        "",
      )
      .trim();

  try {
    return JSON.parse(
      cleaned,
    );
  } catch {
    const match =
      cleaned.match(
        /\{[\s\S]*\}/,
      );

    if (!match) {
      return null;
    }

    try {
      return JSON.parse(
        match[0],
      );
    } catch {
      return null;
    }
  }
}


async function callGemini(
  item: NewsItem,
): Promise<AIStory | null> {
  if (!GEMINI_API_KEY) {
    return null;
  }

  const prompt = `
Ты редактор новостного канала ФАКТОР.

Работай ТОЛЬКО с информацией из исходной новости.

ИСХОДНЫЙ ЗАГОЛОВОК:
${item.title}

ИСТОЧНИК:
${item.source}

ОПИСАНИЕ:
${item.description}

Верни ТОЛЬКО JSON.

Формат:

{
  "headline": "короткий точный заголовок",
  "short": "одно короткое предложение, объясняющее событие",
  "main": [
    "конкретный факт 1",
    "конкретный факт 2",
    "конкретный факт 3"
  ],
  "important": "один конкретный вывод только из источника",
  "urgent": false
}

ПРАВИЛА:

1. Никаких выдуманных фактов.
2. Не додумывай отсутствующую информацию.
3. Не повторяй одну и ту же мысль.
4. short, main и important должны различаться.
5. Если фактов мало — используй меньше пунктов.
6. Не пиши "ситуация развивается".
7. Не пиши "стало известно".
8. Не используй рекламные формулировки.
9. headline должен быть конкретным.
10. urgent=true только если новость действительно срочная.
11. Обычная новость = urgent=false.
`;

  try {
    const response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
          encodeURIComponent(
            GEMINI_API_KEY,
          ),
        {
          method: "POST",

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
                  0.15,

                responseMimeType:
                  "application/json",
              },
            }),

          signal:
            AbortSignal.timeout(
              20000,
            ),
        },
      );

    if (!response.ok) {
      console.error(
        "Gemini HTTP:",
        response.status,
        (
          await response.text()
        ).slice(
          0,
          1000,
        ),
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
          (p: any) =>
            p.text ?? "",
        )
        .join("")
        .trim();

    if (!text) {
      return null;
    }

    const json =
      extractJson(text);

    if (!json) {
      return null;
    }

    return {
      headline:
        stripHtml(
          String(
            json.headline ||
              item.title,
          ),
        ),

      short:
        stripHtml(
          String(
            json.short ||
              item.description ||
              item.title,
          ),
        ),

      main:
        Array.isArray(
          json.main,
        )
          ? json.main
              .map(
                (x: any) =>
                  stripHtml(
                    String(x),
                  ),
              )
              .filter(Boolean)
              .slice(0, 3)
          : [],

      important:
        stripHtml(
          String(
            json.important ||
              "",
          ),
        ),

      urgent:
        Boolean(
          json.urgent,
        ) ||
        detectUrgency(item),
    };
  } catch (error) {
    console.error(
      "Gemini:",
      error instanceof Error
        ? error.message
        : String(error),
    );

    return null;
  }
}


// ============================================================
// FALLBACK
// ============================================================

function makeFallbackStory(
  item: NewsItem,
): AIStory {
  const text =
    truncate(
      item.description ||
        item.title,
      500,
    );

  return {
    headline:
      stripHtml(
        item.title,
      ),

    short:
      text,

    main:
      text
        ? [text]
        : [],

    important:
      text,

    urgent:
      detectUrgency(item),
  };
}


// ============================================================
// TEXT DUPLICATES
// ============================================================

function textWords(
  value: string,
): Set<string> {
  return new Set(
    normalizeForHash(
      value,
    )
      .split(" ")
      .filter(
        (word) =>
          word.length >= 5,
      ),
  );
}


function similarity(
  a: string,
  b: string,
): number {
  const aw =
    textWords(a);

  const bw =
    textWords(b);

  if (
    aw.size === 0 ||
    bw.size === 0
  ) {
    return 0;
  }

  let common = 0;

  for (
    const word of aw
  ) {
    if (bw.has(word)) {
      common++;
    }
  }

  return (
    common /
    Math.max(
      aw.size,
      bw.size,
    )
  );
}


async function isRepeatedStoryText(
  story: AIStory,
): Promise<boolean> {
  const recent =
    await getRecentTitles(
      MAX_HISTORY_CHECKED,
    );

  if (
    !story.headline.trim()
  ) {
    return false;
  }

  for (
    const oldTitle of recent
  ) {
    if (
      similarity(
        story.headline,
        oldTitle,
      ) >= 0.72
    ) {
      return true;
    }
  }

  return false;
}


// ============================================================
// SOURCE
// ============================================================

function cleanSourceName(
  source: string,
  articleMedia: ArticleMedia,
): string {
  const candidate =
    articleMedia.sourceName ||
    source ||
    "Источник";

  return cleanText(
    candidate
      .replace(
        /^https?:\/\//i,
        "",
      )
      .replace(
        /^www\./i,
        "",
      ),
  );
}


// ============================================================
// POST
// ============================================================

function buildPost(
  item: NewsItem,
  story: AIStory,
  sourceName: string,
  articleUrl: string,
): string {
  const header =
    story.urgent
      ? "🔴 <b>ФАКТОР • ОПЕРАТИВНО</b>"
      : "🔵 <b>ФАКТОР • ГЛАВНОЕ</b>";

  const category =
    `${item.categoryEmoji} <b>${escapeHtml(
      item.category,
    )}</b>`;

  const headline =
    `<b>${escapeHtml(
      truncate(
        story.headline,
        260,
      ),
    )}</b>`;

  const short =
    escapeHtml(
      truncate(
        story.short,
        500,
      ),
    );

  const main =
    story.main
      .filter(Boolean)
      .map(
        (x) =>
          `• ${escapeHtml(
            truncate(
              x,
              350,
            ),
          )}`,
      )
      .join("\n");

  const important =
    escapeHtml(
      truncate(
        story.important,
        400,
      ),
    );

  const time =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        hour:
          "2-digit",

        minute:
          "2-digit",

        timeZone:
          "Europe/Moscow",
      },
    ).format(
      new Date(),
    );

  const safeUrl =
    isUsableArticleUrl(
      articleUrl,
    )
      ? articleUrl
      : "";

  const sourceLine =
    safeUrl
      ? `🔗 <a href="${escapeHtml(
          safeUrl,
        )}">${escapeHtml(
          sourceName,
        )}</a>`
      : `🔗 ${escapeHtml(
          sourceName,
        )}`;

  return [
    header,

    "",

    category,

    "",

    headline,

    "",

    "<b>КРАТКО</b>",

    short,

    "",

    "<b>ГЛАВНОЕ</b>",

    main ||
      `• ${short}`,

    "",

    "<b>ЧТО ВАЖНО</b>",

    important ||
      short,

    "",

    `🕒 ${time}`,

    sourceLine,

    "",

    "<i>ФАКТОР</i>",
  ].join("\n");
}


// ============================================================
// MEDIA
// ============================================================

async function findBestMedia(
  articleMedia: ArticleMedia,
): Promise<DownloadedMedia | null> {
  // 1. VIDEO

  if (
    articleMedia.videoUrl
  ) {
    console.log(
      "Trying article video:",
      articleMedia.videoUrl,
    );

    const video =
      await downloadMedia(
        articleMedia.videoUrl,
        "video",
      );

    if (video) {
      return video;
    }
  }

  // 2. IMAGE

  if (
    articleMedia.imageUrl
  ) {
    console.log(
      "Trying article image:",
      articleMedia.imageUrl,
    );

    const image =
      await downloadMedia(
        articleMedia.imageUrl,
        "image",
      );

    if (image) {
      return image;
    }
  }

  // 3. TEXT
  return null;
}


// ============================================================
// CANDIDATE
// ============================================================

async function chooseCandidate(
  items: NewsItem[],
  urgentAllowed: boolean,
  regularAllowed: boolean,
): Promise<{
  item: NewsItem;
  story: AIStory;
  articleMedia: ArticleMedia;
} | null> {
  const sorted =
    [...items]
      .filter(
        (item) =>
          item.title.length >= 15,
      )
      .sort(
        (a, b) => {
          const ad =
            Date.parse(
              a.pubDate,
            ) || 0;

          const bd =
            Date.parse(
              b.pubDate,
            ) || 0;

          return bd - ad;
        },
      );

  for (
    const item of sorted
  ) {
    // Сначала определяем локальную срочность,
    // чтобы не тратить Gemini на очевидно неподходящие
    // старые повторы.

    const locallyUrgent =
      detectUrgency(item);

    if (
      locallyUrgent &&
      !urgentAllowed
    ) {
      continue;
    }

    if (
      !locallyUrgent &&
      !regularAllowed
    ) {
      continue;
    }

    const articleMedia =
      await extractArticleMedia(
        item.link,
      );

    const articleUrl =
      articleMedia.articleUrl;

    if (
      await isAlreadyPublished(
        item,
        articleUrl,
      )
    ) {
      continue;
    }

    const story =
      (await callGemini(
        item,
      )) ||
      makeFallbackStory(
        item,
      );

    story.urgent =
      story.urgent ||
      locallyUrgent;

    if (
      story.urgent &&
      !urgentAllowed
    ) {
      continue;
    }

    if (
      !story.urgent &&
      !regularAllowed
    ) {
      continue;
    }

    if (
      await isRepeatedStoryText(
        story,
      )
    ) {
      continue;
    }

    return {
      item,
      story,
      articleMedia,
    };
  }

  return null;
}


// ============================================================
// ATOMIC KV LOCK
// ============================================================

const PIPELINE_LOCK_KEY = [
  "factor",
  "lock",
];


async function acquirePipelineLock(): Promise<string | null> {
  const db =
    await getKV();

  const token =
    crypto.randomUUID();

  const result =
    await db
      .atomic()
      .check({
        key:
          PIPELINE_LOCK_KEY,
        versionstamp:
          null,
      })
      .set(
        PIPELINE_LOCK_KEY,
        {
          token,
          created_at:
            Date.now(),
        },
        {
          expireIn:
            LOCK_TTL_MS,
        },
      )
      .commit();

  if (!result.ok) {
    return null;
  }

  return token;
}


async function releasePipelineLock(
  token: string,
): Promise<void> {
  const db =
    await getKV();

  const current =
    await db.get<{
      token: string;
      created_at: number;
    }>(
      PIPELINE_LOCK_KEY,
    );

  if (
    current.value?.token !==
    token
  ) {
    return;
  }

  await db
    .atomic()
    .check({
      key:
        PIPELINE_LOCK_KEY,
      versionstamp:
        current.versionstamp,
    })
    .delete(
      PIPELINE_LOCK_KEY,
    )
    .commit();
}


// ============================================================
// STATE
// ============================================================

async function getState(): Promise<PipelineState> {
  const db =
    await getKV();

  const regular =
    (
      await db.get<number>(
        [
          "factor",
          "state",
          "last_regular",
        ],
      )
    ).value ?? null;

  const urgent =
    (
      await db.get<number>(
        [
          "factor",
          "state",
          "last_urgent",
        ],
      )
    ).value ?? null;

  const lastPipeline =
    (
      await db.get<unknown>(
        [
          "factor",
          "state",
          "last_pipeline",
        ],
      )
    ).value ?? null;

  const lock =
    await db.get<unknown>(
      PIPELINE_LOCK_KEY,
    );

  const running =
    Boolean(
      lock.value,
    );

  const now =
    Date.now();

  return {
    running,

    cron:
      CRON_SCHEDULE,

    regular: {
      interval_minutes:
        30,

      last:
        regular,

      can_publish:
        regular === null ||
        now -
            regular >=
          REGULAR_INTERVAL_MS,
    },

    urgent: {
      interval_minutes:
        5,

      last:
        urgent,

      can_publish:
        urgent === null ||
        now -
            urgent >=
          URGENT_INTERVAL_MS,
    },

    media: {
      max_video_mb:
        MAX_VIDEO_BYTES /
        1024 /
        1024,

      max_image_mb:
        MAX_IMAGE_BYTES /
        1024 /
        1024,

      priority:
        "video -> image -> text",
    },

    dedup: {
      persistent:
        true,

      ttl_days:
        30,

      max_history_checked:
        MAX_HISTORY_CHECKED,
    },

    lock: {
      atomic:
        true,

      ttl_minutes:
        LOCK_TTL_MS /
        60000,
    },

    last_pipeline:
      lastPipeline,
  };
}


// ============================================================
// PIPELINE
// ============================================================

async function runPipeline(
  manual = false,
): Promise<any> {
  const lock =
    await acquirePipelineLock();

  if (!lock) {
    return {
      ok: false,

      skipped: true,

      reason:
        "pipeline already running",
    };
  }

  try {
    return await executePipeline(
      manual,
    );
  } finally {
    await releasePipelineLock(
      lock,
    );
  }
}


async function executePipeline(
  manual = false,
): Promise<any> {
  const db =
    await getKV();

  const startedAt =
    Date.now();

  try {
    const feedResults =
      await Promise.all(
        RSS_FEEDS.map(
          loadRSS,
        ),
      );

    const items =
      feedResults
        .flat()
        .sort(
          (a, b) => {
            const ad =
              Date.parse(
                a.pubDate,
              ) || 0;

            const bd =
              Date.parse(
                b.pubDate,
              ) || 0;

            return bd - ad;
          },
        )
        .slice(
          0,
          MAX_RSS_ITEMS,
        );

    console.log(
      "RSS items:",
      items.length,
    );

    const now =
      Date.now();

    const lastRegular =
      (
        await db.get<number>(
          [
            "factor",
            "state",
            "last_regular",
          ],
        )
      ).value ?? null;

    const lastUrgent =
      (
        await db.get<number>(
          [
            "factor",
            "state",
            "last_urgent",
          ],
        )
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
      !urgentAllowed &&
      !regularAllowed
    ) {
      const result = {
        ok: true,

        selected: 0,

        reason:
          "publication intervals not reached",

        rss_total:
          items.length,

        duration_ms:
          Date.now() -
          startedAt,
      };

      await db.set(
        [
          "factor",
          "state",
          "last_pipeline",
        ],
        result,
      );

      return result;
    }

    const candidate =
      await chooseCandidate(
        items,
        urgentAllowed,
        regularAllowed,
      );

    if (!candidate) {
      const result = {
        ok: true,

        selected: 0,

        reason:
          "no new non-duplicate candidate",

        rss_total:
          items.length,

        duration_ms:
          Date.now() -
          startedAt,
      };

      await db.set(
        [
          "factor",
          "state",
          "last_pipeline",
        ],
        result,
      );

      return result;
    }

    const {
      item,
      story,
      articleMedia,
    } =
      candidate;

    const urgent =
      story.urgent ||
      detectUrgency(item);

    if (
      urgent &&
      !urgentAllowed &&
      !manual
    ) {
      return {
        ok: true,
        selected: 0,
        reason:
          "urgent interval not reached",
      };
    }

    if (
      !urgent &&
      !regularAllowed &&
      !manual
    ) {
      return {
        ok: true,
        selected: 0,
        reason:
          "regular interval not reached",
      };
    }

    const finalArticleUrl =
      isUsableArticleUrl(
        articleMedia.articleUrl,
      )
        ? articleMedia.articleUrl
        : "";

    // Повторная защита от публикации.
    if (
      await isAlreadyPublished(
        item,
        finalArticleUrl,
      )
    ) {
      return {
        ok: true,

        selected: 0,

        reason:
          "duplicate detected before publish",
      };
    }

    const media =
      await findBestMedia(
        articleMedia,
      );

    const sourceName =
      cleanSourceName(
        item.source,
        articleMedia,
      );

    const text =
      buildPost(
        item,
        story,
        sourceName,
        finalArticleUrl,
      );

    let mediaInfo:
      | {
          type:
            | "video"
            | "image";

          token: string;
        }
      | undefined;

    if (media) {
      try {
        console.log(
          "Uploading media:",
          media.type,
          media.bytes.byteLength,
        );

        const token =
          await uploadMedia(
            media,
          );

        mediaInfo = {
          type:
            media.type,

          token,
        };
      } catch (error) {
        console.error(
          "Media upload failed:",
          error instanceof Error
            ? error.message
            : String(error),
        );

        // Важное правило:
        // если медиа не загрузилось,
        // текстовая публикация всё равно возможна.
        mediaInfo =
          undefined;
      }
    }

    let publication:
      any;

    if (mediaInfo) {
      try {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              mediaInfo.type ===
                "video"
                ? 5000
                : 2500,
            ),
        );

        publication =
          await publishToMax(
            text,
            mediaInfo,
          );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        // MAX может вернуть attachment.not.ready.
        // Повторяем публикацию без повторной загрузки файла.

        if (
          message.includes(
            "attachment.not.ready",
          ) ||
          message.includes(
            "not.processed",
          )
        ) {
          console.log(
            "MAX attachment not ready. Retrying...",
          );

          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                8000,
              ),
          );

          publication =
            await publishToMax(
              text,
              mediaInfo,
            );
        } else {
          throw error;
        }
      }
    } else {
      publication =
        await publishToMax(
          text,
        );
    }

    // Только после успешной публикации
    // отмечаем новость как опубликованную.

    await markPublished(
      item,
      finalArticleUrl,
    );

    await rememberTitle(
      story.headline,
    );

    if (urgent) {
      await db.set(
        [
          "factor",
          "state",
          "last_urgent",
        ],
        now,
      );
    } else {
      await db.set(
        [
          "factor",
          "state",
          "last_regular",
        ],
        now,
      );
    }

    const result = {
      ok: true,

      selected: 1,

      urgent,

      manual,

      rss_total:
        items.length,

      item: {
        title:
          item.title,

        source:
          sourceName,

        article_url:
          finalArticleUrl ||
          null,

        category:
          item.category,
      },

      media:
        media
          ? {
              type:
                media.type,

              source_url:
                media.sourceUrl,
            }
          : null,

      publication,

      duration_ms:
        Date.now() -
        startedAt,
    };

    await db.set(
      [
        "factor",
        "state",
        "last_pipeline",
      ],
      result,
    );

    return result;
  } catch (error) {
    const result = {
      ok: false,

      error:
        error instanceof Error
          ? error.message
          : String(error),

      duration_ms:
        Date.now() -
        startedAt,
    };

    await db.set(
      [
        "factor",
        "state",
        "last_pipeline",
      ],
      result,
    );

    console.error(
      "PIPELINE ERROR:",
      result,
    );

    return result;
  }
}


// ============================================================
// TEST PUBLISH
// ============================================================

async function publishTest(): Promise<any> {
  const text = [
    "🔴 <b>ФАКТОР • ТЕСТ</b>",

    "",

    "📡 Система публикации работает.",

    "",

    `🕒 ${new Intl.DateTimeFormat(
      "ru-RU",
      {
        hour:
          "2-digit",

        minute:
          "2-digit",

        timeZone:
          "Europe/Moscow",
      },
    ).format(
      new Date(),
    )}`,

    "",

    "<i>ФАКТОР</i>",
  ].join("\n");

  return await publishToMax(
    text,
  );
}


// ============================================================
// JSON
// ============================================================

function json(
  value: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(
      value,
      null,
      2,
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",
      },
    },
  );
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
      "CRON: starting pipeline",
    );

    try {
      const result =
        await runPipeline(
          false,
        );

      console.log(
        "CRON: finished",
        JSON.stringify(
          result,
        ),
      );
    } catch (error) {
      console.error(
        "CRON ERROR:",
        error,
      );

      throw error;
    }
  },
);


// ============================================================
// HTTP SERVER
// ============================================================

Deno.serve(
  async (
    request,
  ) => {
    const url =
      new URL(
        request.url,
      );

    const path =
      url.pathname.replace(
        /\/$/,
        "",
      ) || "/";

    try {
      // ------------------------------------------------------
      // ROOT
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/"
      ) {
        return json({
          ok: true,

          service:
            "MAX NEWS AGENT — ФАКТОР",

          runtime:
            "Deno Deploy",

          cron:
            CRON_SCHEDULE,

          endpoints: [
            "/",
            "/status",
            "/pipeline-state",
            "/run",
            "/publish-test",
            "/me",
          ],
        });
      }

      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/status"
      ) {
        return json({
          ok: true,

          now:
            new Date().toISOString(),

          service:
            "MAX NEWS AGENT — ФАКТОР",

          runtime:
            "Deno Deploy",

          auto_pipeline:
            true,

          max_connection: {
            ca_loaded:
              maxCaStatus.loaded,

            root_ca:
              maxCaStatus.root,

            sub_ca:
              maxCaStatus.sub,

            error:
              maxCaStatus.error,
          },

          configuration: {
            max_token:
              Boolean(
                MAX_BOT_TOKEN,
              ),

            target_chat:
              Boolean(
                TARGET_CHAT_ID,
              ),

            gemini:
              Boolean(
                GEMINI_API_KEY,
              ),
          },

          ...(await getState()),
        });
      }

      // ------------------------------------------------------
      // PIPELINE STATE
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path ===
          "/pipeline-state"
      ) {
        return json({
          ok: true,

          ...(await getState()),
        });
      }

      // ------------------------------------------------------
      // MANUAL RUN
      // ------------------------------------------------------

      if (
        (
          request.method === "GET" ||
          request.method === "POST"
        ) &&
        path === "/run"
      ) {
        const result =
          await runPipeline(
            true,
          );

        return json(
          result,
        );
      }

      // ------------------------------------------------------
      // TEST PUBLISH
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path ===
          "/publish-test"
      ) {
        const result =
          await publishTest();

        return json({
          ok: true,

          provider:
            "MAX",

          operation:
            "publish-test",

          chat_id:
            TARGET_CHAT_ID,

          response:
            result,
        });
      }

      // ------------------------------------------------------
      // ME
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/me"
      ) {
        const me =
          await maxJson(
            "/me",
            {
              method: "GET",
            },
          );

        return json({
          ok: true,

          max_me:
            me,
        });
      }

      // ------------------------------------------------------
      // WEBHOOK
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        path === "/webhook"
      ) {
        const body =
          await request.text();

        console.log(
          "WEBHOOK:",
          body.slice(
            0,
            2000,
          ),
        );

        return json({
          ok: true,

          received:
            true,
        });
      }

      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      return json(
        {
          ok: false,

          error:
            "Endpoint not found",

          path,
        },
        404,
      );
    } catch (error) {
      console.error(
        "HTTP ERROR:",
        error,
      );

      return json(
        {
          ok: false,

          error:
            error instanceof Error
              ? error.message
              : String(error),

          path,
        },
        500,
      );
    }
  },
);