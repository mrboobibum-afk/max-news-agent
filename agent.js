/*
 * ============================================================
 * MAX NEWS AGENT
 * Deno Deploy
 *
 * RSS -> новости
 * Gemini -> анализ
 * Qwen -> резервный анализ
 * MAX -> проверка -> chat_id -> публикация
 * ============================================================
 */

const MAX_API = "https://platform-api2.max.ru";

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_API =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const QWEN_API =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

const QWEN_MODEL = "qwen-plus";

const MAX_BOT_TOKEN = Deno.env.get("MAX_BOT_TOKEN") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const QWEN_API_KEY = Deno.env.get("QWEN_API_KEY") || "";

const RSS_FEEDS = [
  "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru",
  "https://news.google.com/rss/search?q=технологии+OR+промышленность+OR+авто&hl=ru&gl=RU&ceid=RU:ru"
];

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    }
  );
}

async function readJson(response) {
  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

function requireSecret(value, name) {
  if (!value) {
    throw new Error(`Secret ${name} не настроен в Deno Deploy`);
  }
}

async function maxRequest(path, token, options = {}) {
  requireSecret(token, "MAX_BOT_TOKEN");

  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      `${MAX_API}${cleanPath}`,
      {
        ...options,
        signal: controller.signal,
        headers: {
          "Authorization": token,
          "Accept": "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        }
      }
    );

    return await readJson(response);
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        data: {
          error: "MAX API request timeout",
          path: cleanPath
        }
      };
    }

    return {
      ok: false,
      status: 500,
      data: {
        error: error?.message || String(error),
        path: cleanPath
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function geminiGenerate(apiKey, prompt) {
  requireSecret(apiKey, "GEMINI_API_KEY");

  const response = await fetch(
    `${GEMINI_API}?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
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
          maxOutputTokens: 800
        }
      })
    }
  );

  return await readJson(response);
}

async function qwenGenerate(apiKey, prompt) {
  requireSecret(apiKey, "QWEN_API_KEY");

  const response = await fetch(
    QWEN_API,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          {
            role: "system",
            content: "Ты аналитик новостей. Отвечай кратко и фактически."
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

  return await readJson(response);
}

function extractTag(xml, tag) {
  const regex = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );

  const match = xml.match(regex);

  if (!match) {
    return "";
  }

  return match[1]
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractItems(xml) {
  const items = [];
  const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const item of matches) {
    const title = extractTag(item, "title");
    const link = extractTag(item, "link");
    const description = extractTag(item, "description");
    const pubDate = extractTag(item, "pubDate");

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

  for (const feed of RSS_FEEDS) {
    try {
      const response = await fetch(
        feed,
        {
          headers: {
            "User-Agent": "MAX-News-Agent/1.0"
          }
        }
      );

      if (!response.ok) {
        results.push({
          feed,
          ok: false,
          status: response.status
        });

        continue;
      }

      const xml = await response.text();
      const items = extractItems(xml);

      results.push({
        feed,
        ok: true,
        count: items.length,
        items: items.slice(0, 10)
      });
    } catch (error) {
      results.push({
        feed,
        ok: false,
        error: error?.message || String(error)
      });
    }
  }

  return results;
}

function extractChatIds(data) {
  const ids = new Set();

  const updates =
    Array.isArray(data?.updates)
      ? data.updates
      : [];

  for (const update of updates) {
    if (
      update &&
      update.chat_id !== undefined &&
      update.chat_id !== null
    ) {
      ids.add(String(update.chat_id));
    }
  }

  return [...ids];
}

function getUpdateSummary(data) {
  const updates =
    Array.isArray(data?.updates)
      ? data.updates
      : [];

  return updates.map((update) => ({
    update_type: update?.update_type ?? null,
    chat_id:
      update?.chat_id !== undefined && update?.chat_id !== null
        ? String(update.chat_id)
        : null,
    timestamp: update?.timestamp ?? null,
    is_channel: update?.is_channel ?? null
  }));
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return json({ ok: true });
  }

  try {
    /*
     * ==========================================================
     * /
     * ==========================================================
     */

    if (path === "/" && request.method === "GET") {
      return json({
        ok: true,
        service: "MAX NEWS AGENT",
        runtime: "Deno Deploy",
        status: "online",
        time: new Date().toISOString(),
        endpoints: [
          "/check",
          "/rss",
          "/gemini-test",
          "/qwen-test",
          "/max-test",
          "/updates",
          "/chat-ids",
          "/chat-test?chat_id=...",
          "/publish-test?chat_id=..."
        ]
      });
    }

    /*
     * ==========================================================
     * /check
     * ==========================================================
     */

    if (path === "/check" && request.method === "GET") {
      const result = {
        ok: true,
        service: "MAX NEWS AGENT",
        runtime: "Deno Deploy",
        checks: {
          gemini: {
            configured: !!GEMINI_API_KEY
          },
          qwen: {
            configured: !!QWEN_API_KEY
          },
          max: {
            configured: !!MAX_BOT_TOKEN
          }
        }
      };

      if (GEMINI_API_KEY) {
        try {
          const test = await geminiGenerate(
            GEMINI_API_KEY,
            "Ответь одним словом: OK"
          );

          result.checks.gemini.api = {
            ok: test.ok,
            http_status: test.status
          };
        } catch (error) {
          result.checks.gemini.api = {
            ok: false,
            error: error?.message || String(error)
          };
        }
      }

      if (QWEN_API_KEY) {
        try {
          const test = await qwenGenerate(
            QWEN_API_KEY,
            "Ответь одним словом: OK"
          );

          result.checks.qwen.api = {
            ok: test.ok,
            http_status: test.status
          };
        } catch (error) {
          result.checks.qwen.api = {
            ok: false,
            error: error?.message || String(error)
          };
        }
      }

      if (MAX_BOT_TOKEN) {
        try {
          const test = await maxRequest(
            "/me",
            MAX_BOT_TOKEN,
            {
              method: "GET"
            }
          );

          result.checks.max.api = {
            ok: test.ok,
            http_status: test.status,
            response: test.data
          };
        } catch (error) {
          result.checks.max.api = {
            ok: false,
            error: error?.message || String(error)
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

      return json(result, result.ok ? 200 : 503);
    }

    /*
     * ==========================================================
     * /rss
     * ==========================================================
     */

    if (path === "/rss" && request.method === "GET") {
      const feeds = await fetchRSS();

      const total = feeds.reduce(
        (sum, feed) => sum + (feed.count || 0),
        0
      );

      return json({
        ok: true,
        total_items: total,
        feeds
      });
    }

    /*
     * ==========================================================
     * /gemini-test
     * ==========================================================
     */

    if (path === "/gemini-test" && request.method === "GET") {
      const prompt =
        url.searchParams.get("prompt") ||
        "Ответь кратко: Gemini API работает?";

      const result = await geminiGenerate(
        GEMINI_API_KEY,
        prompt
      );

      return json({
        ok: result.ok,
        provider: "Google Gemini",
        model: GEMINI_MODEL,
        http_status: result.status,
        response: result.data
      });
    }

    /*
     * ==========================================================
     * /qwen-test
     * ==========================================================
     */

    if (path === "/qwen-test" && request.method === "GET") {
      const prompt =
        url.searchParams.get("prompt") ||
        "Ответь кратко: Qwen API работает?";

      const result = await qwenGenerate(
        QWEN_API_KEY,
        prompt
      );

      return json({
        ok: result.ok,
        provider: "Alibaba Qwen",
        model: QWEN_MODEL,
        http_status: result.status,
        response: result.data
      });
    }

    /*
     * ==========================================================
     * /max-test
     * ==========================================================
     */

    if (path === "/max-test" && request.method === "GET") {
      const result = await maxRequest(
        "/me",
        MAX_BOT_TOKEN,
        {
          method: "GET"
        }
      );

      return json({
        ok: result.ok,
        provider: "MAX",
        endpoint: "/me",
        http_status: result.status,
        response: result.data
      });
    }

    /*
     * ==========================================================
     * /updates
     * ==========================================================
     */

    if (path === "/updates" && request.method === "GET") {
      const params = new URLSearchParams();

      params.set(
        "limit",
        url.searchParams.get("limit") || "100"
      );

      params.set(
        "timeout",
        url.searchParams.get("timeout") || "0"
      );

      const marker = url.searchParams.get("marker");

      if (marker) {
        params.set("marker", marker);
      }

      const types = url.searchParams.get("types");

      if (types) {
        params.set("types", types);
      }

      const result = await maxRequest(
        `/updates?${params.toString()}`,
        MAX_BOT_TOKEN,
        {
          method: "GET"
        }
      );

      return json({
        ok: result.ok,
        provider: "MAX",
        endpoint: "/updates",
        http_status: result.status,
        response: result.data
      });
    }

    /*
     * ==========================================================
     * /chat-ids
     * ==========================================================
     */

    if (path === "/chat-ids" && request.method === "GET") {
      const result = await maxRequest(
        "/updates?limit=100&timeout=0",
        MAX_BOT_TOKEN,
        {
          method: "GET"
        }
      );

      const chatIds = extractChatIds(result.data);

      return json({
        ok: result.ok,
        provider: "MAX",
        endpoint: "/chat-ids",
        http_status: result.status,
        chat_ids: chatIds,
        updates: getUpdateSummary(result.data),
        message: chatIds.length
          ? "Chat ID найдены."
          : "Chat ID пока не найдены. Для нового события добавьте/запустите бота в MAX и повторите запрос.",
        raw: result.data
      });
    }

    /*
     * ==========================================================
     * /chat-test
     * Проверяет, видит ли бот конкретный чат/канал.
     * ==========================================================
     */

    if (path === "/chat-test" && request.method === "GET") {
      const chatId =
        url.searchParams.get("chat_id");

      if (!chatId) {
        return json({
          ok: false,
          error: "Не указан chat_id.",
          usage: "/chat-test?chat_id=123456789"
        }, 400);
      }

      const result = await maxRequest(
        `/chats/${encodeURIComponent(chatId)}`,
        MAX_BOT_TOKEN,
        {
          method: "GET"
        }
      );

      return json({
        ok: result.ok,
        provider: "MAX",
        operation: "chat-test",
        chat_id: chatId,
        http_status: result.status,
        response: result.data
      });
    }

    /*
     * ==========================================================
     * /publish-test
     * ==========================================================
     */

    if (path === "/publish-test" && request.method === "GET") {
      const chatId =
        url.searchParams.get("chat_id");

      if (!chatId) {
        return json({
          ok: false,
          error: "Не указан chat_id.",
          usage: "/publish-test?chat_id=123456789",
          next_step:
            "Сначала укажите настоящий chat_id канала или чата."
        }, 400);
      }

      const text =
        url.searchParams.get("text") ||
        "ТЕСТ MAX NEWS AGENT\n\nWorker успешно подключён к API MAX.";

      const result = await maxRequest(
        `/messages?chat_id=${encodeURIComponent(chatId)}`,
        MAX_BOT_TOKEN,
        {
          method: "POST",
          body: JSON.stringify({
            text
          })
        }
      );

      return json({
        ok: result.ok,
        provider: "MAX",
        operation: "publish-test",
        chat_id: chatId,
        http_status: result.status,
        response: result.data
      });
    }

    /*
     * ==========================================================
     * UNKNOWN ROUTE
     * ==========================================================
     */

    return json({
      ok: false,
      error: "Endpoint not found",
      path
    }, 404);

  } catch (error) {
    console.error(
      "MAX NEWS AGENT ERROR:",
      error
    );

    return json({
      ok: false,
      error: error?.message || String(error)
    }, 500);
  }
});