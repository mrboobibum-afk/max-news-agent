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

const MAX_WEBHOOK_SECRET =
  Deno.env.get("MAX_WEBHOOK_SECRET") ||
  (MAX_BOT_TOKEN
    ? `factor-${MAX_BOT_TOKEN.slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, "")}`
    : "");

const PUBLIC_BASE_URL =
  (Deno.env.get("PUBLIC_BASE_URL") || "")
    .replace(/\/$/, "");

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
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Max-Bot-Api-Secret"
      }
    }
  );
}

const RETRIES =
  numberEnv("API_RETRIES", 3);

const REQUEST_TIMEOUT_MS =
  numberEnv("API_TIMEOUT_MS", 25000);

const AUTO_PIPELINE =
  (
    Deno.env.get("AUTO_PIPELINE") || "false"
  ).toLowerCase() === "true";

const CRON_SCHEDULE =
  Deno.env.get("CRON_SCHEDULE") ||
  "*/15 * * * *";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") || "";

const MAX_NEWS_PER_RUN =
  numberEnv("MAX_NEWS_PER_RUN", 1);

const GEMINI_MODELS =
  parseList(
    Deno.env.get("GEMINI_MODELS") ||
    "gemini-3.8-flash,gemini-2.5-flash,gemini-3-flash-preview,gemini-2.5-pro"
  );

const QWEN_MODELS =
  parseList(
    Deno.env.get("QWEN_MODELS") ||
    "qwen3.8-flash,qwen3.7-plus,qwen3.6-flash,qwen-plus,qwen3.5-flash,qwen3.5-plus"
  );

const RSS_FEEDS = [
  "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"
];

let discoveredGeminiModels = null;
let discoveredQwenModels = null;
let kv = null;

try {
  kv = await Deno.openKv();
} catch (error) {
  console.error(
    "Deno KV unavailable:",
    error?.message || error
  );
}

const recentPublished = new Map();

async function readJson(response) {
  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    headers: response.headers
  };
}

async function fetchJson(url, options = {}, config = {}) {
  const retries =
    config.retries ?? RETRIES;

  const timeoutMs =
    config.timeoutMs ?? REQUEST_TIMEOUT_MS;

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
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const response = await fetch(
        url,
        {
          ...options,
          signal: controller.signal
        }
      );

      const result = await readJson(response);

      last = result;

      if (result.ok) {
        return result;
      }

      if (
        !isRetryableStatus(result.status) ||
        attempt >= retries
      ) {
        return result;
      }

      const retryAfter =
        Number(
          response.headers.get("Retry-After")
        );

      const delay =
        Number.isFinite(retryAfter) &&
        retryAfter >= 0
          ? Math.min(
              retryAfter * 1000,
              60000
            )
          : Math.min(
              1000 * 2 ** attempt,
              10000
            ) +
            Math.floor(
              Math.random() * 500
            );

      await sleep(delay);
    } catch (error) {
      last = {
        ok: false,
        status:
          error?.name === "AbortError"
            ? 504
            : 599,
        data: {
          error:
            error?.name === "AbortError"
              ? "Request timeout"
              : error?.message ||
                String(error)
        }
      };

      if (attempt < retries) {
        await sleep(
          Math.min(
            1000 * 2 ** attempt,
            10000
          ) +
          Math.floor(
            Math.random() * 500
          )
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return last;
}

function requireSecret(value, name) {
  if (!value) {
    throw new Error(
      `Secret ${name} не настроен в Deno Deploy`
    );
  }
}

async function maxRequest(path, options = {}) {
  requireSecret(
    MAX_BOT_TOKEN,
    "MAX_BOT_TOKEN"
  );

  const cleanPath =
    path.startsWith("/")
      ? path
      : `/${path}`;

  return fetchJson(
    `${MAX_API}${cleanPath}`,
    {
      ...options,
      headers: {
        Authorization: MAX_BOT_TOKEN,
        Accept: "application/json",
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

function extractGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("") || ""
  ).trim();
}

function extractQwenText(data) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    ""
  ).trim();
}

async function discoverGeminiModels() {
  if (!GEMINI_API_KEY) return [];

  if (discoveredGeminiModels) {
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
    discoveredGeminiModels = [];
    return [];
  }

  discoveredGeminiModels =
    (
      Array.isArray(result.data?.models)
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
            model.name || ""
          ).replace(
            /^models\//,
            ""
          )
      )
      .filter(Boolean);

  return discoveredGeminiModels;
}

async function discoverQwenModels() {
  if (!QWEN_API_KEY) return [];

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
    discoveredQwenModels = [];
    return [];
  }

  const raw =
    Array.isArray(result.data?.data)
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
  ].slice(0, limit);
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
          temperature: 0.35,
          maxOutputTokens: 1400
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
              "Ты редактор новостного канала. Пиши быстро, ясно и фактически. Не выдумывай факты, не используй агитацию и не приписывай людям мотивы без источника."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        stream: false
      })
    }
  );
}

async function generateWithFallback(
  prompt
) {
  const attempts = [];

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
    const model of geminiModels
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
          result.ok
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
    const model of qwenModels
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
          result.ok
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
    xml.match(regex);

  if (!match) return "";

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

function extractItems(xml) {
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

    if (!title) continue;

    items.push({
      title,
      link:
        extractTag(
          item,
          "link"
        ),
      description:
        extractTag(
          item,
          "description"
        ),
      pubDate:
        extractTag(
          item,
          "pubDate"
        )
    });
  }

  return items;
}

async function fetchRSS() {
  return Promise.all(
    RSS_FEEDS.map(
      async (feed) => {
        const result =
          await fetchJson(
            feed,
            {
              method: "GET",
              headers: {
                "User-Agent":
                  "FACTOR-MAX-News-Agent/3.0"
              }
            },
            {
              retries: 2,
              timeoutMs: 15000
            }
          );

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
              result.data?.error ||
              "RSS response is not plain XML",
            items: []
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
}

function flattenNews(feeds) {
  return feeds
    .flatMap(
      (feed) =>
        feed.ok
          ? (
              feed.items || []
            ).map(
              (item) => ({
                ...item,
                source_feed:
                  feed.feed
              })
            )
          : []
    )
    .sort(
      (a, b) =>
        (
          Date.parse(
            b.pubDate || ""
          ) || 0
        ) -
        (
          Date.parse(
            a.pubDate || ""
          ) || 0
        )
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

function newsKey(item) {
  return (
    item.link ||
    `${item.title}|${item.pubDate || ""}`
  );
}

async function kvGetChats() {
  const ids =
    new Set(
      TARGET_CHAT_ID
        ? [
            String(
              TARGET_CHAT_ID
            )
          ]
        : []
    );

  if (!kv) {
    return [...ids];
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
      ids.add(
        String(
          entry.value?.chat_id ||
          entry.key?.[1] ||
          ""
        )
      );
    }
  } catch (error) {
    console.error(
      "KV read chats:",
      error?.message ||
        error
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
    update?.chat?.chat_id;

  if (
    chatId === undefined ||
    chatId === null ||
    !kv
  ) {
    return;
  }

  const id =
    String(chatId);

  const value = {
    chat_id: id,
    update_type:
      update?.update_type ||
      null,
    is_channel:
      update?.is_channel ??
      null,
    updated_at:
      new Date().toISOString()
  };

  try {
    await kv.set(
      [
        "max-chat",
        id
      ],
      value
    );
  } catch (error) {
    console.error(
      "KV save chat:",
      error?.message ||
        error
    );
  }
}

async function kvDeleteChat(
  update
) {
  const chatId =
    update?.chat_id;

  if (
    chatId !== undefined &&
    chatId !== null &&
    kv
  ) {
    try {
      await kv.delete([
        "max-chat",
        String(chatId)
      ]);
    } catch {}
  }
}

async function kvPublished(
  key
) {
  if (!kv) {
    return recentPublished.has(
      key
    );
  }

  try {
    const result =
      await kv.get([
        "published",
        key
      ]);

    return !!result.value;
  } catch {
    return recentPublished.has(
      key
    );
  }
}

async function kvMarkPublished(
  key
) {
  recentPublished.set(
    key,
    Date.now()
  );

  if (!kv) return;

  try {
    await kv.set(
      [
        "published",
        key
      ],
      {
        published_at:
          new Date().toISOString()
      }
    );
  } catch {}
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
          "chat_id не задан"
      }
    };
  }

  return maxRequest(
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

async function publishToAllChats(
  text
) {
  const chats =
    await kvGetChats();

  const results = [];

  for (
    const chatId of chats
  ) {
    const result =
      await publishToMax(
        chatId,
        text
      );

    results.push({
      chat_id:
        chatId,
      ok:
        result.ok,
      http_status:
        result.status,
      response:
        result.data
    });

    if (
      !result.ok &&
      result.status === 404
    ) {
      await kvDeleteChat({
        chat_id:
          chatId
      });
    }

    await sleep(550);
  }

  return {
    ok:
      results.some(
        (item) =>
          item.ok
      ),
    chats:
      results
  };
}

async function runPipeline() {
  const started =
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
      stage: "rss",
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
    const item of selected
  ) {
    const key =
      newsKey(item);

    if (
      await kvPublished(
        key
      )
    ) {
      results.push({
        ok: true,
        skipped: true,
        reason:
          "already published",
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
        stage: "ai",
        item,
        analysis
      });

      continue;
    }

    const text =
      analysis.text.trim();

    let publication = {
      ok: false,
      skipped: true,
      reason:
        "AUTO_PIPELINE=false"
    };

    if (AUTO_PIPELINE) {
      publication =
        await publishToAllChats(
          text
        );

      if (publication.ok) {
        await kvMarkPublished(
          key
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
      started,
    auto_pipeline:
      AUTO_PIPELINE,
    target_chat_configured:
      !!TARGET_CHAT_ID,
    stored_chat_ids:
      await kvGetChats(),
    rss_total:
      news.length,
    results
  };
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
      "user_removed",
      "bot_admin_permissions_changed"
    ].includes(type)
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
    ].includes(type)
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

function deriveWebhookUrl(
  request
) {
  return `${
    PUBLIC_BASE_URL ||
    new URL(
      request.url
    ).origin
  }/webhook`;
}

/*
 * НОВАЯ ЛОГИКА WEBHOOK
 *
 * MAX сам проверяет доступность HTTPS endpoint
 * при POST /subscriptions.
 *
 * Сначала удаляем старую подписку именно нашего
 * webhook URL, затем создаём её заново.
 *
 * Старые чужие подписки не трогаем.
 */

async function deleteWebhookSubscription(
  webhookUrl
) {
  const result =
    await maxRequest(
      `/subscriptions?url=${encodeURIComponent(
        webhookUrl
      )}`,
      {
        method: "DELETE"
      }
    );

  return {
    ok:
      result.ok &&
      result.data?.success !== false,
    http_status:
      result.status,
    response:
      result.data
  };
}

async function getSubscriptions() {
  const result =
    await maxRequest(
      "/subscriptions",
      {
        method: "GET"
      }
    );

  return result;
}

async function createWebhookSubscription(
  webhookUrl
) {
  const body = {
    url: webhookUrl,
    update_types: [
      "bot_started",
      "bot_added",
      "message_created",
      "user_added",
      "user_removed",
      "bot_removed",
      "bot_stopped",
      "bot_admin_permissions_changed"
    ],
    secret:
      MAX_WEBHOOK_SECRET
  };

  return maxRequest(
    "/subscriptions",
    {
      method: "POST",
      body:
        JSON.stringify(body)
    }
  );
}

async function setupWebhook(
  request
) {
  requireSecret(
    MAX_BOT_TOKEN,
    "MAX_BOT_TOKEN"
  );

  const webhookUrl =
    deriveWebhookUrl(
      request
    );

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

  if (
    !MAX_WEBHOOK_SECRET
  ) {
    return {
      ok: false,
      error:
        "MAX_WEBHOOK_SECRET не сформирован",
      webhook_url:
        webhookUrl
    };
  }

  /*
   * Проверяем текущие подписки.
   */
  const before =
    await getSubscriptions();

  if (!before.ok) {
    return {
      ok: false,
      stage:
        "get-subscriptions",
      provider:
        "MAX",
      endpoint:
        "/subscriptions",
      http_status:
        before.status,
      response:
        before.data,
      webhook_url:
        webhookUrl
    };
  }

  const current =
    Array.isArray(
      before.data?.subscriptions
    )
      ? before.data.subscriptions
      : [];

  /*
   * Если наш URL уже существует,
   * сначала удаляем его.
   */
  const existing =
    current.filter(
      (item) =>
        item?.url ===
        webhookUrl
    );

  let deleted = [];

  if (existing.length) {
    const deletion =
      await deleteWebhookSubscription(
        webhookUrl
      );

    deleted.push(
      deletion
    );

    if (
      !deletion.ok
    ) {
      return {
        ok: false,
        stage:
          "delete-existing-webhook",
        provider:
          "MAX",
        endpoint:
          "/subscriptions",
        webhook_url:
          webhookUrl,
        deleted,
        error:
          deletion.response ||
          "Не удалось удалить старую подписку"
      };
    }

    await sleep(500);
  }

  /*
   * Создаём актуальную подписку.
   */
  const created =
    await createWebhookSubscription(
      webhookUrl
    );

  /*
   * Даже если MAX вернул сетевую ошибку,
   * сразу повторно читаем subscriptions.
   *
   * Это важно: POST мог быть принят MAX,
   * но соединение могло оборваться до ответа.
   */
  const after =
    await getSubscriptions();

  const finalSubscriptions =
    Array.isArray(
      after.data?.subscriptions
    )
      ? after.data.subscriptions
      : [];

  const registered =
    finalSubscriptions.some(
      (item) =>
        item?.url ===
        webhookUrl
    );

  return {
    ok:
      registered ||
      (
        created.ok &&
        created.data?.success !== false
      ),
    provider:
      "MAX",
    webhook_url:
      webhookUrl,
    operation:
      "replace-webhook",
    deleted,
    create: {
      http_status:
        created.status,
      ok:
        created.ok,
      response:
        created.data
    },
    verification: {
      http_status:
        after.status,
      ok:
        after.ok,
      registered,
      subscriptions:
        finalSubscriptions
    }
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
      const result =
        await runPipeline();

      console.log(
        "[CRON]",
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
          auto_pipeline:
            AUTO_PIPELINE,
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
            "/publish-test",
            "/pipeline",
            "/run",
            "/webhook"
          ]
        });
      }

      if (
        path === "/check" &&
        request.method ===
          "GET"
      ) {
        const result = {
          ok: false,
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
            },
            webhook: {
              configured:
                !!MAX_WEBHOOK_SECRET,
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

        const result =
          await generateWithFallback(
            prompt
          );

        return json(
          {
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
          },
          result.ok
            ? 200
            : 503
        );
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
          const model of models
        ) {
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
            model,
            ok:
              result.ok,
            http_status:
              result.status
          });

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

        return json(
          {
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
          },
          result.ok
            ? 200
            : 503
        );
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

        return json(
          {
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
          },
          result.ok
            ? 200
            : 503
        );
      }

      if (
        path ===
          "/chat-ids" &&
        request.method ===
          "GET"
      ) {
        return json({
          ok: true,
          provider:
            "MAX",
          endpoint:
            "/chat-ids",
          chat_ids:
            await kvGetChats(),
          source:
            "Deno KV + TARGET_CHAT_ID"
        });
      }

      if (
        path ===
          "/subscriptions" &&
        request.method ===
          "GET"
      ) {
        const result =
          await maxRequest(
            "/subscriptions",
            {
              method:
                "GET"
            }
          );

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
              result.data
          },
          result.ok
            ? 200
            : 503
        );
      }

      if (
        path ===
          "/setup-webhook" &&
        (
          request.method ===
            "GET" ||
          request.method ===
            "POST"
        )
      ) {
        return json(
          await setupWebhook(
            request
          )
        );
      }

      if (
        path ===
          "/publish-test" &&
        request.method ===
          "GET"
      ) {
        const stored =
          await kvGetChats();

        const chatId =
          url.searchParams.get(
            "chat_id"
          ) ||
          stored[0] ||
          TARGET_CHAT_ID;

        if (!chatId) {
          return json(
            {
              ok: false,
              error:
                "chat_id пока не найден. Сначала настрой Webhook и запусти бота."
            },
            400
          );
        }

        const text =
          url.searchParams.get(
            "text"
          ) ||
          "⚡ ТЕСТ\n\nMAX NEWS AGENT успешно подключён и готов к публикации.";

        const result =
          await publishToMax(
            chatId,
            text
          );

        return json(
          {
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
          },
          result.ok
            ? 200
            : 503
        );
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
          path
        },
        500
      );
    }
  }
);
