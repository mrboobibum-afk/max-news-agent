/*
 * ============================================================
 * ФАКТОР — MAX NEWS AGENT
 * FINAL PRODUCTION VERSION
 *
 * DENO DEPLOY
 *
 * RSS -> AI -> EDITORIAL FORMAT -> MAX
 *
 * ОСНОВНЫЕ ПРИНЦИПЫ:
 *
 * 1. Deno KV НЕ используется.
 * 2. Webhook НЕ управляет публикацией.
 * 3. TARGET_CHAT_ID используется напрямую.
 * 4. Автопубликация каждые 5 минут.
 * 5. Gemini -> Qwen fallback.
 * 6. Дедупликация через историю постов MAX.
 * 7. Максимум 1 публикация за цикл.
 * 8. Новость должна быть свежей.
 * 9. Собственная оперативная новостная подача.
 * 10. HTML-форматирование MAX.
 *
 * СТИЛЬ ПУБЛИКАЦИИ:
 *
 * 🔴 ФАКТОР • ОПЕРАТИВНО
 *
 * 📊 ЭКОНОМИКА
 *
 * ЗАГОЛОВОК
 *
 * Коротко:
 * ...
 *
 * Главное:
 * • ...
 * • ...
 *
 * Что важно:
 * ...
 *
 * 🕒 10:30
 * 🔗 Источник
 *
 * ============================================================
 */


/*
 * ============================================================
 * API
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

const MAX_WEBHOOK_SECRET =
  (Deno.env.get("MAX_WEBHOOK_SECRET") || "").trim();

const AUTO_PIPELINE =
  (
    Deno.env.get("AUTO_PIPELINE") ||
    "true"
  ).toLowerCase() === "true";


/*
 * ВАЖНО:
 *
 * Не делаем cron динамическим через ENV.
 * Deno Deploy должен видеть регистрацию
 * cron на верхнем уровне файла.
 */

const CRON_SCHEDULE =
  "*/5 * * * *";


/*
 * ============================================================
 * LIMITS
 * ============================================================
 */

const MAX_NEWS_PER_RUN =
  1;

const MAX_NEWS_AGE_HOURS =
  24;

const API_RETRIES =
  2;

const API_TIMEOUT_MS =
  20000;

const MAX_HISTORY_COUNT =
  100;


/*
 * ============================================================
 * AI MODELS
 * ============================================================
 */

const GEMINI_MODELS =
  parseList(
    Deno.env.get("GEMINI_MODELS") ||
    [
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gemini-2.5-flash-lite",
      "gemini-3-flash-preview"
    ].join(",")
  );


const QWEN_MODELS =
  parseList(
    Deno.env.get("QWEN_MODELS") ||
    [
      "qwen3.8-flash",
      "qwen3.8-max",
      "qwen3.8-max-0902",
      "qwen3.8-27b",
      "qwen3.7-plus",
      "qwen-plus"
    ].join(",")
  );


let discoveredGeminiModels = null;

let discoveredQwenModels = null;


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

  {
    category: "МИР",
    emoji: "🌍",
    url:
      "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    category: "ПОЛИТИКА",
    emoji: "🏛️",
    url:
      "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    category: "ЭКОНОМИКА",
    emoji: "📊",
    url:
      "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    category: "ПРОИСШЕСТВИЯ",
    emoji: "🚨",
    url:
      "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    category: "ТЕХНОЛОГИИ",
    emoji: "💻",
    url:
      "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"
  }

];


/*
 * ============================================================
 * WEBHOOK
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

const webhookLogs = [];

let lastPipelineResult = null;

let lastPipelineStartedAt = null;

let lastPipelineFinishedAt = null;


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
        .map(x => x.trim())
        .filter(Boolean)
    )
  ];

}


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );

}


function json(data, status = 200) {

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


function requireSecret(value, name) {

  if (!value) {

    throw new Error(
      `Secret ${name} не настроен`
    );

  }

}


/*
 * ============================================================
 * HTML
 * ============================================================
 */

function escapeHtml(value) {

  return String(value || "")

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
    )

    .replace(
      /'/g,
      "&#39;"
    );

}


function stripHtml(value) {

  return String(value || "")

    .replace(
      /<[^>]*>/g,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();

}


/*
 * ============================================================
 * HTTP
 * ============================================================
 */

function isRetryableStatus(status) {

  return (

    status === 408 ||

    status === 409 ||

    status === 425 ||

    status === 429 ||

    status >= 500

  );

}


function retryDelay(attempt, retryAfterHeader) {

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
      1000 * (2 ** attempt),
      8000
    ) +

    Math.floor(
      Math.random() * 400
    )

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
        `MAX root CA: HTTP ${rootResponse.status}`
      );

    }


    const rootCa =
      await rootResponse.text();


    maxCaStatus.root =
      true;


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
        `MAX sub CA: HTTP ${subResponse.status}`
      );

    }


    const subCa =
      await subResponse.text();


    maxCaStatus.sub =
      true;


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
      "[MAX TLS] loaded"
    );


    return maxHttpClient;


  } catch (error) {

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


async function readJson(response) {

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
    API_RETRIES;

  const timeoutMs =
    config.timeoutMs ??
    API_TIMEOUT_MS;

  const useMaxClient =
    config.useMaxClient === true;


  let last = {

    ok: false,

    status: 599,

    statusText:
      "No HTTP response",

    data: null

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
          error?.name === "AbortError"
            ? 504
            : 599,

        statusText:
          error?.name === "AbortError"
            ? "Gateway Timeout"
            : "Network Error",

        data: {

          error:
            error?.message ||
            String(error)

        },

        error_name:
          error?.name ||
          "Error",

        error_message:
          error?.message ||
          String(error)

      };


      console.error(
        "[HTTP ERROR]",
        JSON.stringify({
          url,
          attempt,
          error:
            error?.message ||
            String(error)
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

      clearTimeout(timer);

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
 * MAX METHODS
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

  return await maxRequest(

    `/subscriptions?url=${encodeURIComponent(
      webhookUrl
    )}`,

    {
      method: "DELETE"
    }

  );

}


async function getTargetChat() {

  if (!TARGET_CHAT_ID) {

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

    `/chats/${encodeURIComponent(
      TARGET_CHAT_ID
    )}`,

    {
      method: "GET"
    }

  );

}


async function getRecentMessages() {

  if (!TARGET_CHAT_ID) {

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
      TARGET_CHAT_ID
    )}&count=${MAX_HISTORY_COUNT}`,

    {
      method: "GET"
    }

  );

}


/*
 * ============================================================
 * WEBHOOK URL
 * ============================================================
 */

function getWebhookUrl(requestUrl) {

  const current =
    new URL(requestUrl);


  return `${current.origin}/webhook`;

}


/*
 * ============================================================
 * WEBHOOK CLEANUP
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
      webhookUrl === currentWebhook
    ) {

      continue;

    }


    const result =
      await deleteSubscription(
        webhookUrl
      );


    deleted.push({

      url:
        webhookUrl,

      ok:
        result.ok,

      http_status:
        result.status,

      response:
        result.data

    });

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
 * WEBHOOK SETUP
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


  const tls =
    await initMaxHttpClient();


  if (!tls) {

    return {

      ok: false,

      stage:
        "max_tls",

      webhook_url:
        webhookUrl,

      tls:
        maxCaStatus,

      error:
        maxHttpClientError

    };

  }


  const cleanup =
    await cleanupWebhooks(
      requestUrl
    );


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
 * XML
 * ============================================================
 */

function decodeXml(value) {

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


function extractTagRaw(
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


  return match
    ? match[1]
    : "";

}


function extractTag(
  xml,
  tag
) {

  return stripHtml(
    decodeXml(
      extractTagRaw(
        xml,
        tag
      )
    )
  );

}


function extractSource(
  item
) {

  const raw =
    extractTagRaw(
      item,
      "source"
    );


  return stripHtml(
    decodeXml(
      raw
    )
  ) || "Источник";

}


function extractItems(
  xml,
  feed
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


    const source =
      extractSource(
        item
      );


    const guid =
      extractTag(
        item,
        "guid"
      );


    if (!title) {

      continue;

    }


    items.push({

      title,

      link,

      description,

      pubDate,

      source,

      guid,

      category:
        feed.category,

      category_emoji:
        feed.emoji,

      source_feed:
        feed.url

    });

  }


  return items;

}


/*
 * ============================================================
 * RSS
 * ============================================================
 */

async function fetchRSS() {

  const results =
    await Promise.all(

      RSS_FEEDS.map(
        async feed => {

          const result =
            await fetchJson(

              feed.url,

              {

                method:
                  "GET",

                headers: {

                  "User-Agent":
                    "Factor-News-Agent/1.0",

                  Accept:
                    "application/rss+xml, application/xml, text/xml"

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

              category:
                feed.category,

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
            typeof xml !== "string"
          ) {

            return {

              category:
                feed.category,

              ok: false,

              status:
                result.status,

              error:
                "RSS response is not XML"

            };

          }


          const items =
            extractItems(
              xml,
              feed
            );


          return {

            category:
              feed.category,

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
 * NEWS
 * ============================================================
 */

function newsKey(item) {

  return (

    item.guid ||

    item.link ||

    `${item.title}|${item.pubDate || ""}`

  );

}


function normalizeText(value) {

  return String(value || "")

    .toLowerCase()

    .replace(
      /<[^>]*>/g,
      " "
    )

    .replace(
      /https?:\/\/\S+/g,
      ""
    )

    .replace(
      /[^\p{L}\p{N}\s]/gu,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();

}


function flattenNews(
  feeds
) {

  const all = [];


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


    all.push(
      ...feed.items
    );

  }


  all.sort(
    (a, b) => {

      const aTime =
        Date.parse(
          a.pubDate || ""
        ) || 0;


      const bTime =
        Date.parse(
          b.pubDate || ""
        ) || 0;


      return bTime - aTime;

    }
  );


  const unique = [];

  const seen =
    new Set();


  for (
    const item
    of all
  ) {

    const key =
      newsKey(item);


    if (
      seen.has(key)
    ) {

      continue;

    }


    seen.add(key);

    unique.push(item);

  }


  return unique;

}


/*
 * ============================================================
 * FRESHNESS
 * ============================================================
 */

function isFresh(item) {

  const timestamp =
    Date.parse(
      item.pubDate || ""
    );


  if (!timestamp) {

    return true;

  }


  const age =
    Date.now() -
    timestamp;


  const maxAge =
    MAX_NEWS_AGE_HOURS *
    60 *
    60 *
    1000;


  return (
    age >= 0 &&
    age <= maxAge
  );

}


/*
 * ============================================================
 * ALREADY PUBLISHED
 * ============================================================
 */

function extractMessageText(
  message
) {

  return (

    message?.body?.text ||

    message?.text ||

    ""

  );

}


function wasAlreadyPublished(
  item,
  messages
) {

  const targetTitle =
    normalizeText(
      item.title
    );


  const targetLink =
    String(
      item.link || ""
    ).trim();


  const targetGuid =
    String(
      item.guid || ""
    ).trim();


  for (
    const message
    of messages
  ) {

    const text =
      extractMessageText(
        message
      );


    if (!text) {

      continue;

    }


    const normalized =
      normalizeText(
        text
      );


    /*
     * Самый надёжный вариант:
     * ссылка уже была опубликована.
     */

    if (
      targetLink &&
      text.includes(
        targetLink
      )
    ) {

      return true;

    }


    /*
     * Если Google изменит wrapper URL,
     * используем GUID.
     */

    if (
      targetGuid &&
      text.includes(
        targetGuid
      )
    ) {

      return true;

    }


    /*
     * Дополнительная защита:
     * совпадение заголовка.
     */

    if (
      targetTitle &&
      targetTitle.length >= 30 &&
      normalized.includes(
        targetTitle
      )
    ) {

      return true;

    }

  }


  return false;

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
 * GEMINI DISCOVERY
 * ============================================================
 */

async function discoverGeminiModels() {

  if (!GEMINI_API_KEY) {

    return [];

  }


  if (discoveredGeminiModels) {

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
 * QWEN DISCOVERY
 * ============================================================
 */

async function discoverQwenModels() {

  if (!QWEN_API_KEY) {

    return [];

  }


  if (discoveredQwenModels) {

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
  discovered
) {

  return [

    ...new Set([

      ...primary,

      ...discovered

    ])

  ].slice(
    0,
    15
  );

}


/*
 * ============================================================
 * GEMINI
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
 * QWEN
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
                "Ты редактор новостного канала. Пиши кратко, фактически, нейтрально. Не выдумывай факты. Используй только предоставленный материал."

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
      "Все AI-модели не ответили успешно.",

    attempts

  };

}


/*
 * ============================================================
 * AI PROMPT
 * ============================================================
 */

function buildAnalysisPrompt(
  item
) {

  return `

Ты редактор новостного канала ФАКТОР.

Нужно подготовить короткий новостной материал.

ИСТОЧНИК:
${item.source}

КАТЕГОРИЯ:
${item.category}

ЗАГОЛОВОК:
${item.title}

ДАТА:
${item.pubDate || "не указана"}

МАТЕРИАЛ:
${item.description || "нет"}

ПРАВИЛА:

1. Используй только информацию из материала.
2. Не выдумывай цифры, имена, даты и события.
3. Не приписывай людям заявления, которых нет в материале.
4. Не добавляй собственные политические оценки.
5. Не используй истеричную лексику.
6. Не повторяй заголовок полностью.
7. Пиши на русском.
8. Максимально быстро переходи к сути.
9. Не используй Markdown.
10. Не добавляй ссылки.
11. Не используй эмодзи.
12. Не добавляй вступления вроде "В этой новости".

ФОРМАТ:

КРАТКО:
Одно или два предложения.

ГЛАВНОЕ:
• Факт.
• Факт.
• Факт.

ЧТО ВАЖНО:
Одно короткое предложение.

Если какого-либо факта нет в исходном материале — не придумывай его.

`.trim();

}


/*
 * ============================================================
 * AI TEXT CLEANER
 * ============================================================
 */

function cleanAiText(
  text
) {

  return String(text || "")

    .replace(
      /\*\*/g,
      ""
    )

    .replace(
      /__/g,
      ""
    )

    .replace(
      /^#{1,6}\s*/gm,
      ""
    )

    .trim();

}


/*
 * ============================================================
 * CURRENT TIME
 * ============================================================
 */

function currentMoscowTime() {

  return new Intl.DateTimeFormat(
    "ru-RU",
    {

      timeZone:
        "Europe/Moscow",

      hour:
        "2-digit",

      minute:
        "2-digit",

      hour12:
        false

    }
  ).format(
    new Date()
  );

}


/*
 * ============================================================
 * PUBLICATION FORMAT
 * ============================================================
 */

function buildPublication(
  item,
  aiText
) {

  const clean =
    cleanAiText(
      aiText
    );


  const title =
    escapeHtml(
      item.title
    );


  const source =
    escapeHtml(
      item.source ||
      "Источник"
    );


  const category =
    escapeHtml(
      item.category
    );


  const emoji =
    item.category_emoji ||
    "📰";


  /*
   * Обрабатываем секции AI.
   */

  let body =
    clean;


  body =
    body.replace(
      /^КРАТКО:\s*/im,
      ""
    );


  const parts =
    body.split(
      /ГЛАВНОЕ:\s*/i
    );


  let shortText =
    parts[0] || "";


  let factsAndImportant =
    parts[1] || "";


  const importantParts =
    factsAndImportant.split(
      /ЧТО ВАЖНО:\s*/i
    );


  let facts =
    importantParts[0] || "";


  let important =
    importantParts[1] || "";


  shortText =
    shortText
      .replace(
        /^КРАТКО:\s*/i,
        ""
      )
      .trim();


  facts =
    facts.trim();


  important =
    important.trim();


  /*
   * Если AI вернул неидеальную структуру,
   * всё равно публикуем нормальный текст.
   */

  if (!shortText) {

    shortText =
      clean;

  }


  const factLines =
    facts

      .split("\n")

      .map(
        line =>
          line
            .replace(
              /^[•\-–—]\s*/,
              ""
            )
            .trim()
      )

      .filter(Boolean)

      .slice(
        0,
        5
      );


  const factsHtml =
    factLines.length

      ? factLines
          .map(
            line =>
              `• ${escapeHtml(
                line
              )}`
          )
          .join("<br>")

      : "• Дополнительные детали уточняются.";


  const safeShort =
    escapeHtml(
      shortText
    );


  const safeImportant =
    escapeHtml(
      important
    );


  const sourceUrl =
    item.link &&
    /^https?:\/\//i.test(
      item.link
    )
      ? item.link
      : null;


  const sourceHtml =
    sourceUrl

      ? `<a href="${escapeHtml(
          sourceUrl
        )}">🔗 ${source}</a>`

      : `🔗 ${source}`;


  /*
   * ИТОГОВАЯ ПОДАЧА.
   *
   * Собственная структура ФАКТОР.
   * Не копирует оформление конкретного канала.
   */

  const text =

    `🔴 <b>ФАКТОР • ОПЕРАТИВНО</b>\n\n` +

    `${emoji} <b>${category}</b>\n\n` +

    `<b>${title}</b>\n\n` +

    `<b>КРАТКО</b>\n` +

    `${safeShort}\n\n` +

    `<b>ГЛАВНОЕ</b>\n` +

    `${factsHtml}\n\n` +

    `<b>ЧТО ВАЖНО</b>\n` +

    `${safeImportant || "Ситуация развивается."}\n\n` +

    `🕒 ${currentMoscowTime()}\n` +

    `${sourceHtml}`;


  /*
   * MAX принимает до 4000 символов.
   */

  return text.slice(
    0,
    3900
  );

}


/*
 * ============================================================
 * PUBLISH
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
          "chat_id не задан"

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

          text,

          format:
            "html",

          notify:
            true,

          disable_link_preview:
            true

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
    "[PIPELINE] START"
  );


  if (!TARGET_CHAT_ID) {

    const result = {

      ok: false,

      stage:
        "config",

      error:
        "TARGET_CHAT_ID не задан"

    };


    lastPipelineResult =
      result;


    return result;

  }


  /*
   * ----------------------------------------------------------
   * Проверяем канал.
   * ----------------------------------------------------------
   */

  const target =
    await getTargetChat();


  if (!target.ok) {

    const result = {

      ok: false,

      stage:
        "target_chat",

      error:
        "Не удалось получить TARGET_CHAT_ID",

      response:
        target.data

    };


    lastPipelineResult =
      result;


    lastPipelineFinishedAt =
      new Date().toISOString();


    return result;

  }


  /*
   * ----------------------------------------------------------
   * Получаем последние посты.
   * Это наша постоянная дедупликация без KV.
   * ----------------------------------------------------------
   */

  const history =
    await getRecentMessages();


  if (!history.ok) {

    const result = {

      ok: false,

      stage:
        "history",

      error:
        "Не удалось прочитать историю канала. Бот должен иметь права администратора и read_all_messages.",

      response:
        history.data

    };


    lastPipelineResult =
      result;


    lastPipelineFinishedAt =
      new Date().toISOString();


    return result;

  }


  const messages =
    Array.isArray(
      history.data?.messages
    )
      ? history.data.messages
      : [];


  /*
   * ----------------------------------------------------------
   * RSS
   * ----------------------------------------------------------
   */

  const feeds =
    await fetchRSS();


  const news =
    flattenNews(
      feeds
    );


  if (!news.length) {

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
   * ----------------------------------------------------------
   * Выбираем свежую и ещё не опубликованную.
   * ----------------------------------------------------------
   */

  const candidates = [];


  for (
    const item
    of news
  ) {

    if (
      !isFresh(item)
    ) {

      continue;

    }


    if (
      wasAlreadyPublished(
        item,
        messages
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
   * ----------------------------------------------------------
   * Нет новых.
   * ----------------------------------------------------------
   */

  if (!candidates.length) {

    const result = {

      ok: true,

      stage:
        "deduplication",

      message:
        "Свежих непубликованных новостей нет.",

      rss_total:
        news.length,

      history_count:
        messages.length

    };


    lastPipelineResult =
      result;


    lastPipelineFinishedAt =
      new Date().toISOString();


    console.log(
      "[PIPELINE]",
      result.message
    );


    return result;

  }


  const results = [];


  /*
   * ----------------------------------------------------------
   * Обработка.
   * ----------------------------------------------------------
   */

  for (
    const item
    of candidates
  ) {

    console.log(
      "[PIPELINE] NEWS:",
      item.title
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


    /*
     * Публикационный текст.
     */

    const publication =
      buildPublication(

        item,

        analysis.text

      );


    /*
     * Публикация.
     */

    const publishResult =
      await publishToMax(

        TARGET_CHAT_ID,

        publication

      );


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

      publication: {

        ok:
          publishResult.ok,

        http_status:
          publishResult.status,

        response:
          publishResult.data

      },

      text:
        publication

    });


    /*
     * Только одна новость.
     */

    await sleep(
      1000
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

    cron_schedule:
      CRON_SCHEDULE,

    target_chat_id:
      TARGET_CHAT_ID,

    target_chat_type:
      target.data?.type ||
      null,

    rss_total:
      news.length,

    history_count:
      messages.length,

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
 * WEBHOOK LOG
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
 *
 * ВАЖНО:
 *
 * Deno.cron зарегистрирован НА ВЕРХНЕМ УРОВНЕ.
 *
 * Никакого:
 *
 * if (AUTO_PIPELINE) {
 *   Deno.cron(...)
 * }
 *
 * Это было исправлено.
 * ============================================================
 */

Deno.cron(

  "MAX News automatic pipeline",

  "*/5 * * * *",

  {

    backoffSchedule: [

      5000,

      15000,

      60000

    ]

  },

  async () => {

    if (!AUTO_PIPELINE) {

      console.log(
        "[CRON] AUTO_PIPELINE=false"
      );

      return;

    }


    console.log(
      `[CRON] START ${new Date().toISOString()}`
    );


    try {

      await runPipeline();

    } catch (error) {

      console.error(
        "[CRON ERROR]",
        error
      );

      throw error;

    }

  }

);


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
     * OPTIONS
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
            "MAX NEWS AGENT — ФАКТОР",

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
            CRON_SCHEDULE,

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
        path === "/diagnostic" &&
        request.method === "GET"
      ) {

        const me =
          await maxMe();


        const subscriptions =
          await getSubscriptions();


        const target =
          TARGET_CHAT_ID
            ? await getTargetChat()
            : null;


        return json({

          ok: true,

          service:
            "MAX NEWS AGENT — ФАКТОР",

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

          target_chat: target
            ? {

                ok:
                  target.ok,

                status:
                  target.status,

                response:
                  target.data

              }

            : null,

          subscriptions: {

            ok:
              subscriptions.ok,

            status:
              subscriptions.status,

            response:
              subscriptions.data

          },

          runtime_state: {

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
        path === "/tls-test" &&
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
            maxHttpClientError

        });

      }


      /*
       * ======================================================
       * /check
       * ======================================================
       */

      if (
        path === "/check" &&
        request.method === "GET"
      ) {

        const result = {

          ok: false,

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


        if (MAX_BOT_TOKEN) {

          const max =
            await maxMe();


          result.checks.max.api = {

            ok:
              max.ok,

            http_status:
              max.status,

            response:
              max.data

          };

        }


        if (TARGET_CHAT_ID) {

          const target =
            await getTargetChat();


          result.checks.target_chat.api = {

            ok:
              target.ok,

            http_status:
              target.status,

            response:
              target.data

          };

        }


        if (GEMINI_API_KEY) {

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


        if (QWEN_API_KEY) {

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
              .api?.ok &&

            result.checks.target_chat
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
        path === "/models" &&
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
        path === "/max-test" &&
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
        path === "/subscriptions" &&
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
        path === "/cleanup-webhooks" &&
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
        path === "/setup-webhook" &&
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
        path === "/chat-test" &&
        request.method === "GET"
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
                "Не указан chat_id"

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
        path === "/publish-test" &&
        request.method === "GET"
      ) {

        const chatId =
          url.searchParams.get(
            "chat_id"
          ) ||
          TARGET_CHAT_ID;


        if (!chatId) {

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

          `🔴 <b>ФАКТОР • ТЕСТ</b>\n\n` +

          `📡 <b>Система публикации работает.</b>\n\n` +

          `🕒 ${currentMoscowTime()}`;


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
        path === "/webhook-log" &&
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
       */

      if (
        path === "/webhook" &&
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

        } catch (error) {

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


        addWebhookLog(

          payload,

          request,

          true

        );


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
         * MAX получает 200 как можно быстрее.
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
            "Error"

        },

        500

      );

    }

  }
);