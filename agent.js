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

const GEMINI_MODELS = parseList(
  Deno.env.get("GEMINI_MODELS") ||
    "gemini-3.8-flash,gemini-2.5-flash"
);

const QWEN_MODELS = parseList(
  Deno.env.get("QWEN_MODELS") ||
    "qwen3.8-flash,qwen3.7-plus,qwen3.6-flash,qwen-plus"
);

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

const PUBLIC_BASE_URL =
  (Deno.env.get("PUBLIC_BASE_URL") || "")
    .replace(/\/$/, "");

const MAX_WEBHOOK_SECRET =
  Deno.env.get("MAX_WEBHOOK_SECRET") ||
  (MAX_BOT_TOKEN
    ? `factor-${MAX_BOT_TOKEN.slice(0, 24)}`
    : "");

const AUTO_WEBHOOK =
  (Deno.env.get("AUTO_WEBHOOK") || "true")
    .toLowerCase() === "true";

const MAX_NEWS_PER_RUN =
  numberEnv("MAX_NEWS_PER_RUN", 1);

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

const RSS_FEEDS = [
  "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"
];

const recentPublished = new Map();

let discoveredGeminiModels = null;
let discoveredQwenModels = null;

let kv = null;

try {
  kv = await Deno.openKv();
} catch (error) {
  console.error(
    "Deno KV unavailable:",
    error?.message || String(error)
  );
}

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

async function initMaxHttpClient() {
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
          method: "GET",
          signal:
            AbortSignal.timeout(10000)
        }
      );

    if (!rootResponse.ok) {
      throw new Error(
        `MAX root CA download failed: HTTP ${rootResponse.status}`
      );
    }

    const rootCa =
      await rootResponse.text();

    maxCaStatus.root = true;

    const subResponse =
      await fetch(
        MAX_SUB_CA_URL,
        {
          method: "GET",
          signal:
            AbortSignal.timeout(10000)
        }
      );

    if (!subResponse.ok) {
      throw new Error(
        `MAX sub CA download failed: HTTP ${subResponse.status}`
      );
    }

    const subCa =
      await subResponse.text();

    maxCaStatus.sub = true;

    maxHttpClient =
      Deno.createHttpClient({
        caCerts: [
          rootCa,
          subCa
        ]
      });

    maxCaStatus.loaded = true;
    maxCaStatus.error = null;

    console.log(
      "[MAX TLS] Russian Trusted CA loaded successfully"
    );

    return maxHttpClient;

  } catch (error) {
    maxHttpClientError =
      error?.message ||
      String(error);

    maxCaStatus.error =
      maxHttpClientError;

    console.error(
      "[MAX TLS] Failed to load CA certificates:",
      maxHttpClientError
    );

    return null;
  }
}

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
    status: response.status,
    statusText:
      response.statusText || "",
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

  const useMaxClient =
    config.useMaxClient === true;

  let last = {
    ok: false,
    status: 599,
    statusText:
      "No HTTP response",
    data: {
      error:
        "request failed before receiving a response"
    },
    error_type:
      "unknown"
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
      const requestOptions = {
        ...options,
        signal:
          controller.signal
      };

      if (useMaxClient) {
        const client =
          await initMaxHttpClient();

        if (client) {
          requestOptions.client =
            client;
        }
      }

      const response =
        await fetch(
          url,
          requestOptions
        );

      const result =
        await readJson(
          response
        );

      last = {
        ...result,

        error_type:
          result.ok
            ? null
            : "http"
      };

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
      const isTimeout =
        error?.name ===
        "AbortError";

      last = {
        ok: false,

        status:
          isTimeout
            ? 504
            : 599,

        statusText:
          isTimeout
            ? "Gateway Timeout"
            : "Network Error",

        data: {
          error:
            isTimeout
              ? "Request timeout"
              : error?.message ||
                String(error)
        },

        error_type:
          isTimeout
            ? "timeout"
            : "network",

        error_name:
          error?.name ||
          "Error",

        error_message:
          error?.message ||
          String(error),

        url
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
        method:
          "GET"
      }
    );

  if (!result.ok) {
    discoveredGeminiModels =
      [];

    return [];
  }

  discoveredGeminiModels =
    (
      Array.isArray(
        result.data?.models
      )
        ? result.data.models
        : []
    )
      .filter(
        (model) =>
          !Array.isArray(
            model?.supportedGenerationMethods
          ) ||
          model.supportedGenerationMethods.includes(
            "generateContent"
          )
      )
      .map(
        (model) =>
          String(
            model?.name ||
              ""
          ).replace(
            /^models\//,
            ""
          )
      )
      .filter(Boolean);

  return discoveredGeminiModels;
}

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
        method:
          "GET",

        headers: {
          Authorization:
            `Bearer ${QWEN_API_KEY}`,

          Accept:
            "application/json"
        }
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

function uniqueModels(
  primary,
  discovered,
  limit = 30
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

async function geminiGenerate(
  model,
  prompt
) {
  requireSecret(
    GEMINI_API_KEY,
    "GEMINI_API_KEY"
  );

  return fetchJson(
    `${GEMINI_BASE}/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`,

    {
      method:
        "POST",

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
            temperature:
              0.2,

            maxOutputTokens:
              1200
          }
        })
    }
  );
}

async function qwenGenerate(
  model,
  prompt
) {
  requireSecret(
    QWEN_API_KEY,
    "QWEN_API_KEY"
  );

  return fetchJson(
    QWEN_API,

    {
      method:
        "POST",

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
                "system",

              content:
                "Ты редактор новостного канала. Пиши быстро, ясно и фактически. Не выдумывай факты, не используй агитацию и не приписывай людям мотивы без источника."
            },

            {
              role:
                "user",

              content:
                prompt
            }
          ],

          stream:
            false
        })
    }
  );
}

async function generateWithFallback(
  prompt
) {
  const attempts =
    [];

  const geminiModels =
    uniqueModels(
      GEMINI_MODELS,
      await discoverGeminiModels()
    );

  const qwenModels =
    uniqueModels(
      QWEN_MODELS,
      await discoverQwenModels()
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

      const text =
        extractGeminiText(
          result.data
        );

      attempts.push({
        provider:
          "Google Gemini",

        model,

        http_status:
          result.status,

        ok:
          result.ok,

        error:
          result.data?.error ||
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

      const text =
        extractQwenText(
          result.data
        );

      attempts.push({
        provider:
          "Alibaba Qwen",

        model,

        http_status:
          result.status,

        ok:
          result.ok,

        error:
          result.data?.error ||
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
    xml.match(
      regex
    );

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
                retries:
                  1,

                timeoutMs:
                  15000
              }
            );

          if (!result.ok) {
            return {
              feed,

              ok:
                false,

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

              ok:
                false,

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

            ok:
              true,

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

function buildAnalysisPrompt(
  item
) {
  return `
Ты редактор новостного канала ФАКТОР.

Стиль подачи — как живая новостная лента «прямой эфир»:
событие появляется сразу;
главное — в первых словах;
короткие абзацы;
быстрый темп;
минимум лишних объяснений.

НОВОСТЬ:

ЗАГОЛОВОК:
${item.title}

ДАТА:
${item.pubDate || "не указана"}

ОПИСАНИЕ:
${item.description || "нет"}

ССЫЛКА:
${item.link || "нет"}

Правила:

1. Начни с короткой метки только если она оправдана фактами:
⚡ СРОЧНО
🔴 ВАЖНО
🟠 ВНИМАНИЕ

Если срочность не подтверждена — никакой метки.

2. Первое предложение должно сразу сообщать главное событие.

3. Используй 2–4 коротких абзаца.

4. Общий объём:
450–900 знаков.

5. Используй 1–3 уместных эмодзи.
Не превращай текст в россыпь эмодзи.

6. После главного факта дай контекст:
кто, где, когда и что известно.

7. Если информация предварительная,
используй:
«по предварительным данным»,
«сообщается»,
«данные уточняются».

8. Ничего не выдумывай:
цифры,
причины,
мотивы,
цитаты,
последствия.

9. Для политики и спорных тем сохраняй нейтральность.
Не агитируй и не оценивай политический выбор.

10. Не используй:
«шокирующая новость»,
«все в ужасе»,
«сенсация»,
«это конец»,
«власти скрывают»,
если такие утверждения не подтверждены источником.

11. В конце отдельной строкой:

Источник: ${item.link || "ссылка не указана"}

12. Не используй Markdown-таблицы.

Верни только готовый текст поста.
`.trim();
}

function newsKey(
  item
) {
  return (
    item.link ||
    `${item.title}|${item.pubDate || ""}`
  );
}

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
      method:
        "POST",

      body:
        JSON.stringify({
          text
        })
    }
  );
}

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
      newsKey(
        item
      );

    if (
      recentPublished.has(
        key
      )
    ) {
      results.push({
        ok: true,

        skipped:
          true,

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

      skipped:
        true,

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
          publishResult.data,

        error:
          publishResult.error_message ||
          null
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

async function kvGetChats() {
  const ids =
    new Set();

  if (TARGET_CHAT_ID) {
    ids.add(
      String(
        TARGET_CHAT_ID
      )
    );
  }

  if (!kv) {
    return [
      ...ids
    ].filter(Boolean);
  }

  try {
    for await (
      const entry
      of kv.list({
        prefix: [
          "max-chat"
        ]
      })
    ) {
      const id =
        entry.value?.chat_id ??
        entry.key?.[1] ??
        "";

      if (id !== "") {
        ids.add(
          String(id)
        );
      }
    }
  } catch (error) {
    console.error(
      "KV read chats:",
      error?.message ||
        String(error)
    );
  }

  return [
    ...ids
  ].filter(Boolean);
}

async function kvSaveChat(
  update
) {
  const chatId =
    update?.chat_id ??
    update?.chat?.chat_id ??
    update?.message?.chat_id ??
    update?.message?.chat?.chat_id;

  if (
    chatId ===
      undefined ||
    chatId ===
      null ||
    !kv
  ) {
    return null;
  }

  const id =
    String(chatId);

  try {
    await kv.set(
      [
        "max-chat",
        id
      ],

      {
        chat_id:
          id,

        update_type:
          update?.update_type ||
          null,

        is_channel:
          update?.is_channel ??
          null,

        updated_at:
          new Date().toISOString()
      }
    );

    return id;

  } catch (error) {
    console.error(
      "KV save chat:",
      error?.message ||
        String(error)
    );

    return null;
  }
}

async function kvDeleteChat(
  update
) {
  const chatId =
    update?.chat_id ??
    update?.chat?.chat_id ??
    update?.message?.chat_id ??
    update?.message?.chat?.chat_id;

  if (
    chatId ===
      undefined ||
    chatId ===
      null ||
    !kv
  ) {
    return;
  }

  try {
    await kv.delete([
      "max-chat",
      String(chatId)
    ]);
  } catch (error) {
    console.error(
      "KV delete chat:",
      error?.message ||
        String(error)
    );
  }
}

function deriveWebhookUrl(
  request = null
) {
  if (PUBLIC_BASE_URL) {
    return `${PUBLIC_BASE_URL}/webhook`;
  }

  if (request) {
    return `${
      new URL(
        request.url
      ).origin
    }/webhook`;
  }

  return "";
}

async function handleWebhook(
  request
) {
  if (
    MAX_WEBHOOK_SECRET &&
    request.headers.get(
      "X-Max-Bot-Api-Secret"
    ) !==
      MAX_WEBHOOK_SECRET
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

  let update;

  try {
    update =
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

  const type =
    update?.update_type ||
    "unknown";

  if (
    [
      "bot_started",
      "bot_added",
      "message_created",
      "chat_title_changed",
      "user_added",
      "bot_admin_permissions_changed",
      "message_callback"
    ].includes(
      type
    )
  ) {
    await kvSaveChat(
      update
    );
  }

  if (
    [
      "bot_removed",
      "bot_stopped",
      "dialog_removed"
    ].includes(
      type
    )
  ) {
    await kvDeleteChat(
      update
    );
  }

  console.log(
    "[MAX WEBHOOK]",
    JSON.stringify({
      update_type:
        type,

      chat_id:
        update?.chat_id ??
        update?.chat?.chat_id ??
        update?.message?.chat_id ??
        update?.message?.chat?.chat_id ??
        null,

      timestamp:
        update?.timestamp ??
        null
    })
  );

  return json({
    ok: true
  });
}

async function setupWebhook(
  request = null
) {
  requireSecret(
    MAX_BOT_TOKEN,
    "MAX_BOT_TOKEN"
  );

  const webhookUrl =
    deriveWebhookUrl(
      request
    );

  if (!webhookUrl) {
    return {
      ok: false,

      error:
        "PUBLIC_BASE_URL не настроен. Укажите полный URL Deno Deploy без /webhook.",

      webhook_url:
        null
    };
  }

  if (
    !webhookUrl.startsWith(
      "https://"
    )
  ) {
    return {
      ok: false,

      error:
        "Webhook URL должен быть HTTPS",

      webhook_url:
        webhookUrl
    };
  }

  const result =
    await maxRequest(
      "/subscriptions",

      {
        method:
          "POST",

        body:
          JSON.stringify({
            url:
              webhookUrl,

            update_types: [
              "bot_started",
              "bot_added",
              "message_created",
              "bot_removed",
              "bot_stopped",
              "dialog_removed",
              "chat_title_changed",
              "user_added",
              "bot_admin_permissions_changed",
              "message_callback"
            ],

            secret:
              MAX_WEBHOOK_SECRET
          })
      }
    );

  return {
    ok:
      result.ok,

    provider:
      "MAX",

    endpoint:
      "/subscriptions",

    webhook_url:
      webhookUrl,

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
  };
}

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

      if (
        AUTO_WEBHOOK
      ) {
        const webhook =
          await setupWebhook();

        console.log(
          "[CRON] Webhook setup:",
          JSON.stringify(
            webhook
          )
        );
      }

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
      if (
        path ===
          "/webhook" &&
        request.method ===
          "POST"
      ) {
        return await handleWebhook(
          request
        );
      }

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

          auto_webhook:
            AUTO_WEBHOOK,

          cron_schedule:
            AUTO_PIPELINE
              ? CRON_SCHEDULE
              : null,

          target_chat_configured:
            !!TARGET_CHAT_ID,

          stored_chat_ids:
            await kvGetChats(),

          webhook_url:
            deriveWebhookUrl(
              request
            ),

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

          endpoints: [
            "/check",
            "/rss",
            "/models",
            "/gemini-test",
            "/qwen-test",
            "/max-test",
            "/updates",
            "/chat-ids",
            "/subscriptions",
            "/setup-webhook",
            "/webhook",
            "/chat-test?chat_id=...",
            "/publish-test?chat_id=...",
            "/pipeline",
            "/run"
          ]
        });
      }

      if (
        path ===
          "/check" &&
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
            },

            webhook: {
              configured:
                !!MAX_WEBHOOK_SECRET,

              auto:
                AUTO_WEBHOOK,

              url:
                deriveWebhookUrl(
                  request
                )
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
              test.data
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

        result.ok =
          !!(
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
              (
                feed.count ||
                0
              ),

            0
          );

        return json({
          ok: true,

          total_items:
            total,

          feeds
        });
      }

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

            http_status:
              result.status,

            ok:
              result.ok,

            response:
              result.ok
                ? extractQwenText(
                    result.data
                  )
                : null,

            error:
              result.data?.error ||
              result.error_message ||
              null
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

      if (
        path ===
          "/chat-ids" &&
        request.method ===
          "GET"
      ) {
        const stored =
          await kvGetChats();

        return json({
          ok: true,

          provider:
            "MAX",

          endpoint:
            "/chat-ids",

          chat_ids:
            stored,

          source:
            "Deno KV + TARGET_CHAT_ID",

          message:
            stored.length
              ? "Chat ID найдены."
              : "Chat ID пока не найдены. Запустите бота/добавьте его в чат или канал после настройки Webhook."
        });
      }

      if (
        path === "/subscriptions" &&
        request.method === "GET"
      ) {
        const result =
          await maxRequest(
            "/subscriptions",
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
            "/subscriptions",

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
            result.data,

          webhook_url:
            deriveWebhookUrl(
              request
            )
        });
      }

      if (
        path === "/setup-webhook" &&
        (
          request.method === "GET" ||
          request.method === "POST"
        )
      ) {
        const result =
          await setupWebhook(
            request
          );

        return json(
          result,

          result.ok
            ? 200
            : 503
        );
      }

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
            result.data,

          error:
            result.error_message ||
            null
        });
      }

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
        "MAX NEWS AGENT ERROR:",
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
            "Error"
        },

        500
      );
    }
  }
);
