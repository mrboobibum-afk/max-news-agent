const MAX_API = "https://platform-api2.max.ru";

const MAX_TOKEN =
  Deno.env.get("MAX_BOT_TOKEN") ||
  Deno.env.get("MAX_TOKEN") ||
  Deno.env.get("MAX_ACCESS_TOKEN") ||
  "";

const TARGET_CHAT_ID =
  Deno.env.get("TARGET_CHAT_ID") ||
  "";

const WEBHOOK_SECRET =
  Deno.env.get("MAX_WEBHOOK_SECRET") ||
  "factor_max_webhook_2026";

const kv = await Deno.openKv();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function maxFetch(
  path: string,
  options: RequestInit = {},
) {
  if (!MAX_TOKEN) {
    throw new Error("MAX_BOT_TOKEN is not configured");
  }

  const headers = new Headers(options.headers);
  headers.set("Authorization", MAX_TOKEN);
  headers.set("Content-Type", "application/json");

  const response = await fetch(`${MAX_API}${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();

  let body: unknown;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

/* ---------------------------------------------------------
   CHAT ID STORAGE
--------------------------------------------------------- */

async function getChatIds(): Promise<string[]> {
  const result = await kv.get<string[]>(["max", "chat_ids"]);
  return result.value || [];
}

async function saveChatId(chatId: unknown) {
  if (
    chatId === null ||
    chatId === undefined ||
    chatId === ""
  ) {
    return;
  }

  const id = String(chatId);

  const current = await getChatIds();

  if (!current.includes(id)) {
    current.push(id);
    await kv.set(["max", "chat_ids"], current);
  }

  await kv.set(
    ["max", "chat", id],
    {
      chat_id: id,
      saved_at: new Date().toISOString(),
    },
  );
}

async function removeChatId(chatId: unknown) {
  if (
    chatId === null ||
    chatId === undefined ||
    chatId === ""
  ) {
    return;
  }

  const id = String(chatId);

  const current = await getChatIds();

  const updated = current.filter((x) => x !== id);

  await kv.set(["max", "chat_ids"], updated);
  await kv.delete(["max", "chat", id]);
}

/* ---------------------------------------------------------
   EXTRACT CHAT ID FROM ANY MAX UPDATE
--------------------------------------------------------- */

function extractChatId(update: any): string | null {
  if (!update) return null;

  if (
    update.chat_id !== undefined &&
    update.chat_id !== null
  ) {
    return String(update.chat_id);
  }

  if (
    update.chatId !== undefined &&
    update.chatId !== null
  ) {
    return String(update.chatId);
  }

  if (
    update.chat?.chat_id !== undefined &&
    update.chat?.chat_id !== null
  ) {
    return String(update.chat.chat_id);
  }

  if (
    update.chat?.chatId !== undefined &&
    update.chat?.chatId !== null
  ) {
    return String(update.chat.chatId);
  }

  if (
    update.message?.recipient?.chat_id !== undefined &&
    update.message?.recipient?.chat_id !== null
  ) {
    return String(update.message.recipient.chat_id);
  }

  if (
    update.message?.recipient?.chatId !== undefined &&
    update.message?.recipient?.chatId !== null
  ) {
    return String(update.message.recipient.chatId);
  }

  if (
    update.message?.chat_id !== undefined &&
    update.message?.chat_id !== null
  ) {
    return String(update.message.chat_id);
  }

  return null;
}

/* ---------------------------------------------------------
   REGISTER WEBHOOK AUTOMATICALLY
--------------------------------------------------------- */

async function ensureWebhook(origin: string) {
  const webhookUrl = `${origin}/webhook`;

  const existing = await maxFetch("/subscriptions", {
    method: "GET",
  });

  if (
    existing.ok &&
    Array.isArray((existing.body as any)?.subscriptions)
  ) {
    const found = (existing.body as any).subscriptions.some(
      (item: any) =>
        item?.url === webhookUrl,
    );

    if (found) {
      return {
        ok: true,
        already_exists: true,
        webhook_url: webhookUrl,
        subscriptions: (existing.body as any).subscriptions,
      };
    }
  }

  const created = await maxFetch("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      url: webhookUrl,
      update_types: [
        "bot_added",
        "bot_removed",
        "bot_started",
        "message_created",
        "message_edited",
        "message_removed",
        "chat_title_changed",
        "bot_admin_permissions_changed",
      ],
      secret: WEBHOOK_SECRET,
    }),
  });

  return {
    ok: created.ok,
    already_exists: false,
    webhook_url: webhookUrl,
    status: created.status,
    response: created.body,
  };
}

/* ---------------------------------------------------------
   HANDLE MAX WEBHOOK
--------------------------------------------------------- */

async function handleWebhook(request: Request) {
  const suppliedSecret =
    request.headers.get("X-Max-Bot-Api-Secret");

  if (
    suppliedSecret &&
    suppliedSecret !== WEBHOOK_SECRET
  ) {
    return json({
      ok: false,
      error: "Invalid webhook secret",
    }, 403);
  }

  let update: any = null;

  try {
    update = await request.json();
  } catch {
    return json({
      ok: true,
      received: false,
      message: "Empty or invalid JSON",
    });
  }

  await kv.set(
    ["max", "last_update"],
    {
      received_at: new Date().toISOString(),
      update,
    },
  );

  const chatId = extractChatId(update);

  if (chatId) {
    await saveChatId(chatId);
  }

  const updateType =
    update?.update_type ||
    update?.type ||
    "";

  if (updateType === "bot_removed") {
    if (chatId) {
      await removeChatId(chatId);
    }
  }

  return json({
    ok: true,
    received: true,
    update_type: updateType,
    chat_id: chatId,
  });
}

/* ---------------------------------------------------------
   GET UPDATES FALLBACK
--------------------------------------------------------- */

async function pullUpdates() {
  const markerResult =
    await kv.get<number>(["max", "marker"]);

  const marker = markerResult.value;

  let url = "/updates";

  if (
    marker !== null &&
    marker !== undefined
  ) {
    url += `?marker=${encodeURIComponent(marker)}`;
  }

  const result = await maxFetch(url, {
    method: "GET",
  });

  if (!result.ok) {
    return result;
  }

  const body: any = result.body || {};

  const updates =
    Array.isArray(body.updates)
      ? body.updates
      : [];

  for (const update of updates) {
    const chatId = extractChatId(update);

    if (chatId) {
      await saveChatId(chatId);
    }

    if (
      update?.update_type === "bot_removed" &&
      chatId
    ) {
      await removeChatId(chatId);
    }

    await kv.set(
      ["max", "last_update"],
      {
        received_at: new Date().toISOString(),
        update,
        source: "polling",
      },
    );
  }

  if (
    body.marker !== undefined &&
    body.marker !== null
  ) {
    await kv.set(
      ["max", "marker"],
      body.marker,
    );
  }

  return result;
}

/* ---------------------------------------------------------
   MAIN SERVER
--------------------------------------------------------- */

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;

  /* ---------------- WEBHOOK ---------------- */

  if (
    request.method === "POST" &&
    path === "/webhook"
  ) {
    return await handleWebhook(request);
  }

  /* ---------------- MAX TEST ---------------- */

  if (
    request.method === "GET" &&
    (
      path === "/MaxTest" ||
      path === "/maxtest" ||
      path === "/max-test"
    )
  ) {
    try {
      const origin = url.origin;

      const me = await maxFetch("/me", {
        method: "GET",
      });

      const webhook = await ensureWebhook(origin);

      const chatIds = await getChatIds();

      return json({
        ok:
          me.ok &&
          webhook.ok,

        service: "MAX NEWS AGENT",

        runtime: "Deno Deploy",

        bot: me.body,

        webhook,

        target_chat_id:
          TARGET_CHAT_ID || null,

        chat_ids: chatIds,

        chat_ids_count:
          chatIds.length,

        message:
          chatIds.length > 0
            ? "MAX connected. Chat IDs detected and stored automatically."
            : "MAX connected. Webhook registered. Waiting for chat event.",
      });
    } catch (error) {
      return json({
        ok: false,
        service: "MAX NEWS AGENT",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }, 500);
    }
  }

  /* ---------------- CHAT IDS ---------------- */

  if (
    request.method === "GET" &&
    path === "/chat-ids"
  ) {
    const chatIds = await getChatIds();

    return json({
      ok: true,
      provider: "MAX",
      endpoint: "/chat-ids",
      chat_ids: chatIds,
      count: chatIds.length,
      source: "Deno KV + Webhook",
      target_chat_id:
        TARGET_CHAT_ID || null,
    });
  }

  /* ---------------- WEBHOOK STATUS ---------------- */

  if (
    request.method === "GET" &&
    path === "/webhook-status"
  ) {
    try {
      const subscriptions =
        await maxFetch(
          "/subscriptions",
          {
            method: "GET",
          },
        );

      return json({
        ok: subscriptions.ok,
        provider: "MAX",
        endpoint: "/subscriptions",
        http_status: subscriptions.status,
        response: subscriptions.body,
      });
    } catch (error) {
      return json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }, 500);
    }
  }

  /* ---------------- PULL UPDATES ---------------- */

  if (
    request.method === "GET" &&
    path === "/pull-updates"
  ) {
    try {
      const result = await pullUpdates();

      const chatIds = await getChatIds();

      return json({
        ok: result.ok,
        provider: "MAX",
        endpoint: "/updates",
        http_status: result.status,
        chat_ids: chatIds,
        updates:
          (result.body as any)?.updates || [],
        marker:
          (result.body as any)?.marker ?? null,
        raw: result.body,
      });
    } catch (error) {
      return json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }, 500);
    }
  }

  /* ---------------- HEALTH ---------------- */

  if (
    request.method === "GET" &&
    (
      path === "/" ||
      path === "/health"
    )
  ) {
    return json({
      ok: true,
      service: "MAX NEWS AGENT",
      runtime: "Deno Deploy",
      max_configured: Boolean(MAX_TOKEN),
      target_chat_configured:
        Boolean(TARGET_CHAT_ID),
      endpoints: [
        "/MaxTest",
        "/chat-ids",
        "/webhook-status",
        "/pull-updates",
        "/webhook",
        "/health",
      ],
    });
  }

  return json({
    ok: false,
    error: "Endpoint not found",
    path,
  }, 404);
});
