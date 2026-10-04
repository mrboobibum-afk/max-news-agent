const MAX_API = "https://platform-api2.max.ru";

interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  EDITOR_CHAT_ID?: string;
  STATE: DurableObjectNamespace;
}

type Update = {
  update_type?: string;
  timestamp?: number;
  chat_id?: number;
  user?: { user_id?: number; name?: string; username?: string };
  payload?: string | null;
  message?: any;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function maxApi(env: Env, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", env.BOT_TOKEN);
  headers.set("Content-Type", "application/json");
  return fetch(MAX_API + path, { ...init, headers });
}

async function sendToUser(env: Env, userId: number, text: string) {
  const r = await maxApi(env, `/messages?user_id=${encodeURIComponent(String(userId))}`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`MAX send user failed: ${r.status} ${await r.text()}`);
}

async function sendToChat(env: Env, chatId: string | number, text: string, attachments?: any[]) {
  const body: any = { text };
  if (attachments?.length) body.attachments = attachments;
  const r = await maxApi(env, `/messages?chat_id=${encodeURIComponent(String(chatId))}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`MAX send chat failed: ${r.status} ${await r.text()}`);
}

function userIdOf(update: Update): number | null {
  const id = update.user?.user_id;
  return typeof id === "number" ? id : null;
}

function messageOf(update: Update) {
  return update.message ?? (update as any).message_created ?? (update as any).body ?? null;
}

function messageText(message: any): string {
  return String(message?.body?.text ?? message?.text ?? "").trim();
}

function attachmentsOf(message: any): any[] {
  const a = message?.body?.attachments ?? message?.attachments ?? [];
  return Array.isArray(a) ? a : [];
}

function isUsefulSubmission(text: string, attachments: any[]) {
  if (text && /^https?:\\/\\//i.test(text)) return true;
  if (text && /(https?:\\/\\/|www\\.)/i.test(text)) return true;
  return attachments.some((a) => ["video", "image", "file"].includes(String(a?.type)));
}

function normalizeForwardAttachments(attachments: any[]) {
  return attachments
    .filter((a) => ["video", "image", "file"].includes(String(a?.type)))
    .map((a) => {
      const payload = a?.payload ?? {};
      const out: any = { type: a.type, payload: {} };
      if (payload.token) out.payload.token = payload.token;
      else if (payload.url) out.payload.url = payload.url;
      if (a.text) out.text = a.text;
      return out;
    })
    .filter((a) => Object.keys(a.payload).length > 0);
}

export class BotState {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      return json({ ok: true, service: "factor-max-bot-state" });
    }
    if (request.method !== "POST") return json({ ok: false }, 405);
    const data = await request.json();
    if (url.pathname === "/set") {
      await this.state.storage.put("mode", data.mode);
      await this.state.storage.put("expiresAt", Date.now() + Number(data.ttlMs ?? 900000));
      return json({ ok: true });
    }
    if (url.pathname === "/get") {
      const mode = await this.state.storage.get<string>("mode");
      const expiresAt = await this.state.storage.get<number>("expiresAt");
      if (!mode || !expiresAt || expiresAt < Date.now()) {
        await this.state.storage.deleteAll();
        return json({ mode: null });
      }
      return json({ mode });
    }
    if (url.pathname === "/clear") {
      await this.state.storage.deleteAll();
      return json({ ok: true });
    }
    return json({ ok: false }, 404);
  }
}

async function stateRequest(env: Env, userId: number, action: string, body?: any) {
  const id = env.STATE.idFromName(String(userId));
  const stub = env.STATE.get(id);
  return stub.fetch(`https://state.local/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function handleStarted(update: Update, env: Env) {
  const userId = userIdOf(update);
  if (!userId) return;
  const payload = String(update.payload ?? "").toLowerCase();

  if (payload === "video") {
    await stateRequest(env, userId, "set", { mode: "video", ttlMs: 15 * 60 * 1000 });
    await sendToUser(
      env,
      userId,
      "🎥 Предложить видео\\n\\nПришлите сюда видеофайл или ссылку на материал. После получения передам его редакции ФАКТОР."
    );
    return;
  }

  if (payload === "urgent") {
    await sendToUser(env, userId, "🔥 Раздел «Срочное» пока подключаем. Следующим шагом добавим подписку на срочные новости.");
    return;
  }

  if (payload === "settings") {
    await sendToUser(env, userId, "⚙️ Настройки уведомлений пока подключаем. Здесь появится выбор типов и частоты уведомлений.");
    return;
  }

  if (payload === "chat") {
    await sendToUser(env, userId, "💬 Напишите сообщение следующим сообщением — оно поступит в редакцию ФАКТОР.");
    await stateRequest(env, userId, "set", { mode: "chat", ttlMs: 15 * 60 * 1000 });
    return;
  }

  if (payload === "news" || payload === "videos") {
    await sendToUser(env, userId, payload === "news"
      ? "📰 Новости ФАКТОР публикуются в нашем канале."
      : "▶️ Видеоматериалы ФАКТОР публикуются в канале. Отдельные уведомления добавим следующим шагом.");
    return;
  }

  await sendToUser(env, userId, "Добро пожаловать в ФАКТОР. Откройте Mini App и выберите нужное действие.");
}

async function handleMessage(update: Update, env: Env) {
  const userId = userIdOf(update);
  const chatId = update.chat_id;
  if (!userId || !chatId) return;

  const stateResponse = await stateRequest(env, userId, "get", {});
  const state = await stateResponse.json() as any;
  const mode = state.mode;

  if (!mode) {
    await sendToUser(env, userId, "Выберите действие в Mini App ФАКТОР или напишите /start.");
    return;
  }

  const message = messageOf(update);
  const text = messageText(message);
  const attachments = attachmentsOf(message);

  if (mode === "video") {
    if (!isUsefulSubmission(text, attachments)) {
      await sendToUser(env, userId, "🎥 Пришлите видеофайл или ссылку на материал.");
      return;
    }

    const forwardAttachments = normalizeForwardAttachments(attachments);
    const sender = update.user?.name || update.user?.username || String(userId);
    const editorialText =
      `🎥 НОВЫЙ МАТЕРИАЛ ОТ ПОДПИСЧИКА\\n\\nОт: ${sender} (ID ${userId})` +
      (text ? `\\n\\nСсылка/текст:\\n${text}` : "");

    if (env.EDITOR_CHAT_ID) {
      await sendToChat(env, env.EDITOR_CHAT_ID, editorialText, forwardAttachments);
    }

    await stateRequest(env, userId, "clear", {});
    await sendToUser(
      env,
      userId,
      env.EDITOR_CHAT_ID
        ? "✅ Материал получен и передан редакции ФАКТОР."
        : "✅ Материал получен. Редакционный канал пока не настроен, поэтому материал сохранён только в текущем диалоге. Следующим шагом подключим адрес редакции."
    );
    return;
  }

  if (mode === "chat") {
    const sender = update.user?.name || update.user?.username || String(userId);
    if (env.EDITOR_CHAT_ID) {
      await sendToChat(env, env.EDITOR_CHAT_ID, `💬 СООБЩЕНИЕ В ФАКТОР\\n\\nОт: ${sender} (ID ${userId})\\n\\n${text || "[медиа/вложение]"}`, normalizeForwardAttachments(attachments));
      await sendToUser(env, userId, "✅ Сообщение передано редакции ФАКТОР.");
    } else {
      await sendToUser(env, userId, "✅ Сообщение получено. Подключение редакционного чата добавим следующим шагом.");
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "factor-max-bot" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const secret = request.headers.get("X-Max-Bot-Api-Secret");
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    let update: Update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    try {
      if (update.update_type === "bot_started") {
        await handleStarted(update, env);
      } else if (update.update_type === "message_created") {
        await handleMessage(update, env);
      }
    } catch (error) {
      console.error(error);
    }

    return json({ ok: true });
  },
};
