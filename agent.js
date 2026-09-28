const MAX_API = "https://platform-api2.max.ru";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

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
 *
 * Можно задать свои модели через:
 *
 * GEMINI_MODELS
 * QWEN_MODELS
 *
 * Формат:
 * model1,model2,model3
 *
 * Код также пытается автоматически получить список
 * доступных моделей у провайдера.
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
          "Content-Type, Authorization"
      }
    }
  );
}

/*
 * ============================================================
 * HTTP JSON
 * ============================================================
 */

async function readJson(response) {
  const text =
    await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
  } catch {
    data = {
      raw: text
    };
  }

  return {
    ok: response.ok,

    status:
      response.status,

    data,

    headers:
      response.headers
  };
}

async function fetchJson(
  url,
  options = {},
  config = {}
) {
  const retries =
    config.retries ?? RETRIES;

  const timeoutMs =
    config.timeoutMs ??
    REQUEST_TIMEOUT_MS;

  let last = {
    ok: false,

    status: 599,

    data: {
      error:
        "request failed before receiving a response"
    }
  };

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          url,
          {
            ...options,

            signal:
              controller.signal
          }
        );

      const result =
        await readJson(
          response
        );

      last = result;

      if (result.ok) {
        return result;
      }

      if (
        !isRetryableStatus(
          result.status
        )
      ) {
        return result;
      }

      if (
        attempt < retries
      ) {
        await sleep(
          retryDelay(
            attempt,

            response.headers.get(
              "Retry-After"
            )
          )
        );
      }
    } catch (error) {
      last = {
        ok: false,

        status:
          error?.name ===
          "AbortError"
            ? 504
            : 599,

        data: {
          error:
            error?.name ===
            "AbortError"
              ? "Request timeout"
              : error?.message ||
                String(error)
        }
      };

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
          MAX_BOT_TOKEN,

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
      .filter(
        (model) =>
          Array.isArray(
            model
              ?.supportedGenerationMethods
          )
            ? model.supportedGenerationMethods.includes(
                "generateContent"
              )
            : true
      )
      .map(
        (model) =>
          String(
            model.name || ""
          ).replace(
            /^models\//,
            ""
          )
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

  const base =
    QWEN_API.replace(
      /\/chat\/completions\/?$/,
      ""
    );

  const result =
    await fetchJson(
      `${base}/models`,

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

  const raw =
    Array.isArray(
      result.data?.data
    )
      ? result.data.data
      : Array.isArray(
          result.data?.models
        )
        ? result.data.models
        : [];

  discoveredQwenModels =
    raw
      .map(
        (model) =>
          String(
            model?.id ||
              model?.name ||
              ""
          ).trim()
      )
      .filter(Boolean);

  return discoveredQwenModels;
}

/*
 * ============================================================
 * UNIQUE MODEL LIST
 * ============================================================
 */

function uniqueModels(
  primary,
  discovered,
  limit = 12
) {
  return [
    ...new Set([
      ...primary,
      ...discovered
    ])
  ].slice(
    0,
    limit
  );
}

/*
 * ============================================================
 * GEMINI GENERATION
 * ============================================================
 */

async function geminiGenerate(
  model,
  prompt
) {
  requireSecret(
    GEMINI_API_KEY,
    "GEMINI_API_KEY"
  );

  return await fetchJson(
    `${GEMINI_BASE}/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`,

    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],

        generationConfig: {
          temperature: 0.2,

          maxOutputTokens:
            1200
        }
      })
    }
  );
}

/*
 * ============================================================
 * QWEN GENERATION
 * ============================================================
 */

async function qwenGenerate(
  model,
  prompt
) {
  requireSecret(
    QWEN_API_KEY,
    "QWEN_API_KEY"
  );

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

      body: JSON.stringify({
        model,

        messages: [
          {
            role: "system",

            content:
              "Ты аналитик новостей. Отвечай кратко, фактически и не выдумывай факты."
          },

          {
            role: "user",

            content:
              prompt
          }
        ],

        stream: false
      })
    }
  );
}

/*
 * ============================================================
 * UNIVERSAL AI FALLBACK
 * ============================================================
 */

async function generateWithFallback(
  prompt
) {
  const attempts = [];

  const geminiDiscovered =
    await discoverGeminiModels();

  const qwenDiscovered =
    await discoverQwenModels();

  const geminiModels =
    uniqueModels(
      GEMINI_MODELS,
      geminiDiscovered
    );

  const qwenModels =
    uniqueModels(
      QWEN_MODELS,
      qwenDiscovered
    );

  for (
    const model
    of geminiModels
  ) {
    try {
      const result =
        await geminiGenerate(
          model,
          prompt
        );

      attempts.push({
        provider:
          "Google Gemini",

        model,

        http_status:
          result.status,

        ok:
          result.ok
      });

      const text =
        extractGeminiText(
          result.data
        );

      if (
        result.ok &&
        text
      ) {
        return {
          ok: true,

          provider:
            "Google Gemini",

          model,

          text,

          attempts
        };
      }
    } catch (error) {
      attempts.push({
        provider:
          "Google Gemini",

        model,

        ok: false,

        error:
          error?.message ||
          String(error)
      });
    }
  }

  for (
    const model
    of qwenModels
  ) {
    try {
      const result =
        await qwenGenerate(
          model,
          prompt
        );

      attempts.push({
        provider:
          "Alibaba Qwen",

        model,

        http_status:
          result.status,

        ok:
          result.ok
      });

      const text =
        extractQwenText(
          result.data
        );

      if (
        result.ok &&
        text
      ) {
        return {
          ok: true,

          provider:
            "Alibaba Qwen",

          model,

          text,

          attempts
        };
      }
    } catch (error) {
      attempts.push({
        provider:
          "Alibaba Qwen",

        model,

        ok: false,

        error:
          error?.message ||
          String(error)
      });
    }
  }

  return {
    ok: false,

    error:
      "Все доступные AI-модели не ответили успешно.",

    attempts
  };
}

/*
 * ============================================================
 * RSS XML
 * ============================================================
 */

function extractTag(
  xml,
  tag
) {
  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(regex);

  if (!match) {
    return "";
  }

  return match[1]
    .replace(
      /<!\[CDATA\[/g,
      ""
    )
    .replace(
      /\]\]>/g,
      ""
    )
    .replace(
      /<[^>]+>/g,
      ""
    )
    .trim();
}

function extractItems(
  xml
) {
  const items = [];

  const matches =
    xml.match(
      /<item[\s\S]*?<\/item>/gi
    ) || [];

  for (
    const item
    of matches
  ) {
    const title =
      extractTag(
        item,
        "title"
      );

    const link =
      extractTag(
        item,
        "link"
      );

    const description =
      extractTag(
        item,
        "description"
      );

    const pubDate =
      extractTag(
        item,
        "pubDate"
      );

    if (!title) {
      continue;
    }

    items.push({
      title,

      link,

      description,

      pubDate
    });
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
                method: "GET",

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
Проанализируй новость для новостного канала.

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
3. Не используй эмоциональную пропагандистскую лексику.
4. Если данных недостаточно, прямо укажи это.
5. Ответь на русском.
6. Не используй Markdown-таблицы.

Структура ответа:

КРАТКО:
1-2 предложения.

ФАКТЫ:
3-5 пунктов.

ЧТО ВАЖНО:
1-2 предложения.

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
        AUTO_PIPELINE &&
        TARGET_CHAT_ID
          ? "not attempted"
          : "AUTO_PIPELINE=false or TARGET_CHAT_ID is empty"
    };

    if (
      AUTO_PIPELINE &&
      TARGET_CHAT_ID
    ) {
      const publishResult =
        await publishToMax(
          TARGET_CHAT_ID,
          text
        );

      publication = {
        ok:
          publishResult.ok,

        http_status:
          publishResult.status,

        response:
          publishResult.data
      };

      if (
        publishResult.ok
      ) {
        recentPublished.set(
          key,
          Date.now()
        );
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
 * MAX UPDATE HELPERS
 * ============================================================
 */

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
      update &&
      update.chat_id !==
        undefined &&
      update.chat_id !==
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

          endpoints: [
            "/check",

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
              test.status
          };
        }

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

        const attempts = [];

        for (
          const model
          of models
        ) {
          const result =
            await qwenGenerate(
              model,
              prompt
            );

          attempts.push({
            model,

            ok:
              result.ok,

            http_status:
              result.status
          });

          const text =
            extractQwenText(
              result.data
            );

          if (
            result.ok &&
            text
          ) {
            return json({
              ok: true,

              provider:
                "Alibaba Qwen",

              model,

              response:
                text,

              attempts
            });
          }
        }

        return json(
          {
            ok: false,

            provider:
              "Alibaba Qwen",

            attempts
          },

          503
        );
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
        const params =
          new URLSearchParams();

        params.set(
          "limit",

          url.searchParams.get(
            "limit"
          ) ||
            "100"
        );

        params.set(
          "timeout",

          url.searchParams.get(
            "timeout"
          ) ||
            "0"
        );

        const marker =
          url.searchParams.get(
            "marker"
          );

        if (
          marker
        ) {
          params.set(
            "marker",
            marker
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
        const result =
          await maxRequest(
            "/updates?limit=100&timeout=0",

            {
              method:
                "GET"
            }
          );

        const chatIds =
          extractChatIds(
            result.data
          );

        return json({
          ok:
            result.ok,

          provider:
            "MAX",

          endpoint:
            "/chat-ids",

          http_status:
            result.status,

          chat_ids:
            chatIds,

          updates:
            getUpdateSummary(
              result.data
            ),

          message:
            chatIds.length
              ? "Chat ID найдены."
              : "Chat ID пока не найдены.",

          raw:
            result.data
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

          operation:
            "chat-test",

          chat_id:
            chatId,

          http_status:
            result.status,

          response:
            result.data
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
          "ТЕСТ MAX NEWS AGENT\n\nWorker успешно подключён к API MAX.";

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

          operation:
            "publish-test",

          chat_id:
            chatId,

          http_status:
            result.status,

          response:
            result.data
        });
      }

      /*
       * ======================================================
       * /pipeline
       * /run
       * ======================================================
       */

      if (
        (
          path ===
            "/pipeline" ||
          path ===
            "/run"
        ) &&
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
       * UNKNOWN ROUTE
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
      /*
       * ======================================================
       * GLOBAL ERROR HANDLER
       * ======================================================
       */

      console.error(
        "MAX NEWS AGENT ERROR:",

        error
      );

      return json(
        {
          ok: false,

          error:
            error?.message ||
            String(error)
        },

        500
      );
    }
  }
);
