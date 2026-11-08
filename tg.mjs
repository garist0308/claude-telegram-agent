/**
 * Обёртка над GramJS (MTProto). Весь Telegram — только здесь.
 *
 * Два правила этого файла:
 *  1) Соединение поднимается лениво и само закрывается после простоя: висящий
 *     MTProto-коннект с heartbeat'ами не нужен, пока сообщений нет.
 *  2) Ничего не печатается в stdout. Для MCP stdio stdout — это транспорт
 *     JSON-RPC, любая лишняя строка там рвёт протокол. GramJS по умолчанию
 *     болтлив, поэтому логгер выключен явно.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { Raw } from 'telegram/events/index.js';
import { readCredentials } from './config.mjs';

const IDLE_DISCONNECT_MS = 120_000;

let client = null;
let idleTimer = null;

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void disconnect();
  }, IDLE_DISCONNECT_MS);
  // Таймер не должен держать процесс живым сам по себе.
  idleTimer.unref?.();
}

export class TelegramAuthError extends Error {}

/** Поднимает соединение при первом обращении и переиспользует дальше. */
export async function getClient() {
  if (client?.connected) {
    touchIdle();
    return client;
  }
  const { apiId, apiHash, session } = readCredentials();
  client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 1000,
    autoReconnect: true,
    baseLogger: new Logger(LogLevel.NONE),
  });
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    await disconnect();
    throw new TelegramAuthError(
      'Сессия Telegram недействительна (AUTH_KEY_UNREGISTERED или сессия отозвана).\n' +
        'Это бывает, если ты вышел из этого устройства в Telegram → Settings → Devices ' +
        'или сменил пароль двухфакторной авторизации.\n' +
        'Войди заново: npm run login',
    );
  }
  touchIdle();
  return client;
}

export async function disconnect() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const c = client;
  client = null;
  if (c) {
    try {
      await c.destroy();
    } catch {
      /* соединение могло уже умереть — это не ошибка */
    }
  }
}

/** «Имя Фамилия» из сущности пользователя. */
export function displayName(entity) {
  if (!entity) return '';
  if (entity.title) return String(entity.title);
  const parts = [entity.firstName, entity.lastName].filter(Boolean);
  return parts.join(' ').trim();
}

function dialogType(d) {
  if (d.isUser) return 'user';
  if (d.isGroup) return 'group';
  if (d.isChannel) return 'channel';
  return 'unknown';
}

/**
 * Список диалогов в простом виде, пригодном для сопоставления имён.
 * Возвращает только то, что нужно для поиска получателя: без текстов сообщений.
 */
export async function listDialogs({ limit = 100, onlyUsers = true } = {}) {
  const c = await getClient();
  const dialogs = await c.getDialogs({ limit });
  const out = [];
  for (const d of dialogs) {
    const type = dialogType(d);
    if (onlyUsers && type !== 'user') continue;
    const e = d.entity ?? {};
    out.push({
      id: String(d.id),
      title: displayName(e) || String(d.title ?? ''),
      username: e.username ?? null,
      usernames: (e.usernames ?? []).map((u) => u.username).filter(Boolean),
      type,
      isBot: Boolean(e.bot),
      isSelf: Boolean(e.self),
      isDeleted: Boolean(e.deleted),
      unreadCount: d.unreadCount ?? 0,
      lastMessageDate: d.message?.date ?? d.date ?? 0,
    });
  }
  return out;
}

export async function whoami() {
  const c = await getClient();
  const me = await c.getMe();
  return {
    id: String(me.id),
    name: displayName(me),
    username: me.username ?? null,
    phone: me.phone ? `…${String(me.phone).slice(-4)}` : null, // номер целиком не нужен
    premium: Boolean(me.premium),
  };
}

/**
 * Разрешает получателя (@username или числовой id) в конкретную сущность.
 * Нужен, чтобы перед отправкой знать точно, кто это.
 */
export async function resolvePeer(peer) {
  const c = await getClient();
  const entity = await c.getEntity(peer);
  const isUser = entity instanceof Api.User;
  return {
    id: String(entity.id),
    title: displayName(entity),
    username: entity.username ?? null,
    type: isUser ? 'user' : entity.megagroup || entity.broadcast ? 'channel' : 'group',
    isBot: Boolean(entity.bot),
    isSelf: Boolean(entity.self),
    entity,
  };
}

/** Собственно отправка. Проверки — на уровне server.mjs, здесь только запрос. */
export async function sendMessage(entity, text) {
  const c = await getClient();
  const res = await c.sendMessage(entity, { message: text, parseMode: undefined });
  return { messageId: res?.id ? String(res.id) : null };
}

/**
 * Сообщения диалога, от новых к старым. Медиа не скачивается — только тип.
 * offsetId, если задан, возвращает сообщения строго старше него: так читают
 * чат полностью, вызывая инструмент несколько раз подряд (постранично).
 */
export async function getMessages(entity, { limit = 20, offsetId = 0 } = {}) {
  const c = await getClient();
  const messages = await c.getMessages(entity, { limit, offsetId });
  return messages.map((m) => ({
    id: String(m.id),
    date: m.date ? new Date(m.date * 1000).toISOString() : null,
    fromMe: Boolean(m.out),
    text: m.message || '',
    hasMedia: Boolean(m.media),
    mediaType: m.media ? m.media.className ?? 'media' : null,
    isVoice: Boolean(m.voice),
    isVideoNote: Boolean(m.videoNote),
  }));
}

/**
 * Расшифровка голосового или видео-кружка в текст — функция Telegram Premium
 * (messages.transcribeAudio). Если текст не приходит сразу (pending), ждём
 * финальное обновление UpdateTranscribedAudio до timeoutMs.
 */
export async function transcribeAudio(entity, msgId, { timeoutMs } = {}) {
  const c = await getClient();
  const res = await c.invoke(new Api.messages.TranscribeAudio({ peer: entity, msgId: Number(msgId) }));
  if (!res.pending) return { text: res.text, pending: false };

  return await new Promise((resolve) => {
    let done = false;
    const event = new Raw({ types: [Api.UpdateTranscribedAudio] });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.removeEventHandler(handler, event);
      resolve(result);
    };
    const handler = (update) => {
      if (String(update.transcriptionId) !== String(res.transcriptionId)) return;
      if (update.pending) return; // промежуточное обновление — ждём финальное
      finish({ text: update.text, pending: false });
    };
    c.addEventHandler(handler, event);
    const timer = setTimeout(() => finish({ text: null, pending: true }), timeoutMs);
  });
}

/** Отправка файла. Путь и размер проверены заранее в server.mjs. */
export async function sendFile(entity, filePath, caption) {
  const c = await getClient();
  const res = await c.sendFile(entity, { file: filePath, caption: caption || undefined, parseMode: undefined });
  return { messageId: res?.id ? String(res.id) : null };
}
