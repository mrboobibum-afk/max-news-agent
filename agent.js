/*
 * ============================================================
 * ФАКТОР — MAX NEWS AGENT FINAL
 * DENO DEPLOY
 *
 * RSS -> ARTICLE -> MEDIA -> AI -> DEDUP -> MAX
 *
 * ЛОГИКА:
 * - cron сканирует каждые 5 минут;
 * - срочная новость может публиковаться на каждом сканировании,
 *   если она новая и прошла фильтр;
 * - обычная новость — не чаще 1 раза в 30 минут;
 * - Deno KV хранит историю публикаций и интервалы после рестарта;
 * - проверяются последние посты MAX, чтобы не повторять уже
 *   опубликованные материалы;
 * - сначала ищется видео именно внутри исходной статьи СМИ;
 * - если видео нет — используется изображение статьи;
 * - если нет ни видео, ни изображения — допускается текстовый пост;
 * - MAX media upload -> token -> POST /messages;
 * - Gemini -> Qwen fallback;
 * - MAX TLS через Russian Trusted CA.
 *
 * ВАЖНО:
 * Видео берётся только из HTML исходной статьи или её media URL.
 * Случайные YouTube/стоковые ролики по ключевым словам НЕ берутся.
 * ============================================================
 */

const MAX_API = "https://platform-api2.max.ru";

const GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta";

const QWEN_API =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

const MAX_ROOT_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt";

const MAX_SUB_CA_URL =
  "https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt";


/*
 * ============================================================
 * ENVIRONMENT
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


const AUTO_PIPELINE =
  (
    Deno.env.get("AUTO_PIPELINE") ||
    "true"
  ).toLowerCase() === "true";


const CRON_SCHEDULE =
  Deno.env.get("CRON_SCHEDULE") ||
  "*/5 * * * *";


const MAX_NEWS_PER_RUN =
  numberEnv(
    "MAX_NEWS_PER_RUN",
    1
  );


const API_RETRIES =
  numberEnv(
    "API_RETRIES",
    2
  );


const API_TIMEOUT_MS =
  numberEnv(
    "API_TIMEOUT_MS",
    20000
  );


/*
 * Обычная публикация:
 * максимум одна каждые 30 минут.
 */

const REGULAR_INTERVAL_MS =
  numberEnv(
    "REGULAR_INTERVAL_MINUTES",
    30
  ) * 60_000;


/*
 * Срочные новости:
 * проверяются каждые 5 минут.
 */

const URGENT_INTERVAL_MS =
  numberEnv(
    "URGENT_INTERVAL_MINUTES",
    5
  ) * 60_000;


/*
 * Максимальный размер скачиваемого видео.
 *
 * MAX разрешает до 250 MB,
 * но для бесплатного Deno безопаснее
 * не держать огромные ролики в памяти.
 */

const MAX_VIDEO_BYTES =
  numberEnv(
    "MAX_VIDEO_MB",
    80
  ) * 1024 * 1024;


const MAX_IMAGE_BYTES =
  numberEnv(
    "MAX_IMAGE_MB",
    15
  ) * 1024 * 1024;


const MAX_ARTICLE_BYTES =
  numberEnv(
    "MAX_ARTICLE_MB",
    8
  ) * 1024 * 1024;


const HISTORY_TTL_MS =
  numberEnv(
    "DEDUP_HISTORY_DAYS",
    30
  ) *
  24 *
  60 *
  60 *
  1000;


const MAX_RECENT_MESSAGES =
  numberEnv(
    "MAX_RECENT_MESSAGES",
    50
  );


const MEDIA_WAIT_MS =
  numberEnv(
    "MEDIA_PROCESS_WAIT_SECONDS",
    4
  ) *
  1000;


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
    "gemini-2.5-flash,gemini-flash-latest"
  );


const QWEN_MODELS =
  parseList(
    Deno.env.get(
      "QWEN_MODELS"
    ) ||
    "qwen-plus,qwen-turbo"
  );


/*
 * ============================================================
 * RSS SOURCES
 * ============================================================
 */

const RSS_FEEDS = [

  {
    name:
      "МИР",

    emoji:
      "🌍",

    url:
      "https://news.google.com/rss/search?q=мир+OR+международные+события&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    name:
      "ПОЛИТИКА",

    emoji:
      "🏛️",

    url:
      "https://news.google.com/rss/search?q=политика+OR+право&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    name:
      "ЭКОНОМИКА",

    emoji:
      "💰",

    url:
      "https://news.google.com/rss/search?q=финансы+OR+экономика+OR+бизнес&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    name:
      "ПРОИСШЕСТВИЯ",

    emoji:
      "🚨",

    url:
      "https://news.google.com/rss/search?q=происшествия+OR+катастрофы+OR+криминал&hl=ru&gl=RU&ceid=RU:ru"
  },

  {
    name:
      "ТЕХНОЛОГИИ",

    emoji:
      "💻",

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


const KNOWN_OLD_WEBHOOKS = [

  "https://bogdan15.app.n8n.cloud/webhook-test/m",

  "https://bogdan15.app.n8n.cloud/webhook-test/max-callback",

  "https://bogdan15.app.n8n.cloud/webhook/max-callback"

];


const MAX_WEBHOOK_SECRET =
  (
    Deno.env.get(
      "MAX_WEBHOOK_SECRET"
    ) || ""
  ).trim();


/*
 * ============================================================
 * RUNTIME
 * ============================================================
 */

let maxHttpClient =
  null;


let maxHttpClientError =
  null;


let maxCaStatus = {

  loaded:
    false,

  root:
    false,

  sub:
    false,

  error:
    null

};


let kv =
  null;


try {

  kv =
    await Deno.openKv();

} catch (
  error
) {

  console.error(
    "[KV]",
    error?.message ||
    String(error)
  );

}


let discoveredGeminiModels =
  null;


let discoveredQwenModels =
  null;


let lastPipeline =
  null;


let lastPipelineStartedAt =
  null;


let lastPipelineFinishedAt =
  null;


let pipelineRunning =
  false;


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

      String(
        value || ""
      )

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

  const n =
    Number(
      Deno.env.get(
        name
      )
    );


  return (

    Number.isFinite(
      n
    ) &&

    n > 0

  )

    ? n

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

  if (
    !value
  ) {

    throw new Error(
      `Secret ${name} не настроен`
    );

  }

}


function isRetryableStatus(
  status
) {

  return (

    [
      408,
      409,
      425,
      429
    ].includes(
      status
    )

    ||

    status >= 500

  );

}


function retryDelay(
  attempt,
  retryAfter
) {

  const n =
    Number(
      retryAfter
    );


  if (

    Number.isFinite(
      n
    )

    &&

    n >= 0

  ) {

    return Math.min(
      n * 1000,
      60000
    );

  }


  return (

    Math.min(
      1000 *
      (
        2 **
        attempt
      ),
      8000
    )

    +

    Math.floor(
      Math.random() *
      400
    )

  );

}


function cleanText(
  value
) {

  return decodeEntities(

    String(
      value || ""
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
        /\s+/g,
        " "
      )

      .trim()

  );

}


function decodeEntities(
  value
) {

  return String(
    value || ""
  )

    .replace(
      /&amp;/gi,
      "&"
    )

    .replace(
      /&lt;/gi,
      "<"
    )

    .replace(
      /&gt;/gi,
      ">"
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
      /&#x27;/gi,
      "'"
    )

    .replace(
      /&nbsp;/gi,
      " "

    );

}


function normalizeText(
  value
) {

  return cleanText(
    value
  )

    .toLowerCase()

    .replace(
      /ё/g,
      "е"
    )

    .replace(
      /[«»"“”'’`]/g,
      ""
    )

    .replace(
      /[^a-zа-я0-9]+/gi,
      " "
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim();

}


function tokens(
  value
) {

  return new Set(

    normalizeText(
      value
    )

      .split(" ")

      .filter(
        x =>
          x.length >= 4
      )

  );

}


function similarity(
  a,
  b
) {

  const A =
    tokens(
      a
    );

  const B =
    tokens(
      b
    );


  if (
    !A.size ||
    !B.size
  ) {

    return 0;

  }


  let same =
    0;


  for (
    const x
    of A
  ) {

    if (
      B.has(
        x
      )
    ) {

      same++;

    }

  }


  return (

    same /

    Math.max(
      1,
      Math.min(
        A.size,
        B.size
      )
    )

  );

}


function hashString(
  value
) {

  const s =
    String(
      value || ""
    );


  let h1 =
    0x811c9dc5;


  let h2 =
    0x01000193;


  for (
    let i = 0;
    i < s.length;
    i++
  ) {

    const c =
      s.charCodeAt(
        i
      );


    h1 ^=
      c;


    h1 =
      Math.imul(
        h1,
        16777619
      );


    h2 ^=
      c +
      i;


    h2 =
      Math.imul(
        h2,
        2246822519
      );

  }


  return (

    (
      h1 >>> 0
    )
      .toString(16)
      .padStart(
        8,
        "0"
      )

    +

    (
      h2 >>> 0
    )
      .toString(16)
      .padStart(
        8,
        "0"
      )

  );

}


function safeUrl(
  value,
  base = null
) {

  try {

    const u =
      new URL(
        String(
          value || ""
        ),
        base ||
        undefined
      );


    if (

      ![
        "http:",
        "https:"
      ].includes(
        u.protocol
      )

    ) {

      return null;

    }


    return u.href;

  } catch {

    return null;

  }

}


function sourceNameFromUrl(
  url
) {

  try {

    return new URL(
      url
    )

      .hostname

      .replace(
        /^www\./,
        ""
      )

      .replace(
        /^m\./,
        ""
      );

  } catch {

    return "СМИ";

  }

}


function formatTime(
  date = new Date()
) {

  return new Intl.DateTimeFormat(
    "ru-RU",
    {

      hour:
        "2-digit",

      minute:
        "2-digit"

    }

  ).format(
    date
  );

}


/*
 * ============================================================
 * HTTP
 * ============================================================
 */

async function readResponse(
  response
) {

  const text =
    await response.text();


  let data =
    null;


  try {

    data =
      text
        ? JSON.parse(
            text
          )
        : null;

  } catch {

    data = {

      raw:
        text

    };

  }


  return {

    ok:
      response.ok,

    status:
      response.status,

    statusText:
      response.statusText ||
      "",

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
    config.useMaxClient ===
    true;


  let last = {

    ok:
      false,

    status:
      599,

    statusText:
      "No response",

    data: {

      error:
        "request failed"

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
        await readResponse(
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
        result.ok ||
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

      const timeout =
        error?.name ===
        "AbortError";


      last = {

        ok:
          false,

        status:
          timeout
            ? 504
            : 599,

        statusText:
          timeout
            ? "Gateway Timeout"
            : "Network Error",

        data: {

          error:
            error?.message ||
            String(error)

        },

        error_type:
          timeout
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


async function fetchBytes(
  url,
  options = {},
  maxBytes = MAX_VIDEO_BYTES
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(

      () =>
        controller.abort(),

      Math.max(
        API_TIMEOUT_MS,
        45000
      )

    );


  try {

    const response =
      await fetch(

        url,

        {

          ...options,

          signal:
            controller.signal,

          redirect:
            "follow"

        }

      );


    if (
      !response.ok
    ) {

      return {

        ok:
          false,

        status:
          response.status,

        error:
          `HTTP ${response.status}`

      };

    }


    const length =
      Number(
        response.headers.get(
          "content-length"
        ) ||
        0
      );


    if (

      length &&

      length >
        maxBytes

    ) {

      return {

        ok:
          false,

        status:
          413,

        error:
          `media_too_large:${length}`

      };

    }


    if (
      !response.body
    ) {

      const bytes =
        new Uint8Array(

          await response.arrayBuffer()

        );


      if (
        bytes.byteLength >
        maxBytes
      ) {

        return {

          ok:
            false,

          status:
            413,

          error:
            "media_too_large"

        };

      }


      return {

        ok:
          true,

        bytes,

        contentType:
          response.headers.get(
            "content-type"
          ) ||
          ""

      };

    }


    const reader =
      response.body.getReader();


    const chunks =
      [];


    let total =
      0;


    while (
      true
    ) {

      const {
        done,
        value
      } =
        await reader.read();


      if (
        done
      ) {

        break;

      }


      total +=
        value.byteLength;


      if (
        total >
        maxBytes
      ) {

        await reader.cancel();


        return {

          ok:
            false,

          status:
            413,

          error:
            `media_too_large:${total}`

        };

      }


      chunks.push(
        value
      );

    }


    const bytes =
      new Uint8Array(
        total
      );


    let offset =
      0;


    for (
      const chunk
      of chunks
    ) {

      bytes.set(
        chunk,
        offset
      );


      offset +=
        chunk.byteLength;

    }


    return {

      ok:
        true,

      bytes,

      contentType:
        response.headers.get(
          "content-type"
        ) ||
        ""

    };

  } catch (
    error
  ) {

    return {

      ok:
        false,

      status:
        599,

      error:
        error?.message ||
        String(error)

    };

  } finally {

    clearTimeout(
      timer
    );

  }

}


/*
 * ============================================================
 * MAX TLS
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

    const root =
      await fetch(
        MAX_ROOT_CA_URL
      );


    if (
      !root.ok
    ) {

      throw new Error(
        `root CA HTTP ${root.status}`
      );

    }


    const rootCa =
      await root.text();


    maxCaStatus.root =
      true;


    const sub =
      await fetch(
        MAX_SUB_CA_URL
      );


    if (
      !sub.ok
    ) {

      throw new Error(
        `sub CA HTTP ${sub.status}`
      );

    }


    const subCa =
      await sub.text();


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


    return maxHttpClient;

  } catch (
    error
  ) {

    maxHttpClientError =
      error?.message ||
      String(error);


    maxCaStatus.error =
      maxHttpClientError;


    return null;

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


  return fetchJson(

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

        ...(options.headers ||
          {})

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
 * DENO KV
 * ============================================================
 */

async function kvGet(
  key
) {

  if (
    !kv
  ) {

    return null;

  }


  try {

    const result =
      await kv.get(
        key
      );


    return (
      result?.value ??
      null
    );

  } catch {

    return null;

  }

}


async function kvSet(
  key,
  value,
  expireIn
) {

  if (
    !kv
  ) {

    return false;

  }


  try {

    const operation =
      kv.set(
        key,
        value
      );


    if (
      expireIn
    ) {

      operation.expireIn(
        expireIn
      );

    }


    await operation;


    return true;

  } catch (
    error
  ) {

    console.error(
      "[KV SET]",
      error?.message ||
      String(error)
    );


    return false;

  }

}


async function kvList(
  prefix,
  limit = 100
) {

  if (
    !kv
  ) {

    return [];

  }


  const result =
    [];


  try {

    for await (
      const entry
      of kv.list({

        prefix,

        reverse:
          true,

        limit

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

  } catch {}

  return result;

}


/*
 * ============================================================
 * RSS
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
    String(
      xml || ""
    ).match(
      regex
    );


  if (
    !match
  ) {

    return "";

  }


  return cleanText(

    match[1]

      .replace(
        /<!\[CDATA\[/gi,
        ""
      )

      .replace(
        /\]\]>/g,
        ""
      )

  );

}


function extractItems(
  xml
) {

  const items =
    [];


  const matches =
    String(
      xml || ""
    ).match(

      /<item[\s\S]*?<\/item>/gi

    ) ||
    [];


  for (
    const raw
    of matches
  ) {

    const title =
      extractTag(
        raw,
        "title"
      );


    const link =
      extractTag(
        raw,
        "link"
      );


    const description =
      extractTag(
        raw,
        "description"
      );


    const pubDate =
      extractTag(
        raw,
        "pubDate"
      );


    const source =
      extractTag(
        raw,
        "source"
      );


    if (
      !title ||
      !link
    ) {

      continue;

    }


    items.push({

      title,

      link:
        safeUrl(
          link
        ),

      description,

      pubDate,

      source

    });

  }


  return items;

}


async function fetchRSS() {

  return Promise.all(

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
                  "Mozilla/5.0 (compatible; FactorNewsAgent/1.0)"

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

          !result.ok ||

          typeof result.data?.raw !==
            "string"

        ) {

          return {

            ...feed,

            ok:
              false,

            count:
              0,

            items:
              [],

            error:
              result.data?.error ||
              result.status

          };

        }


        const items =
          extractItems(
            result.data.raw
          )

            .map(
              item => ({

                ...item,

                category:
                  feed.name,

                categoryEmoji:
                  feed.emoji,

                sourceFeed:
                  feed.url

              })
            );


        return {

          ...feed,

          ok:
            true,

          count:
            items.length,

          items

        };

      }

    )

  );

}


function flattenNews(
  feeds
) {

  const all =
    [];


  for (
    const feed
    of feeds
  ) {

    if (
      feed.ok
    ) {

      all.push(
        ...feed.items
      );

    }

  }


  const unique =
    [];


  const seen =
    new Set();


  for (
    const item
    of all.sort(

      (a, b) =>

        (
          Date.parse(
            b.pubDate ||
            ""
          ) ||
          0
        )

        -

        (
          Date.parse(
            a.pubDate ||
            ""
          ) ||
          0
        )

    )
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
 * ARTICLE MEDIA
 * ============================================================
 */

function extractAttr(
  tag,
  attr
) {

  const regex =
    new RegExp(

      `${attr}\\s*=\\s*["']([^"']+)["']`,

      "i"

    );


  return (
    tag.match(
      regex
    )?.[1] ||
    ""
  );

}


function extractMeta(
  html,
  propertyNames
) {

  const metas =
    String(
      html || ""
    ).match(

      /<meta\b[^>]*>/gi

    ) ||
    [];


  for (
    const name
    of propertyNames
  ) {

    for (
      const tag
      of metas
    ) {

      const property =

        (

          extractAttr(
            tag,
            "property"
          )

          ||

          extractAttr(
            tag,
            "name"
          )

          ||

          extractAttr(
            tag,
            "itemprop"
          )

        )

          .toLowerCase();


      if (
        property ===
        name.toLowerCase()
      ) {

        const content =
          extractAttr(
            tag,
            "content"
          );


        if (
          content
        ) {

          return decodeEntities(
            content
          );

        }

      }

    }

  }


  return "";

}


function extractLinks(
  html,
  pattern
) {

  const out =
    [];


  const tags =
    String(
      html || ""
    ).match(

      /<(?:video|source|a|link|meta)\b[^>]*>/gi

    ) ||
    [];


  for (
    const tag
    of tags
  ) {

    const values = [

      extractAttr(
        tag,
        "src"
      ),

      extractAttr(
        tag,
        "href"
      ),

      extractAttr(
        tag,
        "content"
      )

    ].filter(
      Boolean
    );


    for (
      const value
      of values
    ) {

      const decoded =
        decodeEntities(
          value
        );


      if (
        pattern.test(
          decoded
        )
      ) {

        out.push(
          decoded
        );

      }

    }

  }


  return [

    ...new Set(
      out
    )

  ];

}


function isDirectVideoUrl(
  url
) {

  try {

    const u =
      new URL(
        url
      );


    const path =
      u.pathname.toLowerCase();


    return (

      /\.(mp4|mov|mkv|webm)(?:$|\?)/i.test(
        path
      )

      ||

      /(?:video|videofile|media|stream)/i.test(
        path
      )

    );

  } catch {

    return false;

  }

}


function isHlsUrl(
  url
) {

  return /\.m3u8(?:$|\?)/i.test(
    url
  );

}


function extractArticleMedia(
  html,
  articleUrl
) {

  const videoCandidates =
    [];


  const ogVideo =
    extractMeta(

      html,

      [

        "og:video",

        "og:video:url",

        "og:video:secure_url",

        "twitter:player:stream"

      ]

    );


  if (
    ogVideo
  ) {

    videoCandidates.push(

      safeUrl(
        ogVideo,
        articleUrl
      )

    );

  }


  for (
    const raw
    of extractLinks(

      html,

      /\.(mp4|mov|mkv|webm|m3u8)(?:[?#]|$)/i

    )
  ) {

    videoCandidates.push(

      safeUrl(
        raw,
        articleUrl
      )

    );

  }


  const videos =
    [

      ...new Set(

        videoCandidates
          .filter(
            Boolean
          )

      )

    ];


  const directVideo =
    videos.find(
      isDirectVideoUrl
    ) ||
    null;


  const hlsVideo =
    videos.find(
      isHlsUrl
    ) ||
    null;


  const image =

    safeUrl(

      extractMeta(

        html,

        [

          "og:image",

          "twitter:image",

          "twitter:image:src"

        ]

      ),

      articleUrl

    ) ||

    null;


  return {

    video:
      directVideo,

    hls:
      hlsVideo,

    image

  };

}


async function loadArticle(
  item
) {

  const url =
    safeUrl(
      item.link
    );


  if (
    !url
  ) {

    return {

      ok:
        false,

      error:
        "invalid_article_url"

    };

  }


  const result =
    await fetchBytes(

      url,

      {

        headers: {

          "User-Agent":
            "Mozilla/5.0 (compatible; FactorNewsAgent/1.0)",

          Accept:
            "text/html,application/xhtml+xml"

        }

      },

      MAX_ARTICLE_BYTES

    );


  if (
    !result.ok
  ) {

    return {

      ok:
        false,

      finalUrl:
        url,

      error:
        result.error

    };

  }


  const html =
    new TextDecoder()
      .decode(
        result.bytes
      );


  const finalUrl =
    url;


  const media =
    extractArticleMedia(

      html,

      finalUrl

    );


  return {

    ok:
      true,

    finalUrl,

    html,

    media,

    source:
      sourceNameFromUrl(
        finalUrl
      )

  };

}


/*
 * ============================================================
 * MEDIA DOWNLOAD
 * ============================================================
 */

async function downloadVideo(
  url
) {

  if (

    !url ||

    !isDirectVideoUrl(
      url
    )

  ) {

    return {

      ok:
        false,

      error:
        "no_direct_video"

    };

  }


  const result =
    await fetchBytes(

      url,

      {

        headers: {

          "User-Agent":
            "Mozilla/5.0 (compatible; FactorNewsAgent/1.0)",

          Accept:
            "video/mp4,video/webm,video/*;q=0.9,*/*;q=0.5"

        }

      },

      MAX_VIDEO_BYTES

    );


  if (
    !result.ok
  ) {

    return result;

  }


  const contentType =
    result.contentType.toLowerCase();


  if (

    contentType &&

    !contentType.includes(
      "video"
    ) &&

    !contentType.includes(
      "octet-stream"
    )

  ) {

    return {

      ok:
        false,

      status:
        415,

      error:
        `not_video_content_type:${contentType}`

    };

  }


  return result;

}


async function downloadImage(
  url
) {

  if (
    !url
  ) {

    return {

      ok:
        false,

      error:
        "no_image"

    };

  }


  const result =
    await fetchBytes(

      url,

      {

        headers: {

          "User-Agent":
            "Mozilla/5.0 (compatible; FactorNewsAgent/1.0)",

          Accept:
            "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8"

        }

      },

      MAX_IMAGE_BYTES

    );


  if (
    !result.ok
  ) {

    return result;

  }


  if (

    result.contentType &&

    !result.contentType
      .toLowerCase()
      .startsWith(
        "image/"
      )

  ) {

    return {

      ok:
        false,

      status:
        415,

      error:
        "not_image"

    };

  }


  return result;

}


/*
 * ============================================================
 * MAX MEDIA UPLOAD
 * ============================================================
 */

async function maxUploadUrl(
  type
) {

  return maxRequest(

    `/uploads?type=${encodeURIComponent(
      type
    )}`,

    {

      method:
        "POST"

    }

  );

}


async function uploadMediaToMax(
  type,
  bytes,
  contentType,
  filename
) {

  const init =
    await maxUploadUrl(
      type
    );


  if (

    !init.ok ||

    !init.data?.url

  ) {

    return {

      ok:
        false,

      stage:
        "max_upload_init",

      status:
        init.status,

      response:
        init.data

    };

  }


  const form =
    new FormData();


  const blob =
    new Blob(

      [bytes],

      {

        type:

          contentType ||

          (

            type === "video"

              ? "video/mp4"

              : "image/jpeg"

          )

      }

    );


  form.append(

    "data",

    new File(

      [blob],

      filename ||

      (

        type === "video"

          ? "factor-news.mp4"

          : "factor-news.jpg"

      ),

      {

        type:
          blob.type

      }

    )

  );


  const upload =
    await fetch(

      init.data.url,

      {

        method:
          "POST",

        body:
          form,

        headers: {

          Authorization:
            MAX_BOT_TOKEN

        }

      }

    );


  const uploadBody =
    await readResponse(
      upload
    );


  if (
    !upload.ok
  ) {

    return {

      ok:
        false,

      stage:
        "max_media_upload",

      status:
        upload.status,

      response:
        uploadBody.data

    };

  }


  const token =

    init.data.token ||

    uploadBody.data?.token ||

    uploadBody.data?.mediafile_token ||

    uploadBody.data?.photos
      ?.photoIds
      ?.token;


  if (
    !token
  ) {

    return {

      ok:
        false,

      stage:
        "max_media_token",

      status:
        upload.status,

      response:
        uploadBody.data

    };

  }


  return {

    ok:
      true,

    token

  };

}


/*
 * ============================================================
 * MAX PUBLISH
 * ============================================================
 */

async function publishToMax(
  chatId,
  text,
  media = null
) {

  if (
    !chatId
  ) {

    return {

      ok:
        false,

      status:
        400,

      data: {

        error:
          "TARGET_CHAT_ID не задан"

      }

    };

  }


  const body = {

    text

  };


  if (
    media?.token
  ) {

    body.attachments = [

      {

        type:
          media.type,

        payload: {

          token:
            media.token

        }

      }

    ];

  }


  if (
    media?.payload?.url
  ) {

    body.attachments = [

      {

        type:
          media.type,

        payload: {

          url:
            media.payload.url

        }

      }

    ];

  }


  return maxRequest(

    `/messages?chat_id=${encodeURIComponent(
      chatId
    )}`,

    {

      method:
        "POST",

      body:
        JSON.stringify(
          body
        )

    }

  );

}


/*
 * ============================================================
 * DEDUP
 * ============================================================
 */

function newsKey(
  item
) {

  return (

    item.link ||

    `${normalizeText(
      item.title
    )}|${item.pubDate || ""}`

  );

}


function newsFingerprint(
  item
) {

  return hashString(

    [

      normalizeText(
        item.title
      ),

      normalizeText(
        item.description
      ),

      sourceNameFromUrl(
        item.resolvedUrl ||
        item.link ||
        ""
      )

    ].join("|")

  );

}


async function wasProcessed(
  item
) {

  const key =
    newsKey(
      item
    );


  const fp =
    newsFingerprint(
      item
    );


  const a =
    await kvGet(

      [
        "factor",
        "news",
        "url",
        key
      ]

    );


  if (
    a
  ) {

    return true;

  }


  const b =
    await kvGet(

      [
        "factor",
        "news",
        "fp",
        fp
      ]

    );


  if (
    b
  ) {

    return true;

  }


  return false;

}


async function markProcessed(
  item,
  extra = {}
) {

  const key =
    newsKey(
      item
    );


  const fp =
    newsFingerprint(
      item
    );


  const value = {

    key,

    fingerprint:
      fp,

    title:
      item.title,

    url:
      item.resolvedUrl ||
      item.link,

    publishedAt:
      new Date()
        .toISOString(),

    ...extra

  };


  await kvSet(

    [
      "factor",
      "news",
      "url",
      key
    ],

    value,

    HISTORY_TTL_MS

  );


  await kvSet(

    [
      "factor",
      "news",
      "fp",
      fp
    ],

    value,

    HISTORY_TTL_MS

  );

}


async function getLastPublish(
  type
) {

  return await kvGet(

    [
      "factor",
      "schedule",
      type
    ]

  );

}


async function setLastPublish(
  type
) {

  await kvSet(

    [
      "factor",
      "schedule",
      type
    ],

    {

      at:
        Date.now(),

      iso:
        new Date()
          .toISOString()

    }

  );

}


async function canPublish(
  type
) {

  const last =
    await getLastPublish(
      type
    );


  if (
    !last?.at
  ) {

    return true;

  }


  const interval =

    type === "urgent"

      ? URGENT_INTERVAL_MS

      : REGULAR_INTERVAL_MS;


  return (

    Date.now() -
    Number(
      last.at
    )

    >=

    interval

  );

}


/*
 * ============================================================
 * MAX HISTORY
 * ============================================================
 */

async function getRecentMaxMessages() {

  if (
    !TARGET_CHAT_ID
  ) {

    return [];

  }


  const result =
    await maxRequest(

      `/messages?chat_id=${encodeURIComponent(
        TARGET_CHAT_ID
      )}&count=${MAX_RECENT_MESSAGES}`,

      {

        method:
          "GET"

      }

    );


  if (
    !result.ok
  ) {

    return [];

  }


  return (

    Array.isArray(
      result.data?.messages
    )

      ? result.data.messages

      : Array.isArray(
          result.data
        )

        ? result.data

        : []

  );

}


function messageText(
  message
) {

  return (

    message?.body?.text ||

    message?.text ||

    ""

  );

}


async function looksLikeAlreadyPublished(
  item,
  recentMessages
) {

  const title =
    normalizeText(
      item.title
    );


  if (
    !title
  ) {

    return false;

  }


  for (
    const message
    of recentMessages
  ) {

    const text =
      messageText(
        message
      );


    if (
      !text
    ) {

      continue;

    }


    if (

      text.includes(
        item.resolvedUrl ||
        item.link
      )

    ) {

      return true;

    }


    const firstPart =

      normalizeText(

        title
          .split(" ")
          .slice(
            0,
            7
          )
          .join(" ")

      );


    if (

      firstPart.length >= 20 &&

      normalizeText(
        text
      ).includes(
        firstPart
      )

    ) {

      return true;

    }


    if (

      similarity(
        title,
        text
      ) >=
      0.72

    ) {

      return true;

    }

  }


  return false;

}


/*
 * ============================================================
 * PRIORITY
 * ============================================================
 */

const URGENT_PATTERNS = [

  /срочно/i,

  /экстренно/i,

  /молния/i,

  /теракт/i,

  /взрыв/i,

  /землетряс/i,

  /цунами/i,

  /крупн(ая|ое|ый)\s+авари/i,

  /катастроф/i,

  /погибл/i,

  /обруш/i,

  /массов(ая|ое|ый)\s+гибел/i,

  /начал[ао]?сь\s+войн/i,

  /военн(ая|ое)\s+операц/i,

  /удар[а-я]*\s+по/i,

  /ракет/i,

  /запуск.*ракет/i,

  /дефолт/i,

  /банкротств/i,

  /обвал.*рынк/i,

  /санкц/i,

  /аварийн/i,

  /эвакуац/i,

  /чрезвычайн/i

];


const LOW_VALUE_PATTERNS = [

  /анонс/i,

  /покажет новые/i,

  /приглашает/i,

  /мероприятие пройдет/i,

  /стала известна программа/i,

  /названы даты/i,

  /может представить/i,

  /рассказал о планах/i

];


function priorityScore(
  item
) {

  const text =

    `${item.title} ${item.description}`

      .toLowerCase();


  let score =
    0;


  for (
    const re
    of URGENT_PATTERNS
  ) {

    if (
      re.test(
        text
      )
    ) {

      score +=
        3;

    }

  }


  for (
    const re
    of LOW_VALUE_PATTERNS
  ) {

    if (
      re.test(
        text
      )
    ) {

      score -=
        3;

    }

  }


  const age =

    Date.now() -

    (
      Date.parse(
        item.pubDate ||
        ""
      ) ||

      Date.now()

    );


  if (
    age <=
    15 *
    60_000
  ) {

    score +=
      2;

  } else if (
    age <=
    60 *
    60_000
  ) {

    score +=
      1;

  }


  if (
    item.category ===
    "ПРОИСШЕСТВИЯ"
  ) {

    score +=
      1;

  }


  if (
    item.category ===
    "МИР"
  ) {

    score +=
      1;

  }


  if (
    item.category ===
    "ЭКОНОМИКА"
  ) {

    score +=
      1;

  }


  return score;

}


function isUrgent(
  item
) {

  return (
    priorityScore(
      item
    ) >=
    4
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
        p =>
          p?.text ||
          ""
      )
      .join("")

    ||

    ""

  ).trim();

}


function extractQwenText(
  data
) {

  return (

    data
      ?.choices?.[0]
      ?.message?.content

    ||

    data
      ?.choices?.[0]
      ?.text

    ||

    ""

  ).trim();

}


function parseJsonObject(
  text
) {

  const raw =
    String(
      text ||
      ""
    )

      .replace(
        /```json/gi,
        ""
      )

      .replace(
        /```/g,
        ""
      )

      .trim();


  try {

    return JSON.parse(
      raw
    );

  } catch {}


  const start =
    raw.indexOf(
      "{"
    );


  const end =
    raw.lastIndexOf(
      "}"
    );


  if (

    start >= 0 &&

    end >
      start

  ) {

    try {

      return JSON.parse(

        raw.slice(
          start,
          end + 1
        )

      );

    } catch {}

  }


  return null;

}


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


  discoveredGeminiModels =

    (
      result.data?.models ||
      []

    )

      .filter(

        m =>

          !Array.isArray(
            m?.supportedGenerationMethods
          )

          ||

          m
            .supportedGenerationMethods
            .includes(
              "generateContent"
            )

      )

      .map(

        m =>

          String(
            m.name ||
            ""
          )

            .replace(
              /^models\//,
              ""
            )

      )

      .filter(
        Boolean
      );


  return discoveredGeminiModels;

}


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
        m =>
          String(
            m?.id ||
            m?.name ||
            ""
          ).trim()
      )

      .filter(
        Boolean
      );


  return discoveredQwenModels;

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
              0.15,

            maxOutputTokens:
              900,

            responseMimeType:
              "application/json"

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
                "Ты редактор новостей. Не выдумывай факты. Возвращай только JSON."

            },

            {

              role:
                "user",

              content:
                prompt

            }

          ],

          temperature:
            0.15,

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


  const gm = [

    ...new Set([

      ...GEMINI_MODELS,

      ...(
        await discoverGeminiModels()
      )

    ])

  ].slice(
    0,
    5
  );


  const qw = [

    ...new Set([

      ...QWEN_MODELS,

      ...(
        await discoverQwenModels()
      )

    ])

  ].slice(
    0,
    5
  );


  for (
    const model
    of gm
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

        status:
          result.status,

        ok:
          result.ok

      });


      if (

        result.ok &&

        text

      ) {

        const parsed =
          parseJsonObject(
            text
          );


        if (
          parsed
        ) {

          return {

            ok:
              true,

            provider:
              "Google Gemini",

            model,

            data:
              parsed,

            attempts

          };

        }

      }

    } catch (
      error
    ) {

      attempts.push({

        provider:
          "Google Gemini",

        model,

        ok:
          false,

        error:
          error?.message ||
          String(error)

      });

    }

  }


  for (
    const model
    of qw
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

        status:
          result.status,

        ok:
          result.ok

      });


      if (

        result.ok &&

        text

      ) {

        const parsed =
          parseJsonObject(
            text
          );


        if (
          parsed
        ) {

          return {

            ok:
              true,

            provider:
              "Alibaba Qwen",

            model,

            data:
              parsed,

            attempts

          };

        }

      }

    } catch (
      error
    ) {

      attempts.push({

        provider:
          "Alibaba Qwen",

        model,

        ok:
          false,

        error:
          error?.message ||
          String(error)

      });

    }

  }


  return {

    ok:
      false,

    error:
      "AI fallback exhausted",

    attempts

  };

}


/*
 * ============================================================
 * AI PROMPT
 * ============================================================
 */

function buildAnalysisPrompt(
  item,
  articleText = ""
) {

  return `

Ты редактор новостного канала ФАКТОР.

Сделай короткий пост в стиле оперативной новостной ленты:
динамично, чисто, без воды, без истерики и без повторов.

ИСТОЧНИК:
${item.source || sourceNameFromUrl(item.resolvedUrl || item.link)}

КАТЕГОРИЯ:
${item.category}

ЗАГОЛОВОК:
${item.title}

ОПИСАНИЕ:
${item.description || "нет"}

ТЕКСТ СТРАНИЦЫ:
${articleText.slice(0, 7000)}

Верни СТРОГО JSON:

{
  "headline": "короткий заголовок без названия СМИ",
  "lead": "1-2 коротких предложения с сутью",
  "facts": [
    "факт 1",
    "факт 2",
    "факт 3"
  ],
  "important": "одно предложение о том, что важно понимать"
}

ПРАВИЛА:

- Только подтверждённое из материала.
- Не придумывай цифры.
- Не придумывай цитаты.
- Не придумывай причины.
- Не придумывай последствия.
- Не повторяй одну мысль разными словами.
- Не копируй исходный заголовок целиком.
- Не пиши "ситуация развивается".
- Не пиши "стало известно", если это ничего не добавляет.
- facts: максимум 3 пункта.
- Каждый факт короткий.
- Русский язык.

`.trim();

}


/*
 * ============================================================
 * POST FORMAT
 * ============================================================
 */

function dedupeSentences(
  text
) {

  const parts =

    String(
      text ||
      ""
    )

      .split(
        /(?<=[.!?])\s+/
      )

      .map(
        x =>
          x.trim()
      )

      .filter(
        Boolean
      );


  const out =
    [];


  for (
    const part
    of parts
  ) {

    if (

      out.some(

        x =>

          similarity(
            x,
            part
          ) >=
          0.82

      )

    ) {

      continue;

    }


    out.push(
      part
    );

  }


  return out.join(
    " "
  );

}


function cleanAiData(
  data,
  item
) {

  const headline =

    cleanText(
      data?.headline
    )

    ||

    cleanText(
      item.title
    );


  const lead =

    dedupeSentences(

      cleanText(
        data?.lead
      )

    );


  const facts =

    Array.isArray(
      data?.facts
    )

      ? data.facts

          .map(
            cleanText
          )

          .filter(
            Boolean
          )

          .slice(
            0,
            3
          )

      : [];


  const important =

    dedupeSentences(

      cleanText(
        data?.important
      )

    );


  return {

    headline,

    lead,

    facts,

    important

  };

}


function escapeHtml(
  value
) {

  return String(
    value ||
    ""
  )

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
    );

}


function escapeAttribute(
  value
) {

  return String(
    value ||
    ""
  )

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /"/g,
      "&quot;"
    );

}


function buildPost(
  item,
  ai
) {

  const urgent =
    isUrgent(
      item
    );


  const mode =

    urgent

      ? "🔴 ФАКТОР • ОПЕРАТИВНО"

      : "🔴 ФАКТОР • ГЛАВНОЕ";


  const emoji =
    item.categoryEmoji ||
    "📰";


  const facts =

    ai.facts.length

      ? ai.facts
          .map(
            x =>
              `• ${x}`
          )
          .join(
            "\n"
          )

      : "";


  const source =
    sourceNameFromUrl(

      item.resolvedUrl ||
      item.link

    );


  return [

    mode,

    "",

    `${emoji} ${item.category}`,

    "",

    `<b>${escapeHtml(
      ai.headline
    )}</b>`,

    "",

    escapeHtml(
      ai.lead
    ),

    "",

    facts

      ? `<b>📌 ГЛАВНОЕ</b>\n${escapeHtml(
          facts
        )}`

      : "",

    "",

    ai.important

      ? `<b>⚡ ЧТО ВАЖНО</b>\n${escapeHtml(
          ai.important
        )}`

      : "",

    "",

    `🕒 ${formatTime()}`,

    `🔗 <a href="${escapeAttribute(
      item.resolvedUrl ||
      item.link
    )}">${escapeHtml(
      source
    )}</a>`

  ]

    .filter(

      (x, i, arr) =>

        x !== "" ||

        arr[i - 1] !== ""

    )

    .join(
      "\n"
    );

}


/*
 * ============================================================
 * MEDIA PIPELINE
 * ============================================================
 */

async function prepareMedia(
  article
) {

  if (
    !article?.ok
  ) {

    return {

      type:
        null,

      token:
        null,

      source:
        null,

      reason:
        "article_unavailable"

    };

  }


  /*
   * ==========================================================
   * ВИДЕО — ПРИОРИТЕТ №1
   * ==========================================================
   *
   * Только видео, найденное внутри исходной статьи СМИ.
   */

  if (
    article.media?.video
  ) {

    const video =
      await downloadVideo(

        article.media.video

      );


    if (
      video.ok
    ) {

      const uploaded =

        await uploadMediaToMax(

          "video",

          video.bytes,

          video.contentType ||
            "video/mp4",

          "factor-news.mp4"

        );


      if (
        uploaded.ok
      ) {

        return {

          type:
            "video",

          token:
            uploaded.token,

          source:
            article.media.video

        };

      }

    }

  }


  /*
   * HLS / m3u8 напрямую не отправляем.
   * MAX принимает готовый видеофайл.
   *
   * Поэтому при m3u8 используем фото статьи.
   */


  /*
   * ==========================================================
   * ФОТО — ПРИОРИТЕТ №2
   * ==========================================================
   */

  if (
    article.media?.image
  ) {

    const image =
      await downloadImage(

        article.media.image

      );


    if (
      image.ok
    ) {

      const uploaded =

        await uploadMediaToMax(

          "image",

          image.bytes,

          image.contentType ||
            "image/jpeg",

          "factor-news.jpg"

        );


      if (
        uploaded.ok
      ) {

        return {

          type:
            "image",

          token:
            uploaded.token,

          source:
            article.media.image

        };

      }

    }


    /*
     * Последний fallback для картинки:
     * отправляем внешний URL.
     */

    return {

      type:
        "image_url",

      url:
        article.media.image,

      source:
        article.media.image

    };

  }


  /*
   * ==========================================================
   * ТЕКСТ — ПОСЛЕДНИЙ FALLBACK
   * ==========================================================
   */

  return {

    type:
      null,

    token:
      null,

    source:
      null,

    reason:
      "no_media"

  };

}


/*
 * ============================================================
 * CANDIDATE SELECTION
 * ============================================================
 */

async function selectCandidate(
  news
) {

  const recentMessages =
    await getRecentMaxMessages();


  const candidates =
    [];


  for (
    const item
    of news
  ) {

    /*
     * Долговременный dedup.
     */

    if (
      await wasProcessed(
        item
      )
    ) {

      continue;

    }


    /*
     * Дополнительная проверка
     * последних сообщений MAX.
     */

    if (

      await looksLikeAlreadyPublished(

        item,

        recentMessages

      )

    ) {

      await markProcessed(

        item,

        {

          skipped:
            true,

          reason:
            "already_in_max_history"

        }

      );


      continue;

    }


    /*
     * Открываем реальную статью СМИ.
     */

    const article =
      await loadArticle(
        item
      );


    if (
      !article.ok
    ) {

      /*
       * Не помечаем обработанной:
       * это может быть временная ошибка сети.
       */

      continue;

    }


    item.resolvedUrl =
      article.finalUrl ||
      item.link;


    item.resolvedSource =
      article.source;


    item.articleText =

      cleanText(

        extractMeta(

          article.html,

          [

            "description",

            "og:description"

          ]

        )

      );


    item.media =
      article.media;


    item.priority =
      priorityScore(
        item
      );


    item.urgent =
      isUrgent(
        item
      );


    candidates.push({

      item,

      article

    });

  }


  /*
   * Сначала:
   * 1. срочные;
   * 2. приоритетные;
   * 3. свежие.
   */

  candidates.sort(

    (a, b) =>

      (

        Number(
          b.item.urgent
        )

        -

        Number(
          a.item.urgent
        )

      )

      ||

      (

        b.item.priority
        -

        a.item.priority

      )

      ||

      (

        (
          Date.parse(
            b.item.pubDate ||
            ""
          ) ||
          0
        )

        -

        (
          Date.parse(
            a.item.pubDate ||
            ""
          ) ||
          0
        )

      )

  );


  /*
   * ==========================================================
   * СРОЧНАЯ
   * ==========================================================
   */

  const urgent =
    candidates.find(
      x =>
        x.item.urgent
    );


  if (

    urgent &&

    await canPublish(
      "urgent"
    )

  ) {

    return {

      ...urgent,

      scheduleType:
        "urgent"

    };

  }


  /*
   * ==========================================================
   * ОБЫЧНАЯ
   * ==========================================================
   */

  if (
    await canPublish(
      "regular"
    )
  ) {

    const regular =
      candidates.find(
        x =>
          !x.item.urgent
      );


    if (
      regular
    ) {

      return {

        ...regular,

        scheduleType:
          "regular"

      };

    }

  }


  return null;

}


/*
 * ============================================================
 * MAIN PIPELINE
 * ============================================================
 */

async function runPipeline() {

  if (
    pipelineRunning
  ) {

    return {

      ok:
        true,

      skipped:
        true,

      reason:
        "pipeline_already_running"

    };

  }


  pipelineRunning =
    true;


  const started =
    Date.now();


  lastPipelineStartedAt =
    new Date()
      .toISOString();


  try {

    if (
      !TARGET_CHAT_ID
    ) {

      return {

        ok:
          false,

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

      return {

        ok:
          false,

        stage:
          "rss",

        error:
          "RSS не вернул новостей",

        feeds

      };

    }


    /*
     * Выбор кандидата.
     */

    const selected =
      await selectCandidate(
        news
      );


    if (
      !selected
    ) {

      const result = {

        ok:
          true,

        stage:
          "queue",

        message:
          "Новой публикации сейчас нет: либо новости уже опубликованы, либо действует интервал обычных публикаций.",

        rss_total:
          news.length

      };


      lastPipeline =
        result;


      return result;

    }


    const item =
      selected.item;


    /*
     * ========================================================
     * AI
     * ========================================================
     */

    const ai =
      await generateWithFallback(

        buildAnalysisPrompt(

          item,

          item.articleText ||
            ""

        )

      );


    if (
      !ai.ok
    ) {

      return {

        ok:
          false,

        stage:
          "ai",

        item,

        ai

      };

    }


    const cleanAi =
      cleanAiData(

        ai.data,

        item

      );


    const text =
      buildPost(

        item,

        cleanAi

      );


    /*
     * ========================================================
     * MEDIA
     * ========================================================
     *
     * video -> image -> text
     */

    const media =
      await prepareMedia(

        selected.article

      );


    let attachment =
      null;


    if (
      media.type ===
      "video"
    ) {

      attachment = {

        type:
          "video",

        token:
          media.token

      };

    }


    else if (
      media.type ===
      "image"
    ) {

      attachment = {

        type:
          "image",

        token:
          media.token

      };

    }


    else if (
      media.type ===
      "image_url"
    ) {

      attachment = {

        type:
          "image",

        payload: {

          url:
            media.url

        }

      };

    }


    /*
     * ========================================================
     * PUBLISH
     * ========================================================
     */

    const publication =
      await publishToMax(

        TARGET_CHAT_ID,

        text,

        attachment

      );


    /*
     * MAX иногда возвращает
     * attachment.not.ready.
     *
     * Ждём и повторяем.
     */

    if (

      !publication.ok &&

      attachment &&

      /attachment\.not\.ready|not processed/i.test(

        JSON.stringify(
          publication.data ||
          {}
        )

      )

    ) {

      await sleep(
        MEDIA_WAIT_MS
      );


      const retry =
        await publishToMax(

          TARGET_CHAT_ID,

          text,

          attachment

        );


      if (
        retry.ok
      ) {

        await markProcessed(

          item,

          {

            scheduleType:
              selected.scheduleType,

            mediaType:
              media.type,

            publication:
              "ok_retry"

          }

        );


        await setLastPublish(

          selected.scheduleType

        );


        const result = {

          ok:
            true,

          retry:
            true,

          item,

          media,

          ai: {

            provider:
              ai.provider,

            model:
              ai.model,

            attempts:
              ai.attempts

          },

          publication:
            retry

        };


        lastPipeline =
          result;


        return result;

      }

    }


    if (
      !publication.ok
    ) {

      return {

        ok:
          false,

        stage:
          "max_publish",

        item,

        media,

        publication

      };

    }


    /*
     * Только после успешной публикации
     * фиксируем news + interval.
     */

    await markProcessed(

      item,

      {

        scheduleType:
          selected.scheduleType,

        mediaType:
          media.type,

        mediaSource:
          media.source ||
          null,

        maxMessage:

          publication
            .data
            ?.message
            ?.body
            ?.mid ||

          publication
            .data
            ?.message
            ?.body
            ?.id ||

          null

      }

    );


    await setLastPublish(

      selected.scheduleType

    );


    const result = {

      ok:
        true,

      duration_ms:
        Date.now() -
        started,

      schedule_type:
        selected.scheduleType,

      urgent:
        item.urgent,

      priority:
        item.priority,

      item: {

        title:
          item.title,

        source:
          item.resolvedSource,

        url:
          item.resolvedUrl

      },

      media: {

        type:
          media.type,

        source:
          media.source ||
          null

      },

      ai: {

        provider:
          ai.provider,

        model:
          ai.model,

        attempts:
          ai.attempts

      },

      publication

    };


    lastPipeline =
      result;


    return result;

  } catch (
    error
  ) {

    const result = {

      ok:
        false,

      stage:
        "exception",

      error:
        error?.message ||
        String(error),

      error_name:
        error?.name ||
        "Error"

    };


    lastPipeline =
      result;


    return result;

  } finally {

    lastPipelineFinishedAt =
      new Date()
        .toISOString();


    pipelineRunning =
      false;

  }

}


/*
 * ============================================================
 * WEBHOOK
 * ============================================================
 */

function getWebhookUrl(
  requestUrl
) {

  const u =
    new URL(
      requestUrl
    );


  return (
    `${u.origin}/webhook`
  );

}


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


  return value == null

    ? null

    : String(
        value
      );

}


async function saveWebhookLog(
  payload,
  request
) {

  await kvSet(

    [

      "factor",

      "webhook",

      crypto.randomUUID()

    ],

    {

      received_at:
        new Date()
          .toISOString(),

      method:
        request.method,

      path:
        new URL(
          request.url
        ).pathname,

      payload

    },

    7 *
    24 *
    60 *
    60 *
    1000

  );

}


/*
 * ============================================================
 * WEBHOOK SETUP
 * ============================================================
 */

async function setupWebhook(
  requestUrl
) {

  const current =
    getWebhookUrl(
      requestUrl
    );


  const before =
    await maxRequest(

      "/subscriptions",

      {

        method:
          "GET"

      }

    );


  const subscriptions =

    Array.isArray(
      before.data
        ?.subscriptions
    )

      ? before.data
          .subscriptions

      : [];


  const candidates =
    new Set(
      KNOWN_OLD_WEBHOOKS
    );


  for (
    const s
    of subscriptions
  ) {

    if (
      s?.url
    ) {

      candidates.add(
        s.url
      );

    }

  }


  const deleted =
    [];


  for (
    const oldUrl
    of candidates
  ) {

    if (

      !oldUrl ||

      oldUrl ===
        current

    ) {

      continue;

    }


    const result =
      await maxRequest(

        `/subscriptions?url=${encodeURIComponent(
          oldUrl
        )}`,

        {

          method:
            "DELETE"

        }

      );


    deleted.push({

      url:
        oldUrl,

      ok:
        result.ok,

      status:
        result.status

    });

  }


  const body = {

    url:
      current,

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
    await maxRequest(

      "/subscriptions",

      {

        method:
          "GET"

      }

    );


  return {

    ok:
      created.ok &&
      after.ok,

    webhook_url:
      current,

    deleted,

    create: {

      ok:
        created.ok,

      status:
        created.status,

      response:
        created.data

    },

    after:
      after.data

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

    "FACTOR news scanner",

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


      /*
       * Не бросаем exception,
       * если просто нет подходящей новости.
       */

      if (

        !result.ok &&

        result.stage !==
          "queue"

      ) {

        console.error(

          "[PIPELINE ERROR]",

          JSON.stringify(
            result
          )

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
       * HOME
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
            "MAX NEWS AGENT — ФАКТОР",

          runtime:
            "Deno Deploy",

          status:
            "online",

          time:
            new Date()
              .toISOString(),

          auto_pipeline:
            AUTO_PIPELINE,

          cron_schedule:
            CRON_SCHEDULE,

          target_chat_configured:
            !!TARGET_CHAT_ID,

          tls:
            maxCaStatus,

          endpoints: [

            "/check",

            "/diagnostic",

            "/rss",

            "/models",

            "/subscriptions",

            "/setup-webhook",

            "/cleanup-webhooks",

            "/pipeline",

            "/run",

            "/pipeline-state",

            "/max-test",

            "/publish-test",

            "/webhook",

            "/webhook-log"

          ]

        });

      }


      /*
       * ======================================================
       * CHECK
       * ======================================================
       */

      if (

        path === "/check" &&

        request.method ===
          "GET"

      ) {

        let max =
          null;


        if (
          MAX_BOT_TOKEN
        ) {

          max =
            await maxRequest(

              "/me",

              {

                method:
                  "GET"

              }

            );

        }


        const gemini =

          GEMINI_API_KEY

            ? await discoverGeminiModels()

            : [];


        const qwen =

          QWEN_API_KEY

            ? await discoverQwenModels()

            : [];


        return json({

          ok:

            !!(

              MAX_BOT_TOKEN &&

              max?.ok &&

              TARGET_CHAT_ID

            ),

          tls:
            maxCaStatus,

          environment: {

            MAX_BOT_TOKEN:
              !!MAX_BOT_TOKEN,

            GEMINI_API_KEY:
              !!GEMINI_API_KEY,

            QWEN_API_KEY:
              !!QWEN_API_KEY,

            TARGET_CHAT_ID:
              TARGET_CHAT_ID ||
              null,

            AUTO_PIPELINE,

            CRON_SCHEDULE

          },

          max: {

            ok:
              max?.ok ||
              false,

            status:
              max?.status ||
              null,

            response:
              max?.data ||
              null

          },

          ai: {

            gemini_models:
              gemini.slice(
                0,
                20
              ),

            qwen_models:
              qwen.slice(
                0,
                20
              )

          }

        });

      }


      /*
       * ======================================================
       * DIAGNOSTIC
       * ======================================================
       */

      if (

        path === "/diagnostic" &&

        request.method ===
          "GET"

      ) {

        const me =
          await maxRequest(

            "/me",

            {

              method:
                "GET"

            }

          );


        const subscriptions =
          await maxRequest(

            "/subscriptions",

            {

              method:
                "GET"

            }

          );


        return json({

          ok:

            me.ok &&

            subscriptions.ok,

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
              TARGET_CHAT_ID ||
              null,

            AUTO_PIPELINE,

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

          pipeline: {

            running:
              pipelineRunning,

            started_at:
              lastPipelineStartedAt,

            finished_at:
              lastPipelineFinishedAt,

            last:
              lastPipeline

          }

        });

      }


      /*
       * ======================================================
       * PIPELINE STATE
       * ======================================================
       */

      if (

        path ===
          "/pipeline-state" &&

        request.method ===
          "GET"

      ) {

        const regular =
          await getLastPublish(
            "regular"
          );


        const urgent =
          await getLastPublish(
            "urgent"
          );


        return json({

          ok:
            true,

          now:
            new Date()
              .toISOString(),

          running:
            pipelineRunning,

          cron:
            CRON_SCHEDULE,

          regular: {

            interval_minutes:
              REGULAR_INTERVAL_MS /
              60000,

            last:
              regular ||
              null,

            can_publish:
              await canPublish(
                "regular"
              )

          },

          urgent: {

            interval_minutes:
              URGENT_INTERVAL_MS /
              60000,

            last:
              urgent ||
              null,

            can_publish:
              await canPublish(
                "urgent"
              )

          },

          media: {

            max_video_mb:
              MAX_VIDEO_BYTES /
              1024 /
              1024,

            max_image_mb:
              MAX_IMAGE_BYTES /
              1024 /
              1024,

            priority:
              "video -> image -> text"

          },

          dedup: {

            persistent:
              !!kv,

            ttl_days:
              HISTORY_TTL_MS /
              86400000,

            max_history_checked:
              MAX_RECENT_MESSAGES

          },

          last_pipeline:
            lastPipeline

        });

      }


      /*
       * ======================================================
       * TLS TEST
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
       * RSS
       * ======================================================
       */

      if (

        path === "/rss" &&

        request.method ===
          "GET"

      ) {

        const feeds =
          await fetchRSS();


        return json({

          ok:
            true,

          total:

            feeds.reduce(

              (sum, f) =>

                sum +
                (
                  f.count ||
                  0
                ),

              0

            ),

          feeds

        });

      }


      /*
       * ======================================================
       * MODELS
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

          configured: {

            gemini:
              GEMINI_MODELS,

            qwen:
              QWEN_MODELS

          },

          discovered: {

            gemini:
              await discoverGeminiModels(),

            qwen:
              await discoverQwenModels()

          }

        });

      }


      /*
       * ======================================================
       * MAX TEST
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

          status:
            result.status,

          response:
            result.data

        });

      }


      /*
       * ======================================================
       * SUBSCRIPTIONS
       * ======================================================
       */

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


        return json({

          ok:
            result.ok,

          status:
            result.status,

          response:
            result.data

        });

      }


      /*
       * ======================================================
       * SETUP WEBHOOK
       * ======================================================
       */

      if (

        path ===
          "/setup-webhook" &&

        request.method ===
          "GET"

      ) {

        return json(

          await setupWebhook(
            request.url
          )

        );

      }


      /*
       * ======================================================
       * CLEAN WEBHOOKS
       * ======================================================
       */

      if (

        path ===
          "/cleanup-webhooks" &&

        request.method ===
          "GET"

      ) {

        const current =
          getWebhookUrl(
            request.url
          );


        const subs =
          await maxRequest(

            "/subscriptions",

            {

              method:
                "GET"

            }

          );


        const list =

          Array.isArray(
            subs.data
              ?.subscriptions
          )

            ? subs.data
                .subscriptions

            : [];


        const deleted =
          [];


        for (
          const s
          of list
        ) {

          if (

            s?.url &&

            s.url !==
              current

          ) {

            const result =
              await maxRequest(

                `/subscriptions?url=${encodeURIComponent(
                  s.url
                )}`,

                {

                  method:
                    "DELETE"

                }

              );


            deleted.push({

              url:
                s.url,

              ok:
                result.ok,

              status:
                result.status

            });

          }

        }


        return json({

          ok:
            true,

          current_webhook:
            current,

          deleted

        });

      }


      /*
       * ======================================================
       * PUBLISH TEST
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
          )

          ||

          TARGET_CHAT_ID;


        const text =

          url.searchParams.get(
            "text"
          )

          ||

          "🔴 ФАКТОР • ТЕСТ\n\n" +

          "📡 Система публикации работает.\n\n" +

          `🕒 ${formatTime()}`;


        const result =
          await publishToMax(

            chatId,

            text

          );


        return json({

          ok:
            result.ok,

          status:
            result.status,

          response:
            result.data

        });

      }


      /*
       * ======================================================
       * PIPELINE
       * ======================================================
       */

      if (

        (

          path ===
            "/pipeline"

          ||

          path ===
            "/run"

        )

        &&

        (

          request.method ===
            "GET"

          ||

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
       * WEBHOOK LOG
       * ======================================================
       */

      if (

        path ===
          "/webhook-log" &&

        request.method ===
          "GET"

      ) {

        return json({

          ok:
            true,

          logs:

            await kvList(

              [
                "factor",
                "webhook"
              ],

              50

            )

        });

      }


      /*
       * ======================================================
       * WEBHOOK
       * ======================================================
       */

      if (

        path ===
          "/webhook" &&

        request.method ===
          "POST"

      ) {

        if (
          MAX_WEBHOOK_SECRET
        ) {

          const incoming =
            request.headers.get(

              "X-Max-Bot-Api-Secret"

            );


          if (

            incoming !==
            MAX_WEBHOOK_SECRET

          ) {

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


        let payload;


        try {

          payload =
            await request.json();

        } catch {

          return json(

            {

              ok:
                false,

              error:
                "Invalid JSON"

            },

            400

          );

        }


        await saveWebhookLog(

          payload,

          request

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

              : [

                  payload

                ];


        const processed =
          [];


        for (
          const update
          of updates
        ) {

          const chatId =
            extractChatId(
              update
            );


          if (
            chatId
          ) {

            processed.push({

              update_type:
                update?.update_type ||
                null,

              chat_id:
                chatId,

              timestamp:
                update?.timestamp ||
                null

            });

          }

        }


        /*
         * ВАЖНО:
         *
         * Webhook НЕ запускает pipeline.
         *
         * Публикация управляется cron.
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
       * UNKNOWN
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

        "[SERVER ERROR]",

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