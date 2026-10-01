/*
 * ============================================================
 * MAX NEWS AGENT — Deno Deploy
 * Clean production version
 *
 * RSS -> AI -> MAX
 *
 * Главное:
 * - MAX API: platform-api2.max.ru
 * - Webhook: /webhook
 * - Deno KV: chat_id + webhook logs
 * - автоматическая очистка старых Webhook
 * - ручная установка Webhook: /setup-webhook
 * - диагностика: /diagnostic
 * - тест Webhook: /webhook-test
 * - публикация: /publish-test
 * - RSS + Gemini + Qwen
 * ============================================================
 */

const MAX_API = "https://platform-api2.max.ru";

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

const MAX_WEBHOOK_SECRET =
  (Deno.env.get("MAX_WEBHOOK_SECRET") || "").trim();

const TARGET_CHAT_ID =
  (Deno.env.get("TARGET_CHAT_ID") || "").trim();

const AUTO_PIPELINE =
  (
    Deno.env.get("AUTO_PIPELINE") ||
    "false"
  ).toLowerCase() === "true";

const CRON_SCHEDULE =
  Deno.env.get("CRON_SCHEDULE") ||
  "*/15 * * * *";

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
    Deno.env.get("GEMINI_MODELS") ||
    "gemini-2.5-flash,gemini-3-flash-preview"
  );

const QWEN_MODELS =
  parseList(
    Deno.env.get("QWEN_MODELS") ||
    "qwen3.8-flash,qwen3.8-max,qwen3.8-27b"
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

  "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",

  "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru",

  "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru",

  "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru",

  "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"

];


/*
 * ============================================================
 * MAX UPDATE TYPES
 *
 * Оставляем основные события, необходимые для
 * обнаружения чатов и сообщений.
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
 * STATE
 * ============================================================
 */

let discoveredGeminiModels = null;

let discoveredQwenModels = null;

const recentPublished =
  new Map();


/*
 * ============================================================
 * DENO KV
 * ============================================================
 */

let kv = null;

try {

  kv = await Deno.openKv();

  console.log(
    "[KV] Deno KV initialized"
  );

} catch (error) {

  console.error(
    "[KV] unavailable:",
    error?.message ||
    String(error)
  );

}


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

  return Number.isFinite(value) &&
    value > 0
    ? value
    : fallback;
}


function sleep(ms) {

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
          "GET,POST,DELETE,OPTIONS",

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
      `Secret ${name} не настроен в Deno Deploy`
    );

  }

}


/*
 * ============================================================
 * MAX TLS INITIALIZATION
 * ============================================================
 */

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
            AbortSignal.timeout(
              10000
            )
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
            AbortSignal.timeout(
              10000
            )
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
      "[MAX TLS] failed:",
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


      if (
        useMaxClient
      ) {

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
          retryDelay(attempt)
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

  return await maxRequest(

    `/subscriptions?url=${encodeURIComponent(
      webhookUrl
    )}`,

    {
      method: "DELETE"
    }

  );

}


async function createSubscription(
  webhookUrl
) {

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


  return await maxRequest(

    "/subscriptions",

    {

      method: "POST",

      body:
        JSON.stringify(body)

    }

  );

}


/*
 * ============================================================
 * WEBHOOK URL
 * ============================================================
 */

function getWebhookUrl(
  requestUrl
) {

  const current =
    new URL(requestUrl);

  return `${current.origin}/webhook`;

}


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


  const subscriptionResult =
    await getSubscriptions();


  const discovered =
    Array.isArray(
      subscriptionResult
        ?.data
        ?.subscriptions
    )

      ? subscriptionResult
          .data
          .subscriptions

      : [];


  const candidates =
    new Set(
      KNOWN_OLD_WEBHOOKS
    );


  for (
    const subscription
    of discovered
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

    discovered_count:
      discovered.length,

    subscriptions_before:
      subscriptionResult.data,

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


  const client =
    await initMaxHttpClient();


  if (!client) {

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


  const before =
    await getSubscriptions();


  const cleanup =
    await cleanupWebhooks(
      requestUrl
    );


  const created =
    await createSubscription(
      webhookUrl
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

    before: {

      ok:
        before.ok,

      http_status:
        before.status,

      response:
        before.data

    },

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
 * KV CHAT STORAGE
 * ============================================================
 */

async function saveChatId(
  chatId,
  meta = {}
) {

  if (
    !kv ||
    chatId === undefined ||
    chatId === null
  ) {

    return false;

  }


  const id =
    String(chatId);


  await kv.set(

    [
      "max",
      "chat",
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

      updated_at:
        new Date()
          .toISOString()

    }

  );


  console.log(
    "[CHAT SAVED]",
    id
  );


  return true;

}


async function deleteChatId(
  chatId
) {

  if (
    !kv ||
    chatId === undefined ||
    chatId === null
  ) {

    return false;

  }


  await kv.delete([

    "max",
    "chat",
    String(chatId)

  ]);


  return true;

}


async function getStoredChatIds() {

  if (!kv) {

    return [];

  }


  const result = [];


  for await (
    const entry
    of kv.list({

      prefix: [
        "max",
        "chat"
      ]

    })
  ) {

    if (
      entry?.value?.chat_id
    ) {

      result.push(
        entry.value
      );

    }

  }


  return result;

}


/*
 * ============================================================
 * WEBHOOK LOG
 * ============================================================
 */

async function saveWebhookLog(
  payload,
  meta = {}
) {

  if (!kv) {

    return false;

  }


  const id =
    `${Date.now()}-${crypto.randomUUID()}`;


  await kv.set(

    [
      "max",
      "webhook_log",
      id
    ],

    {

      id,

      received_at:
        new Date()
          .toISOString(),

      method:
        meta.method ||
        null,

      path:
        meta.path ||
        null,

      secret_valid:
        meta.secret_valid ??
        null,

      content_type:
        meta.content_type ||
        null,

      user_agent:
        meta.user_agent ||
        null,

      payload

    }

  );


  return true;

}


async function getWebhookLogs(
  limit = 20
) {

  if (!kv) {

    return [];

  }


  const result = [];


  for await (
    const entry
    of kv.list({

      prefix: [
        "max",
        "webhook_log"
      ],

      reverse: true,

      limit:
        Math.min(
          100,
          Math.max(
            1,
            Number(limit) ||
            20
          )
        )

    })
  ) {

    if (
      entry?.value
    ) {

      result.push(
        entry.value
      );

    }

  }


  return result;

}


/*
 * ============================================================
 * CHAT ID EXTRACTION
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


  return String(value);

}


/*
 * ============================================================
 * PROCESS UPDATE
 * ============================================================
 */

async function processWebhookUpdate(
  update
) {

  if (!update) {

    return {

      saved: false,

      reason:
        "empty_update"

    };

  }


  const updateType =
    update.update_type ||
    null;


  const chatId =
    extractChatId(
      update
    );


  console.log(

    "[WEBHOOK UPDATE]",

    JSON.stringify({

      update_type:
        updateType,

      chat_id:
        chatId,

      keys:
        Object.keys(update || {})

    })

  );


  if (
    updateType ===
    "bot_removed"
  ) {

    if (chatId) {

      await deleteChatId(
        chatId
      );

    }


    return {

      saved: false,

      deleted:
        chatId,

      update_type:
        updateType

    };

  }


  if (chatId) {

    await saveChatId(

      chatId,

      {

        is_channel:
          update.is_channel ??
          update?.chat
            ?.is_channel ??
          null,

        update_type:
          updateType,

        timestamp:
          update.timestamp ??
          Date.now()

      }

    );


    return {

      saved: true,

      chat_id:
        chatId,

      update_type:
        updateType

    };

  }


  return {

    saved: false,

    update_type:
      updateType,

    reason:
      "chat_id_not_present"

  };

}


/*
 * ============================================================
 * WEBHOOK RECEIVER
 * ============================================================
 */

async function handleWebhook(
  request
) {

  console.log(
    "[WEBHOOK] POST received",
    new Date().toISOString()
  );


  /*
   * Сначала проверяем secret.
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

      console.error(
        "[WEBHOOK] INVALID SECRET"
      );


      await saveWebhookLog(

        {

          error:
            "Invalid webhook secret",

          headers: {

            user_agent:
              request.headers.get(
                "User-Agent"
              )

          }

        },

        {

          method:
            request.method,

          path:
            "/webhook",

          secret_valid:
            false,

          content_type:
            request.headers.get(
              "Content-Type"
            ),

          user_agent:
            request.headers.get(
              "User-Agent"
            )

        }

      );


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


  let payload;


  try {

    payload =
      await request.json();

  } catch (error) {

    console.error(
      "[WEBHOOK] Invalid JSON",
      error
    );


    await saveWebhookLog(

      {

        error:
          "Invalid JSON",

        details:
          error?.message ||
          String(error)

      },

      {

        method:
          request.method,

        path:
          "/webhook",

        secret_valid:
          true,

        content_type:
          request.headers.get(
            "Content-Type"
          ),

        user_agent:
          request.headers.get(
            "User-Agent"
          )

      }

    );


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


  await saveWebhookLog(

    payload,

    {

      method:
        request.method,

      path:
        "/webhook",

      secret_valid:
        true,

      content_type:
        request.headers.get(
          "Content-Type"
        ),

      user_agent:
        request.headers.get(
          "User-Agent"
        )

    }

  );


  let updates;


  if (
    Array.isArray(payload)
  ) {

    updates =
      payload;

  } else if (
    Array.isArray(
      payload?.updates
    )
  ) {

    updates =
      payload.updates;

  } else {

    updates = [
      payload
    ];

  }


  const processed = [];


  for (
    const update
    of updates
  ) {

    try {

      const result =
        await processWebhookUpdate(
          update
        );


      processed.push(
        result
      );

    } catch (error) {

      processed.push({

        saved: false,

        error:
          error?.message ||
          String(error)

      });

    }

  }


  return json({

    ok: true,

    received: true,

    count:
      updates.length,

    processed

  });

}


/*
 * ============================================================
 * RSS PARSER
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
                    "MAX-News-Agent/4.0"

                }

              },

              {

                retries: 1,

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
            extractItems(xml);


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


      return bTime - aTime;

    }

  );

}


/*
 * ============================================================
 * GEMINI / QWEN
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
          part?.text ||
          ""
      )
      .join("") ||

    ""

  ).trim();

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

      },

      {

        retries: 1

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
            model
              ?.supportedGenerationMethods
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
            model.name ||
            ""
          )

            .replace(
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

      },

      {

        retries: 1

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
                "Ты аналитик новостей. Отвечай кратко, фактически и не выдумывай факты."

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
          result.ok,

        error:
          result.data?.error ||
          null

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
          result.ok,

        error:
          result.data?.error ||
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
 * NEWS ANALYSIS
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

Структура:

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

function newsKey(
  item
) {

  return (

    item.link ||

    `${item.title}|${item.pubDate || ""}`

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
      newsKey(item);


    if (
      recentPublished.has(key)
    ) {

      results.push({

        ok: true,

        skipped: true,

        reason:
          "already processed",

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
        item =>
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
        "[CRON] pipeline started"
      );


      const result =
        await runPipeline();


      console.log(

        "[CRON] result:",

        JSON.stringify(
          result
        )

      );


      if (!result.ok) {

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
  async request => {

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;


    /*
     * ========================================================
     * CORS
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
            new Date()
              .toISOString(),

          max_api:
            MAX_API,

          auto_pipeline:
            AUTO_PIPELINE,

          cron_schedule:
            AUTO_PIPELINE
              ? CRON_SCHEDULE
              : null,

          target_chat_configured:
            !!TARGET_CHAT_ID,

          webhook:
            getWebhookUrl(
              request.url
            ),

          endpoints: [

            "/check",

            "/diagnostic",

            "/tls-test",

            "/rss",

            "/models",

            "/max-test",

            "/subscriptions",

            "/cleanup-webhooks",

            "/setup-webhook",

            "/updates",

            "/chat-ids",

            "/stored-chat-ids",

            "/webhook-log",

            "/webhook-test",

            "/chat-test?chat_id=...",

            "/publish-test?chat_id=...",

            "/pipeline",

            "/run",

            "/webhook"

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

        let subscriptions = null;

        let subscriptionsError = null;

        try {

          const result =
            await getSubscriptions();

          subscriptions = {

            ok:
              result.ok,

            status:
              result.status,

            response:
              result.data

          };

        } catch (error) {

          subscriptionsError =
            error?.message ||
            String(error);

        }


        let me = null;

        let meError = null;

        try {

          const result =
            await maxRequest(
              "/me",
              {
                method:
                  "GET"
              }
            );

          me = {

            ok:
              result.ok,

            status:
              result.status,

            response:
              result.data

          };

        } catch (error) {

          meError =
            error?.message ||
            String(error);

        }


        const stored =
          await getStoredChatIds();

        const logs =
          await getWebhookLogs(10);


        return json({

          ok: true,

          service:
            "MAX NEWS AGENT",

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
              AUTO_PIPELINE

          },

          max_me:
            me,

          max_me_error:
            meError,

          subscriptions,

          subscriptions_error:
            subscriptionsError,

          kv: {

            available:
              !!kv,

            stored_chat_ids:
              stored,

            webhook_log_count:
              logs.length

          },

          webhook_logs:
            logs

        });

      }


      /*
       * ======================================================
       * /webhook GET
       *
       * Проверяет, что URL реально существует.
       * ======================================================
       */

      if (
        path ===
        "/webhook" &&
        request.method ===
        "GET"
      ) {

        return json({

          ok: true,

          endpoint:
            "/webhook",

          method:
            "POST",

          status:
            "ready",

          message:
            "MAX webhook endpoint is online. POST events here."

        });

      }


      /*
       * ======================================================
       * /webhook-test
       *
       * Локальный тест Webhook.
       * ======================================================
       */

      if (
        path ===
        "/webhook-test" &&
        request.method ===
        "GET"
      ) {

        const fakeUpdate = {

          update_type:
            "bot_started",

          chat_id:
            "WEBHOOK_TEST_CHAT",

          timestamp:
            Date.now(),

          is_channel:
            false

        };


        const result =
          await processWebhookUpdate(
            fakeUpdate
          );


        return json({

          ok: true,

          test: true,

          processed:
            result,

          stored:
            await getStoredChatIds()

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
        request.method ===
        "GET"
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
        request.method ===
        "GET"
      ) {

        const result = {

          ok: true,

          service:
            "MAX NEWS AGENT",

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


      /*
       * ======================================================
       * /rss
       * ======================================================
       */

      if (
        path ===
        "/rss" &&
        request.method ===
        "GET"
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


      /*
       * ======================================================
       * /subscriptions
       * ======================================================
       */

      if (
        path ===
        "/subscriptions" &&
        request.method ===
        "GET"
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

          status_text:
            result.statusText ||
            null,

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
        request.method ===
        "GET"
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
        request.method ===
        "GET"
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
          ) || "100"

        );


        params.set(

          "timeout",

          url.searchParams.get(
            "timeout"
          ) || "0"

        );


        const marker =
          url.searchParams.get(
            "marker"
          );


        if (marker) {

          params.set(
            "marker",
            marker
          );

        }


        const types =
          url.searchParams.get(
            "types"
          );


        if (types) {

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
            result.data,

          note:
            "При активном Webhook MAX может возвращать пустой updates. Основной источник событий — /webhook."

        });

      }


      /*
       * ======================================================
       * /chat-ids
       * ======================================================
       *
       * Здесь НЕ полагаемся на /updates.
       * Показываем только KV.
       * ======================================================
       */

      if (
        path ===
        "/chat-ids" &&
        request.method ===
        "GET"
      ) {

        const stored =
          await getStoredChatIds();


        return json({

          ok: true,

          provider:
            "MAX",

          endpoint:
            "/chat-ids",

          source:
            "Deno KV",

          chat_ids:
            stored.map(
              x =>
                x.chat_id
            ),

          count:
            stored.length,

          chats:
            stored

        });

      }


      /*
       * ======================================================
       * /stored-chat-ids
       * ======================================================
       */

      if (
        path ===
        "/stored-chat-ids" &&
        request.method ===
        "GET"
      ) {

        const stored =
          await getStoredChatIds();


        return json({

          ok: true,

          source:
            "Deno KV",

          count:
            stored.length,

          chat_ids:
            stored

        });

      }


      /*
       * ======================================================
       * /webhook-log
       * ======================================================
       */

      if (
        path ===
        "/webhook-log" &&
        request.method ===
        "GET"
      ) {

        const limit =
          Number(

            url.searchParams.get(
              "limit"
            ) || "20"

          );


        const logs =
          await getWebhookLogs(
            limit
          );


        return json({

          ok: true,

          source:
            "Deno KV",

          count:
            logs.length,

          logs

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

        let chatId =
          url.searchParams.get(
            "chat_id"
          );


        if (!chatId) {

          const stored =
            await getStoredChatIds();


          if (
            stored.length
          ) {

            chatId =
              String(
                stored[0].chat_id
              );

          }

        }


        if (!chatId) {

          return json(

            {

              ok: false,

              error:
                "Chat ID не найден.",

              next_step:
                "Добавьте бота в MAX-чат и дождитесь webhook-события bot_added или bot_started."

            },

            400

          );

        }


        const text =

          url.searchParams.get(
            "text"
          ) ||

          "ТЕСТ MAX NEWS AGENT\n\n" +
          "Webhook, TLS и API MAX работают.";


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
       * /webhook POST
       * ======================================================
       */

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