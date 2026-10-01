/*
 * ============================================================
 * MAX NEWS AGENT — FINAL
 * DENO DEPLOY
 *
 * RSS -> AI -> MAX
 *
 * ВАЖНО:
 * - Deno KV НЕ используется
 * - Webhook НЕ влияет на публикацию
 * - TARGET_CHAT_ID используется напрямую
 * - автоматическая публикация каждые 5 минут
 * - Gemini -> Qwen fallback
 * - защита от дублей
 * ============================================================
 */

const MAX_API =
  "https://platform-api2.max.ru";

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta";

const QWEN_API =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";


/*
 * ============================================================
 * ENV
 * ============================================================
 */

const MAX_BOT_TOKEN =
  (Deno.env.get("MAX_BOT_TOKEN") || "").trim();

const GEMINI_API_KEY =
  (Deno.env.get("GEMINI_API_KEY") || "").trim();

const QWEN_API_KEY =
  (Deno.env.get("QWEN_API_KEY") || "").trim();

const TARGET_CHAT_ID =
  (Deno.env.get("TARGET_CHAT_ID") || "").trim();


/*
 * Автопубликация включена по умолчанию.
 *
 * Если понадобится отключить:
 *
 * AUTO_PIPELINE=false
 *
 * Но сейчас оставляем true.
 */

const AUTO_PIPELINE =
  (
    Deno.env.get("AUTO_PIPELINE") ||
    "true"
  ).toLowerCase() === "true";


/*
 * Каждые 5 минут.
 */

const CRON_SCHEDULE =
  Deno.env.get("CRON_SCHEDULE") ||
  "*/5 * * * *";


/*
 * Сколько новостей публиковать за один запуск.
 *
 * 1 = безопасный режим.
 */

const MAX_NEWS_PER_RUN =
  numberEnv(
    "MAX_NEWS_PER_RUN",
    1
  );


const RETRIES =
  numberEnv(
    "API_RETRIES",
    2
  );


const REQUEST_TIMEOUT_MS =
  numberEnv(
    "API_TIMEOUT_MS",
    20000
  );


/*
 * ============================================================
 * AI MODELS
 * ============================================================
 */

const GEMINI_MODELS =
  parseList(
    Deno.env.get(
      "GEMINI_MODELS"
    ) ||
    [
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gemini-2.5-flash-lite",
      "gemini-3-flash-preview"
    ].join(",")
  );


const QWEN_MODELS =
  parseList(
    Deno.env.get(
      "QWEN_MODELS"
    ) ||
    [
      "qwen3.8-flash",
      "qwen3.8-max",
      "qwen3.8-max-0902",
      "qwen3.8-27b",
      "qwen3.7-plus",
      "qwen-plus"
    ].join(",")
  );


/*
 * ============================================================
 * MAX TLS
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
 * RSS
 * ============================================================
 */

const RSS_FEEDS = [

  /*
   * МИР
   */

  "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",

  /*
   * ПОЛИТИКА / ПРАВО
   */

  "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru",

  /*
   * ЭКОНОМИКА / БИЗНЕС
   */

  "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru",

  /*
   * ПРОИСШЕСТВИЯ
   */

  "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru",

  /*
   * ТЕХНОЛОГИИ / ПРОМЫШЛЕННОСТЬ
   */

  "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"
];


/*
 * ============================================================
 * WEBHOOK EVENTS
 * ============================================================
 */

const MAX_WEBHOOK_UPDATE_TYPES = [

  "bot_added",
  "bot_started",
  "bot_stopped",
  "bot_removed",

  "message_created",
  "message_edited",
  "message_removed",

  "user_added",
  "user_removed",

  "chat_title_changed",

  "bot_admin_permissions_changed"
];


/*
 * ============================================================
 * OLD WEBHOOKS
 * ============================================================
 */

const KNOWN_OLD_WEBHOOKS = [

  "https://bogdan15.app.n8n.cloud/webhook-test/m",

  "https://bogdan15.app.n8n.cloud/webhook-test/max-callback",

  "https://bogdan15.app.n8n.cloud/webhook/max-callback"
];


/*
 * ============================================================
 * RUNTIME STATE
 * ============================================================
 */


/*
 * Уже обработанные новости.
 *
 * Работает без Deno KV.
 */

const processedNews =
  new Map();


/*
 * Webhook diagnostics.
 *
 * Храним последние 100 событий
 * в памяти процесса.
 */

const webhookLogs = [];


/*
 * Последний запуск pipeline.
 */

let lastPipelineResult = null;

let lastPipelineStartedAt = null;

let lastPipelineFinishedAt = null;


/*
 * AI model discovery cache.
 */

let discoveredGeminiModels = null;

let discoveredQwenModels = null;


/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function parseList(
  value
) {

  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map(
          x =>
            x.trim()
        )
        .filter(Boolean)
    )
  ];
}


function numberEnv(
  name,
  fallback
) {

  const value =
    Number(
      Deno.env.get(name)
    );

  return (
    Number.isFinite(value) &&
    value > 0
  )
    ? value
    : fallback;
}


function sleep(
  ms
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function isRetryableStatus(
  status
) {

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
    Number(
      retryAfterHeader
    );

  if (
    Number.isFinite(
      retryAfter
    ) &&
    retryAfter >= 0
  ) {

    return Math.min(
      retryAfter * 1000,
      60000
    );
  }

  return (

    Math.min(
      1000 *
      2 ** attempt,
      8000
    )

    +

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
          "GET,POST,OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Max-Bot-Api-Secret"

      }
    }

  );
}


function requireSecret(
  value,
  name
) {

  if (!value) {

    throw new Error(
      `Secret ${name} не настроен`
    );
  }
}


/*
 * ============================================================
 * MAX HTTP CLIENT
 * ============================================================
 */

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

    /*
     * ROOT CA
     */

    const rootResponse =
      await fetch(
        MAX_ROOT_CA_URL,
        {
          method: "GET",
          signal:
            AbortSignal.timeout(
              10000
            )
        }
      );


    if (
      !rootResponse.ok
    ) {

      throw new Error(
        `MAX root CA download failed: HTTP ${rootResponse.status}`
      );
    }


    const rootCa =
      await rootResponse.text();


    maxCaStatus.root =
      true;


    /*
     * SUB CA
     */

    const subResponse =
      await fetch(
        MAX_SUB_CA_URL,
        {
          method: "GET",
          signal:
            AbortSignal.timeout(
              10000
            )
        }
      );


    if (
      !subResponse.ok
    ) {

      throw new Error(
        `MAX sub CA download failed: HTTP ${subResponse.status}`
      );
    }


    const subCa =
      await subResponse.text();


    maxCaStatus.sub =
      true;


    /*
     * DENO HTTP CLIENT
     */

    maxHttpClient =
      Deno.createHttpClient({
        caCerts: [
          rootCa,
          subCa
        ]
      });


    maxCaStatus.loaded =
      true;


    maxCaStatus.error =
      null;


    console.log(
      "[MAX TLS] Russian Trusted CA loaded"
    );


    return maxHttpClient;


  } catch (
    error
  ) {

    maxHttpClientError =
      error?.message ||
      String(error);


    maxCaStatus.error =
      maxHttpClientError;


    console.error(
      "[MAX TLS ERROR]",
      maxHttpClientError
    );


    return null;
  }
}


/*
 * ============================================================
 * HTTP JSON
 * ============================================================
 */

async function readJson(
  response
) {

  const text =
    await response.text();


  let data = null;


  try {

    data =
      text
        ? JSON.parse(text)
        : null;

  } catch {

    data = {
      raw: text
    };
  }


  return {

    ok:
      response.ok,

    status:
      response.status,

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
    config.retries ??
    RETRIES;


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
        "request failed"
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


      /*
       * MAX API
       */

      if (
        useMaxClient
      ) {

        const client =
          await initMaxHttpClient();


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


      if (
        result.ok
      ) {

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


    } catch (
      error
    ) {

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
            error?.message ||
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
        JSON.stringify({

          url,

          attempt,

          error_name:
            error?.name,

          error_message:
            error?.message

        })
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
          }
          : {}),

        ...(options.headers || {})

      }

    },

    {

      useMaxClient:
        true

    }

  );
}


/*
 * ============================================================
 * MAX /ME
 * ============================================================
 */

async function maxMe() {

  return await maxRequest(
    "/me",
    {
      method: "GET"
    }
  );
}


/*
 * ============================================================
 * MAX SUBSCRIPTIONS
 * ============================================================
 */

async function getSubscriptions() {

  return await maxRequest(
    "/subscriptions",
    {
      method: "GET"
    }
  );
}


async function deleteSubscription(
  webhookUrl
) {

  const encoded =
    encodeURIComponent(
      webhookUrl
    );


  return await maxRequest(

    `/subscriptions?url=${encoded}`,

    {
      method: "DELETE"
    }

  );
}


function getWebhookUrl(
  requestUrl
) {

  const current =
    new URL(
      requestUrl
    );


  return (
    `${current.origin}/webhook`
  );
}


/*
 * ============================================================
 * WEBHOOK SECRET
 * ============================================================
 *
 * Если MAX_WEBHOOK_SECRET задан,
 * он используется.
 *
 * Если не задан —
 * Webhook работает без secret.
 *
 * Это соответствует текущей настройке.
 */

const MAX_WEBHOOK_SECRET =
  (
    Deno.env.get(
      "MAX_WEBHOOK_SECRET"
    ) || ""
  ).trim();


/*
 * ============================================================
 * CLEAN WEBHOOKS
 * ============================================================
 */

async function cleanupWebhooks(
  requestUrl
) {

  const currentWebhook =
    getWebhookUrl(
      requestUrl
    );


  const result =
    await getSubscriptions();


  const subscriptions =
    Array.isArray(
      result?.data?.subscriptions
    )
      ? result.data.subscriptions
      : [];


  const candidates =
    new Set(
      KNOWN_OLD_WEBHOOKS
    );


  for (
    const subscription
    of subscriptions
  ) {

    if (
      subscription?.url
    ) {

      candidates.add(
        subscription.url
      );
    }
  }


  const deleted = [];


  for (
    const webhookUrl
    of candidates
  ) {

    if (
      !webhookUrl ||
      webhookUrl ===
        currentWebhook
    ) {

      continue;
    }


    try {

      const deletedResult =
        await deleteSubscription(
          webhookUrl
        );


      deleted.push({

        url:
          webhookUrl,

        ok:
          deletedResult.ok,

        http_status:
          deletedResult.status,

        response:
          deletedResult.data

      });


    } catch (
      error
    ) {

      deleted.push({

        url:
          webhookUrl,

        ok: false,

        error:
          error?.message ||
          String(error)

      });

    }
  }


  return {

    current_webhook:
      currentWebhook,

    subscriptions_before:
      subscriptions,

    discovered_count:
      subscriptions.length,

    deleted

  };
}


/*
 * ============================================================
 * SETUP WEBHOOK
 * ============================================================
 */

async function setupWebhook(
  requestUrl
) {

  requireSecret(
    MAX_BOT_TOKEN,
    "MAX_BOT_TOKEN"
  );


  const webhookUrl =
    getWebhookUrl(
      requestUrl
    );


  const tlsClient =
    await initMaxHttpClient();


  if (
    !tlsClient
  ) {

    return {

      ok: false,

      stage:
        "max_tls",

      webhook_url:
        webhookUrl,

      tls:
        maxCaStatus,

      error:
        maxHttpClientError ||
        "MAX HTTP client не создан"

    };
  }


  /*
   * Удаляем старые.
   */

  const cleanup =
    await cleanupWebhooks(
      requestUrl
    );


  /*
   * Создаём новую подписку.
   */

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


  const created =
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


  /*
   * Проверяем итог.
   */

  const after =
    await getSubscriptions();


  return {

    ok:
      created.ok &&
      after.ok,

    provider:
      "MAX",

    webhook_url:
      webhookUrl,

    tls:
      maxCaStatus,

    webhook_secret:
      !!MAX_WEBHOOK_SECRET,

    update_types:
      MAX_WEBHOOK_UPDATE_TYPES,

    cleanup,

    create: {

      ok:
        created.ok,

      http_status:
        created.status,

      response:
        created.data

    },

    after: {

      ok:
        after.ok,

      http_status:
        after.status,

      response:
        after.data

    }

  };
}


/*
 * ============================================================
 * RSS XML
 * ============================================================
 */

function decodeXml(
  value
) {

  return String(value || "")

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
    );
}


function stripHtml(
  value
) {

  return decodeXml(
    String(value || "")
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


  if (
    !match
  ) {

    return "";
  }


  return stripHtml(
    match[1]
  );
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


    if (
      !title
    ) {

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
        async feed => {

          const result =
            await fetchJson(

              feed,

              {

                method:
                  "GET",

                headers: {

                  "User-Agent":
                    "MAX-News-Agent/Final"

                }

              },

              {

                retries:
                  1,

                timeoutMs:
                  15000

              }

            );


          if (
            !result.ok
          ) {

            return {

              feed,

              ok: false,

              status:
                result.status,

              error:
                result.data?.error ||
                null

            };
          }


          const xml =
            result.data?.raw;


          if (
            typeof xml !==
              "string"
          ) {

            return {

              feed,

              ok: false,

              status:
                result.status,

              error:
                "RSS response is not XML"

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
                20
              )

          };

        }
      )

    );


  return results;
}


/*
 * ============================================================
 * NEWS FLATTEN
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


  /*
   * Сортировка по дате.
   */

  items.sort(
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
        bTime -
        aTime
      );
    }
  );


  /*
   * Удаляем одинаковые ссылки.
   */

  const unique = [];

  const seen =
    new Set();


  for (
    const item
    of items
  ) {

    const key =
      newsKey(
        item
      );


    if (
      seen.has(
        key
      )
    ) {

      continue;
    }


    seen.add(
      key
    );


    unique.push(
      item
    );
  }


  return unique;
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
 * AI
 * ============================================================
 */

function extractGeminiText(
  data
) {

  return (

    data
      ?.candidates?.[0]
      ?.content?.parts
      ?.map(
        part =>
          part?.text || ""
      )
      .join("") ||

    ""

  ).trim();
}


function extractQwenText(
  data
) {

  return (

    data
      ?.choices?.[0]
      ?.message?.content ||

    data
      ?.choices?.[0]
      ?.text ||

    ""

  ).trim();
}


/*
 * ============================================================
 * GEMINI MODELS
 * ============================================================
 */

async function discoverGeminiModels() {

  if (
    !GEMINI_API_KEY
  ) {

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
      },

      {
        retries:
          1
      }

    );


  if (
    !result.ok
  ) {

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
        model =>

          !Array.isArray(
            model?.supportedGenerationMethods
          ) ||

          model
            .supportedGenerationMethods
            .includes(
              "generateContent"
            )
      )

      .map(
        model =>

          String(
            model.name || ""
          )

            .replace(
              /^models\//,
              ""
            )

      )

      .filter(Boolean);


  return discoveredGeminiModels;
}


/*
 * ============================================================
 * QWEN MODELS
 * ============================================================
 */

async function discoverQwenModels() {

  if (
    !QWEN_API_KEY
  ) {

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

      },

      {
        retries:
          1
      }

    );


  if (
    !result.ok
  ) {

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
        model =>
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
 * UNIQUE MODELS
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
 * GEMINI GENERATE
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


/*
 * ============================================================
 * QWEN GENERATE
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
                "Ты аналитик новостей. Отвечай кратко, фактически, нейтрально и не выдумывай факты."

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


/*
 * ============================================================
 * AI FALLBACK
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


  /*
   * GEMINI
   */

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

        has_text:
          !!text,

        error:
          result.data?.error ||
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


    } catch (
      error
    ) {

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


  /*
   * QWEN
   */

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

        has_text:
          !!text,

        error:
          result.data?.error ||
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


    } catch (
      error
    ) {

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
      "Все AI-модели не ответили успешно.",

    attempts

  };
}


/*
 * ============================================================
 * NEWS PROMPT
 * ============================================================
 */

function buildAnalysisPrompt(
  item
) {

  return `

Ты работаешь редактором новостного Telegram/MAX-канала.

Проанализируй материал ниже.

ЗАГОЛОВОК:
${item.title}

ДАТА:
${item.pubDate || "не указана"}

ССЫЛКА:
${item.link || "нет"}

ОПИСАНИЕ:
${item.description || "нет"}

ПРАВИЛА:

1. Не выдумывай факты.
2. Используй только информацию из предоставленного материала.
3. Не приписывай людям слова, которых нет в источнике.
4. Не делай неподтверждённых выводов.
5. Не используй пропагандистскую или истеричную лексику.
6. Пиши по-русски.
7. Текст должен быть пригоден для публикации в новостном канале.
8. Не используй Markdown-таблицы.
9. Не начинай с фразы "В этой новости".
10. Не повторяй заголовок целиком.

СТРУКТУРА:

КРАТКО:
1-2 предложения.

ФАКТЫ:
3-5 коротких пунктов.

ЧТО ВАЖНО:
1-2 предложения.

Не добавляй никаких других разделов.

`.trim();
}


/*
 * ============================================================
 * PUBLISH TO MAX
 * ============================================================
 */

async function publishToMax(
  chatId,
  text
) {

  if (
    !chatId
  ) {

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


/*
 * ============================================================
 * PIPELINE
 * ============================================================
 */

async function runPipeline() {

  const startedAt =
    Date.now();


  lastPipelineStartedAt =
    new Date(
      startedAt
    ).toISOString();


  console.log(
    "[PIPELINE] started"
  );


  if (
    !TARGET_CHAT_ID
  ) {

    return {

      ok: false,

      stage:
        "config",

      error:
        "TARGET_CHAT_ID не задан"

    };
  }


  /*
   * RSS
   */

  const feeds =
    await fetchRSS();


  const news =
    flattenNews(
      feeds
    );


  if (
    !news.length
  ) {

    const result = {

      ok: false,

      stage:
        "rss",

      error:
        "RSS не вернул новостей",

      feeds

    };


    lastPipelineResult =
      result;


    lastPipelineFinishedAt =
      new Date().toISOString();


    return result;
  }


  /*
   * Ищем первую ещё не обработанную новость.
   */

  const candidates = [];


  for (
    const item
    of news
  ) {

    const key =
      newsKey(
        item
      );


    if (
      processedNews.has(
        key
      )
    ) {

      continue;
    }


    candidates.push(
      item
    );


    if (
      candidates.length >=
      MAX_NEWS_PER_RUN
    ) {

      break;
    }
  }


  /*
   * Если всё уже обработано.
   */

  if (
    !candidates.length
  ) {

    const result = {

      ok: true,

      stage:
        "deduplication",

      message:
        "Новых необработанных новостей нет.",

      rss_total:
        news.length,

      processed:
        processedNews.size

    };


    lastPipelineResult =
      result;


    lastPipelineFinishedAt =
      new Date().toISOString();


    return result;
  }


  const results = [];


  /*
   * Обрабатываем новости.
   */

  for (
    const item
    of candidates
  ) {

    const key =
      newsKey(
        item
      );


    console.log(
      `[PIPELINE] processing: ${item.title}`
    );


    /*
     * AI
     */

    const analysis =
      await generateWithFallback(

        buildAnalysisPrompt(
          item
        )

      );


    if (
      !analysis.ok
    ) {

      results.push({

        ok: false,

        stage:
          "ai",

        item,

        analysis

      });


      continue;
    }


    /*
     * Финальный текст.
     */

    const text =

      `📰 ${item.title}\n\n` +

      `${analysis.text}\n\n` +

      `Источник: ${item.link || "не указан"}`;


    /*
     * Публикация.
     */

    const publishResult =
      await publishToMax(

        TARGET_CHAT_ID,

        text

      );


    const publication = {

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


    /*
     * Только после успешной публикации
     * помечаем новость обработанной.
     */

    if (
      publishResult.ok
    ) {

      processedNews.set(
        key,
        Date.now()
      );


      /*
       * Не даём Map расти бесконечно.
       */

      cleanupProcessedNews();
    }


    results.push({

      ok:
        publishResult.ok,

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


    /*
     * Небольшая пауза между публикациями.
     */

    await sleep(
      500
    );
  }


  const result = {

    ok:
      results.some(
        x =>
          x.ok
      ),

    duration_ms:
      Date.now() -
      startedAt,

    auto_pipeline:
      AUTO_PIPELINE,

    target_chat_id:
      TARGET_CHAT_ID,

    rss_total:
      news.length,

    selected:
      candidates.length,

    results

  };


  lastPipelineResult =
    result;


  lastPipelineFinishedAt =
    new Date().toISOString();


  console.log(
    "[PIPELINE RESULT]",
    JSON.stringify(
      result
    )
  );


  return result;
}


/*
 * ============================================================
 * DEDUP CLEANUP
 * ============================================================
 */

function cleanupProcessedNews() {

  const MAX_MEMORY_ITEMS =
    1000;


  if (
    processedNews.size <=
    MAX_MEMORY_ITEMS
  ) {

    return;
  }


  const entries =
    [...processedNews.entries()]
      .sort(
        (a, b) =>
          a[1] - b[1]
      );


  const removeCount =
    processedNews.size -
    MAX_MEMORY_ITEMS;


  for (
    let i = 0;
    i < removeCount;
    i++
  ) {

    processedNews.delete(
      entries[i][0]
    );
  }
}


/*
 * ============================================================
 * WEBHOOK
 * ============================================================
 */

function extractChatId(
  update
) {

  const value =

    update?.chat_id ??

    update?.message
      ?.recipient
      ?.chat_id ??

    update?.message
      ?.recipient
      ?.chatId ??

    update?.message
      ?.chat_id ??

    update?.chat
      ?.chat_id ??

    update?.chat
      ?.id;


  if (
    value === undefined ||
    value === null
  ) {

    return null;
  }


  return String(
    value
  );
}


function addWebhookLog(
  payload,
  request,
  secretValid
) {

  const entry = {

    received_at:
      new Date().toISOString(),

    method:
      request.method,

    path:
      new URL(
        request.url
      ).pathname,

    secret_valid:
      secretValid,

    user_agent:
      request.headers.get(
        "User-Agent"
      ),

    content_type:
      request.headers.get(
        "Content-Type"
      ),

    payload

  };


  webhookLogs.push(
    entry
  );


  /*
   * Последние 100 событий.
   */

  while (
    webhookLogs.length >
    100
  ) {

    webhookLogs.shift();
  }


  console.log(
    "[WEBHOOK]",
    JSON.stringify(
      entry
    )
  );
}


/*
 * ============================================================
 * CRON
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
        `[CRON] started ${new Date().toISOString()}`
      );


      try {

        await runPipeline();

      } catch (
        error
      ) {

        console.error(
          "[CRON ERROR]",
          error
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
  async request => {

    const url =
      new URL(
        request.url
      );


    const path =
      url.pathname;


    /*
     * ========================================================
     * OPTIONS
     * ========================================================
     */

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
        request.method === "GET"
      ) {

        return json({

          ok: true,

          service:
            "MAX NEWS AGENT FINAL",

          runtime:
            "Deno Deploy",

          status:
            "online",

          time:
            new Date().toISOString(),

          max_api:
            MAX_API,

          target_chat_configured:
            !!TARGET_CHAT_ID,

          auto_pipeline:
            AUTO_PIPELINE,

          cron_schedule:
            AUTO_PIPELINE
              ? CRON_SCHEDULE
              : null,

          processed_news:
            processedNews.size,

          webhook_events:
            webhookLogs.length,

          webhook:
            getWebhookUrl(
              request.url
            ),

          endpoints: [

            "/diagnostic",

            "/check",

            "/tls-test",

            "/rss",

            "/models",

            "/max-test",

            "/subscriptions",

            "/cleanup-webhooks",

            "/setup-webhook",

            "/chat-test?chat_id=...",

            "/publish-test",

            "/run",

            "/pipeline",

            "/webhook",

            "/webhook-log"

          ]

        });
      }


      /*
       * ======================================================
       * /diagnostic
       * ======================================================
       */

      if (
        path ===
          "/diagnostic" &&
        request.method ===
          "GET"
      ) {

        const me =
          await maxMe();


        const subscriptions =
          await getSubscriptions();


        return json({

          ok: true,

          service:
            "MAX NEWS AGENT FINAL",

          runtime:
            "Deno Deploy",

          current_webhook:
            getWebhookUrl(
              request.url
            ),

          tls:
            maxCaStatus,

          environment: {

            MAX_BOT_TOKEN:
              !!MAX_BOT_TOKEN,

            MAX_WEBHOOK_SECRET:
              !!MAX_WEBHOOK_SECRET,

            GEMINI_API_KEY:
              !!GEMINI_API_KEY,

            QWEN_API_KEY:
              !!QWEN_API_KEY,

            TARGET_CHAT_ID:
              TARGET_CHAT_ID || null,

            AUTO_PIPELINE:
              AUTO_PIPELINE,

            CRON_SCHEDULE:
              CRON_SCHEDULE

          },

          max_me: {

            ok:
              me.ok,

            status:
              me.status,

            response:
              me.data

          },

          subscriptions: {

            ok:
              subscriptions.ok,

            status:
              subscriptions.status,

            response:
              subscriptions.data

          },

          runtime_state: {

            processed_news:
              processedNews.size,

            webhook_events:
              webhookLogs.length,

            last_pipeline_started_at:
              lastPipelineStartedAt,

            last_pipeline_finished_at:
              lastPipelineFinishedAt,

            last_pipeline_result:
              lastPipelineResult

          }

        });
      }


      /*
       * ======================================================
       * /tls-test
       * ======================================================
       */

      if (
        path ===
          "/tls-test" &&
        request.method === "GET"
      ) {

        const client =
          await initMaxHttpClient();


        return json({

          ok:
            !!client,

          max_api:
            MAX_API,

          tls:
            maxCaStatus,

          client_created:
            !!client,

          error:
            maxHttpClientError ||
            null

        });
      }


      /*
       * ======================================================
       * /check
       * ======================================================
       */

      if (
        path ===
          "/check" &&
        request.method === "GET"
      ) {

        const result = {

          ok: true,

          service:
            "MAX NEWS AGENT FINAL",

          runtime:
            "Deno Deploy",

          max_api:
            MAX_API,

          tls:
            maxCaStatus,

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

            target_chat: {

              configured:
                !!TARGET_CHAT_ID

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
            await maxMe();


          result.checks.max.api = {

            ok:
              test.ok,

            http_status:
              test.status,

            response:
              test.data

          };
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


        result.ok =
          !!(

            result.checks.max
              .configured &&

            result.checks.max
              .api?.ok &&

            result.checks.target_chat
              .configured

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
        request.method === "GET"
      ) {

        const feeds =
          await fetchRSS();


        const total =
          feeds.reduce(

            (
              sum,
              feed
            ) =>

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


      /*
       * ======================================================
       * /models
       * ======================================================
       */

      if (
        path ===
          "/models" &&
        request.method === "GET"
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

          }

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
        request.method === "GET"
      ) {

        const result =
          await maxMe();


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
       * /subscriptions
       * ======================================================
       */

      if (
        path ===
          "/subscriptions" &&
        request.method === "GET"
      ) {

        const result =
          await getSubscriptions();


        return json({

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

          tls:
            maxCaStatus

        });
      }


      /*
       * ======================================================
       * /cleanup-webhooks
       * ======================================================
       */

      if (
        path ===
          "/cleanup-webhooks" &&
        request.method === "GET"
      ) {

        const result =
          await cleanupWebhooks(
            request.url
          );


        return json({

          ok: true,

          operation:
            "cleanup-webhooks",

          result

        });
      }


      /*
       * ======================================================
       * /setup-webhook
       * ======================================================
       */

      if (
        path ===
          "/setup-webhook" &&
        request.method === "GET"
      ) {

        const result =
          await setupWebhook(
            request.url
          );


        return json(

          result,

          result.ok
            ? 200
            : 502

        );
      }


      /*
       * ======================================================
       * /chat-test
       * ======================================================
       */

      if (
        path ===
          "/chat-test" &&
        request.method === "GET"
      ) {

        const chatId =
          url.searchParams.get(
            "chat_id"
          );


        if (
          !chatId
        ) {

          return json(

            {

              ok: false,

              error:
                "Не указан chat_id",

              usage:
                "/chat-test?chat_id=123"

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
        request.method === "GET"
      ) {

        const chatId =
          url.searchParams.get(
            "chat_id"
          ) ||
          TARGET_CHAT_ID;


        if (
          !chatId
        ) {

          return json(

            {

              ok: false,

              error:
                "TARGET_CHAT_ID не задан"

            },

            400

          );
        }


        const text =
          url.searchParams.get(
            "text"
          ) ||

          "ТЕСТ MAX NEWS AGENT\n\n" +

          "MAX API работает.\n" +

          "Проверка публикации успешна.";


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


      /*
       * ======================================================
       * /run
       * /pipeline
       * ======================================================
       */

      if (

        (
          path === "/run" ||
          path === "/pipeline"
        )

        &&

        (
          request.method === "GET" ||
          request.method === "POST"
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
       * /webhook-log
       * ======================================================
       */

      if (
        path ===
          "/webhook-log" &&
        request.method === "GET"
      ) {

        return json({

          ok: true,

          source:
            "runtime memory",

          count:
            webhookLogs.length,

          logs:
            [...webhookLogs]
              .reverse()

        });
      }


      /*
       * ======================================================
       * /webhook
       * ======================================================
       *
       * MAX -> сюда
       *
       * ВАЖНО:
       * Никаких внешних API вызовов здесь.
       *
       * Сначала быстро принимаем событие,
       * затем возвращаем 200.
       * ======================================================
       */

      if (
        path ===
          "/webhook" &&
        request.method === "POST"
      ) {

        /*
         * SECRET
         */

        if (
          MAX_WEBHOOK_SECRET
        ) {

          const incomingSecret =
            request.headers.get(
              "X-Max-Bot-Api-Secret"
            );


          if (
            incomingSecret !==
            MAX_WEBHOOK_SECRET
          ) {

            return json(

              {

                ok: false,

                error:
                  "Invalid MAX webhook secret"

              },

              401

            );
          }
        }


        /*
         * JSON
         */

        let payload;


        try {

          payload =
            await request.json();

        } catch (
          error
        ) {

          return json(

            {

              ok: false,

              error:
                "Invalid JSON",

              details:
                error?.message ||
                String(error)

            },

            400

          );
        }


        /*
         * Логируем событие.
         */

        addWebhookLog(

          payload,

          request,

          true

        );


        /*
         * Извлекаем Update.
         */

        const updates =

          Array.isArray(
            payload?.updates
          )

            ? payload.updates

            : Array.isArray(
                payload
              )

              ? payload

              : [payload];


        const summary =
          updates.map(
            update => ({

              update_type:
                update?.update_type ||
                null,

              chat_id:
                extractChatId(
                  update
                ),

              timestamp:
                update?.timestamp ||
                null,

              is_channel:
                update?.is_channel ??
                null

            })
          );


        /*
         * ВАЖНО:
         *
         * Никакого await MAX API.
         * Никакого Deno KV.
         *
         * MAX должен получить 200.
         */

        return json({

          ok: true,

          received: true,

          count:
            updates.length,

          updates:
            summary

        });
      }


      /*
       * ======================================================
       * UNKNOWN
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


    } catch (
      error
    ) {

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
            "Error"

        },

        500

      );
    }

  }
);