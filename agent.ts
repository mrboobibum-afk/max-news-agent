// ============================================================
// MAX NEWS AGENT — ФАКТОР
// DENO DEPLOY
// ============================================================
//
// АВТОМАТИЧЕСКИЙ НОВОСТНОЙ АГЕНТ
//
// 1. Cron — каждые 5 минут.
// 2. RSS — мир / политика / экономика / бизнес / финансы +
//    право / происшествия / технологии / промышленность / авто.
// 3. Обычная новость — не чаще 1 раза в 30 минут.
// 4. Срочная новость — отдельный интервал 5 минут.
// 5. Максимум 1 публикация за один цикл.
// 6. Deno KV хранит историю 30 дней.
// 7. Повторяющиеся новости блокируются.
// 8. Повторяющиеся формулировки блокируются.
// 9. Google News URL НЕ публикуется.
// 10. Сначала определяется реальная страница СМИ.
// 11. Медиа берётся только со страницы СМИ.
// 12. Приоритет: VIDEO -> IMAGE -> TEXT.
// 13. Медиа загружается в MAX.
// 14. После upload ждём обработку MAX.
// 15. attachment.not.ready автоматически повторяется.
// 16. Gemini делает редакторскую упаковку.
// 17. При недоступности Gemini используется fallback.
// 18. /status
// 19. /pipeline-state
// 20. /run
// 21. /publish-test
// 22. /me
// 23. /webhook
// 24. /updates
// 25. /subscriptions
// 26. /resolve-test
// ============================================================

const MAX_API =
  "https://platform-api2.max.ru";

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN")?.trim() ?? "";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID")?.trim() ?? "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY")?.trim() ?? "";

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------

const AUTO_PIPELINE =
  (
    Deno.env.get("AUTO_PIPELINE") ??
    "true"
  ).toLowerCase() === "true";

const MAX_EVENT_MODE =
  (
    Deno.env.get("MAX_EVENT_MODE") ??
    "webhook"
  ).toLowerCase();

const REQUIRE_REAL_SOURCE_URL =
  (
    Deno.env.get(
      "REQUIRE_REAL_SOURCE_URL",
    ) ??
    "true"
  ).toLowerCase() === "true";

const MAX_NEWS_AGE_HOURS =
  Number(
    Deno.env.get(
      "MAX_NEWS_AGE_HOURS",
    ) ??
      "24",
  );

const GOOGLE_RESOLVE_ENABLED =
  (
    Deno.env.get(
      "GOOGLE_RESOLVE_ENABLED",
    ) ??
    "true"
  ).toLowerCase() === "true";

const DEBUG =
  (
    Deno.env.get("DEBUG") ??
    "false"
  ).toLowerCase() === "true";

// ------------------------------------------------------------
// MAX CERTIFICATES
// ------------------------------------------------------------

const MAX_ROOT_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";

const MAX_SUB_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";

let maxHttpClient:
  Deno.HttpClient | null = null;

let maxHttpClientError:
  string | null = null;

const maxCaStatus = {
  loaded: false,
  root: false,
  sub: false,
  error: null as string | null,
};

async function initMaxHttpClient(): Promise<
  Deno.HttpClient | null
> {
  if (maxHttpClient) {
    return maxHttpClient;
  }

  if (maxHttpClientError) {
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
              15000,
            ),
        },
      );

    if (!rootResponse.ok) {
      throw new Error(
        `Root CA HTTP ${rootResponse.status}`,
      );
    }

    const rootCa =
      await rootResponse.text();

    if (
      !rootCa.includes(
        "BEGIN CERTIFICATE",
      )
    ) {
      throw new Error(
        "Root CA certificate content is invalid",
      );
    }

    maxCaStatus.root =
      true;

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
              15000,
            ),
        },
      );

    if (!subResponse.ok) {
      throw new Error(
        `Sub CA HTTP ${subResponse.status}`,
      );
    }

    const subCa =
      await subResponse.text();

    if (
      !subCa.includes(
        "BEGIN CERTIFICATE",
      )
    ) {
      throw new Error(
        "Sub CA certificate content is invalid",
      );
    }

    maxCaStatus.sub =
      true;

    maxHttpClient =
      Deno.createHttpClient({
        caCerts: [
          rootCa,
          subCa,
        ],
      });

    maxCaStatus.loaded =
      true;

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

// ------------------------------------------------------------
// SETTINGS
// ------------------------------------------------------------

const CRON_SCHEDULE =
  "*/5 * * * *";

const URGENT_INTERVAL_MS =
  5 * 60 * 1000;

const REGULAR_INTERVAL_MS =
  30 * 60 * 1000;

const HISTORY_TTL_MS =
  30 *
  24 *
  60 *
  60 *
  1000;

const MAX_VIDEO_BYTES =
  Number(
    Deno.env.get(
      "MAX_VIDEO_MB",
    ) ??
      "60",
  ) *
  1024 *
  1024;

const MAX_IMAGE_BYTES =
  Number(
    Deno.env.get(
      "MAX_IMAGE_MB",
    ) ??
      "15",
  ) *
  1024 *
  1024;

const RSS_LIMIT_PER_FEED =
  30;

const MAX_RSS_ITEMS =
  300;

const MAX_ARTICLE_CANDIDATES =
  25;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140 Safari/537.36";

const sleep =
  (
    ms: number,
  ) =>
    new Promise<void>(
      (
        resolve,
      ) =>
        setTimeout(
          resolve,
          ms,
        ),
    );

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
      "https://news.google.com/rss/search?q=политика+OR+правительство+OR+президент+OR+выборы&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ЭКОНОМИКА",
    emoji: "📈",
    url:
      "https://news.google.com/rss/search?q=экономика+OR+инфляция+OR+ставка+OR+рынки+OR+ВВП&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "БИЗНЕС",
    emoji: "💼",
    url:
      "https://news.google.com/rss/search?q=бизнес+OR+компания+OR+корпорация+OR+инвестиции+OR+стартап&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ФИНАНСЫ",
    emoji: "💰",
    url:
      "https://news.google.com/rss/search?q=финансы+OR+банки+OR+биржа+OR+рубль+OR+доллар+OR+евро&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "ПРАВО",
    emoji: "⚖️",
    url:
      "https://news.google.com/rss/search?q=закон+OR+суд+OR+право+OR+законопроект+OR+регулирование&hl=ru&gl=RU&ceid=RU:ru",
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
      "https://news.google.com/rss/search?q=промышленность+OR+производство+OR+энергетика+OR+сырье&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "АВТО",
    emoji: "🚗",
    url:
      "https://news.google.com/rss/search?q=авто+OR+автомобили+OR+транспорт+OR+электромобили&hl=ru&gl=RU&ceid=RU:ru",
  },

  {
    category: "WORLD BUSINESS",
    emoji: "🌐",
    url:
      "https://news.google.com/rss/search?q=global+business+OR+global+economy+OR+international+markets&hl=en&gl=US&ceid=US:en",
  },

  {
    category: "WORLD TECHNOLOGY",
    emoji: "🌐",
    url:
      "https://news.google.com/rss/search?q=technology+OR+AI+OR+cybersecurity&hl=en&gl=US&ceid=US:en",
  },
];

// ------------------------------------------------------------
// DENO KV
// ------------------------------------------------------------

let kv:
  Deno.Kv | null = null;

async function getKV(): Promise<Deno.Kv> {
  if (!kv) {
    kv =
      await Deno.openKv();
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
  type:
    | "video"
    | "image";

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

  source: {
    require_real_url: boolean;
    google_resolver: boolean;
  };

  last_pipeline:
    unknown;

  max: {
    configured: boolean;
    chat_configured: boolean;
    ca_loaded: boolean;
  };
};

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

async function getState(): Promise<
  PipelineState
> {
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

  const running =
    (
      await db.get<boolean>(
        [
          "factor",
          "state",
          "running",
        ],
      )
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

    source: {
      require_real_url:
        REQUIRE_REAL_SOURCE_URL,

      google_resolver:
        GOOGLE_RESOLVE_ENABLED,
    },

    last_pipeline:
      lastPipeline,

    max: {
      configured:
        Boolean(
          MAX_BOT_TOKEN,
        ),

      chat_configured:
        Boolean(
          TARGET_CHAT_ID,
        ),

      ca_loaded:
        maxCaStatus.loaded,
    },
  };
}

// ------------------------------------------------------------
// TEXT
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
      /&#x([0-9a-f]+);/gi,
      (
        _,
        code,
      ) =>
        String.fromCodePoint(
          parseInt(
            code,
            16,
          ),
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
  return cleanText(
    value,
  )
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

function decodeHtmlEntities(
  value: string,
): string {
  return value
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
      /&lt;/gi,
      "<",
    )
    .replace(
      /&gt;/gi,
      ">",
    );
}

function normalizeForHash(
  value: string,
): string {
  return stripHtml(
    value,
  )
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
      (
        b,
      ) =>
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
// URL
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

function isHttpUrl(
  url: string,
): boolean {
  return /^https?:\/\//i.test(
    url,
  );
}

function isUsableArticleUrl(
  url: string,
): boolean {
  if (
    !isHttpUrl(url)
  ) {
    return false;
  }

  if (
    isGoogleNewsUrl(url)
  ) {
    return false;
  }

  try {
    const u =
      new URL(url);

    if (
      u.hostname
        .toLowerCase()
        .includes(
          "google.",
        )
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
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
// GOOGLE NEWS RESOLUTION
// ------------------------------------------------------------

function extractGoogleArticleId(
  url: string,
): string | null {
  try {
    const u =
      new URL(url);

    const parts =
      u.pathname.split(
        "/",
      );

    const index =
      parts.lastIndexOf(
        "articles",
      );

    if (
      index ===
      -1 ||
      !parts[index + 1]
    ) {
      return null;
    }

    return parts[
      index + 1
    ];
  } catch {
    return null;
  }
}

function tryLegacyGoogleBase64Decode(
  url: string,
): string | null {
  const id =
    extractGoogleArticleId(
      url,
    );

  if (!id) {
    return null;
  }

  try {
    const padded =
      id +
      "=".repeat(
        (
          4 -
          (id.length %
            4)
        ) % 4,
      );

    const binary =
      atob(
        padded
          .replace(
            /-/g,
            "+",
          )
          .replace(
            /_/g,
            "/",
          ),
      );

    const bytes =
      new Uint8Array(
        binary.length,
      );

    for (
      let i = 0;
      i < binary.length;
      i++
    ) {
      bytes[i] =
        binary.charCodeAt(
          i,
        );
    }

    const text =
      new TextDecoder()
        .decode(
          bytes,
        );

    const match =
      text.match(
        /https?:\/\/[^\x00-\x20"'<>\\]+/,
      );

    if (
      match &&
      isUsableArticleUrl(
        match[0],
      )
    ) {
      return match[0];
    }
  } catch {
    // legacy format not applicable
  }

  return null;
}

function extractGoogleSignatureParams(
  html: string,
): {
  signature: string;
  timestamp: string;
} | null {
  const signature =
    html.match(
      /data-n-a-sg=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /"data-n-a-sg"\s*:\s*"([^"]+)"/i,
    )?.[1];

  const timestamp =
    html.match(
      /data-n-a-ts=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /"data-n-a-ts"\s*:\s*"([^"]+)"/i,
    )?.[1];

  if (
    !signature ||
    !timestamp
  ) {
    return null;
  }

  return {
    signature,
    timestamp,
  };
}

async function resolveGoogleViaBatchExecute(
  googleUrl: string,
): Promise<string | null> {
  if (
    !GOOGLE_RESOLVE_ENABLED
  ) {
    return null;
  }

  const articleId =
    extractGoogleArticleId(
      googleUrl,
    );

  if (!articleId) {
    return null;
  }

  try {
    const articleResponse =
      await fetch(
        googleUrl,
        {
          headers: {
            "User-Agent":
              USER_AGENT,

            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

            "Referer":
              "https://news.google.com/",
          },

          signal:
            AbortSignal.timeout(
              12000,
            ),
        },
      );

    if (
      !articleResponse.ok
    ) {
      return null;
    }

    const articleHtml =
      await articleResponse.text();

    const params =
      extractGoogleSignatureParams(
        articleHtml,
      );

    if (!params) {
      return null;
    }

    const requestArray = [
      "garturlreq",
      [
        [
          "X",
          "X",
          [
            "X",
            "X",
          ],
          null,
          null,
          1,
          1,
          "US:en",
          null,
          1,
          null,
          null,
          null,
          null,
          null,
          0,
          1,
        ],
        "X",
        "X",
        1,
        [
          1,
          1,
          1,
        ],
        1,
        1,
        null,
        0,
        0,
        null,
      ],
      articleId,
      Number(
        params.timestamp,
      ),
      params.signature,
    ];

    const rpc =
      JSON.stringify(
        [
          [
            [
              "Fbv4je",
              JSON.stringify(
                requestArray,
              ),
              null,
              "generic",
            ],
          ],
        ],
      );

    const body =
      "f.req=" +
      encodeURIComponent(
        rpc,
      );

    const response =
      await fetch(
        "https://news.google.com/_/DotsSplashUi/data/batchexecute",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded;charset=UTF-8",

            "User-Agent":
              USER_AGENT,

            "Referer":
              "https://news.google.com/",
          },

          body,

          signal:
            AbortSignal.timeout(
              15000,
            ),
        },
      );

    if (
      !response.ok
    ) {
      return null;
    }

    const text =
      await response.text();

    const markers = [
      '\\"garturlres\\",\\"',
      '"garturlres","',
    ];

    for (
      const marker of markers
    ) {
      const start =
        text.indexOf(
          marker,
        );

      if (
        start ===
        -1
      ) {
        continue;
      }

      const from =
        start +
        marker.length;

      const end =
        text.indexOf(
          '\\"',
          from,
        );

      if (
        end ===
        -1
      ) {
        continue;
      }

      const raw =
        text.slice(
          from,
          end,
        );

      const decoded =
        decodeGoogleEscapedUrl(
          raw,
        );

      if (
        isUsableArticleUrl(
          decoded,
        )
      ) {
        return decoded;
      }
    }

    const direct =
      text.match(
        /https?:\\?\/\\?\/[^\\"'\s]+/g,
      ) ?? [];

    for (
      const raw of direct
    ) {
      const decoded =
        decodeGoogleEscapedUrl(
          raw,
        );

      if (
        isUsableArticleUrl(
          decoded,
        )
      ) {
        return decoded;
      }
    }
  } catch (error) {
    if (DEBUG) {
      console.error(
        "Google batch resolver:",
        error,
      );
    }
  }

  return null;
}

function decodeGoogleEscapedUrl(
  value: string,
): string {
  return value
    .replace(
      /\\u003d/gi,
      "=",
    )
    .replace(
      /\\u0026/gi,
      "&",
    )
    .replace(
      /\\u002f/gi,
      "/",
    )
    .replace(
      /\\u003a/gi,
      ":",
    )
    .replace(
      /\\\//g,
      "/",
    )
    .replace(
      /\\\\/g,
      "\\",
    )
    .replace(
      /\\+"/g,
      '"',
    );
}

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
      html.match(
        pattern,
      );

    if (
      match?.[1]
    ) {
      return decodeHtmlEntities(
        cleanText(
          match[1],
        ),
      );
    }
  }

  return null;
}

function extractExternalLinks(
  html: string,
  baseUrl: string,
): string[] {
  const result:
    string[] = [];

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

    if (
      !url ||
      !isUsableArticleUrl(
        url,
      )
    ) {
      continue;
    }

    try {
      const parsed =
        new URL(url);

      const host =
        parsed.hostname.toLowerCase();

      if (
        host.includes(
          "google.",
        ) ||
        host.includes(
          "gstatic.",
        ) ||
        host.includes(
          "googleusercontent.",
        )
      ) {
        continue;
      }

      if (
        seen.has(url)
      ) {
        continue;
      }

      seen.add(url);
      result.push(url);
    } catch {
      // ignore
    }

    if (
      result.length >=
      MAX_ARTICLE_CANDIDATES
    ) {
      break;
    }
  }

  return result;
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

  // Старый формат Google News иногда всё ещё
  // содержит URL в Base64-блоке.
  const legacy =
    tryLegacyGoogleBase64Decode(
      originalUrl,
    );

  if (
    legacy
  ) {
    return legacy;
  }

  // Современный способ.
  const decoded =
    await resolveGoogleViaBatchExecute(
      originalUrl,
    );

  if (
    decoded
  ) {
    return decoded;
  }

  // Дополнительная проверка страницы Google.
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
      html.match(
        /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i,
      )?.[1] ??
      html.match(
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i,
      )?.[1];

    if (
      canonical
    ) {
      const url =
        absoluteUrl(
          decodeHtmlEntities(
            canonical,
          ),
          originalUrl,
        );

      if (
        url &&
        isUsableArticleUrl(
          url,
        )
      ) {
        return url;
      }
    }

    const ogUrl =
      findMeta(
        html,
        "og:url",
      );

    if (
      ogUrl
    ) {
      const url =
        absoluteUrl(
          ogUrl,
          originalUrl,
        );

      if (
        url &&
        isUsableArticleUrl(
          url,
        )
      ) {
        return url;
      }
    }

    const links =
      extractExternalLinks(
        html,
        originalUrl,
      );

    if (
      links.length
    ) {
      return links[0];
    }
  } catch (error) {
    if (DEBUG) {
      console.error(
        "Google News fallback:",
        error,
      );
    }
  }

  return "";
}

// ------------------------------------------------------------
// FRESHNESS
// ------------------------------------------------------------

function getPublicationTime(
  item: NewsItem,
): number {
  const parsed =
    Date.parse(
      item.pubDate,
    );

  return Number.isFinite(
    parsed,
  )
    ? parsed
    : 0;
}

function isFreshEnough(
  item: NewsItem,
): boolean {
  const published =
    getPublicationTime(
      item,
    );

  if (
    published <=
    0
  ) {
    return true;
  }

  const age =
    Date.now() -
    published;

  if (
    age < 0
  ) {
    return true;
  }

  return (
    age <=
    MAX_NEWS_AGE_HOURS *
      60 *
      60 *
      1000
  );
}

// ------------------------------------------------------------
// VIDEO
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
    lower.includes(
      ".mp4",
    ) ||
    lower.includes(
      ".mov",
    ) ||
    lower.includes(
      ".webm",
    ) ||
    lower.includes(
      ".mkv",
    )
  );
}

function normalizeMediaUrl(
  value: string,
): string {
  return decodeHtmlEntities(
    value
      .replace(
        /\\\//g,
        "/",
      )
      .replace(
        /\\u0026/gi,
        "&",
      )
      .replace(
        /\\u003A/gi,
        ":",
      )
      .replace(
        /\\u003a/gi,
        ":",
      )
      .replace(
        /\\u002F/gi,
        "/",
      )
      .replace(
        /\\u002f/gi,
        "/",
      )
      .trim(),
  );
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
        [
          "@graph",
          "video",
          "content",
          "associatedMedia",
        ].includes(
          key,
        )
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

    if (
      value
    ) {
      candidates.push(
        value,
      );
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
        baseUrl,
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
      // ignore invalid JSON-LD
    }
  }

  return null;
}

// ------------------------------------------------------------
// ARTICLE
// ------------------------------------------------------------

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

    if (
      !response.ok
    ) {
      return {
        articleUrl,
        imageUrl: null,
        videoUrl: null,
        sourceName: null,
      };
    }

    const finalArticleUrl =
      response.url ||
      articleUrl;

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
        ) ??
          "0",
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
        return null;
      }
    }

    if (
      type ===
        "image" &&
      !contentType.startsWith(
        "image/",
      )
    ) {
      const imageExtension =
        /\.(jpg|jpeg|png|gif|webp|tiff|bmp|heic)(?:\?|$)/i.test(
          finalUrl,
        );

      if (
        !imageExtension
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

  headers.set(
    "Accept",
    "application/json",
  );

  const client =
    await initMaxHttpClient();

  const requestOptions =
    {
      ...options,

      client:
        client ?? undefined,

      headers,
    } as RequestInit & {
      client?: Deno.HttpClient;
    };

  try {
    return await fetch(
      `${MAX_API}${path}`,
      requestOptions,
    );
  } catch (error) {
    console.error(
      "MAX fetch error:",
      error instanceof Error
        ? error.message
        : String(error),
    );

    throw error;
  }
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

        signal:
          AbortSignal.timeout(
            120000,
          ),
      },
    );

  const uploadText =
    await uploadResponse.text();

  if (
    !uploadResponse.ok
  ) {
    throw new Error(
      `Media upload HTTP ${
        uploadResponse.status
      }: ${uploadText.slice(
        0,
        1500,
      )}`,
    );
  }

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

  const finalToken =
    init.token ||
    uploadResult?.token ||
    uploadResult
      ?.mediafile_token ||
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
      `MAX media token missing for ${media.type}. ` +
        `Upload response: ${uploadText.slice(
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

function isAttachmentNotReady(
  error: unknown,
): boolean {
  const text =
    error instanceof Error
      ? error.message
      : String(error);

  return (
    text.includes(
      "attachment.not.ready",
    ) ||
    text.includes(
      "errors.process.attachment.file.not.processed",
    )
  );
}

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

  const delays = [
    0,
    4000,
    7000,
    10000,
    15000,
  ];

  let lastError:
    unknown = null;

  for (
    const delay of delays
  ) {
    if (
      delay > 0
    ) {
      await sleep(
        delay,
      );
    }

    try {
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
    } catch (error) {
      lastError =
        error;

      if (
        !mediaToken ||
        !isAttachmentNotReady(
          error,
        )
      ) {
        throw error;
      }

      console.log(
        "MAX attachment is not ready. Retrying...",
      );
    }
  }

  throw lastError ??
    new Error(
      "MAX publish failed",
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

Твоя задача — переписать исходную новость в короткую плотную русскоязычную новостную подачу.

Работай ТОЛЬКО с информацией из исходного материала.

ИСХОДНЫЙ ЗАГОЛОВОК:
${item.title}

ИСТОЧНИК:
${item.source}

ОПИСАНИЕ:
${item.description}

Верни ТОЛЬКО JSON.

Формат:

{
  "headline": "короткий конкретный заголовок на русском",
  "short": "одно короткое предложение о событии",
  "main": [
    "факт 1",
    "факт 2",
    "факт 3"
  ],
  "important": "конкретно что важно в этой новости",
  "urgent": false
}

ПРАВИЛА:

1. Пиши на русском языке.
2. Никаких выдуманных фактов.
3. Не добавляй сведения, которых нет в исходном материале.
4. Не меняй смысл новости.
5. Не повторяй одну и ту же мысль.
6. headline должен быть конкретным.
7. Не начинай headline словами "Стало известно".
8. Не используй "ситуация развивается".
9. Не используй "по данным СМИ", если источник уже указан.
10. short должен быть кратким.
11. main должен содержать 1–3 разных факта.
12. Если фактов недостаточно — используй 1 пункт.
13. important должен объяснять значение события только на основании исходного материала.
14. urgent=true только для действительно срочного события.
15. Обычная новость = urgent=false.
16. Не используй рекламные формулировки.
17. Не используй кликбейт, которого нет в исходном материале.
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

    const parsed =
      extractJson(
        text,
      );

    if (
      !parsed
    ) {
      return null;
    }

    return {
      headline:
        stripHtml(
          String(
            parsed.headline ||
              item.title,
          ),
        ),

      short:
        stripHtml(
          String(
            parsed.short ||
              item.description ||
              item.title,
          ),
        ),

      main:
        Array.isArray(
          parsed.main,
        )
          ? parsed.main
              .map(
                (
                  x: unknown,
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
            parsed.important ||
              "",
          ),
        ),

      urgent:
        Boolean(
          parsed.urgent,
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
// TEXT DUPLICATE
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

  for (
    const oldTitle of recent
  ) {
    if (
      similarity(
        story.headline,
        oldTitle,
      ) >=
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

  const sourceLine =
    articleUrl
      ? `🔗 <a href="${escapeHtml(
          articleUrl,
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
  ].join("\n");
}

// ------------------------------------------------------------
// MEDIA
// ------------------------------------------------------------

async function findBestMedia(
  articleMedia: ArticleMedia,
): Promise<DownloadedMedia | null> {
  if (
    articleMedia.videoUrl
  ) {
    console.log(
      "Trying article VIDEO:",
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
      "Trying article IMAGE:",
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
      .filter(
        isFreshEnough,
      )
      .sort(
        (
          a,
          b,
        ) =>
          getPublicationTime(
            b,
          ) -
          getPublicationTime(
            a,
          ),
      );

  let checked =
    0;

  for (
    const item of sorted
  ) {
    if (
      checked >=
      MAX_ARTICLE_CANDIDATES
    ) {
      break;
    }

    checked++;

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

    if (
      REQUIRE_REAL_SOURCE_URL &&
      !isUsableArticleUrl(
        articleMedia.articleUrl,
      )
    ) {
      console.log(
        "Skipping candidate: real source URL not resolved",
        item.title,
      );

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
      detectUrgency(
        item,
      );

    if (
      await isRepeatedStoryText(
        story,
      )
    ) {
      console.log(
        "Skipping repeated wording:",
        story.headline,
      );

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
// PIPELINE LOCK
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

// ------------------------------------------------------------
// PIPELINE
// ------------------------------------------------------------

async function executePipeline(
  manual = false,
): Promise<any> {
  const db =
    await getKV();

  const currentRunning =
    (
      await db.get<boolean>(
        [
          "factor",
          "state",
          "running",
        ],
      )
    ).value ?? false;

  if (
    currentRunning
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
    if (
      !MAX_BOT_TOKEN
    ) {
      throw new Error(
        "MAX_BOT_TOKEN is missing",
      );
    }

    if (
      !TARGET_CHAT_ID
    ) {
      throw new Error(
        "TARGET_CHAT_ID is missing",
      );
    }

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

    if (
      items.length ===
      0
    ) {
      const result = {
        ok: true,

        selected: 0,

        reason:
          "RSS returned no items",

        rss_total: 0,

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
      );

    if (
      !candidate
    ) {
      const result = {
        ok: true,

        selected: 0,

        reason:
          "no new fresh non-duplicate candidate",

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

    const media =
      await findBestMedia(
        articleMedia,
      );

    const sourceName =
      cleanSourceName(
        item.source,
        articleMedia,
      );

    const finalArticleUrl =
      isUsableArticleUrl(
        articleMedia.articleUrl,
      )
        ? articleMedia.articleUrl
        : "";

    if (
      REQUIRE_REAL_SOURCE_URL &&
      !finalArticleUrl
    ) {
      throw new Error(
        "Real publisher URL was not resolved",
      );
    }

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

        await sleep(
          media.type ===
            "video"
            ? 6000
            : 3000,
        );
      } catch (error) {
        console.error(
          "Media upload failed. Publishing text only:",
          error instanceof Error
            ? error.message
            : String(error),
        );

        mediaInfo =
          undefined;
      }
    }

    let publication;

    try {
      publication =
        await publishToMax(
          text,
          mediaInfo,
        );
    } catch (error) {
      /*
       * Если медиа не прошло даже после retry,
       * второй раз отправляем текст без медиа.
       */
      if (
        mediaInfo
      ) {
        console.error(
          "MAX media publication failed. Retrying TEXT ONLY.",
          error instanceof Error
            ? error.message
            : String(error),
        );

        publication =
          await publishToMax(
            text,
          );

        mediaInfo =
          undefined;
      } else {
        throw error;
      }
    }

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
          finalArticleUrl ||
          null,

        category:
          item.category,
      },

      media:
        mediaInfo
          ? {
              type:
                mediaInfo.type,
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
// TEST PUBLISH
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
// MAX UPDATES
// ------------------------------------------------------------

async function getMaxUpdates(
  marker?: number | null,
): Promise<any> {
  const params =
    new URLSearchParams();

  params.set(
    "limit",
    "100",
  );

  params.set(
    "timeout",
    "0",
  );

  if (
    marker !==
      undefined &&
    marker !==
      null
  ) {
    params.set(
      "marker",
      String(marker),
    );
  }

  return await maxJson(
    `/updates?${params.toString()}`,
    {
      method:
        "GET",
    },
  );
}

// ------------------------------------------------------------
// MAX SUBSCRIPTIONS
// ------------------------------------------------------------

async function getSubscriptions(): Promise<any> {
  return await maxJson(
    "/subscriptions",
    {
      method:
        "GET",
    },
  );
}

// ------------------------------------------------------------
// WEBHOOK EVENT
// ------------------------------------------------------------

async function saveWebhookEvent(
  body: any,
): Promise<void> {
  const db =
    await getKV();

  await db.set(
    [
      "factor",
      "events",
      "last",
    ],
    body,
    {
      expireIn:
        7 *
        24 *
        60 *
        60 *
        1000,
    },
  );

  if (
    body &&
    typeof body ===
      "object"
  ) {
    const chatId =
      body.chat_id;

    if (
      chatId !==
        undefined &&
      chatId !==
        null
    ) {
      await db.set(
        [
          "factor",
          "max",
          "last_chat_id",
        ],
        String(chatId),
        {
          expireIn:
            30 *
            24 *
            60 *
            60 *
            1000,
        },
      );
    }
  }
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

if (
  AUTO_PIPELINE
) {
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
}

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

          auto_pipeline:
            AUTO_PIPELINE,

          cron:
            AUTO_PIPELINE
              ? CRON_SCHEDULE
              : null,

          event_mode:
            MAX_EVENT_MODE,

          endpoints: [
            "/",
            "/status",
            "/pipeline-state",
            "/run",
            "/publish-test",
            "/me",
            "/updates",
            "/subscriptions",
            "/resolve-test",
            "/webhook",
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
            AUTO_PIPELINE,

          event_mode:
            MAX_EVENT_MODE,

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

            require_real_source:
              REQUIRE_REAL_SOURCE_URL,

            google_resolver:
              GOOGLE_RESOLVE_ENABLED,

            max_news_age_hours:
              MAX_NEWS_AGE_HOURS,
          },

          max_connection: {
            api:
              MAX_API,

            ca_loaded:
              maxCaStatus.loaded,

            root_ca:
              maxCaStatus.root,

            sub_ca:
              maxCaStatus.sub,

            error:
              maxCaStatus.error,
          },

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
      // UPDATES
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
        path ===
          "/updates"
      ) {
        const markerParam =
          url.searchParams.get(
            "marker",
          );

        const marker =
          markerParam
            ? Number(
                markerParam,
              )
            : undefined;

        const result =
          await getMaxUpdates(
            marker,
          );

        return json({
          ok: true,

          warning:
            "MAX recommends Webhook for production. Long Polling is intended for development/testing.",

          event_mode:
            MAX_EVENT_MODE,

          response:
            result,
        });
      }

      // ------------------------------------------------------
      // SUBSCRIPTIONS
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
        path ===
          "/subscriptions"
      ) {
        const result =
          await getSubscriptions();

        return json({
          ok: true,

          response:
            result,
        });
      }

      // ------------------------------------------------------
      // RESOLVE TEST
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
        path ===
          "/resolve-test"
      ) {
        const sourceUrl =
          url.searchParams.get(
            "url",
          );

        if (
          !sourceUrl
        ) {
          return json(
            {
              ok: false,

              error:
                "Pass ?url=https://news.google.com/...",
            },
            400,
          );
        }

        const resolved =
          await resolveArticleUrl(
            sourceUrl,
          );

        return json({
          ok: Boolean(
            resolved,
          ),

          input:
            sourceUrl,

          resolved:
            resolved ||
            null,

          is_google:
            resolved
              ? isGoogleNewsUrl(
                  resolved,
                )
              : null,

          is_real_source:
            resolved
              ? isUsableArticleUrl(
                  resolved,
                )
              : false,
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
        const bodyText =
          await request.text();

        let body:
          any;

        try {
          body =
            bodyText
              ? JSON.parse(
                  bodyText,
                )
              : null;
        } catch {
          body = {
            raw:
              bodyText.slice(
                0,
                5000,
              ),
          };
        }

        console.log(
          "WEBHOOK:",
          JSON.stringify(
            body,
          ).slice(
            0,
            5000,
          ),
        );

        await saveWebhookEvent(
          body,
        );

        return json({
          ok: true,

          received:
            true,

          update_type:
            body?.update_type ??
            null,

          chat_id:
            body?.chat_id ??
            null,
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