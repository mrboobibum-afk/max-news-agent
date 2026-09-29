/*
 * ============================================================
 * MAX NEWS AGENT
 * Deno Deploy
 *
 * RSS -> AI -> MAX
 *
 * MAX:
 * - Russian Trusted Root CA
 * - Russian Trusted Sub CA
 * - Deno HttpClient
 * - Webhook
 * - automatic old webhook cleanup
 * - chat_id -> Deno KV
 * ============================================================
 */

const MAX_API =
  "https://platform-api2.max.ru";

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta";

const QWEN_API =
  "https://dashscope.aliyuncs.com/api/v1";

const DEFAULT_RSS_FEEDS = [
  "https://news.google.com/rss?hl=ru&gl=RU&ceid=RU:ru",
  "https://lenta.ru/rss/news",
  "https://ria.ru/export/rss2/archive/index.xml",
  "https://tass.ru/rss/v2.xml",
  "https://www.kommersant.ru/RSS/news.xml",
  "https://www.interfax.ru/rss.asp",
  "https://www.reuters.com/rssFeed/worldNews",
  "https://feeds.bbci.co.uk/news/world/rss.xml"
];

/*
 * ============================================================
 * ENV
 * ============================================================
 */

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") ||
  "";

const MAX_WEBHOOK_SECRET =
  Deno.env.get("MAX_WEBHOOK_SECRET") ||
  "";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") ||
  "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ||
  "";

const QWEN_API_KEY =
  Deno.env.get("QWEN_API_KEY") ||
  "";

const AUTO_PIPELINE =
  String(
    Deno.env.get("AUTO_PIPELINE") ||
    "false"
  ).toLowerCase() === "true";

const CRON_SCHEDULE =
  Deno.env.get("CRON_SCHEDULE") ||
  "*/30 * * * *";

const RSS_FEEDS =
  (Deno.env.get("RSS_FEEDS") || "")
    .split("\n")
    .map(
      x =>
        x.trim()
    )
    .filter(Boolean)
    .length
    ? (Deno.env.get("RSS_FEEDS") || "")
        .split("\n")
        .map(
          x =>
            x.trim()
        )
        .filter(Boolean)
    : DEFAULT_RSS_FEEDS;

/*
 * ============================================================
 * RUSSIAN CA CERTIFICATES
 *
 * ВАЖНО:
 * Этот блок НЕ МЕНЯТЬ.
 * ============================================================
 */

const MAX_ROOT_CA =
`-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgISAwAAAAAABBBBBBBBBBBBBBBBBBBBBBBB
-----END CERTIFICATE-----`;

const MAX_SUB_CA =
`-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgISAwAAAAAACCCCCCCCCCCCCCCCCCCCCCC
-----END CERTIFICATE-----`;

/*
 * ============================================================
 * MAX HTTP CLIENT
 * ============================================================
 */

let maxHttpClient = null;

let maxHttpClientError = null;

const maxCaStatus = {
  loaded:
    false,

  root:
    false,

  sub:
    false,

  error:
    null
};


async function initMaxHttpClient() {

  if (
    maxHttpClient
  ) {

    return maxHttpClient;
  }


  try {

    const certs = [];


    if (
      MAX_ROOT_CA &&
      MAX_ROOT_CA.includes(
        "BEGIN CERTIFICATE"
      )
    ) {

      certs.push(
        MAX_ROOT_CA
      );

      maxCaStatus.root =
        true;
    }


    if (
      MAX_SUB_CA &&
      MAX_SUB_CA.includes(
        "BEGIN CERTIFICATE"
      )
    ) {

      certs.push(
        MAX_SUB_CA
      );

      maxCaStatus.sub =
        true;
    }


    if (
      certs.length ===
      0
    ) {

      throw new Error(
        "MAX CA certificates are not configured"
      );
    }


    maxHttpClient =
      Deno.createHttpClient({

        caCerts:
          certs

      });


    maxCaStatus.loaded =
      true;

    maxCaStatus.error =
      null;

    maxHttpClientError =
      null;


    return maxHttpClient;

  } catch (
    error
  ) {

    maxCaStatus.loaded =
      false;

    maxCaStatus.error =
      error?.message ||
      String(error);

    maxHttpClientError =
      error?.message ||
      String(error);


    return null;
  }
}


/*
 * ============================================================
 * KV
 * ============================================================
 */

let kv = null;


async function initKV() {

  if (
    kv
  ) {

    return kv;
  }


  try {

    kv =
      await Deno.openKv();

    return kv;

  } catch (
    error
  ) {

    console.error(
      "Deno KV error:",
      error
    );

    return null;
  }
}


await initKV();


/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

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

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "*",

        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS"
      }
    }
  );
}


function getWebhookUrl(
  requestUrl
) {

  const url =
    new URL(
      requestUrl
    );

  return `${url.origin}/webhook`;
}


function safeJson(
  value
) {

  try {

    return JSON.stringify(
      value
    );

  } catch {

    return String(
      value
    );
  }
}


/*
 * ============================================================
 * MAX REQUEST
 * ============================================================
 */

async function maxRequest(
  path,
  options = {}
) {

  const client =
    await initMaxHttpClient();


  if (
    !client
  ) {

    return {

      ok:
        false,

      status:
        599,

      statusText:
        "Network Error",

      error_type:
        "client",

      error_name:
        "MAX_HTTP_CLIENT_ERROR",

      error_message:
        maxHttpClientError,

      data:
        {
          error:
            "MAX HTTP client unavailable",

          details:
            maxHttpClientError,

          path
        }
    };
  }


  if (
    !MAX_BOT_TOKEN
  ) {

    return {

      ok:
        false,

      status:
        500,

      statusText:
        "Configuration Error",

      error_type:
        "config",

      error_name:
        "MAX_BOT_TOKEN_MISSING",

      error_message:
        "MAX_BOT_TOKEN is not configured",

      data:
        {
          error:
            "MAX_BOT_TOKEN is not configured",

          path
        }
    };
  }


  const url =
    `${MAX_API}${path}`;


  const headers = {
    "Authorization":
      MAX_BOT_TOKEN,

    "Content-Type":
      "application/json",

    "Accept":
      "application/json"
  };


  try {

    const response =
      await fetch(
        url,
        {
          ...options,

          client,

          headers: {
            ...headers,

            ...(options.headers || {})
          }
        }
      );


    const text =
      await response.text();


    let data;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      data =
        text;
    }


    return {

      ok:
        response.ok,

      status:
        response.status,

      statusText:
        response.statusText,

      error_type:
        null,

      error_name:
        null,

      error_message:
        null,

      data
    };

  } catch (
    error
  ) {

    return {

      ok:
        false,

      status:
        599,

      statusText:
        "Network Error",

      error_type:
        "fetch",

      error_name:
        error?.name ||
        "Error",

      error_message:
        error?.message ||
        String(error),

      data:
        {
          error:
            "fetch failed",

          error_name:
            error?.name ||
            "Error",

          path,

          api:
            MAX_API,

          url
        }
    };
  }
}


/*
 * ============================================================
 * MAX /me
 * ============================================================
 */

async function getMaxMe() {

  return await maxRequest(
    "/me",
    {
      method:
        "GET"
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
      method:
        "GET"
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
      method:
        "DELETE"
    }
  );
}


async function createSubscription(
  webhookUrl
) {

  return await maxRequest(
    "/subscriptions",

    {
      method:
        "POST",

      body:
        JSON.stringify({

          url:
            webhookUrl,

          secret:
            MAX_WEBHOOK_SECRET ||
            undefined,

          update_types:
            MAX_WEBHOOK_UPDATE_TYPES
        })
    }
  );
}


/*
 * ============================================================
 * WEBHOOK CONFIG
 * ============================================================
 */

const MAX_WEBHOOK_UPDATE_TYPES = [
  "bot_added",
  "bot_started",
  "bot_stopped",
  "bot_removed",
  "chat_title_changed",
  "dialog_cleared",
  "dialog_muted",
  "dialog_unmuted",
  "dialog_removed",
  "message_created",
  "message_edited",
  "message_removed",
  "message_callback",
  "comment_created",
  "comment_edited",
  "comment_removed",
  "user_added",
  "user_removed",
  "bot_admin_permissions_changed"
];


/*
 * ============================================================
 * CLEANUP WEBHOOKS
 * ============================================================
 */

async function cleanupWebhooks(
  currentWebhook
) {

  const before =
    await getSubscriptions();


  const subscriptions =
    Array.isArray(
      before.data?.subscriptions
    )
      ? before.data.subscriptions
      : [];


  const deleted = [];


  for (
    const subscription
    of subscriptions
  ) {

    const url =
      subscription?.url;


    if (
      !url ||
      url ===
        currentWebhook
    ) {

      continue;
    }


    const result =
      await deleteSubscription(
        url
      );


    deleted.push({

      url,

      ok:
        result.ok,

      http_status:
        result.status,

      response:
        result.data
    });
  }


  return {

    subscriptions_before:
      before.data,

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

  const webhookUrl =
    getWebhookUrl(
      requestUrl
    );


  const before =
    await getSubscriptions();


  const cleanup =
    await cleanupWebhooks(
      webhookUrl
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
      {
        loaded:
          maxCaStatus.loaded,

        root:
          maxCaStatus.root,

        sub:
          maxCaStatus.sub,

        error:
          maxCaStatus.error
      },

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
 * DENO KV CHAT STORAGE
 * ============================================================
 */

async function saveChatId(
  chatId,
  meta = {}
) {

  if (
    !kv ||
    chatId ===
      undefined ||
    chatId ===
      null
  ) {

    return false;
  }


  const id =
    String(
      chatId
    );


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


  return true;
}


async function deleteChatId(
  chatId
) {

  if (
    !kv ||
    chatId ===
      undefined ||
    chatId ===
      null
  ) {

    return false;
  }


  await kv.delete(
    [
      "max",
      "chat",
      String(
        chatId
      )
    ]
  );


  return true;
}


/*
 * ============================================================
 * WEBHOOK DIAGNOSTIC LOG
 * ============================================================
 */

async function saveWebhookLog(
  payload,
  meta = {}
) {

  if (
    !kv
  ) {

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

  if (
    !kv
  ) {

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

      reverse:
        true,

      limit:
        Math.min(
          100,
          Math.max(
            1,
            Number(
              limit
            ) || 20
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
 * GET STORED CHAT IDS
 * ============================================================
 */

async function getStoredChatIds() {

  if (
    !kv
  ) {

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
      entry?.value
        ?.chat_id
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
 * EXTRACT CHAT ID
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
    value ===
      undefined ||
    value ===
      null
  ) {

    return null;
  }


  return String(
    value
  );
}


/*
 * ============================================================
 * PROCESS WEBHOOK UPDATE
 * ============================================================
 */

async function processWebhookUpdate(
  update
) {

  if (
    !update
  ) {

    return {

      saved:
        false,

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


  /*
   * Бот удалён из чата.
   */

  if (
    updateType ===
      "bot_removed"
  ) {

    if (
      chatId
    ) {

      await deleteChatId(
        chatId
      );
    }


    return {

      saved:
        false,

      deleted:
        chatId,

      update_type:
        updateType
    };
  }


  /*
   * Любое событие с chat_id
   * сохраняем.
   */

  if (
    chatId
  ) {

    await saveChatId(

      chatId,

      {

        is_channel:
          update.is_channel ??
          null,

        update_type:
          updateType,

        timestamp:
          update.timestamp ??
          Date.now()
      }
    );


    return {

      saved:
        true,

      chat_id:
        chatId,

      update_type:
        updateType
    };
  }


  return {

    saved:
      false,

    chat_id:
      null,

    update_type:
      updateType,

    reason:
      "chat_id_not_found"
  };
}


/*
 * ============================================================
 * GET UPDATES
 * ============================================================
 */

async function getUpdates(
  options = {}
) {

  const params =
    new URLSearchParams();


  params.set(
    "limit",

    String(
      options.limit ??
      100
    )
  );


  params.set(
    "timeout",

    String(
      options.timeout ??
      0
    )
  );


  if (
    options.marker !==
    undefined &&
    options.marker !==
    null
  ) {

    params.set(
      "marker",

      String(
        options.marker
      )
    );
  }


  if (
    options.types
  ) {

    params.set(
      "types",

      options.types
    );
  }


  return await maxRequest(
    `/updates?${params.toString()}`,

    {
      method:
        "GET"
    }
  );
}


/*
 * ============================================================
 * UPDATE SUMMARY
 * ============================================================
 */

function getUpdateSummary(
  data
) {

  const updates =
    Array.isArray(
      data?.updates
    )
      ? data.updates
      : [];


  return {

    count:
      updates.length,

    marker:
      data?.marker ??
      null,

    types:
      [
        ...new Set(
          updates
            .map(
              update =>
                update?.update_type
            )
            .filter(Boolean)
        )
      ]
  };
}


/*
 * ============================================================
 * RSS
 * ============================================================
 */

async function fetchRSS(
  feedUrl
) {

  try {

    const response =
      await fetch(
        feedUrl
      );


    if (
      !response.ok
    ) {

      return {

        ok:
          false,

        url:
          feedUrl,

        status:
          response.status,

        error:
          `HTTP ${response.status}`
      };
    }


    const text =
      await response.text();


    return {

      ok:
        true,

      url:
        feedUrl,

      status:
        response.status,

      text
    };

  } catch (
    error
  ) {

    return {

      ok:
        false,

      url:
        feedUrl,

      status:
        0,

      error:
        error?.message ||
        String(error)
    };
  }
}


function stripHtml(
  text = ""
) {

  return String(
    text
  )
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function parseRSSItems(
  xml,
  sourceUrl
) {

  const items = [];


  const matches =
    String(
      xml
    ).match(
      /<item[\s\S]*?<\/item>/gi
    ) || [];


  for (
    const itemXml
    of matches
  ) {

    const get =
      tag => {

        const match =
          itemXml.match(
            new RegExp(
              `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
              "i"
            )
          );


        return match
          ? stripHtml(
              match[1]
            )
          : "";
      };


    const title =
      get(
        "title"
      );

    const link =
      get(
        "link"
      );

    const description =
      get(
        "description"
      );

    const pubDate =
      get(
        "pubDate"
      );


    if (
      !title &&
      !description
    ) {

      continue;
    }


    items.push({

      title,

      link,

      description,

      pubDate,

      source:
        sourceUrl
    });
  }


  return items;
}


/*
 * ============================================================
 * RSS COLLECTION
 * ============================================================
 */

async function collectNews() {

  const all = [];


  for (
    const feedUrl
    of RSS_FEEDS
  ) {

    const result =
      await fetchRSS(
        feedUrl
      );


    if (
      !result.ok
    ) {

      continue;
    }


    const items =
      parseRSSItems(
        result.text,
        feedUrl
      );


    for (
      const item
      of items
    ) {

      all.push(
        item
      );
    }
  }


  const seen =
    new Set();


  const unique = [];


  for (
    const item
    of all
  ) {

    const key =
      `${item.title}|${item.link}`
        .toLowerCase();


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
 * GEMINI
 * ============================================================
 */

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];


async function geminiRequest(
  model,
  prompt
) {

  if (
    !GEMINI_API_KEY
  ) {

    return {

      ok:
        false,

      error:
        "GEMINI_API_KEY is not configured"
    };
  }


  const url =
    `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;


  try {

    const response =
      await fetch(
        url,

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

              ]
            })
        }
      );


    const text =
      await response.text();


    let data;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      data =
        text;
    }


    if (
      !response.ok
    ) {

      return {

        ok:
          false,

        status:
          response.status,

        data
      };
    }


    const generated =
      data
        ?.candidates
        ?.0
        ?.content
        ?.parts
        ?.0
        ?.text ||
      "";


    return {

      ok:
        true,

      status:
        response.status,

      text:
        generated,

      data
    };

  } catch (
    error
  ) {

    return {

      ok:
        false,

      error:
        error?.message ||
        String(error)
    };
  }
}


async function generateWithGemini(
  prompt
) {

  for (
    const model
    of GEMINI_MODELS
  ) {

    const result =
      await geminiRequest(
        model,
        prompt
      );


    if (
      result.ok
    ) {

      return {

        ok:
          true,

        model,

        text:
          result.text
      };
    }
  }


  return {

    ok:
      false,

    error:
      "Gemini generation failed"
  };
}


/*
 * ============================================================
 * QWEN
 * ============================================================
 */

const QWEN_MODELS = [
  "qwen-plus",
  "qwen-turbo"
];


async function qwenRequest(
  model,
  prompt
) {

  if (
    !QWEN_API_KEY
  ) {

    return {

      ok:
        false,

      error:
        "QWEN_API_KEY is not configured"
    };
  }


  try {

    const response =
      await fetch(
        `${QWEN_API}/services/aigc/text-generation/generation`,

        {

          method:
            "POST",

          headers: {

            "Authorization":
              `Bearer ${QWEN_API_KEY}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              model,

              input: {

                messages: [

                  {
                    role:
                      "user",

                    content:
                      prompt
                  }

                ]
              },

              parameters: {

                result_format:
                  "message"
              }
            })
        }
      );


    const text =
      await response.text();


    let data;


    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      data =
        text;
    }


    if (
      !response.ok
    ) {

      return {

        ok:
          false,

        status:
          response.status,

        data
      };
    }


    const generated =
      data
        ?.output
        ?.choices
        ?.0
        ?.message
        ?.content ||
      "";


    return {

      ok:
        true,

      status:
        response.status,

      text:
        generated,

      data
    };

  } catch (
    error
  ) {

    return {

      ok:
        false,

      error:
        error?.message ||
        String(error)
    };
  }
}


async function generateWithQwen(
  prompt
) {

  for (
    const model
    of QWEN_MODELS
  ) {

    const result =
      await qwenRequest(
        model,
        prompt
      );


    if (
      result.ok
    ) {

      return {

        ok:
          true,

        model,

        text:
          result.text
      };
    }
  }


  return {

    ok:
      false,

    error:
      "Qwen generation failed"
  };
}


/*
 * ============================================================
 * NEWS GENERATION
 * ============================================================
 */

async function generateNewsPost(
  item
) {

  const prompt = `
Ты редактор новостного канала ФАКТОР.

Сделай короткий новостной пост на русском языке.

Требования:
- только проверяемые факты из исходной новости;
- без выдумок;
- без лишнего пафоса;
- заголовок короткий;
- основной текст 2–4 коротких абзаца;
- в конце укажи источник;
- не используй #aivideo;
- не называй текст "AI";
- не добавляй неподтверждённые детали.

Исходная новость:

ЗАГОЛОВОК:
${item.title}

ОПИСАНИЕ:
${item.description}

ССЫЛКА:
${item.link}

ИСТОЧНИК:
${item.source}
`;


  let result =
    await generateWithGemini(
      prompt
    );


  if (
    !result.ok
  ) {

    result =
      await generateWithQwen(
        prompt
      );
  }


  if (
    !result.ok
  ) {

    return {

      ok:
        false,

      error:
        "All AI providers failed"
    };
  }


  return {

    ok:
      true,

    model:
      result.model,

    text:
      result.text
  };
}


/*
 * ============================================================
 * MAX SEND MESSAGE
 * ============================================================
 */

async function sendMaxMessage(
  chatId,
  text
) {

  if (
    !chatId
  ) {

    return {

      ok:
        false,

      error:
        "chat_id is required"
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

          text:
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

  const news =
    await collectNews();


  if (
    !news.length
  ) {

    return {

      ok:
        true,

      published:
        0,

      reason:
        "No news items"
    };
  }


  const targetChat =
    TARGET_CHAT_ID ||
    (
      (
        await getStoredChatIds()
      )[0]
        ?.chat_id
    );


  if (
    !targetChat
  ) {

    return {

      ok:
        false,

      published:
        0,

      error:
        "TARGET_CHAT_ID is not configured and no stored chat_id exists"
    };
  }


  let published =
    0;


  const results = [];


  for (
    const item
    of news.slice(
      0,
      5
    )
  ) {

    const generated =
      await generateNewsPost(
        item
      );


    if (
      !generated.ok
    ) {

      results.push({

        title:
          item.title,

        ok:
          false,

        error:
          generated.error
      });

      continue;
    }


    const sent =
      await sendMaxMessage(
        targetChat,
        generated.text
      );


    results.push({

      title:
        item.title,

      ok:
        sent.ok,

      status:
        sent.status,

      response:
        sent.data
    });


    if (
      sent.ok
    ) {

      published++;
    }
  }


  return {

    ok:
      true,

    target_chat:
      targetChat,

    published,

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

    "MAX News Pipeline",

    CRON_SCHEDULE,

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

        ok:
          true
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

          ok:
            true,

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

          ok:
            true,

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

          const max =
            await getMaxMe();


          result.checks.max =
            {

              configured:
                true,

              ok:
                max.ok,

              status:
                max.status,

              response:
                max.data
            };
        }


        return json(
          result
        );
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
       * /rss
       * ======================================================
       */

      if (
        path ===
          "/rss" &&
        request.method ===
          "GET"
      ) {

        const news =
          await collectNews();


        return json({

          ok:
            true,

          count:
            news.length,

          items:
            news
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

        return json({

          ok:
            true,

          gemini:
            GEMINI_MODELS,

          qwen:
            QWEN_MODELS
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
            getWebhookUrl(
              request.url
            )
          );


        return json({

          ok:
            true,

          operation:
            "cleanup-webhooks",

          result
        });
      }


      /*
       * ======================================================
       * /setup-webhook
       *
       * ГЛАВНАЯ КОМАНДА.
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
          await getUpdates();


        const updates =
          Array.isArray(
            result.data?.updates
          )
            ? result.data
                .updates
            : [];


        const saved = [];


        for (
          const update
          of updates
        ) {

          const processed =
            await processWebhookUpdate(
              update
            );


          if (
            processed.chat_id
          ) {

            saved.push(
              processed
            );
          }
        }


        const chatIds =
          [
            ...new Set(

              updates

                .map(
                  extractChatId
                )

                .filter(
                  Boolean
                )
            )
          ];


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

          saved,

          raw:
            result.data
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

          ok:
            true,

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
       *
       * Диагностика входящих webhook-событий MAX.
       *
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
            ) ||

            "20"
          );


        const logs =
          await getWebhookLogs(
            limit
          );


        return json({

          ok:
            true,

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


        if (
          !chatId
        ) {

          return json(

            {

              ok:
                false,

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


        /*
         * Если ID не передан —
         * берём первый сохранённый.
         */

        if (
          !chatId
        ) {

          const stored =
            await getStoredChatIds();


          chatId =
            stored[0]
              ?.chat_id ||
            null;
        }


        if (
          !chatId
        ) {

          return json(

            {

              ok:
                false,

              error:
                "chat_id не найден.",

              usage:
                "/publish-test?chat_id=123456789",

              stored:
                await getStoredChatIds()
            },

            400
          );
        }


        const message =
          `ФАКТОР — тест публикации

Время: ${new Date().toLocaleString(
            "ru-RU"
          )}

MAX API работает.`;



        const result =
          await sendMaxMessage(

            chatId,

            message
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
       * ======================================================
       */

      if (
        path ===
          "/pipeline" &&
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
       * /webhook
       *
       * MAX -> сюда
       *
       * ВАЖНО:
       * 1. Проверяем секрет.
       * 2. Читаем сырой body.
       * 3. Сохраняем ПОЛНЫЙ payload в Deno KV.
       * 4. Обрабатываем chat_id.
       *
       * ======================================================
       */

      if (
        path ===
          "/webhook" &&
        request.method ===
          "POST"
      ) {

        /*
         * Проверяем secret только если
         * он задан.
         */

        let secretValid =
          true;


        if (
          MAX_WEBHOOK_SECRET
        ) {

          const incomingSecret =
            request.headers.get(
              "X-Max-Bot-Api-Secret"
            );


          secretValid =
            incomingSecret ===
            MAX_WEBHOOK_SECRET;


          if (
            !secretValid
          ) {

            /*
             * В диагностический журнал
             * сам секрет НЕ сохраняем.
             */

            await saveWebhookLog(

              {
                error:
                  "Invalid MAX webhook secret",

                headers: {

                  content_type:
                    request.headers.get(
                      "Content-Type"
                    ),

                  user_agent:
                    request.headers.get(
                      "User-Agent"
                    ),

                  has_secret:
                    !!incomingSecret
                }
              },

              {

                method:
                  request.method,

                path,

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

                ok:
                  false,

                error:
                  "Invalid MAX webhook secret"

              },

              401
            );
          }
        }


        let rawBody =
          "";

        let payload;


        try {

          rawBody =
            await request.text();


          payload =
            rawBody
              ? JSON.parse(
                  rawBody
                )
              : null;

        } catch (
          error
        ) {

          await saveWebhookLog(

            {

              raw_body:
                rawBody,

              parse_error:
                error?.message ||
                String(error)

            },

            {

              method:
                request.method,

              path,

              secret_valid:
                secretValid,

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

              ok:
                false,

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
         * СОХРАНЯЕМ ПОЛНЫЙ PAYLOAD.
         *
         * Здесь специально сохраняется
         * всё, что прислал MAX.
         */

        await saveWebhookLog(

          payload,

          {

            method:
              request.method,

            path,

            secret_valid:
              secretValid,

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


        /*
         * Поддерживаем как один Update,
         * так и массив updates.
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

              : [
                  payload
                ];


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

          } catch (
            error
          ) {

            processed.push({

              saved:
                false,

              error:
                error?.message ||
                String(error)
            });
          }
        }


        /*
         * MAX должен получить 200.
         */

        return json({

          ok:
            true,

          received:
            true,

          count:
            updates.length,

          processed
        });
      }


      /*
       * ======================================================
       * UNKNOWN ROUTE
       * ======================================================
       */

      return json(

        {

          ok:
            false,

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
        "MAX NEWS AGENT ERROR:",
        error
      );


      return json(

        {

          ok:
            false,

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
