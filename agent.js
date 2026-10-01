// ============================================================
// FAKTOR — MAX NEWS AGENT
// DENO DEPLOY / DENO 2.x
// ОДИН ФАЙЛ: main.ts
// ============================================================
//
// ЛОГИКА:
//
// 1. Cron — каждые 5 минут.
// 2. RSS — мир, политика, экономика, бизнес, финансы,
//    право, происшествия, технологии, промышленность, авто.
// 3. Срочная новость — не чаще 1 раза в 5 минут.
// 4. Обычная новость — не чаще 1 раза в 30 минут.
// 5. Deno KV — история 30 дней.
// 6. Дубликаты блокируются.
// 7. Google News URL не публикуется.
// 8. Пытаемся получить реальный URL СМИ.
// 9. Медиа: VIDEO -> IMAGE -> TEXT.
// 10. Видео/изображение загружается в MAX.
// 11. Сообщение отправляется с format: html.
// 12. /health
// 13. /status
// 14. /pipeline-state
// 15. /run
// 16. /publish-test
// 17. /me
//
// ВАЖНО:
// Никакого Deno.json для этой версии НЕ НУЖНО.
// Никакого отдельного JSON-файла НЕ НУЖНО.
// ============================================================

const MAX_API = "https://platform-api2.max.ru";

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") ?? "";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") ?? "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? "";

const ADMIN_KEY =
  Deno.env.get("ADMIN_KEY") ?? "";

// ============================================================
// НАСТРОЙКИ
// ============================================================

const CRON_SCHEDULE =
  "*/5 * * * *";

const URGENT_INTERVAL_MS =
  5 * 60 * 1000;

const REGULAR_INTERVAL_MS =
  30 * 60 * 1000;

const HISTORY_TTL_MS =
  30 * 24 * 60 * 60 * 1000;

// Наши лимиты специально ниже лимитов MAX.
const MAX_VIDEO_BYTES =
  60 * 1024 * 1024;

const MAX_IMAGE_BYTES =
  15 * 1024 * 1024;

const RSS_LIMIT_PER_FEED =
  25;

const MAX_RSS_ITEMS =
  180;

const MAX_CANDIDATES_TO_CHECK =
  20;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140 Safari/537.36";

// ============================================================
// RSS
// ============================================================

type Feed = {
  category: string;
  emoji: string;
  url: string;
};

const RSS_FEEDS: Feed[] = [
  // ----------------------------------------------------------
  // GOOGLE NEWS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // ПРЯМЫЕ RSS
  // ----------------------------------------------------------

  {
    category: "МИР",
    emoji: "🌍",
    url:
      "https://feeds.bbci.co.uk/news/world/rss.xml",
  },

  {
    category: "БИЗНЕС",
    emoji: "💼",
    url:
      "https://feeds.bbci.co.uk/news/business/rss.xml",
  },

  {
    category: "ТЕХНОЛОГИИ",
    emoji: "💻",
    url:
      "https://feeds.bbci.co.uk/news/technology/rss.xml",
  },

  {
    category: "МИР",
    emoji: "🌍",
    url:
      "https://rss.dw.com/rdf/rss-en-top",
  },

  {
    category: "БИЗНЕС",
    emoji: "💼",
    url:
      "https://rss.dw.com/rdf/rss-en-bus",
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
  googleNews: boolean;
  publisherUrl: string | null;
};

type ArticleMedia = {
  articleUrl: string | null;
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
// TEXT
// ============================================================

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
      /<br\s*\/?\s*>/gi,
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
      /&#x2F;/gi,
      "/",
    )
    .replace(
      /&lt;/gi,
      "<",
    )
    .replace(
      /&gt;/gi,
      ">",
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
      /[*_]+/g,
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

  return [...new Uint8Array(hash)]
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

// ============================================================
// URL
// ============================================================

function isHttpUrl(
  value: string,
): boolean {
  return /^https?:\/\//i.test(
    value,
  );
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

function isGoogleNewsUrl(
  value: string,
): boolean {
  try {
    const host =
      new URL(value)
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

function domainOf(
  value: string,
): string | null {
  try {
    return new URL(
      value,
    )
      .hostname
      .toLowerCase();
  } catch {
    return null;
  }
}

// ============================================================
// RSS PARSER
// ============================================================

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

function extractSourceInfo(
  xml: string,
  fallback: string,
): {
  name: string;
  url: string | null;
} {
  const sourceMatch =
    xml.match(
      /<source\b([^>]*)>([\s\S]*?)<\/source>/i,
    );

  const attrs =
    sourceMatch?.[1] ??
    "";

  const name =
    cleanText(
      sourceMatch?.[2] ??
        "",
    ) ||
    fallback;

  const url =
    attrs.match(
      /\burl=["']([^"']+)["']/i,
    )?.[1] ??
    null;

  return {
    name,
    url:
      url &&
      isHttpUrl(url)
        ? url
        : null,
  };
}

function parseRSS(
  xml: string,
  feed: Feed,
): NewsItem[] {
  const items:
    NewsItem[] = [];

  const matches =
    xml.match(
      /<item\b[\s\S]*?<\/item>/gi,
    ) ??
    [];

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

    const sourceInfo =
      extractSourceInfo(
        itemXml,
        feed.category,
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
      source:
        sourceInfo.name,
      category:
        feed.category,
      categoryEmoji:
        feed.emoji,
      sourceFeed:
        feed.url,
      googleNews:
        isGoogleNewsUrl(
          link,
        ),
      publisherUrl:
        sourceInfo.url,
    });
  }

  return items;
}

async function loadRSS(
  feed: Feed,
): Promise<NewsItem[]> {
  try {
    const response =
      await fetch(
        feed.url,
        {
          headers: {
            "User-Agent":
              USER_AGENT,

            Accept:
              "application/rss+xml, application/xml, text/xml, */*;q=0.8",
          },

          signal:
            AbortSignal.timeout(
              12_000,
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

    return parseRSS(
      await response.text(),
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
  name: string,
): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`,
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
      return match[1].trim();
    }
  }

  return null;
}

// ============================================================
// GOOGLE NEWS
// ============================================================

async function resolveArticleUrl(
  originalUrl: string,
  publisherUrl:
    | string
    | null = null,
): Promise<string | null> {
  if (
    !isHttpUrl(
      originalUrl,
    )
  ) {
    return null;
  }

  if (
    !isGoogleNewsUrl(
      originalUrl,
    )
  ) {
    return originalUrl;
  }

  let articleId =
    "";

  try {
    const parsed =
      new URL(
        originalUrl,
      );

    const parts =
      parsed.pathname
        .split("/")
        .filter(
          Boolean,
        );

    articleId =
      parts.at(-1) ??
      "";
  } catch {
    return null;
  }

  if (
    !articleId
  ) {
    return null;
  }

  const publisherDomain =
    publisherUrl
      ? domainOf(
          publisherUrl,
        )?.replace(
          /^www\./,
          "",
        )
      : null;

  function matchesPublisher(
    candidate: string,
  ): boolean {
    if (
      !isHttpUrl(
        candidate,
      ) ||
      isGoogleNewsUrl(
        candidate,
      )
    ) {
      return false;
    }

    const host =
      domainOf(
        candidate,
      )?.replace(
        /^www\./,
        "",
      );

    if (
      !host
    ) {
      return false;
    }

    if (
      !publisherDomain
    ) {
      return true;
    }

    return (
      host ===
        publisherDomain ||
      host.endsWith(
        `.${publisherDomain}`,
      )
    );
  }

  try {
    const shellUrl =
      `https://news.google.com/articles/${encodeURIComponent(
        articleId,
      )}`;

    const shellResponse =
      await fetch(
        shellUrl,
        {
          redirect:
            "follow",

          headers: {
            "User-Agent":
              USER_AGENT,

            Accept:
              "text/html,application/xhtml+xml,*/*;q=0.8",
          },

          signal:
            AbortSignal.timeout(
              15_000,
            ),
        },
      );

    const shellHtml =
      await shellResponse.text();

    const signature =
      shellHtml.match(
        /data-n-a-sg=["']([^"']+)["']/i,
      )?.[1];

    const timestamp =
      shellHtml.match(
        /data-n-a-ts=["']([^"']+)["']/i,
      )?.[1];

    // Быстрый fallback.
    const fallbackCandidates =
      [
        findMeta(
          shellHtml,
          "og:url",
        ),

        findMeta(
          shellHtml,
          "twitter:url",
        ),

        shellHtml.match(
          /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i,
        )?.[1],
      ].filter(
        Boolean,
      ) as string[];

    for (
      const candidate of fallbackCandidates
    ) {
      const url =
        absoluteUrl(
          candidate,
          shellResponse.url ||
            shellUrl,
        );

      if (
        url &&
        matchesPublisher(
          url,
        )
      ) {
        return url;
      }
    }

    if (
      !signature ||
      !timestamp
    ) {
      return null;
    }

    const requestPayload =
      [
        [
          [
            "Fbv4je",

            JSON.stringify(
              [
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
                  0,
                ],

                articleId,

                Number(
                  timestamp,
                ),

                signature,
              ],
            ),

            null,

            "generic",
          ],
        ],
      ];

    const body =
      `f.req=${encodeURIComponent(
        JSON.stringify(
          requestPayload,
        ),
      )}`;

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
          },

          body,

          signal:
            AbortSignal.timeout(
              15_000,
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

    const chunks =
      text
        .split(
          "\n\n",
        )
        .filter(
          Boolean,
        );

    for (
      const chunk of chunks
    ) {
      const firstBracket =
        chunk.indexOf(
          "[",
        );

      if (
        firstBracket <
        0
      ) {
        continue;
      }

      try {
        const outer =
          JSON.parse(
            chunk.slice(
              firstBracket,
            ),
          );

        const stack:
          unknown[] = [
            outer,
          ];

        while (
          stack.length
        ) {
          const value =
            stack.pop();

          if (
            typeof value ===
            "string"
          ) {
            const candidate =
              value.replace(
                /\\\//g,
                "/",
              );

            if (
              matchesPublisher(
                candidate,
              )
            ) {
              return candidate;
            }
          } else if (
            Array.isArray(
              value,
            )
          ) {
            for (
              const child of value
            ) {
              stack.push(
                child,
              );
            }
          } else if (
            value &&
            typeof value ===
              "object"
          ) {
            for (
              const child of Object.values(
                value,
              )
            ) {
              stack.push(
                child,
              );
            }
          }
        }
      } catch {
        // Пробуем следующий блок.
      }
    }
  } catch (error) {
    console.error(
      "Google News resolve:",
      error instanceof Error
        ? error.message
        : String(error),
    );
  }

  // НИКОГДА не возвращаем Google News URL.
  return null;
}

// ============================================================
// VIDEO
// ============================================================

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

  return /\.(mp4|mov|webm|mkv)(?:$|\?)/i.test(
    lower,
  );
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
      /<video[^>]+src=["']([^"']+)["']/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  for (
    const match of html.matchAll(
      /<source[^>]+src=["']([^"']+)["']/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  for (
    const match of html.matchAll(
      /["']contentUrl["']\s*:\s*["']([^"']+)["']/gi,
    )
  ) {
    candidates.push(
      match[1],
    );
  }

  for (
    const match of html.matchAll(
      /["'](?:videoUrl|video_url|file)["']\s*:\s*["']([^"']+)["']/gi,
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
        candidate
          .replace(
            /\\\//g,
            "/",
          )
          .replace(
            /\\u0026/g,
            "&",
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

  const blocks =
    html.match(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
    ) ??
    [];

  for (
    const block of blocks
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

      const objects =
        Array.isArray(
          data,
        )
          ? data
          : [
              data,
            ];

      for (
        const object of objects
      ) {
        const value =
          object?.contentUrl ??
          object?.video?.contentUrl ??
          object?.video?.url;

        if (
          typeof value !==
          "string"
        ) {
          continue;
        }

        const url =
          absoluteUrl(
            value,
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
      // Некорректный JSON-LD — пропускаем.
    }
  }

  return null;
}

// ============================================================
// ARTICLE
// ============================================================

async function extractArticleMedia(
  originalUrl: string,
  publisherUrl:
    | string
    | null = null,
): Promise<ArticleMedia> {
  const articleUrl =
    await resolveArticleUrl(
      originalUrl,
      publisherUrl,
    );

  if (
    !articleUrl
  ) {
    return {
      articleUrl:
        null,

      imageUrl:
        null,

      videoUrl:
        null,

      sourceName:
        null,
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

            Accept:
              "text/html,application/xhtml+xml,*/*;q=0.8",
          },

          signal:
            AbortSignal.timeout(
              20_000,
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
      !isGoogleNewsUrl(
        response.url,
      )
        ? response.url
        : articleUrl;

    const html =
      await response.text();

    const imageMeta =
      findMeta(
        html,
        "og:image",
      ) ??
      findMeta(
        html,
        "twitter:image",
      );

    const imageUrl =
      imageMeta
        ? absoluteUrl(
            imageMeta,
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
      ) ??
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

// ============================================================
// MEDIA DOWNLOAD
// ============================================================

function imageTypeAllowed(
  contentType: string,
): boolean {
  return [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/tiff",
    "image/bmp",
    "image/heic",
  ].some(
    (x) =>
      contentType.includes(
        x,
      ),
  );
}

function extensionFromContentType(
  type:
    | "video"
    | "image",
  contentType: string,
): string {
  const ct =
    contentType.toLowerCase();

  if (
    type === "video"
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
    )
    {
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
      "tiff",
    )
  ) {
    return "tiff";
  }

  if (
    ct.includes(
      "bmp",
    )
  ) {
    return "bmp";
  }

  if (
    ct.includes(
      "heic",
    )
  ) {
    return "heic";
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

            Accept:
              type ===
              "video"
                ? "video/mp4,video/quicktime,video/webm,video/*;q=0.9,*/*;q=0.3"
                : "image/jpeg,image/png,image/gif,image/tiff,image/bmp,image/heic,*/*;q=0.3",
          },

          signal:
            AbortSignal.timeout(
              type ===
                "video"
                ? 35_000
                : 15_000,
            ),
        },
      );

    if (
      !response.ok
    ) {
      return null;
    }

    const contentType =
      (
        response.headers.get(
          "content-type",
        ) ??
        ""
      ).toLowerCase();

    if (
      contentType.includes(
        "mpegurl",
      ) ||
      contentType.includes(
        "dash",
      )
    ) {
      return null;
    }

    const limit =
      type ===
      "video"
        ? MAX_VIDEO_BYTES
        : MAX_IMAGE_BYTES;

    const contentLength =
      Number(
        response.headers.get(
          "content-length",
        ) ??
          "0",
      );

    if (
      contentLength >
      limit
    ) {
      return null;
    }

    if (
      type ===
        "image" &&
      contentType &&
      !imageTypeAllowed(
        contentType,
      )
    ) {
      return null;
    }

    const bytes =
      new Uint8Array(
        await response.arrayBuffer(),
      );

    if (
      bytes.byteLength ===
        0 ||
      bytes.byteLength >
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
      ) &&
      !isDirectVideoUrl(
        finalUrl,
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
          type ===
          "video"
            ? "video/mp4"
            : "image/jpeg"
        ),

      extension:
        extensionFromContentType(
          type,
          contentType,
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

// ============================================================
// MAX API
// ============================================================

async function maxFetch(
  path: string,
  options:
    RequestInit = {},
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
  options:
    RequestInit = {},
): Promise<T> {
  const response =
    await maxFetch(
      path,
      options,
    );

  const text =
    await response.text();

  let data:
    unknown = null;

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

// ============================================================
// MAX MEDIA TOKEN
// ============================================================

function extractUploadToken(
  value: unknown,
): string | null {
  if (
    typeof value ===
      "string" &&
    value.trim()
  ) {
    return value.trim();
  }

  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return null;
  }

  const object =
    value as Record<
      string,
      unknown
    >;

  const direct = [
    object.token,
    object.mediafile_token,
  ];

  for (
    const candidate of direct
  ) {
    if (
      typeof candidate ===
        "string" &&
      candidate.trim()
    ) {
      return candidate.trim();
    }
  }

  const photos =
    object.photos;

  if (
    photos &&
    typeof photos ===
      "object"
  ) {
    const photoIds =
      (
        photos as Record<
          string,
          unknown
        >
      ).photoIds;

    if (
      typeof photoIds ===
        "string" &&
      photoIds.trim()
    ) {
      return photoIds.trim();
    }

    if (
      photoIds &&
      typeof photoIds ===
        "object"
    ) {
      const token =
        (
          photoIds as Record<
            string,
            unknown
          >
        ).token;

      if (
        typeof token ===
          "string" &&
        token.trim()
      ) {
        return token.trim();
      }
    }
  }

  return null;
}

// ============================================================
// MAX UPLOAD
// ============================================================

async function uploadMedia(
  media: DownloadedMedia,
): Promise<string> {
  const init =
    await maxJson<{
      url?: string;
      token?: string;
    }>(
      `/uploads?type=${encodeURIComponent(
        media.type,
      )}`,
      {
        method:
          "POST",

        headers: {
          Accept:
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

  form.append(
    "data",

    new Blob(
      [
        media.bytes,
      ],
      {
        type:
          media.contentType,
      },
    ),

    `factor.${media.extension}`,
  );

  const uploadHeaders =
    new Headers();

  // Для image MAX документирует Authorization
  // при multipart upload.
  if (
    media.type ===
    "image"
  ) {
    uploadHeaders.set(
      "Authorization",
      MAX_BOT_TOKEN,
    );
  }

  const response =
    await fetch(
      init.url,
      {
        method:
          "POST",

        body:
          form,

        headers:
          uploadHeaders,

        signal:
          AbortSignal.timeout(
            90_000,
          ),
      },
    );

  const responseText =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `Media upload HTTP ${
        response.status
      }: ${responseText.slice(
        0,
        700,
      )}`,
    );
  }

  let uploadResult:
    unknown = null;

  try {
    uploadResult =
      responseText
        ? JSON.parse(
            responseText,
          )
        : null;
  } catch {
    uploadResult =
      null;
  }

  const token =
    extractUploadToken(
      init,
    ) ??
    extractUploadToken(
      uploadResult,
    );

  if (
    !token
  ) {
    throw new Error(
      `MAX media token missing for ${media.type}. Response: ${responseText.slice(
        0,
        1000,
      )}`,
    );
  }

  return token;
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
): Promise<unknown> {
  const body:
    Record<
      string,
      unknown
    > = {
    text,

    format:
      "html",

    notify:
      true,

    disable_link_preview:
      true,
  };

  if (
    mediaToken
  ) {
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

  return maxJson(
    `/messages?chat_id=${encodeURIComponent(
      TARGET_CHAT_ID,
    )}`,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json",

        Accept:
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
// PUBLISH WITH RETRY
// ============================================================

async function publishWithMediaRetry(
  text: string,
  mediaInfo?: {
    type:
      | "video"
      | "image";

    token: string;
  },
): Promise<unknown> {
  if (
    !mediaInfo
  ) {
    return publishToMax(
      text,
    );
  }

  const delays = [
    0,
    4_000,
    8_000,
    15_000,
  ];

  let lastError:
    unknown = null;

  for (
    const delay of delays
  ) {
    if (
      delay
    ) {
      await new Promise(
        (
          resolve,
        ) =>
          setTimeout(
            resolve,
            delay,
          ),
      );
    }

    try {
      return await publishToMax(
        text,
        mediaInfo,
      );
    } catch (error) {
      lastError =
        error;

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      const retryable =
        message.includes(
          "attachment.not.ready",
        ) ||
        message.includes(
          "file.not.processed",
        ) ||
        message.includes(
          "429",
        ) ||
        message.includes(
          "500",
        ) ||
        message.includes(
          "502",
        ) ||
        message.includes(
          "503",
        ) ||
        message.includes(
          "504",
        );

      if (
        !retryable
      ) {
        throw error;
      }
    }
  }

  throw (
    lastError instanceof Error
      ? lastError
      : new Error(
          String(
            lastError,
          ),
        )
  );
}

// ============================================================
// DEDUP
// ============================================================

async function isAlreadyPublished(
  item: NewsItem,
): Promise<boolean> {
  const db =
    await getKV();

  const titleKey =
    await sha256(
      normalizeForHash(
        item.title,
      ),
    );

  const linkKey =
    await sha256(
      normalizeForHash(
        item.link,
      ),
    );

  const titleExists =
    (
      await db.get<boolean>(
        [
          "factor",
          "published_title",
          titleKey,
        ],
      )
    ).value ===
    true;

  if (
    titleExists
  ) {
    return true;
  }

  const linkExists =
    (
      await db.get<boolean>(
        [
          "factor",
          "published_link",
          linkKey,
        ],
      )
    ).value ===
    true;

  return linkExists;
}

async function markPublished(
  item: NewsItem,
): Promise<void> {
  const db =
    await getKV();

  const titleKey =
    await sha256(
      normalizeForHash(
        item.title,
      ),
    );

  const linkKey =
    await sha256(
      normalizeForHash(
        item.link,
      ),
    );

  await db.set(
    [
      "factor",
      "published_title",
      titleKey,
    ],
    true,
    {
      expireIn:
        HISTORY_TTL_MS,
    },
  );

  await db.set(
    [
      "factor",
      "published_link",
      linkKey,
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

  const result:
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
      result.push(
        entry.value,
      );
    }

    if (
      result.length >=
      limit
    ) {
      break;
    }
  }

  return result;
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
// STATE
// ============================================================

async function getNumber(
  key: string[],
): Promise<number | null> {
  const db =
    await getKV();

  return (
    (
      await db.get<number>(
        key,
      )
    ).value ??
    null
  );
}

async function getState() {
  const now =
    Date.now();

  const regular =
    await getNumber(
      [
        "factor",
        "state",
        "last_regular",
      ],
    );

  const urgent =
    await getNumber(
      [
        "factor",
        "state",
        "last_urgent",
      ],
    );

  const db =
    await getKV();

  const running =
    (
      await db.get<boolean>(
        [
          "factor",
          "state",
          "running",
        ],
      )
    ).value ??
    false;

  const lastPipeline =
    (
      await db.get<unknown>(
        [
          "factor",
          "state",
          "last_pipeline",
        ],
      )
    ).value ??
    null;

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
        regular ===
          null ||
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
        urgent ===
          null ||
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

    sources: {
      total_feeds:
        RSS_FEEDS.length,

      google_news_feeds:
        RSS_FEEDS.filter(
          (
            f,
          ) =>
            f.url.includes(
              "news.google.com",
            ),
        ).length,

      direct_rss_feeds:
        RSS_FEEDS.filter(
          (
            f,
          ) =>
            !f.url.includes(
              "news.google.com",
            ),
        ).length,
    },

    gemini_enabled:
      Boolean(
        GEMINI_API_KEY,
      ),

    admin_enabled:
      Boolean(
        ADMIN_KEY,
      ),

    last_pipeline:
      lastPipeline,
  };
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

  const patterns = [
    "теракт",
    "террорист",
    "атака",
    "взрыв",
    "пожар",
    "землетрясение",
    "цунами",
    "катастроф",
    "крушение",
    "самолет разбился",
    "погиб",
    "погибли",
    "убит",
    "убиты",
    "захват заложников",
    "началась война",
    "обстрел",
    "ракетн",
    "санкции",
    "чрезвычайное положение",
    "эвакуация",
    "прорыв дамбы",
    "массовое отключение",
  ];

  return patterns.some(
    (
      pattern,
    ) =>
      text.includes(
        pattern,
      ),
  );
}

// ============================================================
// GEMINI
// ============================================================

function extractJson(
  text: string,
): unknown | null {
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
    // fallback ниже
  }

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

Работай ТОЛЬКО с информацией исходной новости.

ЗАГОЛОВОК:
${item.title}

ИСТОЧНИК:
${item.source}

ОПИСАНИЕ:
${item.description}

Верни только JSON.

Формат:

{
  "headline": "короткий точный заголовок",
  "short": "одно короткое предложение",
  "main": [
    "факт 1",
    "факт 2",
    "факт 3"
  ],
  "important": "конкретный вывод только из источника",
  "urgent": false
}

Правила:

1. Никаких выдуманных фактов.
2. Не додумывай отсутствующую информацию.
3. Не повторяй одну мысль несколько раз.
4. headline должен быть конкретным.
5. short должен быть коротким.
6. main содержит 1–3 факта.
7. Если фактов мало — используй только 1 факт.
8. important должен быть основан только на исходнике.
9. Не используй рекламные формулировки.
10. Не пиши "ситуация развивается".
11. Не пиши "стало известно".
12. urgent=true только для действительно срочной новости.
`;

  try {
    const response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_API_KEY,
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

                responseSchema: {
                  type:
                    "OBJECT",

                  properties: {
                    headline: {
                      type:
                        "STRING",
                    },

                    short: {
                      type:
                        "STRING",
                    },

                    main: {
                      type:
                        "ARRAY",

                      items: {
                        type:
                          "STRING",
                      },
                    },

                    important: {
                      type:
                        "STRING",
                    },

                    urgent: {
                      type:
                        "BOOLEAN",
                    },
                  },

                  required: [
                    "headline",
                    "short",
                    "main",
                    "important",
                    "urgent",
                  ],
                },
              },
            }),

          signal:
            AbortSignal.timeout(
              20_000,
            ),
        },
      );

    if (
      !response.ok
    ) {
      console.error(
        "Gemini HTTP:",
        response.status,
        await response.text(),
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
            p: {
              text?: string;
            },
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
      ) as Record<
        string,
        unknown
      > | null;

    if (
      !json
    ) {
      return null;
    }

    const main =
      Array.isArray(
        json.main,
      )
        ? json.main
            .map(
              (
                x,
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
        : [];

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

      main,

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
      350,
    );

  return {
    headline:
      stripHtml(
        item.title,
      ),

    short:
      text,

    main: [
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

// ============================================================
// DUPLICATE TEXT
// ============================================================

async function isRepeatedStoryText(
  story: AIStory,
): Promise<boolean> {
  const recent =
    await getRecentTitles(
      300,
    );

  const candidate =
    normalizeForHash(
      story.headline,
    );

  const candidateWords =
    new Set(
      candidate
        .split(" ")
        .filter(
          (
            word,
          ) =>
            word.length >
            4,
        ),
    );

  if (
    candidateWords.size <
    4
  ) {
    return false;
  }

  for (
    const oldTitle of recent
  ) {
    const oldWords =
      new Set(
        normalizeForHash(
          oldTitle,
        )
          .split(" ")
          .filter(
            (
              word,
            ) =>
              word.length >
              4,
          ),
      );

    if (
      oldWords.size <
      4
    ) {
      continue;
    }

    let same =
      0;

    for (
      const word of candidateWords
    ) {
      if (
        oldWords.has(
          word,
        )
      ) {
        same++;
      }
    }

    const ratio =
      same /
      Math.min(
        candidateWords.size,
        oldWords.size,
      );

    if (
      same >=
        4 &&
      ratio >=
        0.65
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// POST
// ============================================================

function cleanSourceName(
  source: string,
  articleMedia: ArticleMedia,
): string {
  return cleanText(
    articleMedia.sourceName ||
      source ||
      "Источник",
  )
    .replace(
      /^https?:\/\//i,
      "",
    )
    .replace(
      /^www\./i,
      "",
    );
}

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
      .filter(
        Boolean,
      )
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
      .join("\n") ||
    `• ${short}`;

  const important =
    escapeHtml(
      truncate(
        story.important ||
          story.short,
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

    main,

    "",

    "<b>ЧТО ВАЖНО</b>",

    important,

    "",

    `🕒 ${time}`,

    `🔗 <a href="${escapeHtml(
      articleUrl,
    )}">${escapeHtml(
      sourceName,
    )}</a>`,
  ].join("\n");
}

// ============================================================
// CANDIDATE
// ============================================================

async function candidateIsAllowed(
  item: NewsItem,
  manual: boolean,
): Promise<{
  allowed: boolean;
  story: AIStory;
  media: ArticleMedia;
} | null> {
  if (
    await isAlreadyPublished(
      item,
    )
  ) {
    return null;
  }

  const media =
    await extractArticleMedia(
      item.link,
      item.publisherUrl,
    );

  // Google News URL без реального URL СМИ
  // не публикуем.
  if (
    !media.articleUrl
  ) {
    return null;
  }

  const story =
    (await callGemini(
      item,
    )) ??
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
    return null;
  }

  if (
    manual
  ) {
    return {
      allowed:
        true,

      story,

      media,
    };
  }

  const now =
    Date.now();

  const lastRegular =
    await getNumber(
      [
        "factor",
        "state",
        "last_regular",
      ],
    );

  const lastUrgent =
    await getNumber(
      [
        "factor",
        "state",
        "last_urgent",
      ],
    );

  if (
    story.urgent
  ) {
    if (
      lastUrgent !==
        null &&
      now -
          lastUrgent <
        URGENT_INTERVAL_MS
    ) {
      return null;
    }
  } else {
    if (
      lastRegular !==
        null &&
      now -
          lastRegular <
        REGULAR_INTERVAL_MS
    ) {
      return null;
    }
  }

  return {
    allowed:
      true,

    story,

    media,
  };
}

async function chooseCandidate(
  items: NewsItem[],
  manual: boolean,
) {
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
        ) =>
          (
            Date.parse(
              b.pubDate,
            ) ||
            0
          ) -
          (
            Date.parse(
              a.pubDate,
            ) ||
            0
          ),
      );

  let checked =
    0;

  for (
    const item of sorted
  ) {
    if (
      checked++ >=
      MAX_CANDIDATES_TO_CHECK
    ) {
      break;
    }

    const result =
      await candidateIsAllowed(
        item,
        manual,
      );

    if (
      result?.allowed
    ) {
      return {
        item,

        ...result,
      };
    }
  }

  return null;
}

// ============================================================
// PIPELINE
// ============================================================

let pipelinePromise:
  Promise<unknown> | null =
  null;

async function runPipeline(
  manual = false,
): Promise<any> {
  if (
    pipelinePromise
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

  const running =
    (
      await db.get<boolean>(
        [
          "factor",
          "state",
          "running",
        ],
      )
    ).value ??
    false;

  if (
    running
  ) {
    return {
      ok:
        false,

      skipped:
        true,

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

    // --------------------------------------------------------
    // RSS
    // --------------------------------------------------------

    const feedResults =
      await Promise.all(
        RSS_FEEDS.map(
          loadRSS,
        ),
      );

    // ВАЖНО:
    // сначала объединяем ВСЕ RSS,
    // потом сортируем по дате.
    //
    // Иначе первые Google News ленты
    // могли вытеснять BBC/DW.
    const items =
      feedResults
        .flat()
        .sort(
          (
            a,
            b,
          ) =>
            (
              Date.parse(
                b.pubDate,
              ) ||
              0
            ) -
            (
              Date.parse(
                a.pubDate,
              ) ||
              0
            ),
        )
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
        manual,
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
          "no allowed non-duplicate candidate",

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
      media:
        articleMedia,
    } =
      candidate;

    const urgent =
      story.urgent;

    const articleUrl =
      articleMedia.articleUrl;

    if (
      !articleUrl
    ) {
      throw new Error(
        "Real article URL missing",
      );
    }

    const sourceName =
      cleanSourceName(
        item.source,
        articleMedia,
      );

    // --------------------------------------------------------
    // MEDIA
    // --------------------------------------------------------

    const media =
      await findBestMedia(
        articleMedia,
      );

    // --------------------------------------------------------
    // POST
    // --------------------------------------------------------

    const text =
      buildPost(
        item,
        story,
        sourceName,
        articleUrl,
      );

    // --------------------------------------------------------
    // UPLOAD MEDIA
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
      } catch (error) {
        // Медиа не должно ломать публикацию.
        console.error(
          "Media upload failed; publishing text-only:",
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
      await publishWithMediaRetry(
        text,
        mediaInfo,
      );

    const now =
      Date.now();

    // --------------------------------------------------------
    // SAVE
    // --------------------------------------------------------

    await markPublished(
      item,
    );

    await rememberTitle(
      story.headline,
    );

    await db.set(
      [
        "factor",
        "state",
        urgent
          ? "last_urgent"
          : "last_regular",
      ],
      now,
    );

    const result = {
      ok:
        true,

      selected:
        1,

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
      ok:
        false,

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

// ============================================================
// SECURITY
// ============================================================

function controlAuthorized(
  request: Request,
): boolean {
  if (
    !ADMIN_KEY
  ) {
    return false;
  }

  const header =
    request.headers.get(
      "x-admin-key",
    );

  if (
    header &&
    header ===
      ADMIN_KEY
  ) {
    return true;
  }

  const url =
    new URL(
      request.url,
    );

  const queryKey =
    url.searchParams.get(
      "key",
    );

  return (
    queryKey ===
    ADMIN_KEY
  );
}

// ============================================================
// TEST
// ============================================================

async function publishTest(): Promise<unknown> {
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

  return publishToMax(
    text,
  );
}

// ============================================================
// JSON RESPONSE
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
//
// ВАЖНО:
//
// Deno Deploy должен видеть Deno.cron()
// НА ВЕРХНЕМ УРОВНЕ.
//
// Не помещать внутрь Deno.serve().
// Не помещать внутрь if.
// Не помещать внутрь функции.
//
// Deno Deploy сейчас обнаруживает cron
// при деплое приложения.
// ============================================================

Deno.cron(
  "FAKTOR news pipeline",

  CRON_SCHEDULE,

  {
    backoffSchedule: [
      5_000,
      15_000,
      30_000,
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

    // Если pipeline реально упал,
    // бросаем ошибку, чтобы Deno Cron
    // мог использовать backoffSchedule.
    if (
      result &&
      typeof result ===
        "object" &&
      "ok" in result &&
      result.ok ===
        false
    ) {
      throw new Error(
        `Cron pipeline failed: ${JSON.stringify(
          result,
        )}`,
      );
    }
  },
);

// ============================================================
// HTTP
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
        request.method ===
          "GET" &&
        path === "/"
      ) {
        return json({
          ok:
            true,

          service:
            "MAX NEWS AGENT — ФАКТОР",

          runtime:
            "Deno Deploy",

          cron:
            CRON_SCHEDULE,

          endpoints: [
            "/",
            "/health",
            "/status",
            "/pipeline-state",
            "/run",
            "/publish-test",
            "/me",
          ],
        });
      }

      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
        path ===
          "/health"
      ) {
        return json({
          ok:
            true,

          service:
            "FAKTOR",

          time:
            new Date().toISOString(),
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
          ok:
            true,

          now:
            new Date().toISOString(),

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
          ok:
            true,

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
        path ===
          "/run"
      ) {
        if (
          !controlAuthorized(
            request,
          )
        ) {
          return json(
            {
              ok:
                false,

              error:
                "Unauthorized",
            },
            401,
          );
        }

        return json(
          await runPipeline(
            true,
          ),
        );
      }

      // ------------------------------------------------------
      // PUBLISH TEST
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
        path ===
          "/publish-test"
      ) {
        if (
          !controlAuthorized(
            request,
          )
        ) {
          return json(
            {
              ok:
                false,

              error:
                "Unauthorized",
            },
            401,
          );
        }

        return json({
          ok:
            true,

          provider:
            "MAX",

          operation:
            "publish-test",

          response:
            await publishTest(),
        });
      }

      // ------------------------------------------------------
      // ME
      // ------------------------------------------------------

      if (
        request.method ===
          "GET" &&
        path ===
          "/me"
      ) {
        if (
          !controlAuthorized(
            request,
          )
        ) {
          return json(
            {
              ok:
                false,

              error:
                "Unauthorized",
            },
            401,
          );
        }

        return json({
          ok:
            true,

          max_me:
            await maxJson(
              "/me",
            ),
        });
      }

      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      return json(
        {
          ok:
            false,

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
          ok:
            false,

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