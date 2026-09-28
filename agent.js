/*
 * ============================================================
 * MAX NEWS AGENT
 * Deno Deploy
 *
 * RSS -> новости
 * Gemini -> анализ
 * Qwen -> резервный анализ
 * MAX -> webhook -> chat_id -> публикация
 *
 * WEBHOOK:
 * - автоматически удаляет старые n8n subscriptions
 * - создаёт текущий Deno /webhook
 * - получает события MAX
 * - сохраняет chat_id в Deno KV
 * ============================================================
 */

const MAX_API = "https://platform-api2.max.ru";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const QWEN_API =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

const QWEN_MODEL = "qwen-plus";

const MAX_BOT_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") || "";

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") || "";

const QWEN_API_KEY =
  Deno.env.get("QWEN_API_KEY") || "";

const MAX_WEBHOOK_SECRET =
  Deno.env.get("MAX_WEBHOOK_SECRET") || "";


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
 * MAX WEBHOOK CONFIG
 * ============================================================
 *
 * События, которые нужны для автоматического получения
 * chat_id и нормальной работы бота.
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

  "message_callback",
  "message_created",
  "message_edited",
  "message_removed",

  "comment_created",
  "comment_edited",
  "comment_removed",

  "user_added",
  "user_removed",

  "bot_admin_permissions_changed"
];


/*
 * ============================================================
 * ИЗВЕСТНЫЕ СТАРЫЕ N8N WEBHOOK
 * ============================================================
 *
 * Эти адреса удаляются автоматически.
 */

const KNOWN_OLD_WEBHOOKS = [
  "https://bogdan15.app.n8n.cloud/webhook-test/m",
  "https://bogdan15.app.n8n.cloud/webhook-test/max-callback",
  "https://bogdan15.app.n8n.cloud/webhook/max-callback"
];


/*
 * ============================================================
 * DENO KV
 * ============================================================
 */

let KV = null;

try {
  KV = await Deno.openKv();
} catch (error) {
  console.error(
    "DENO KV INIT ERROR:",
    error?.message || String(error)
  );
}


/*
 * ============================================================
 * RESPONSE HELPERS
 * ============================================================
 */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
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
          "GET, POST, DELETE, OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Max-Bot-Api-Secret"
      }
    }
  );
}


async function readJson(response) {
  const text = await response.text();

  let data;

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
    ok:
      response.ok,

    status:
      response.status,

    statusText:
      response.statusText,

    data
  };
}


function requireSecret(value, name) {
  if (!value) {
    throw new Error(
      `Secret ${name} не настроен в Deno Deploy`
    );
  }
}


/*
 * ============================================================
 * MAX API REQUEST
 * ============================================================
 */

async function maxRequest(
  path,
  token,
  options = {}
) {
  requireSecret(
    token,
    "MAX_BOT_TOKEN"
  );

  const cleanPath =
    path.startsWith("/")
      ? path
      : `/${path}`;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      30000
    );

  try {
    const response =
      await fetch(
        `${MAX_API}${cleanPath}`,
        {
          ...options,

          signal:
            controller.signal,

          headers: {
            "Authorization":
              token,

            "Accept":
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

    return await readJson(
      response
    );

  } catch (error) {

    return {
      ok:
        false,

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
          String(error),

        error_name:
          error?.name ||
          null,

        path:
          cleanPath,

        api:
          MAX_API,

        url:
          `${MAX_API}${cleanPath}`
      }
    };

  } finally {
    clearTimeout(timeout);
  }
}


/*
 * ============================================================
 * GEMINI
 * ============================================================
 */

async function geminiGenerate(
  apiKey,
  prompt
) {
  requireSecret(
    apiKey,
    "GEMINI_API_KEY"
  );

  const response =
    await fetch(
      `${GEMINI_API}?key=${encodeURIComponent(apiKey)}`,
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
                800
            }
          })
      }
    );

  return await readJson(
    response
  );
}


/*
 * ============================================================
 * QWEN
 * ============================================================
 */

async function qwenGenerate(
  apiKey,
  prompt
) {
  requireSecret(
    apiKey,
    "QWEN_API_KEY"
  );

  const response =
    await fetch(
      QWEN_API,
      {
        method:
          "POST",

        headers: {
          "Authorization":
            `Bearer ${apiKey}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            model:
              QWEN_MODEL,

            messages: [
              {
                role:
                  "system",

                content:
                  "Ты аналитик новостей. Отвечай кратко и фактически."
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

  return await readJson(
    response
  );
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
    const item of matches
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
  const results = [];

  for (
    const feed of RSS_FEEDS
  ) {
    try {

      const response =
        await fetch(
          feed,
          {
            headers: {
              "User-Agent":
                "MAX-News-Agent/1.0"
            }
          }
        );

      if (!response.ok) {

        results.push({
          feed,

          ok:
            false,

          status:
            response.status
        });

        continue;
      }

      const xml =
        await response.text();

      const items =
        extractItems(xml);

      results.push({
        feed,

        ok:
          true,

        count:
          items.length,

        items:
          items.slice(0, 10)
      });

    } catch (error) {

      results.push({
        feed,

        ok:
          false,

        error:
          error?.message ||
          String(error)
      });

    }
  }

  return results;
}


/*
 * ============================================================
 * CHAT ID HELPERS
 * ============================================================
 */

function extractChatIds(data) {
  const ids =
    new Set();

  const updates =
    Array.isArray(data?.updates)
      ? data.updates
      : Array.isArray(data)
        ? data
        : [data];

  for (
    const update of updates
  ) {

    const chatId =
      update?.chat_id ??
      update?.message?.recipient?.chat_id ??
      update?.message?.recipient?.chatId ??
      update?.message?.chat_id ??
      update?.chat?.chat_id ??
      update?.chat?.id;

    if (
      chatId !== undefined &&
      chatId !== null
    ) {

      ids.add(
        String(chatId)
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
    Array.isArray(data?.updates)
      ? data.updates
      : [];

  return updates.map(
    (
      update
    ) => ({

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
 * KV CHAT STORAGE
 * ============================================================
 */

async function saveChatId(
  chatId,
  meta = {}
) {
  if (
    !KV ||
    chatId === undefined ||
    chatId === null
  ) {
    return false;
  }

  const id =
    String(chatId);

  await KV.set(
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
        new Date().toISOString()
    }
  );

  return true;
}


async function deleteChatId(
  chatId
) {
  if (
    !KV ||
    chatId === undefined ||
    chatId === null
  ) {
    return false;
  }

  await KV.delete(
    [
      "max",
      "chat",
      String(chatId)
    ]
  );

  return true;
}


async function getStoredChatIds() {
  if (!KV) {
    return [];
  }

  const ids = [];

  for await (
    const entry of KV.list({
      prefix: [
        "max",
        "chat"
      ]
    })
  ) {

    if (
      entry?.value?.chat_id
    ) {

      ids.push(
        entry.value
      );
    }
  }

  return ids;
}


/*
 * ============================================================
 * WEBHOOK UPDATE PROCESSOR
 * ============================================================
 */

async function processWebhookUpdate(
  update
) {
  if (!update) {
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
    update.chat_id !==
      undefined &&
    update.chat_id !==
      null
      ? String(
          update.chat_id
        )
      : (
          update?.message?.recipient?.chat_id ??
          update?.message?.recipient?.chatId ??
          update?.message?.chat_id ??
          update?.chat?.chat_id ??
          update?.chat?.id
        ) !== undefined &&
        (
          update?.message?.recipient?.chat_id ??
          update?.message?.recipient?.chatId ??
          update?.message?.chat_id ??
          update?.chat?.chat_id ??
          update?.chat?.id
        ) !== null
        ? String(
            update?.message?.recipient?.chat_id ??
            update?.message?.recipient?.chatId ??
            update?.message?.chat_id ??
            update?.chat?.chat_id ??
            update?.chat?.id
          )
        : null;


  /*
   * Если бот удалён из чата —
   * удаляем chat_id из KV.
   */

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
      saved:
        false,

      deleted:
        chatId,

      update_type:
        updateType
    };
  }


  /*
   * Если chat_id найден —
   * сохраняем его.
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
        updateType,

      is_channel:
        update.is_channel ??
        null
    };
  }


  return {
    saved:
      false,

    update_type:
      updateType,

    reason:
      "chat_id_not_present"
  };
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
    new URL(
      requestUrl
    );

  return `${current.origin}/webhook`;
}


/*
 * ============================================================
 * MAX SUBSCRIPTIONS
 * ============================================================
 */

async function getMaxSubscriptions() {
  return await maxRequest(
    "/subscriptions",
    MAX_BOT_TOKEN,
    {
      method:
        "GET"
    }
  );
}


async function deleteMaxSubscription(
  webhookUrl
) {
  const encoded =
    encodeURIComponent(
      webhookUrl
    );

  return await maxRequest(
    `/subscriptions?url=${encoded}`,
    MAX_BOT_TOKEN,
    {
      method:
        "DELETE"
    }
  );
}


async function createMaxSubscription(
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
    MAX_BOT_TOKEN,
    {
      method:
        "POST",

      body:
        JSON.stringify(body)
    }
  );
}


/*
 * ============================================================
 * CLEANUP OLD WEBHOOKS
 * ============================================================
 */

async function cleanupOldWebhooks(
  currentWebhook
) {
  const candidates =
    new Set(
      KNOWN_OLD_WEBHOOKS
    );


  /*
   * Получаем реальные
   * текущие подписки MAX.
   */

  const current =
    await getMaxSubscriptions();

  const found =
    Array.isArray(
      current?.data?.subscriptions
    )
      ? current.data.subscriptions
      : [];


  /*
   * Добавляем в список удаления
   * все найденные webhook-и,
   * кроме нашего текущего.
   */

  for (
    const subscription of found
  ) {

    const url =
      subscription?.url;

    if (
      url &&
      url !==
        currentWebhook
    ) {

      candidates.add(
        url
      );
    }
  }


  const results = [];

  for (
    const webhookUrl of candidates
  ) {

    if (
      !webhookUrl ||
      webhookUrl ===
        currentWebhook
    ) {
      continue;
    }

    const result =
      await deleteMaxSubscription(
        webhookUrl
      );

    results.push({
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

    discovered_subscriptions:
      found,

    deleted:
      results
  };
}


/*
 * ============================================================
 * FULL WEBHOOK SETUP
 * ============================================================
 *
 * 1. Узнаём текущий URL Deno
 * 2. Получаем существующие подписки
 * 3. Удаляем старые n8n
 * 4. Удаляем любые другие старые webhook
 * 5. Создаём текущий /webhook
 * 6. Проверяем итог
 *
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


  /*
   * Получаем исходные подписки.
   */

  const before =
    await getMaxSubscriptions();


  /*
   * Удаляем всё старое,
   * кроме текущего Deno webhook.
   */

  const cleanup =
    await cleanupOldWebhooks(
      webhookUrl
    );


  /*
   * Создаём текущую подписку.
   */

  const created =
    await createMaxSubscription(
      webhookUrl
    );


  /*
   * Проверяем итог.
   */

  const after =
    await getMaxSubscriptions();


  return {
    ok:
      created.ok &&
      after.ok,

    provider:
      "MAX",

    webhook_url:
      webhookUrl,

    update_types:
      MAX_WEBHOOK_UPDATE_TYPES,

    webhook_secret:
      !!MAX_WEBHOOK_SECRET,

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
 * DENO SERVE
 * ============================================================
 */

Deno.serve(
  async (
    request
  ) => {

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
            new Date().toISOString(),

          max_api:
            MAX_API,

          webhook:
            getWebhookUrl(
              request.url
            ),

          endpoints: [
            "/check",
            "/rss",
            "/gemini-test",
            "/qwen-test",
            "/max-test",
            "/updates",
            "/chat-ids",
            "/stored-chat-ids",
            "/chat-test?chat_id=...",
            "/publish-test?chat_id=...",
            "/subscriptions",
            "/cleanup-webhooks",
            "/setup-webhook",
            "/webhook"
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
          ok:
            true,

          service:
            "MAX NEWS AGENT",

          runtime:
            "Deno Deploy",

          checks: {

            gemini: {
              configured:
                !!GEMINI_API_KEY
            },

            qwen: {
              configured:
                !!QWEN_API_KEY
            },

            max: {
              configured:
                !!MAX_BOT_TOKEN
            },

            webhook: {
              configured:
                true,

              url:
                getWebhookUrl(
                  request.url
                )
            }
          }
        };


        /*
         * Gemini API test
         */

        if (
          GEMINI_API_KEY
        ) {

          try {

            const test =
              await geminiGenerate(
                GEMINI_API_KEY,
                "Ответь одним словом: OK"
              );

            result.checks.gemini.api = {
              ok:
                test.ok,

              http_status:
                test.status
            };

          } catch (
            error
          ) {

            result.checks.gemini.api = {
              ok:
                false,

              error:
                error?.message ||
                String(error)
            };
          }
        }


        /*
         * Qwen API test
         */

        if (
          QWEN_API_KEY
        ) {

          try {

            const test =
              await qwenGenerate(
                QWEN_API_KEY,
                "Ответь одним словом: OK"
              );

            result.checks.qwen.api = {
              ok:
                test.ok,

              http_status:
                test.status
            };

          } catch (
            error
          ) {

            result.checks.qwen.api = {
              ok:
                false,

              error:
                error?.message ||
                String(error)
            };
          }
        }


        /*
         * MAX API test
         */

        if (
          MAX_BOT_TOKEN
        ) {

          try {

            const test =
              await maxRequest(
                "/me",
                MAX_BOT_TOKEN,
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

              response:
                test.data
            };

          } catch (
            error
          ) {

            result.checks.max.api = {
              ok:
                false,

              error:
                error?.message ||
                String(error)
            };
          }
        }


        result.ok =
          !!(
            result.checks.gemini.configured &&
            result.checks.qwen.configured &&
            result.checks.max.configured &&
            result.checks.gemini.api?.ok &&
            result.checks.qwen.api?.ok &&
            result.checks.max.api?.ok
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
          ok:
            true,

          total_items:
            total,

          feeds
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
          "Ответь кратко: Gemini API работает?";

        const result =
          await geminiGenerate(
            GEMINI_API_KEY,
            prompt
          );

        return json({
          ok:
            result.ok,

          provider:
            "Google Gemini",

          model:
            GEMINI_MODEL,

          http_status:
            result.status,

          response:
            result.data
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
          "Ответь кратко: Qwen API работает?";

        const result =
          await qwenGenerate(
            QWEN_API_KEY,
            prompt
          );

        return json({
          ok:
            result.ok,

          provider:
            "Alibaba Qwen",

          model:
            QWEN_MODEL,

          http_status:
            result.status,

          response:
            result.data
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
            MAX_BOT_TOKEN,
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
            result.statusText,

          response:
            result.data
        });
      }


      /*
       * ======================================================
       * /subscriptions
       * ======================================================
       *
       * Получение текущих подписок MAX.
       */

      if (
        path ===
          "/subscriptions" &&
        request.method ===
          "GET"
      ) {

        const result =
          await getMaxSubscriptions();

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
            result.statusText,

          response:
            result.data
        });
      }


      /*
       * ======================================================
       * /cleanup-webhooks
       * ======================================================
       *
       * Удаляет старые n8n и любые другие
       * существующие webhook-подписки,
       * кроме текущего Deno /webhook.
       */

      if (
        path ===
          "/cleanup-webhooks" &&
        request.method ===
          "GET"
      ) {

        const webhookUrl =
          getWebhookUrl(
            request.url
          );

        const result =
          await cleanupOldWebhooks(
            webhookUrl
          );

        return json({
          ok:
            true,

          provider:
            "MAX",

          operation:
            "cleanup-webhooks",

          webhook_url:
            webhookUrl,

          result
        });
      }


      /*
       * ======================================================
       * /setup-webhook
       * ======================================================
       *
       * ГЛАВНАЯ КОМАНДА.
       *
       * Делает всё автоматически:
       *
       * 1. получает subscriptions
       * 2. удаляет старые n8n
       * 3. удаляет другие старые webhook
       * 4. создаёт текущий Deno webhook
       * 5. проверяет результат
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
       * /webhook
       * ======================================================
       *
       * СЮДА MAX ПРИСЫЛАЕТ СОБЫТИЯ.
       *
       * Endpoint должен вернуть 200 быстро.
       */

      if (
        path ===
          "/webhook" &&
        request.method ===
          "POST"
      ) {

        /*
         * Проверка секрета MAX,
         * если MAX_WEBHOOK_SECRET задан.
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

            return json({
              ok:
                false,

              error:
                "Invalid MAX webhook secret"
            }, 401);
          }
        }


        let payload;

        try {

          payload =
            await request.json();

        } catch (
          error
        ) {

          return json({
            ok:
              false,

            error:
              "Invalid JSON",

            details:
              error?.message ||
              String(error)
          }, 400);
        }


        /*
         * MAX может прислать Update напрямую.
         *
         * Также поддерживаем массив updates,
         * если он придёт в пакетном формате.
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
          const update of updates
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
         * MAX ждёт HTTP 200.
         */

        return json({
          ok:
            true,

          received:
            true,

          count:
            updates.length,

          processed
        }, 200);
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
            MAX_BOT_TOKEN,
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
       *
       * Оставляем старый endpoint.
       */

      if (
        path ===
          "/chat-ids" &&
        request.method ===
          "GET"
      ) {

        /*
         * Сначала смотрим сохранённые ID.
         */

        const stored =
          await getStoredChatIds();


        /*
         * Потом дополнительно проверяем
         * очередь updates.
         */

        const result =
          await maxRequest(
            "/updates?limit=100&timeout=0",
            MAX_BOT_TOKEN,
            {
              method:
                "GET"
            }
          );


        const chatIds =
          extractChatIds(
            result.data
          );


        /*
         * Сохраняем найденные ID.
         */

        for (
          const id of chatIds
        ) {

          await saveChatId(
            id,
            {
              update_type:
                "updates_poll"
            }
          );
        }


        const allStored =
          await getStoredChatIds();


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
            [
              ...new Set(
                [
                  ...stored.map(
                    x =>
                      String(
                        x.chat_id
                      )
                  ),

                  ...chatIds,

                  ...allStored.map(
                    x =>
                      String(
                        x.chat_id
                      )
                  )
                ]
              )
            ],

          updates:
            getUpdateSummary(
              result.data
            ),

          stored:
            allStored,

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

          return json({
            ok:
              false,

            error:
              "Не указан chat_id.",

            usage:
              "/chat-test?chat_id=123456789"
          }, 400);
        }


        const result =
          await maxRequest(
            `/chats/${encodeURIComponent(chatId)}`,
            MAX_BOT_TOKEN,
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
         * Если chat_id не передали,
         * берём первый сохранённый.
         */

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

          return json({
            ok:
              false,

            error:
              "Chat ID не найден.",

            next_step:
              "Сначала выполните /setup-webhook и дождитесь события bot_added или bot_started."
          }, 400);
        }


        const text =
          url.searchParams.get(
            "text"
          ) ||
          "ТЕСТ MAX NEWS AGENT\n\nWebhook и Worker успешно подключены к API MAX.";


        const result =
          await maxRequest(
            `/messages?chat_id=${encodeURIComponent(chatId)}`,
            MAX_BOT_TOKEN,
            {
              method:
                "POST",

              body:
                JSON.stringify({
                  text
                })
            }
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
       * UNKNOWN ROUTE
       * ======================================================
       */

      return json({
        ok:
          false,

        error:
          "Endpoint not found",

        path
      }, 404);


    } catch (
      error
    ) {

      console.error(
        "MAX NEWS AGENT ERROR:",
        error
      );


      return json({
        ok:
          false,

        error:
          error?.message ||
          String(error),

        error_name:
          error?.name ||
          null
      }, 500);
    }
  }
);
