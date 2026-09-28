const MAX_API = "https://platform-api2.max.ru";

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta";

const QWEN_API =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") || "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") || "";

const QWEN_API_KEY =
  Deno.env.get("QWEN_API_KEY") || "";

/*
 * ============================================================
 * AI MODEL CONFIGURATION
 * ============================================================
 */

const GEMINI_MODELS = parseList(
  Deno.env.get("GEMINI_MODELS") ||
    "gemini-3.8-flash,gemini-2.5-flash"
);

const QWEN_MODELS = parseList(
  Deno.env.get("QWEN_MODELS") ||
    "qwen3.8-flash,qwen3.7-plus,qwen3.6-flash,qwen-plus"
);

/*
 * ============================================================
 * GENERAL CONFIGURATION
 * ============================================================
 */

const RETRIES =
  numberEnv("API_RETRIES", 2);

const REQUEST_TIMEOUT_MS =
  numberEnv("API_TIMEOUT_MS", 20000);

const AUTO_PIPELINE =
  (Deno.env.get("AUTO_PIPELINE") || "false")
    .toLowerCase() === "true";

const CRON_SCHEDULE =
  Deno.env.get("CRON_SCHEDULE") ||
  "*/15 * * * *";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") || "";

const MAX_NEWS_PER_RUN =
  numberEnv("MAX_NEWS_PER_RUN", 1);

const MAX_WEBHOOK_SECRET =
  Deno.env.get("MAX_WEBHOOK_SECRET") || "";

const MAX_WEBHOOK_UPDATE_TYPES = [
  "bot_added",
  "bot_started",
  "bot_removed",
  "bot_stopped",
  "dialog_removed",
  "message_created",
  "message_edited",
  "message_removed",
  "comment_created",
  "comment_edited",
  "comment_removed",
  "chat_title_changed",
  "bot_admin_permissions_changed"
];

let maxKv = null;

let webhookSetupCache = {
  url: null,
  ok: false,
  at: 0,
  result: null
};

/*
 * ============================================================
 * MAX TLS / CERTIFICATES
 * ============================================================
 */

const MAX_ROOT_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";

const MAX_SUB_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";

let maxHttpClient = null;

let maxHttpClientError = null;

let maxCaStatus = {
  loaded: false,
  root: false,
  sub: false,
  error: null
};

/*
 * ============================================================
 * RSS SOURCES
 * ============================================================
 */

const RSS_FEEDS = [
  "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"
];

/*
 * ============================================================
 * RUNTIME STATE
 * ============================================================
 */

const recentPublished = new Map();

let discoveredGeminiModels = null;

let discoveredQwenModels = null;

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function parseList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    )
  ];
}

function numberEnv(name, fallback) {
  const value = Number(
    Deno.env.get(name)
  );

  return Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

function isRetryableStatus(status) {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function retryDelay(
  attempt,
  retryAfterHeader
) {
  const retryAfter =
    Number(retryAfterHeader);

  if (
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
  ) {
    return Math.min(
      retryAfter * 1000,
      60000
    );
  }

  return (
    Math.min(
      1000 * 2 ** attempt,
      8000
    ) +
    Math.floor(
      Math.random() * 400
    )
  );
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Methods":
          "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Max-Bot-Api-Secret"
      }
    }
  );
}

/*
 * ============================================================
 * MAX CERTIFICATE CLIENT
 * ============================================================
 */

async function loadMaxCertificates() {
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
    const [
      rootResponse,
      subResponse
    ] = await Promise.all([
      fetch(
        MAX_ROOT_CA_URL
      ),
      fetch(
        MAX_SUB_CA_URL
      )
    ]);

    if (
      !rootResponse.ok
    ) {
      throw new Error(
        `Root CA download failed: ${rootResponse.status}`
      );
    }

    if (
      !subResponse.ok
    ) {
      throw new Error(
        `Sub CA download failed: ${subResponse.status}`
      );
    }

    const rootCa =
      await rootResponse.text();

    const subCa =
      await subResponse.text();

    if (
      !rootCa.trim()
    ) {
      throw new Error(
        "Root CA is empty"
      );
    }

    if (
      !subCa.trim()
    ) {
      throw new Error(
        "Sub CA is empty"
      );
    }

    maxCaStatus.root = true;

    maxCaStatus.sub = true;

    maxCaStatus.loaded = true;

    /*
     * Deno Deploy supports custom CA certificates
     * through a custom HttpClient.
     */

    maxHttpClient =
      Deno.createHttpClient({
        caCerts: [
          rootCa,
          subCa
        ]
      });

    return maxHttpClient;

  } catch (error) {
    maxHttpClientError =
      error;

    maxCaStatus.error =
      error?.message ||
      String(error);

    return null;
  }
}

/*
 * ============================================================
 * GENERIC HTTP
 * ============================================================
 */

async function fetchJson(
  url,
  options = {},
  config = {}
) {
  const retries =
    config.retries ??
    RETRIES;

  const timeoutMs =
    config.timeoutMs ??
    REQUEST_TIMEOUT_MS;

  let last = {
    ok: false,
    status: 0,
    statusText: "",
    data: null,
    error_type: null,
    error_name: null,
    error_message: null
  };

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    let timer = null;

    try {
      const controller =
        new AbortController();

      timer =
        setTimeout(
          () => controller.abort(),
          timeoutMs
        );

      const requestOptions = {
        ...options,
        signal:
          controller.signal
      };

      if (
        config.useMaxClient
      ) {
        const client =
          await loadMaxCertificates();

        if (
          client
        ) {
          requestOptions.client =
            client;
        }
      }

      const response =
        await fetch(
          url,
          requestOptions
        );

      const contentType =
        response.headers.get(
          "content-type"
        ) || "";

      let data = null;

      if (
        contentType.includes(
          "application/json"
        )
      ) {
        try {
          data =
            await response.json();
        } catch {
          data = null;
        }
      } else {
        const text =
          await response.text();

        data = {
          raw: text
        };
      }

      const result = {
        ok:
          response.ok,

        status:
          response.status,

        statusText:
          response.statusText,

        data,

        error_type:
          null,

        error_name:
          null,

        error_message:
          null
      };

      if (
        response.ok
      ) {
        return result;
      }

      last =
        result;

      if (
        !isRetryableStatus(
          response.status
        ) ||
        attempt >= retries
      ) {
        return result;
      }

      await sleep(
        retryDelay(
          attempt,
          response.headers.get(
            "retry-after"
          )
        )
      );

    } catch (error) {
      last = {
        ok: false,

        status: 599,

        statusText: "",

        data: {
          error:
            error?.message ||
            String(error)
        },

        error_type:
          error?.name ===
          "AbortError"
            ? "timeout"
            : "fetch_error",

        error_name:
          error?.name ||
          null,

        error_message:
          error?.message ||
          String(error)
      };

      console.error(
        "[HTTP ERROR]",
        JSON.stringify(
          {
            url,
            attempt,
            error_name:
              error?.name,
            error_message:
              error?.message
          }
        )
      );

      if (
        attempt < retries
      ) {
        await sleep(
          retryDelay(
            attempt
          )
        );
      }

    } finally {
      clearTimeout(
        timer
      );
    }
  }

  return last;
}

/*
 * ============================================================
 * SECRETS
 * ============================================================
 */

function requireSecret(
  value,
  name
) {
  if (!value) {
    throw new Error(
      `Secret ${name} не настроен в Deno Deploy`
    );
  }
}

/*
 * ============================================================
 * MAX API
 * ============================================================
 */

async function maxRequest(
  path,
  options = {}
) {
  requireSecret(
    MAX_BOT_TOKEN,
    "MAX_BOT_TOKEN"
  );

  const cleanPath =
    path.startsWith("/")
      ? path
      : `/${path}`;

  return await fetchJson(
    `${MAX_API}${cleanPath}`,

    {
      ...options,

      headers: {
        Authorization:
          MAX_BOT_TOKEN.trim(),

        Accept:
          "application/json",

        ...(options.body
          ? {
              "Content-Type":
                "application/json"
            }
          : {}),

        ...(options.headers || {})
      }
    },

    {
      useMaxClient: true
    }
  );
}

/*
 * ============================================================
 * GEMINI RESPONSE EXTRACTION
 * ============================================================
 */

function extractGeminiText(
  data
) {
  return (
    data
      ?.candidates?.[0]
      ?.content
      ?.parts
      ?.map(
        (part) =>
          part?.text || ""
      )
      .join("")
      .trim() || ""
  );
}

/*
 * ============================================================
 * QWEN RESPONSE EXTRACTION
 * ============================================================
 */

function extractQwenText(
  data
) {
  return (
    data?.choices?.[0]
      ?.message?.content ||
    data?.choices?.[0]
      ?.text ||
    ""
  ).trim();
}

/*
 * ============================================================
 * GEMINI MODEL DISCOVERY
 * ============================================================
 */

async function discoverGeminiModels() {
  if (!GEMINI_API_KEY) {
    return [];
  }

  if (
    discoveredGeminiModels
  ) {
    return discoveredGeminiModels;
  }

  const result =
    await fetchJson(
      `${GEMINI_BASE}/models?key=${encodeURIComponent(
        GEMINI_API_KEY
      )}`,

      {
        method: "GET"
      },

      {
        retries: 1
      }
    );

  if (!result.ok) {
    discoveredGeminiModels =
      [];

    return [];
  }

  const models =
    Array.isArray(
      result.data?.models
    )
      ? result.data.models
      : [];

  discoveredGeminiModels =
    models
      .map(
        (model) =>
          String(
            model?.name ||
            ""
          )
            .replace(
              /^models\//,
              ""
            )
            .trim()
      )
      .filter(Boolean);

  return discoveredGeminiModels;
}

/*
 * ============================================================
 * QWEN MODEL DISCOVERY
 * ============================================================
 */

async function discoverQwenModels() {
  if (!QWEN_API_KEY) {
    return [];
  }

  if (
    discoveredQwenModels
  ) {
    return discoveredQwenModels;
  }

  const result =
    await fetchJson(
      "https://dashscope-intl.aliyuncs.com/api/v1/models",

      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${QWEN_API_KEY}`,

          Accept:
            "application/json"
        }
      },

      {
        retries: 1
      }
    );

  if (!result.ok) {
    discoveredQwenModels =
      [];

    return [];
  }

  const models =
    Array.isArray(
      result.data?.output?.models
    )
      ? result.data.output.models
      : Array.isArray(
          result.data?.models
        )
        ? result.data.models
        : [];

  discoveredQwenModels =
    models
      .map(
        (model) =>
          String(
            model?.name ||
            model?.model ||
            ""
          ).trim()
      )
      .filter(Boolean);

  return discoveredQwenModels;
}

/*
 * ============================================================
 * UNIQUE MODELS
 * ============================================================
 */

function uniqueModels(
  configured,
  discovered
) {
  return [
    ...new Set([
      ...configured,
      ...discovered
    ])
  ];
}

/*
 * ============================================================
 * GEMINI GENERATION
 * ============================================================
 */

async function generateGemini(
  model,
  prompt
) {
  const url =
    `${GEMINI_BASE}/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;

  return await fetchJson(
    url,

    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    prompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.45,
            topP: 0.9,
            maxOutputTokens: 1200
          }
        })
    },

    {
      retries:
        RETRIES
    }
  );
}

/*
 * ============================================================
 * QWEN GENERATION
 * ============================================================
 */

async function generateQwen(
  model,
  prompt
) {
  return await fetchJson(
    QWEN_API,

    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${QWEN_API_KEY}`,

        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          model,

          messages: [
            {
              role:
                "user",

              content:
                prompt
            }
          ],

          temperature:
            0.45,

          top_p:
            0.9,

          max_tokens:
            1200
        })
    },

    {
      retries:
        RETRIES
    }
  );
}

/*
 * ============================================================
 * AI FALLBACK
 * ============================================================
 */

async function generateWithFallback(
  prompt
) {
  const attempts = [];

  const discoveredGemini =
    await discoverGeminiModels();

  const discoveredQwen =
    await discoverQwenModels();

  const geminiModels =
    uniqueModels(
      GEMINI_MODELS,
      discoveredGemini
    );

  const qwenModels =
    uniqueModels(
      QWEN_MODELS,
      discoveredQwen
    );

  for (
    const model
    of geminiModels
  ) {
    if (
      !GEMINI_API_KEY
    ) {
      break;
    }

    const result =
      await generateGemini(
        model,
        prompt
      );

    const text =
      extractGeminiText(
        result.data
      );

    attempts.push({
      provider:
        "Gemini",

      model,

      ok:
        result.ok &&
        !!text,

      status:
        result.status,

      error:
        result.error_message ||
        null
    });

    if (
      result.ok &&
      text
    ) {
      return {
        ok: true,

        provider:
          "Gemini",

        model,

        text,

        attempts
      };
    }
  }

  for (
    const model
    of qwenModels
  ) {
    if (
      !QWEN_API_KEY
    ) {
      break;
    }

    const result =
      await generateQwen(
        model,
        prompt
      );

    const text =
      extractQwenText(
        result.data
      );

    attempts.push({
      provider:
        "Qwen",

      model,

      ok:
        result.ok &&
        !!text,

      status:
        result.status,

      error:
        result.error_message ||
        null
    });

    if (
      result.ok &&
      text
    ) {
      return {
        ok: true,

        provider:
          "Qwen",

        model,

        text,

        attempts
      };
    }
  }

  return {
    ok: false,

    error:
      "Все настроенные AI-модели не смогли обработать запрос.",

    attempts
  };
}

/*
 * ============================================================
 * RSS PARSER
 * ============================================================
 */

function decodeXml(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      "$1"
    )
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&#x27;/gi,
      "'"
    );
}

function stripHtml(
  value
) {
  return decodeXml(
    String(
      value || ""
    )
      .replace(
        /<[^>]*>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
  );
}

function extractTag(
  block,
  tag
) {
  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    block.match(
      regex
    );

  return match
    ? stripHtml(
        match[1]
      )
    : "";
}

function extractItems(
  xml
) {
  const items = [];

  const matches =
    String(
      xml || ""
    ).match(
      /<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi
    ) || [];

  for (
    const block
    of matches
  ) {
    const title =
      extractTag(
        block,
        "title"
      );

    const link =
      extractTag(
        block,
        "link"
      );

    const description =
      extractTag(
        block,
        "description"
      );

    const pubDate =
      extractTag(
        block,
        "pubDate"
      );

    if (
      title
    ) {
      items.push({
        title,
        link,
        description,
        pubDate
      });
    }
  }

  return items;
}

/*
 * ============================================================
 * RSS FETCH
 * ============================================================
 */

async function fetchRSS() {
  const results =
    await Promise.all(
      RSS_FEEDS.map(
        async (feed) => {
          const result =
            await fetchJson(
              feed,

              {
                method:
                  "GET",

                headers: {
                  "User-Agent":
                    "MAX-News-Agent/2.0"
                }
              },

              {
                retries: 1,

                timeoutMs:
                  15000
              }
            );

          if (!result.ok) {
            return {
              feed,

              ok: false,

              status:
                result.status,

              error:
                result.data
                  ?.error ||
                null
            };
          }

          const xml =
            typeof result.data ===
              "object" &&
            result.data?.raw
              ? result.data.raw
              : null;

          if (!xml) {
            return {
              feed,

              ok: false,

              status:
                result.status,

              error:
                "RSS response is not plain XML"
            };
          }

          const items =
            extractItems(
              xml
            );

          return {
            feed,

            ok: true,

            count:
              items.length,

            items:
              items.slice(
                0,
                10
              )
          };
        }
      )
    );

  return results;
}

/*
 * ============================================================
 * FLATTEN RSS
 * ============================================================
 */

function flattenNews(
  feeds
) {
  const items = [];

  for (
    const feed
    of feeds
  ) {
    if (
      !feed.ok ||
      !Array.isArray(
        feed.items
      )
    ) {
      continue;
    }

    for (
      const item
      of feed.items
    ) {
      items.push({
        ...item,

        source_feed:
          feed.feed
      });
    }
  }

  return items.sort(
    (a, b) => {
      const aTime =
        Date.parse(
          a.pubDate || ""
        ) || 0;

      const bTime =
        Date.parse(
          b.pubDate || ""
        ) || 0;

      return (
        bTime - aTime
      );
    }
  );
}

/*
 * ============================================================
 * NEWS ANALYSIS PROMPT
 * ============================================================
 */

function buildAnalysisPrompt(
  item
) {
  return `
Ты готовишь короткую новость для канала «ФАКТОР». Подача должна ощущаться как прямой эфир: событие произошло — сразу говорим, что случилось, почему это важно и что может измениться дальше.

ЗАГОЛОВОК:
${item.title}

ДАТА:
${item.pubDate || "не указана"}

ССЫЛКА:
${item.link || "нет"}

ОПИСАНИЕ:
${item.description || "нет"}

Правила:

1. Не выдумывай факты.
2. Отделяй подтверждённое от предположений.
3. Пиши динамично, как ведущий новостного прямого эфира, но без кликбейта и истерики.
4. Первый абзац сразу сообщает главное событие. Не начинай с длинного вступления.
5. Эмоция допустима только как реакция на подтверждённый масштаб события: «это важно», «это меняет ситуацию», «главный вопрос теперь…». Не используй эмоциональную лексику ради эмоции.
6. Для политики, войны, выборов и других спорных тем сохраняй нейтральную фактическую подачу и явно отделяй заявления сторон от установленных фактов.
7. Не приписывай людям мотивы, которых нет в источнике.
8. Если данных недостаточно, прямо укажи это.
9. Ответь на русском.
10. Не используй Markdown-таблицы.
11. Не повторяй заголовок дословно в тексте.

Структура:

ГЛАВНОЕ:
2-3 коротких предложения в динамичной новостной манере: что произошло прямо сейчас и почему это важно.

ФАКТЫ:
3-5 коротких пунктов. Только подтверждённые сведения.

ЧТО ДАЛЬШЕ:
1-2 предложения о ближайшем развитии ситуации. Если прогноз невозможен по имеющимся данным — так и скажи.

ИСТОЧНИК:
ссылка на материал.
`.trim();
}

/*
 * ============================================================
 * NEWS KEY
 * ============================================================
 */

function newsKey(
  item
) {
  return (
    item.link ||
    `${item.title}|${item.pubDate || ""}`
  );
}

/*
 * ============================================================
 * MAX PUBLICATION
 * ============================================================
 */

async function publishToMax(
  chatId,
  text
) {
  if (!chatId) {
    return {
      ok: false,

      status: 400,

      data: {
        error:
          "TARGET_CHAT_ID не задан"
      }
    };
  }

  return await maxRequest(
    `/messages?chat_id=${encodeURIComponent(
      chatId
    )}`,

    {
      method: "POST",

      body: JSON.stringify({
        text
      })
    }
  );
}

/*
 * ============================================================
 * FULL PIPELINE
 * ============================================================
 */

async function runPipeline() {
  const startedAt =
    Date.now();

  const feeds =
    await fetchRSS();

  const news =
    flattenNews(
      feeds
    );

  if (!news.length) {
    return {
      ok: false,

      stage:
        "rss",

      error:
        "Новых материалов из RSS не получено.",

      feeds
    };
  }

  const selected =
    news.slice(
      0,
      MAX_NEWS_PER_RUN
    );

  const results = [];

  for (
    const item
    of selected
  ) {
    const key =
      newsKey(item);

    if (
      recentPublished.has(
        key
      )
    ) {
      results.push({
        ok: true,

        skipped: true,

        reason:
          "already processed in current runtime",

        item
      });

      continue;
    }

    const analysis =
      await generateWithFallback(
        buildAnalysisPrompt(
          item
        )
      );

    if (!analysis.ok) {
      results.push({
        ok: false,

        stage:
          "ai",

        item,

        analysis
      });

      continue;
    }

    const text =
      `📰 ${item.title}\n\n` +
      `${analysis.text}\n\n` +
      `Источник: ${
        item.link ||
        "не указан"
      }`;

    let publication = {
      ok: false,

      skipped: true,

      reason:
        AUTO_PIPELINE
          ? "no target chats configured"
          : "AUTO_PIPELINE=false"
    };

    if (
      AUTO_PIPELINE
    ) {
      const storedChats =
        await getStoredMaxChatIds();

      const chatIds = [
        ...new Set([
          ...(TARGET_CHAT_ID
            ? [TARGET_CHAT_ID]
            : []),

          ...storedChats.map(
            (item) =>
              item.chat_id
          )
        ])
      ];

      if (
        chatIds.length
      ) {
        const publications = [];

        for (
          const chatId
          of chatIds
        ) {
          const publishResult =
            await publishToMax(
              chatId,
              text
            );

          publications.push({
            chat_id:
              chatId,

            ok:
              publishResult.ok,

            http_status:
              publishResult.status,

            response:
              publishResult.data,

            error:
              publishResult.error_message ||
              null
          });

          if (
            !publishResult.ok &&
            [400, 403, 404].includes(
              publishResult.status
            ) &&
            chatId !==
              TARGET_CHAT_ID
          ) {
            await removeMaxChatId(
              chatId
            );
          }
        }

        publication = {
          ok:
            publications.some(
              (item) =>
                item.ok
            ),

          attempted:
            publications.length,

          successful:
            publications.filter(
              (item) =>
                item.ok
            ).length,

          results:
            publications
        };

        if (
          publication.ok
        ) {
          recentPublished.set(
            key,
            Date.now()
          );
        }
      }
    }

    results.push({
      ok: true,

      item,

      ai: {
        provider:
          analysis.provider,

        model:
          analysis.model,

        attempts:
          analysis.attempts
      },

      publication,

      text
    });
  }

  return {
    ok:
      results.some(
        (item) =>
          item.ok
      ),

    duration_ms:
      Date.now() -
      startedAt,

    auto_pipeline:
      AUTO_PIPELINE,

    target_chat_configured:
      !!TARGET_CHAT_ID,

    rss_total:
      news.length,

    results
  };
}

/*
 * ============================================================
 * MAX UPDATE / WEBHOOK HELPERS
 * ============================================================
 */

async function getMaxKv() {
  if (
    !maxKv
  ) {
    maxKv =
      await Deno.openKv();
  }

  return maxKv;
}

async function saveMaxChatId(
  chatId,
  meta = {}
) {
  if (
    chatId ===
      undefined ||
    chatId ===
      null ||
    chatId ===
      ""
  ) {
    return false;
  }

  const id =
    String(
      chatId
    );

  const kv =
    await getMaxKv();

  await kv.set(
    [
      "max",
      "chat_ids",
      id
    ],

    {
      chat_id:
        id,

      is_channel:
        meta.is_channel ??
        null,

      update_type:
        meta.update_type ??
        null,

      timestamp:
        meta.timestamp ??
        Date.now(),

      saved_at:
        new Date().toISOString()
    }
  );

  return true;
}

async function removeMaxChatId(
  chatId
) {
  if (
    chatId ===
      undefined ||
    chatId ===
      null ||
    chatId ===
      ""
  ) {
    return false;
  }

  const kv =
    await getMaxKv();

  await kv.delete(
    [
      "max",
      "chat_ids",
      String(
        chatId
      )
    ]
  );

  return true;
}

async function getStoredMaxChatIds() {
  const kv =
    await getMaxKv();

  const ids = [];

  for await (
    const entry
    of kv.list({
      prefix: [
        "max",
        "chat_ids"
      ]
    })
  ) {
    const value =
      entry.value;

    const id =
      value?.chat_id ??
      entry.key?.[2];

    if (
      id !==
        undefined &&
      id !==
        null &&
      String(id)
    ) {
      ids.push({
        chat_id:
          String(id),

        is_channel:
          value?.is_channel ??
          null,

        update_type:
          value?.update_type ??
          null,

        timestamp:
          value?.timestamp ??
          null,

        saved_at:
          value?.saved_at ??
          null
      });
    }
  }

  return ids.sort(
    (a, b) =>
      String(
        a.chat_id
      ).localeCompare(
        String(
          b.chat_id
        )
      )
  );
}

function extractChatIds(
  data
) {
  const ids =
    new Set();

  const updates =
    Array.isArray(
      data?.updates
    )
      ? data.updates
      : [];

  for (
    const update
    of updates
  ) {
    if (
      update?.chat_id !==
        undefined &&
      update?.chat_id !==
        null
    ) {
      ids.add(
        String(
          update.chat_id
        )
      );
    }
  }

  return [
    ...ids
  ];
}

async function processMaxUpdate(
  update
) {
  if (
    !update ||
    typeof update !==
      "object"
  ) {
    return {
      saved: [],
      removed: []
    };
  }

  const saved = [];

  const removed = [];

  const type =
    update.update_type ||
    null;

  const chatId =
    update.chat_id;

  if (
    chatId !==
      undefined &&
    chatId !==
      null
  ) {
    if (
      type ===
        "bot_removed" ||
      type ===
        "dialog_removed" ||
      type ===
        "bot_stopped"
    ) {
      await removeMaxChatId(
        chatId
      );

      removed.push(
        String(
          chatId
        )
      );

    } else {
      await saveMaxChatId(
        chatId,

        {
          is_channel:
            update.is_channel,

          update_type:
            type,

          timestamp:
            update.timestamp
        }
      );

      saved.push(
        String(
          chatId
        )
      );
    }
  }

  return {
    saved,
    removed
  };
}

async function processMaxWebhookPayload(
  payload
) {
  const updates =
    Array.isArray(
      payload?.updates
    )
      ? payload.updates
      : payload &&
          payload.update_type
        ? [payload]
        : [];

  const result = {
    received:
      updates.length,

    saved: [],

    removed: []
  };

  for (
    const update
    of updates
  ) {
    const item =
      await processMaxUpdate(
        update
      );

    result.saved.push(
      ...item.saved
    );

    result.removed.push(
      ...item.removed
    );
  }

  result.saved =
    [
      ...new Set(
        result.saved
      )
    ];

  result.removed =
    [
      ...new Set(
        result.removed
      )
    ];

  return result;
}

function getUpdateSummary(
  data
) {
  const updates =
    Array.isArray(
      data?.updates
    )
      ? data.updates
      : [];

  return updates.map(
    (update) => ({
      update_type:
        update?.update_type ??
        null,

      chat_id:
        update?.chat_id !==
          undefined &&
        update?.chat_id !==
          null
          ? String(
              update.chat_id
            )
          : null,

      timestamp:
        update?.timestamp ??
        null,

      is_channel:
        update?.is_channel ??
        null
    })
  );
}

function webhookSecretValid(
  request
) {
  if (
    !MAX_WEBHOOK_SECRET
  ) {
    return true;
  }

  const received =
    request.headers.get(
      "X-Max-Bot-Api-Secret"
    ) || "";

  return (
    received ===
    MAX_WEBHOOK_SECRET
  );
}

async function getWebhookUrl(
  request
) {
  const url =
    new URL(
      request.url
    );

  return `${url.origin}/webhook`;
}

async function getMaxSubscriptions() {
  return await maxRequest(
    "/subscriptions",

    {
      method:
        "GET"
    }
  );
}

async function ensureMaxWebhook(
  request,
  force = false
) {
  const webhookUrl =
    await getWebhookUrl(
      request
    );

  const now =
    Date.now();

  if (
    !force &&
    webhookSetupCache.url ===
      webhookUrl &&
    webhookSetupCache.ok &&
    now -
        webhookSetupCache.at <
      300000
  ) {
    return webhookSetupCache.result;
  }

  const subscriptions =
    await getMaxSubscriptions();

  if (
    subscriptions.ok
  ) {
    const list =
      Array.isArray(
        subscriptions.data
          ?.subscriptions
      )
        ? subscriptions.data
            .subscriptions
        : [];

    const existing =
      list.find(
        (item) =>
          item?.url ===
          webhookUrl
      );

    if (
      existing
    ) {
      const result = {
        ok: true,

        created: false,

        webhook_url:
          webhookUrl,

        subscriptions:
          list
      };

      webhookSetupCache = {
        url:
          webhookUrl,

        ok: true,

        at:
          now,

        result
      };

      return result;
    }
  }

  const body = {
    url:
      webhookUrl,

    update_types:
      MAX_WEBHOOK_UPDATE_TYPES
  };

  if (
    MAX_WEBHOOK_SECRET
  ) {
    body.secret =
      MAX_WEBHOOK_SECRET;
  }

  const result =
    await maxRequest(
      "/subscriptions",

      {
        method:
          "POST",

        body:
          JSON.stringify(
            body
          )
      }
    );

  const response = {
    ok:
      result.ok &&
      result.data?.success !==
        false,

    created:
      result.ok,

    webhook_url:
      webhookUrl,

    http_status:
      result.status,

    response:
      result.data,

    error:
      result.error_message ||
      null
  };

  webhookSetupCache = {
    url:
      webhookUrl,

    ok:
      response.ok,

    at:
      now,

    result:
      response
  };

  return response;
}

/*
 * ============================================================
 * AUTOMATIC CRON
 * ============================================================
 */

if (
  AUTO_PIPELINE
) {
  Deno.cron(
    "MAX News automatic pipeline",

    CRON_SCHEDULE,

    {
      backoffSchedule: [
        5000,
        15000,
        60000
      ]
    },

    async () => {
      console.log(
        `[CRON] MAX News pipeline started: ${new Date().toISOString()}`
      );

      const result =
        await runPipeline();

      console.log(
        "[CRON] MAX News pipeline result:",

        JSON.stringify(
          result
        )
      );

      if (
        !result.ok
      ) {
        throw new Error(
          result.error ||
            "MAX News pipeline failed"
        );
      }
    }
  );
}

/*
 * ============================================================
 * HTTP SERVER
 * ============================================================
 */

Deno.serve(
  async (request) => {
    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    if (
      request.method ===
      "OPTIONS"
    ) {
      return json({
        ok: true
      });
    }

    try {
      /*
       * ======================================================
       * /
       * ======================================================
       */

      if (
        path === "/" &&
        request.method ===
          "GET"
      ) {
        return json({
          ok: true,

          service:
            "MAX NEWS AGENT",

          runtime:
            "Deno Deploy",

          status:
            "online",

          time:
            new Date().toISOString(),

          auto_pipeline:
            AUTO_PIPELINE,

          cron_schedule:
            AUTO_PIPELINE
              ? CRON_SCHEDULE
              : null,

          target_chat_configured:
            !!TARGET_CHAT_ID,

          max_api:
            MAX_API,

          endpoints: [
            "/check",
            "/webhook",
            "/setup-webhook",
            "/subscriptions",
            "/rss",
            "/models",
            "/gemini-test",
            "/qwen-test",
            "/max-test",
            "/updates",
            "/chat-ids",
            "/chat-test?chat_id=...",
            "/publish-test?chat_id=...",
            "/pipeline",
            "/run"
          ]
        });
      }

      /*
       * ======================================================
       * /webhook
       * ======================================================
       */

      if (
        path === "/webhook" &&
        request.method === "POST"
      ) {
        if (
          !webhookSecretValid(
            request
          )
        ) {
          return json(
            {
              ok: false,

              error:
                "Invalid webhook secret"
            },

            401
          );
        }

        let payload;

        try {
          payload =
            await request.json();

        } catch {
          return json(
            {
              ok: false,

              error:
                "Invalid JSON"
            },

            400
          );
        }

        const processed =
          await processMaxWebhookPayload(
            payload
          );

        console.log(
          "[MAX WEBHOOK]",

          JSON.stringify(
            processed
          )
        );

        return json({
          ok: true,

          received:
            processed.received,

          saved_chat_ids:
            processed.saved,

          removed_chat_ids:
            processed.removed
        });
      }

      /*
       * ======================================================
       * /setup-webhook
       * ======================================================
       */

      if (
        path === "/setup-webhook" &&
        (
          request.method === "GET" ||
          request.method === "POST"
        )
      ) {
        const setup =
          await ensureMaxWebhook(
            request,
            true
          );

        return json(
          {
            ok:
              setup.ok,

            provider:
              "MAX",

            endpoint:
              "/subscriptions",

            webhook:
              setup
          },

          setup.ok
            ? 200
            : 503
        );
      }

      /*
       * ======================================================
       * /subscriptions
       * ======================================================
       */

      if (
        path === "/subscriptions" &&
        request.method === "GET"
      ) {
        const result =
          await getMaxSubscriptions();

        return json(
          {
            ok:
              result.ok,

            provider:
              "MAX",

            endpoint:
              "/subscriptions",

            http_status:
              result.status,

            response:
              result.data,

            error:
              result.error_message ||
              null
          },

          result.ok
            ? 200
            : 503
        );
      }

      /*
       * ======================================================
       * /check
       * ======================================================
       */

      if (
        path === "/check" &&
        request.method ===
          "GET"
      ) {
        const result = {
          ok: true,

          service:
            "MAX NEWS AGENT",

          runtime:
            "Deno Deploy",

          time:
            new Date().toISOString(),

          max_api:
            MAX_API,

          tls: {
            ca_loaded:
              maxCaStatus.loaded,

            root_ca_loaded:
              maxCaStatus.root,

            sub_ca_loaded:
              maxCaStatus.sub,

            error:
              maxCaStatus.error
          },

          checks: {
            max: {
              configured:
                !!MAX_BOT_TOKEN
            },

            gemini: {
              configured:
                !!GEMINI_API_KEY
            },

            qwen: {
              configured:
                !!QWEN_API_KEY
            }
          }
        };

        /*
         * MAX
         */

        if (
          MAX_BOT_TOKEN
        ) {
          const test =
            await maxRequest(
              "/me",

              {
                method:
                  "GET"
              }
            );

          result.checks.max.api = {
            ok:
              test.ok,

            http_status:
              test.status,

            status_text:
              test.statusText ||
              null,

            error_type:
              test.error_type ||
              null,

            error_name:
              test.error_name ||
              null,

            error_message:
              test.error_message ||
              null,

            response:
              test.ok
                ? test.data
                : null
          };
        }

        if (
          MAX_BOT_TOKEN
        ) {
          const webhook =
            await ensureMaxWebhook(
              request
            );

          result.webhook =
            webhook;
        }

        /*
         * GEMINI
         */

        if (
          GEMINI_API_KEY
        ) {
          const models =
            await discoverGeminiModels();

          result.checks.gemini.api = {
            ok:
              models.length > 0,

            discovered_models:
              models.slice(
                0,
                20
              )
          };
        }

        /*
         * QWEN
         */

        if (
          QWEN_API_KEY
        ) {
          const models =
            await discoverQwenModels();

          result.checks.qwen.api = {
            ok:
              models.length > 0,

            discovered_models:
              models.slice(
                0,
                20
              )
          };
        }

        result.ok = !!(
          result.checks.max
            .configured &&
          result.checks.max
            .api?.ok
        );

        return json(
          result,

          result.ok
            ? 200
            : 503
        );
      }

      /*
       * ======================================================
       * /rss
       * ======================================================
       */

      if (
        path === "/rss" &&
        request.method ===
          "GET"
      ) {
        const feeds =
          await fetchRSS();

        const total =
          feeds.reduce(
            (sum, feed) =>
              sum +
              (feed.count ||
                0),
            0
          );

        return json({
          ok: true,

          total_items:
            total,

          feeds
        });
      }

      /*
       * ======================================================
       * /models
       * ======================================================
       */

      if (
        path === "/models" &&
        request.method ===
          "GET"
      ) {
        const gemini =
          await discoverGeminiModels();

        const qwen =
          await discoverQwenModels();

        return json({
          ok: true,

          configured: {
            gemini:
              GEMINI_MODELS,

            qwen:
              QWEN_MODELS
          },

          discovered: {
            gemini,
            qwen
          },

          fallback_order: [
            "Gemini configured/discovered models",
            "Qwen configured/discovered models"
          ]
        });
      }

      /*
       * ======================================================
       * /gemini-test
       * ======================================================
       */

      if (
        path ===
          "/gemini-test" &&
        request.method ===
          "GET"
      ) {
        const prompt =
          url.searchParams.get(
            "prompt"
          ) ||
          "Ответь одним словом: OK";

        if (
          !GEMINI_API_KEY
        ) {
          return json(
            {
              ok: false,

              provider:
                "Google Gemini",

              error:
                "GEMINI_API_KEY не настроен"
            },

            503
          );
        }

        const result =
          await generateWithFallback(
            prompt
          );

        return json({
          ok:
            result.ok,

          provider:
            result.provider ||
            null,

          model:
            result.model ||
            null,

          response:
            result.text ||
            null,

          attempts:
            result.attempts ||
            [],

          error:
            result.error ||
            null
        });
      }

      /*
       * ======================================================
       * /qwen-test
       * ======================================================
       */

      if (
        path ===
          "/qwen-test" &&
        request.method ===
          "GET"
      ) {
        const prompt =
          url.searchParams.get(
            "prompt"
          ) ||
          "Ответь одним словом: OK";

        if (
          !QWEN_API_KEY
        ) {
          return json(
            {
              ok: false,

              provider:
                "Alibaba Qwen",

              error:
                "QWEN_API_KEY не настроен"
            },

            503
          );
        }

        const models =
          uniqueModels(
            QWEN_MODELS,
            await discoverQwenModels()
          );

        const results = [];

        for (
          const model
          of models.slice(
            0,
            10
          )
        ) {
          const result =
            await generateQwen(
              model,
              prompt
            );

          results.push({
            model,

            ok:
              result.ok,

            status:
              result.status,

            response:
              extractQwenText(
                result.data
              ),

            error:
              result.error_message ||
              null
          });

          if (
            result.ok &&
            extractQwenText(
              result.data
            )
          ) {
            break;
          }
        }

        return json({
          ok:
            results.some(
              (item) =>
                item.ok
            ),

          provider:
            "Alibaba Qwen",

          results
        });
      }

      /*
       * ======================================================
       * /max-test
       * ======================================================
       */

      if (
        path ===
          "/max-test" &&
        request.method ===
          "GET"
      ) {
        if (
          !MAX_BOT_TOKEN
        ) {
          return json(
            {
              ok: false,

              provider:
                "MAX",

              error:
                "MAX_BOT_TOKEN не настроен"
            },

            503
          );
        }

        const result =
          await maxRequest(
            "/me",

            {
              method:
                "GET"
            }
          );

        return json({
          ok:
            result.ok,

          provider:
            "MAX",

          endpoint:
            "/me",

          http_status:
            result.status,

          status_text:
            result.statusText ||
            null,

          error_type:
            result.error_type ||
            null,

          error_name:
            result.error_name ||
            null,

          error_message:
            result.error_message ||
            null,

          response:
            result.data
        });
      }

      /*
       * ======================================================
       * /updates
       * ======================================================
       */

      if (
        path ===
          "/updates" &&
        request.method ===
          "GET"
      ) {
        const marker =
          url.searchParams.get(
            "marker"
          );

        const limit =
          url.searchParams.get(
            "limit"
          );

        const timeout =
          url.searchParams.get(
            "timeout"
          );

        const params =
          new URLSearchParams();

        if (
          marker
        ) {
          params.set(
            "marker",
            marker
          );
        }

        if (
          limit
        ) {
          params.set(
            "limit",
            limit
          );
        }

        if (
          timeout
        ) {
          params.set(
            "timeout",
            timeout
          );
        }

        const types =
          url.searchParams.get(
            "types"
          );

        if (
          types
        ) {
          params.set(
            "types",
            types
          );
        }

        const result =
          await maxRequest(
            `/updates?${params.toString()}`,

            {
              method:
                "GET"
            }
          );

        return json({
          ok:
            result.ok,

          provider:
            "MAX",

          endpoint:
            "/updates",

          http_status:
            result.status,

          response:
            result.data
        });
      }

      /*
       * ======================================================
       * /chat-ids
       * ======================================================
       */

      if (
        path ===
          "/chat-ids" &&
        request.method ===
          "GET"
      ) {
        const stored =
          await getStoredMaxChatIds();

        const setup =
          MAX_BOT_TOKEN
            ? await ensureMaxWebhook(
                request
              )
            : null;

        return json({
          ok: true,

          provider:
            "MAX",

          endpoint:
            "/chat-ids",

          chat_ids:
            stored.map(
              (item) =>
                item.chat_id
            ),

          chats:
            stored,

          source:
            "Deno KV + Webhook",

          webhook:
            setup,

          message:
            stored.length
              ? "Chat ID найдены и сохранены автоматически."
              : "Chat ID пока не найдены. После события bot_added/bot_started/message_created Webhook сохранит их автоматически."
        });
      }

      /*
       * ======================================================
       * /chat-test
       * ======================================================
       */

      if (
        path ===
          "/chat-test" &&
        request.method ===
          "GET"
      ) {
        const chatId =
          url.searchParams.get(
            "chat_id"
          );

        if (!chatId) {
          return json(
            {
              ok: false,

              error:
                "Не указан chat_id.",

              usage:
                "/chat-test?chat_id=123456789"
            },

            400
          );
        }

        const result =
          await maxRequest(
            `/chats/${encodeURIComponent(
              chatId
            )}`,

            {
              method:
                "GET"
            }
          );

        return json({
          ok:
            result.ok,

          provider:
            "MAX",

          endpoint:
            `/chats/${chatId}`,

          http_status:
            result.status,

          response:
            result.data,

          error:
            result.error_message ||
            null
        });
      }

      /*
       * ======================================================
       * /publish-test
       * ======================================================
       */

      if (
        path ===
          "/publish-test" &&
        request.method ===
          "GET"
      ) {
        const chatId =
          url.searchParams.get(
            "chat_id"
          );

        if (!chatId) {
          return json(
            {
              ok: false,

              error:
                "Не указан chat_id.",

              usage:
                "/publish-test?chat_id=123456789"
            },

            400
          );
        }

        const text =
          url.searchParams.get(
            "text"
          ) ||
          "Тестовая публикация MAX NEWS AGENT.";

        const result =
          await publishToMax(
            chatId,
            text
          );

        return json({
          ok:
            result.ok,

          provider:
            "MAX",

          endpoint:
            "/messages",

          chat_id:
            chatId,

          http_status:
            result.status,

          response:
            result.data,

          error:
            result.error_message ||
            null
        });
      }

      /*
       * ======================================================
       * /pipeline
       * ======================================================
       */

      if (
        path ===
          "/pipeline" &&
        request.method ===
          "GET"
      ) {
        const result =
          await runPipeline();

        return json(
          result,

          result.ok
            ? 200
            : 503
        );
      }

      /*
       * ======================================================
       * /run
       * ======================================================
       */

      if (
        path ===
          "/run" &&
        (
          request.method ===
            "GET" ||
          request.method ===
            "POST"
        )
      ) {
        const result =
          await runPipeline();

        return json(
          result,

          result.ok
            ? 200
            : 503
        );
      }

      /*
       * ======================================================
       * 404
       * ======================================================
       */

      return json(
        {
          ok: false,

          error:
            "Endpoint not found",

          path
        },

        404
      );

    } catch (error) {
      console.error(
        "[SERVER ERROR]",
        error
      );

      return json(
        {
          ok: false,

          error:
            error?.message ||
            String(error),

          error_name:
            error?.name ||
            null
        },

        500
      );
    }
  }
);
