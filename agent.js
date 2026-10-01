// ============================================================
// MAX NEWS AGENT — ФАКТОР
// DENO DEPLOY
// ============================================================
//
// ЛОГИКА:
//
// 1. Cron — каждые 5 минут.
// 2. RSS — мировые новости + политика + экономика + бизнес +
//    финансы + право + происшествия + технологии и т.д.
// 3. Срочная новость может выйти не чаще 1 раза в 5 минут.
// 4. Обычная новость — не чаще 1 раза в 30 минут.
// 5. Deno KV хранит опубликованные новости 30 дней.
// 6. Повторяющиеся формулировки блокируются.
// 7. Google News URL НЕ публикуется как источник.
// 8. Сначала открывается реальная страница СМИ.
// 9. Медиа берётся именно со страницы СМИ:
//       VIDEO -> IMAGE -> TEXT
// 10. Видео/изображение скачивается на сервер агента
//     и загружается в MAX.
// 11. HTML отправляется с format: "html".
// 12. /pipeline-state существует.
// 13. /status существует.
// 14. /run существует.
// 15. /publish-test существует.
// 16. /me существует.
// ============================================================

const MAX_API =
  "https://platform-api2.max.ru";

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") ?? "";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") ?? "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? "";

// ------------------------------------------------------------
// НАСТРОЙКИ
// ------------------------------------------------------------

const CRON_SCHEDULE =
  "*/5 * * * *";

const URGENT_INTERVAL_MS =
  5 * 60 * 1000;

const REGULAR_INTERVAL_MS =
  30 * 60 * 1000;

const HISTORY_TTL_MS =
  30 * 24 * 60 * 60 * 1000;

const MAX_VIDEO_BYTES =
  Number(
    Deno.env.get("MAX_VIDEO_MB") ??
      "60",
  ) *
  1024 *
  1024;

const MAX_IMAGE_BYTES =
  Number(
    Deno.env.get("MAX_IMAGE_MB") ??
      "15",
  ) *
  1024 *
  1024;

const RSS_LIMIT_PER_FEED =
  30;

const MAX_RSS_ITEMS =
  300;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140 Safari/537.36";

// ------------------------------------------------------------
// RSS
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// DENO KV
// ------------------------------------------------------------

let kv: Deno.Kv | null = null;

async function getKV(): Promise<Deno.Kv> {
  if (!kv) {
    kv = await Deno.openKv();
  }

  return kv;
}

// ------------------------------------------------------------
// TYPES
// ------------------------------------------------------------

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

  last_pipeline: unknown;
};

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

async function getState(): Promise<PipelineState> {
  const db =
    await getKV();

  const regular =
    (
      await db.get<number>([
        "factor",
        "state",
        "last_regular",
      ])
    ).value ?? null;

  const urgent =
    (
      await db.get<number>([
        "factor",
        "state",
        "last_urgent",
      ])
    ).value ?? null;

  const lastPipeline =
    (
      await db.get<any>([
        "factor",
        "state",
        "last_pipeline",
      ])
    ).value ?? null;

  const running =
    (
      await db.get<boolean>([
        "factor",
        "state",
        "running",
      ])
    ).value ?? false;

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
        300,
    },

    last_pipeline:
      lastPipeline,
  };
}

// ------------------------------------------------------------
// TEXT UTILS
// ------------------------------------------------------------

function cleanText(
  value: unknown,
): string {
  return String(value ?? "")
    .replace(
      /<!\[CDATA\[/gi,
      "",
    )
    .replace(
      /\]\]>/gi,
      "",
    )
    .replace(
      /<br\s*\/?>/gi,
      "\n",
    )
    .replace(
      /<[^>]+>/g,
      " ",
    )
    .replace(
      /&nbsp;/gi,
      " ",
    )
    .replace(
      /&amp;/gi,
      "&",
    )
    .replace(
      /&quot;/gi,
      '"',
    )
    .replace(
      /&#39;/gi,
      "'",
    )
    .replace(
      /&#x27;/gi,
      "'",
    )
    .replace(
      /&#(\d+);/g,
      (
        _,
        code,
      ) =>
        String.fromCodePoint(
          Number(code),
        ),
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function stripHtml(
  value: string,
): string {
  return cleanText(value)
    .replace(
      /\*\*/g,
      "",
    )
    .replace(
      /__+/g,
      "",
    )
    .trim();
}

function escapeHtml(
  value: string,
): string {
  return value
    .replace(
      /&/g,
      "&amp;",
    )
    .replace(
      /</g,
      "&lt;",
    )
    .replace(
      />/g,
      "&gt;",
    )
    .replace(
      /"/g,
      "&quot;",
    );
}

function normalizeForHash(
  value: string,
): string {
  return stripHtml(value)
    .toLowerCase()
    .replace(
      /ё/g,
      "е",
    )
    .replace(
      /[«»"“”'`]/g,
      "",
    )
    .replace(
      /[^a-zа-я0-9]+/gi,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
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

  return [
    ...new Uint8Array(hash),
  ]
    .map(
      (b) =>
        b
          .toString(16)
          .padStart(
            2,
            "0",
          ),
    )
    .join("");
}

function truncate(
  value: string,
  max: number,
): string {
  const s =
    value.trim();

  if (
    s.length <= max
  ) {
    return s;
  }

  return (
    s
      .slice(
        0,
        max - 1,
      )
      .trimEnd() +
    "…"
  );
}

// ------------------------------------------------------------
// RSS
// ------------------------------------------------------------

function extractXmlTag(
  xml: string,
  tag: string,
): string {
  const re =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i",
    );

  return (
    re.exec(xml)?.[1] ??
    ""
  );
}

function parseRSS(
  xml: string,
  feed: typeof RSS_FEEDS[number],
): NewsItem[] {
  const items:
    NewsItem[] = [];

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

    if (
      !response.ok
    ) {
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

// ------------------------------------------------------------
// GOOGLE NEWS
// ------------------------------------------------------------

function isGoogleNewsUrl(
  url: string,
): boolean {
  try {
    const host =
      new URL(
        url,
      )
        .hostname
        .toLowerCase();

    return (
      host ===
        "news.google.com" ||
      host.endsWith(
        ".news.google.com",
      )
    );
  } catch {
    return false;
  }
}

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
      !isGoogleNewsUrl(
        finalUrl,
      ) &&
      /^https?:\/\//i.test(
        finalUrl,
      )
    ) {
      return finalUrl;
    }

    const html =
      await response.text();

    const canonical =
      html.match(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
      )?.[1];

    if (
      canonical &&
      !isGoogleNewsUrl(
        canonical,
      ) &&
      /^https?:\/\//i.test(
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

    if (
      ogUrl &&
      !isGoogleNewsUrl(
        ogUrl,
      ) &&
      /^https?:\/\//i.test(
        ogUrl,
      )
    ) {
      return ogUrl;
    }
  } catch (error) {
    console.error(
      "Google News resolve:",
      error instanceof Error
        ? error.message
        : String(error),
    );
  }

  return originalUrl;
}

// ------------------------------------------------------------
// HTML META
// ------------------------------------------------------------

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

    if (
      match?.[1]
    ) {
      return cleanText(
        match[1],
      );
    }
  }

  return null;
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

// ------------------------------------------------------------
// VIDEO EXTRACTION
// ------------------------------------------------------------

function isDirectVideoUrl(
  url: string,
): boolean {
  const lower =
    url.toLowerCase();

  if (
    lower.includes(
      ".m3u8",
    ) ||
    lower.includes(
      ".mpd",
    )
  ) {
    return false;
  }

  return (
    lower.includes(".mp4") ||
    lower.includes(".mov") ||
    lower.includes(".webm") ||
    lower.includes(".mkv") ||
    lower.includes(".matroska")
  );
}

function normalizeMediaUrl(
  value: string,
): string {
  return value
    .replace(
      /\\\//g,
      "/",
    )
    .replace(
      /\\u0026/gi,
      "&",
    )
    .replace(
      /&amp;/gi,
      "&",
    )
    .trim();
}

function collectVideoUrls(
  value: unknown,
  result: string[],
): void {
  if (
    typeof value ===
    "string"
  ) {
    if (
      isDirectVideoUrl(
        value,
      )
    ) {
      result.push(
        value,
      );
    }

    return;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const item of value
    ) {
      collectVideoUrls(
        item,
        result,
      );
    }

    return;
  }

  if (
    value &&
    typeof value ===
      "object"
  ) {
    for (
      const [key, item] of Object.entries(
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
        ].includes(
          key,
        )
      ) {
        collectVideoUrls(
          item,
          result,
        );
      }

      if (
        key ===
          "@graph" ||
        key ===
          "video" ||
        key ===
          "content"
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
  const candidates:
    string[] = [];

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
      candidates.push(
        value,
      );
    }
  }

  // <video src="">
  for (
    const match of html.matchAll(
      /<video[^>]+src=["']([^"']+)["'][^>]*>/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  // <source src="">
  for (
    const match of html.matchAll(
      /<source[^>]+src=["']([^"']+)["'][^>]*>/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  // JSON contentUrl / videoUrl / file
  for (
    const match of html.matchAll(
      /["'](?:contentUrl|videoUrl|video_url|file)["']\s*:\s*["']([^"']+)["']/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  // Иногда URL экранирован
  for (
    const match of html.matchAll(
      /https?:\\?\/\\?\/[^"'\\\s]+?\.(?:mp4|mov|webm|mkv)(?:\?[^"'\\\s]+)?/gi,
    )
  ) {
    candidates.push(
      match[0],
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
      !url
    ) {
      continue;
    }

    if (
      isDirectVideoUrl(
        url,
      )
    ) {
      return url;
    }
  }

  // ----------------------------------------------------------
  // JSON-LD
  // ----------------------------------------------------------

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

      const urls:
        string[] = [];

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
          isDirectVideoUrl(
            url,
          )
        ) {
          return url;
        }
      }
    } catch {
      // malformed JSON-LD — ignore
    }
  }

  return null;
}

// ------------------------------------------------------------
// ARTICLE MEDIA
// ------------------------------------------------------------

async function extractArticleMedia(
  originalUrl: string,
): Promise<ArticleMedia> {
  const articleUrl =
    await resolveArticleUrl(
      originalUrl,
    );

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

    if (
      !response.ok
    ) {
      return {
        articleUrl,
        imageUrl:
          null,
        videoUrl:
          null,
        sourceName:
          null,
      };
    }

    const finalArticleUrl =
      response.url ||
      articleUrl;

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
      imageUrl:
        null,
      videoUrl:
        null,
      sourceName:
        null,
    };
  }
}

// ------------------------------------------------------------
// MEDIA DOWNLOAD
// ------------------------------------------------------------

function extensionFromType(
  type:
    | "video"
    | "image",
  contentType: string,
  url: string,
): string {
  const ct =
    contentType.toLowerCase();

  if (
    type ===
    "video"
  ) {
    if (
      ct.includes(
        "webm",
      )
    ) {
      return "webm";
    }

    if (
      ct.includes(
        "quicktime",
      )
    ) {
      return "mov";
    }

    if (
      ct.includes(
        "matroska",
      )
    ) {
      return "mkv";
    }

    return "mp4";
  }

  if (
    ct.includes(
      "png",
    )
  ) {
    return "png";
  }

  if (
    ct.includes(
      "gif",
    )
  ) {
    return "gif";
  }

  if (
    ct.includes(
      "webp",
    )
  ) {
    return "webp";
  }

  try {
    const path =
      new URL(
        url,
      ).pathname;

    const match =
      path.match(
        /\.([a-z0-9]{2,5})$/i,
      );

    if (
      match
    ) {
      return match[1]
        .toLowerCase();
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
              type ===
              "video"
                ? "video/mp4,video/quicktime,video/webm,video/*;q=0.9,*/*;q=0.3"
                : "image/avif,image/webp,image/apng,image/*,*/*;q=0.5",
          },

          signal:
            AbortSignal.timeout(
              type ===
                "video"
                ? 30000
                : 15000,
            ),
        },
      );

    if (
      !response.ok
    ) {
      console.error(
        `Media HTTP ${response.status}: ${url}`,
      );

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
      )
    ) {
      console.log(
        "Streaming manifest skipped:",
        url,
      );

      return null;
    }

    const contentLength =
      Number(
        response.headers.get(
          "content-length",
        ) ?? "0",
      );

    const limit =
      type ===
      "video"
        ? MAX_VIDEO_BYTES
        : MAX_IMAGE_BYTES;

    if (
      contentLength >
      limit
    ) {
      console.log(
        `Media too large: ${Math.round(
          contentLength /
            1024 /
            1024,
        )} MB`,
      );

      return null;
    }

    const buffer =
      new Uint8Array(
        await response.arrayBuffer(),
      );

    if (
      buffer.byteLength >
      limit
    ) {
      return null;
    }

    const finalUrl =
      response.url ||
      url;

    if (
      type ===
        "video" &&
      !contentType.startsWith(
        "video/",
      )
    ) {
      if (
        !isDirectVideoUrl(
          finalUrl,
        )
      ) {
        console.log(
          "Not a direct video response:",
          contentType,
          finalUrl,
        );

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
          type ===
          "video"
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

// ------------------------------------------------------------
// MAX API
// ------------------------------------------------------------

async function maxFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (
    !MAX_BOT_TOKEN
  ) {
    throw new Error(
      "MAX_BOT_TOKEN is missing",
    );
  }

  const headers =
    new Headers(
      options.headers ??
        {},
    );

  headers.set(
    "Authorization",
    MAX_BOT_TOKEN,
  );

  return fetch(
    `${MAX_API}${path}`,
    {
      ...options,
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

  let data:
    any;

  try {
    data =
      text
        ? JSON.parse(
            text,
          )
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
        data,
      )}`,
    );
  }

  return data as T;
}

// ------------------------------------------------------------
// MAX UPLOAD
// ------------------------------------------------------------

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
        method:
          "POST",

        headers: {
          "Accept":
            "application/json",
        },
      },
    );

  if (
    !init.url
  ) {
    throw new Error(
      `MAX upload URL missing for ${media.type}`,
    );
  }

  const form =
    new FormData();

  const blob =
    new Blob(
      [
        media.bytes,
      ],
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
        method:
          "POST",

        body:
          form,

        headers: {
          "Authorization":
            MAX_BOT_TOKEN,
        },

        signal:
          AbortSignal.timeout(
            60000,
          ),
      },
    );

  if (
    !uploadResponse.ok
  ) {
    const errorText =
      await uploadResponse.text();

    throw new Error(
      `Media upload HTTP ${
        uploadResponse.status
      }: ${errorText.slice(
        0,
        1000,
      )}`,
    );
  }

  const uploadText =
    await uploadResponse.text();

  let uploadResult:
    any = null;

  try {
    uploadResult =
      uploadText
        ? JSON.parse(
            uploadText,
          )
        : null;
  } catch {
    uploadResult =
      null;
  }

  // MAX /uploads возвращает token.
  // Для image/video именно он используется
  // в attachments.payload.token.
  const finalToken =
    init.token ||
    uploadResult?.token ||
    uploadResult?.mediafile_token ||
    uploadResult
      ?.photos
      ?.photoIds
      ?.token ||
    null;

  if (
    typeof finalToken !==
    "string" ||
    !finalToken
  ) {
    throw new Error(
      `MAX media token missing for ${media.type}. Response: ${uploadText.slice(
        0,
        1500,
      )}`,
    );
  }

  return finalToken;
}

// ------------------------------------------------------------
// MAX PUBLISH
// ------------------------------------------------------------

async function publishToMax(
  text: string,
  mediaToken?: {
    type:
      | "video"
      | "image";

    token: string;
  },
): Promise<any> {
  if (
    !TARGET_CHAT_ID
  ) {
    throw new Error(
      "TARGET_CHAT_ID is missing",
    );
  }

  const body:
    any = {
      text,

      format:
        "html",

      notify:
        true,
    };

  if (
    mediaToken
  ) {
    body.attachments =
      [
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
      method:
        "POST",

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

// ------------------------------------------------------------
// DEDUP
// ------------------------------------------------------------

async function isAlreadyPublished(
  item: NewsItem,
): Promise<boolean> {
  const db =
    await getKV();

  const key =
    await sha256(
      normalizeForHash(
        `${item.title}|${item.source}`,
      ),
    );

  const result =
    await db.get<boolean>(
      [
        "factor",
        "published",
        key,
      ],
    );

  return (
    result.value ===
    true
  );
}

async function markPublished(
  item: NewsItem,
): Promise<void> {
  const db =
    await getKV();

  const key =
    await sha256(
      normalizeForHash(
        `${item.title}|${item.source}`,
      ),
    );

  await db.set(
    [
      "factor",
      "published",
      key,
    ],
    true,
    {
      expireIn:
        HISTORY_TTL_MS,
    },
  );
}

async function getRecentTitles(
  limit = 300,
): Promise<string[]> {
  const db =
    await getKV();

  const titles:
    string[] = [];

  for await (
    const entry of db.list<string>(
      {
        prefix: [
          "factor",
          "recent_title",
        ],
      },
    )
  ) {
    if (
      entry.value
    ) {
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

// ------------------------------------------------------------
// URGENCY
// ------------------------------------------------------------

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
    (
      pattern,
    ) =>
      text.includes(
        pattern,
      ),
  );
}

// ------------------------------------------------------------
// GEMINI
// ------------------------------------------------------------

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

    if (
      !match
    ) {
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
  if (
    !GEMINI_API_KEY
  ) {
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
  "short": "одно короткое предложение, которое объясняет событие",
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
2. Не повторяй одну и ту же мысль.
3. short, main и important должны давать разную информацию.
4. Если данных недостаточно — не додумывай.
5. Не пиши "ситуация развивается".
6. Не пиши "стало известно".
7. Не используй рекламные формулировки.
8. headline должен быть конкретным.
9. main может содержать 1–3 пункта.
10. Если фактов мало — лучше 1 пункт.
11. urgent=true только для действительно срочной новости.
12. Обычная новость = urgent=false.
`;

  try {
    const response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
          encodeURIComponent(
            GEMINI_API_KEY,
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

    if (
      !response.ok
    ) {
      const errorText =
        await response.text();

      console.error(
        "Gemini HTTP:",
        response.status,
        errorText.slice(
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
          (
            p: any,
          ) =>
            p.text ??
            "",
        )
        .join("")
        .trim();

    if (
      !text
    ) {
      return null;
    }

    const json =
      extractJson(
        text,
      );

    if (
      !json
    ) {
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
                (
                  x: any,
                ) =>
                  stripHtml(
                    String(x),
                  ),
              )
              .filter(
                Boolean,
              )
              .slice(
                0,
                3,
              )
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
        detectUrgency(
          item,
        ),
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

// ------------------------------------------------------------
// FALLBACK
// ------------------------------------------------------------

function makeFallbackStory(
  item: NewsItem,
): AIStory {
  const text =
    truncate(
      item.description ||
        item.title,
      350,
    );

  return {
    headline:
      stripHtml(
        item.title,
      ),

    short:
      text,

    main:
      [
        text,
      ],

    important:
      text,

    urgent:
      detectUrgency(
        item,
      ),
  };
}

// ------------------------------------------------------------
// DUPLICATE TEXT
// ------------------------------------------------------------

function textWords(
  value: string,
): Set<string> {
  return new Set(
    normalizeForHash(
      value,
    )
      .split(" ")
      .filter(
        (
          word,
        ) =>
          word.length >=
          5,
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
    aw.size ===
      0 ||
    bw.size ===
      0
  ) {
    return 0;
  }

  let common =
    0;

  for (
    const word of aw
  ) {
    if (
      bw.has(word)
    ) {
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
      300,
    );

  const candidate =
    story.headline;

  if (
    !candidate.trim()
  ) {
    return false;
  }

  for (
    const oldTitle of recent
  ) {
    const score =
      similarity(
        candidate,
        oldTitle,
      );

    if (
      score >=
      0.72
    ) {
      return true;
    }
  }

  return false;
}

// ------------------------------------------------------------
// SOURCE
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// POST
// ------------------------------------------------------------

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
        420,
      ),
    );

  const main =
    story.main
      .filter(Boolean)
      .map(
        (
          x,
        ) =>
          `• ${escapeHtml(
            truncate(
              x,
              300,
            ),
          )}`,
      )
      .join("\n");

  const important =
    escapeHtml(
      truncate(
        story.important,
        350,
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

    `🔗 <a href="${escapeHtml(
      articleUrl,
    )}">${escapeHtml(
      sourceName,
    )}</a>`,
  ].join("\n");
}

// ------------------------------------------------------------
// MEDIA
// ------------------------------------------------------------

async function findBestMedia(
  articleMedia: ArticleMedia,
): Promise<DownloadedMedia | null> {
  // СТРОГО:
  //
  // 1. VIDEO
  // 2. IMAGE
  // 3. TEXT

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

    if (
      video
    ) {
      return video;
    }
  }

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

    if (
      image
    ) {
      return image;
    }
  }

  return null;
}

// ------------------------------------------------------------
// CANDIDATE
// ------------------------------------------------------------

async function chooseCandidate(
  items: NewsItem[],
): Promise<{
  item: NewsItem;
  story: AIStory;
  articleMedia: ArticleMedia;
} | null> {
  const sorted =
    [...items]
      .filter(
        (
          item,
        ) =>
          item.title.length >=
          15,
      )
      .sort(
        (
          a,
          b,
        ) => {
          const ad =
            Date.parse(
              a.pubDate,
            ) || 0;

          const bd =
            Date.parse(
              b.pubDate,
            ) || 0;

          return (
            bd - ad
          );
        },
      );

  for (
    const item of sorted
  ) {
    if (
      await isAlreadyPublished(
        item,
      )
    ) {
      continue;
    }

    const articleMedia =
      await extractArticleMedia(
        item.link,
      );

    const story =
      (await callGemini(
        item,
      )) ||
      makeFallbackStory(
        item,
      );

    story.urgent =
      story.urgent ||
      detectUrgency(
        item,
      );

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

// ------------------------------------------------------------
// PIPELINE
// ------------------------------------------------------------

let pipelinePromise:
  Promise<any> | null =
  null;

async function runPipeline(
  manual = false,
): Promise<any> {
  if (
    pipelinePromise
  ) {
    return {
      ok: false,
      skipped: true,
      reason:
        "pipeline already running",
    };
  }

  pipelinePromise =
    executePipeline(
      manual,
    ).finally(
      () => {
        pipelinePromise =
          null;
      },
    );

  return pipelinePromise;
}

async function executePipeline(
  manual = false,
): Promise<any> {
  const db =
    await getKV();

  const state =
    await db.get<boolean>(
      [
        "factor",
        "state",
        "running",
      ],
    );

  if (
    state.value ===
    true
  ) {
    return {
      ok: false,
      skipped: true,
      reason:
        "running",
    };
  }

  await db.set(
    [
      "factor",
      "state",
      "running",
    ],
    true,
  );

  const startedAt =
    Date.now();

  try {
    // --------------------------------------------------------
    // RSS
    // --------------------------------------------------------

    const feedResults =
      await Promise.all(
        RSS_FEEDS.map(
          loadRSS,
        ),
      );

    const items =
      feedResults
        .flat()
        .slice(
          0,
          MAX_RSS_ITEMS,
        );

    console.log(
      "RSS items:",
      items.length,
    );

    // --------------------------------------------------------
    // CANDIDATE
    // --------------------------------------------------------

    const candidate =
      await chooseCandidate(
        items,
      );

    if (
      !candidate
    ) {
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

    // --------------------------------------------------------
    // INTERVALS
    // --------------------------------------------------------

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

    const urgent =
      story.urgent ||
      detectUrgency(
        item,
      );

    const urgentAllowed =
      manual ||
      lastUrgent ===
        null ||
      now -
          lastUrgent >=
        URGENT_INTERVAL_MS;

    const regularAllowed =
      manual ||
      lastRegular ===
        null ||
      now -
          lastRegular >=
        REGULAR_INTERVAL_MS;

    if (
      urgent
    ) {
      if (
        !urgentAllowed
      ) {
        const result = {
          ok: true,
          selected: 0,
          reason:
            "urgent interval not reached",
          title:
            item.title,
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
    } else {
      if (
        !regularAllowed
      ) {
        const result = {
          ok: true,
          selected: 0,
          reason:
            "regular interval not reached",
          title:
            item.title,
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
    }

    // --------------------------------------------------------
    // MEDIA
    // --------------------------------------------------------

    const media =
      await findBestMedia(
        articleMedia,
      );

    // --------------------------------------------------------
    // ARTICLE URL
    // --------------------------------------------------------

    const sourceName =
      cleanSourceName(
        item.source,
        articleMedia,
      );

    const articleUrl =
      articleMedia.articleUrl &&
      !isGoogleNewsUrl(
        articleMedia.articleUrl,
      )
        ? articleMedia.articleUrl
        : await resolveArticleUrl(
            item.link,
          );

    // --------------------------------------------------------
    // POST TEXT
    // --------------------------------------------------------

    const text =
      buildPost(
        item,
        story,
        sourceName,
        articleUrl,
      );

    // --------------------------------------------------------
    // MEDIA UPLOAD
    // --------------------------------------------------------

    let mediaInfo:
      | {
          type:
            | "video"
            | "image";

          token: string;
        }
      | undefined;

    if (
      media
    ) {
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

        await new Promise(
          (
            resolve,
          ) =>
            setTimeout(
              resolve,
              media.type ===
                "video"
                ? 5000
                : 2500,
            ),
        );
      } catch (error) {
        console.error(
          "Media upload failed:",
          error instanceof Error
            ? error.message
            : String(error),
        );

        mediaInfo =
          undefined;
      }
    }

    // --------------------------------------------------------
    // PUBLISH
    // --------------------------------------------------------

    const publication =
      await publishToMax(
        text,
        mediaInfo,
      );

    // --------------------------------------------------------
    // SAVE
    // --------------------------------------------------------

    await markPublished(
      item,
    );

    await rememberTitle(
      story.headline,
    );

    if (
      urgent
    ) {
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
          articleUrl,

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
  } finally {
    await db.set(
      [
        "factor",
        "state",
        "running",
      ],
      false,
    );
  }
}

// ------------------------------------------------------------
// TEST
// ------------------------------------------------------------

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
  ].join("\n");

  return await publishToMax(
    text,
  );
}

// ------------------------------------------------------------
// JSON
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// CRON
// ------------------------------------------------------------
//
// Deno Deploy автоматически обнаруживает Deno.cron()
// на верхнем уровне при production deployment.
// ------------------------------------------------------------

Deno.cron(
  "FAKTOR news pipeline",
  "*/5 * * * *",
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
  },
);

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------

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
        request.method ===
          "GET" &&
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
        request.method ===
          "GET" &&
        path ===
          "/status"
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

          ...(await getState()),
        });
      }

      // ------------------------------------------------------
      // PIPELINE STATE
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
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
          request.method ===
            "GET" ||
          request.method ===
            "POST"
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
        request.method ===
          "GET" &&
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
        request.method ===
          "GET" &&
        path === "/me"
      ) {
        const me =
          await maxJson(
            "/me",
            {
              method:
                "GET",
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
        request.method ===
          "POST" &&
        path ===
          "/webhook"
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