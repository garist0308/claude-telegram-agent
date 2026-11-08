/**
 * Пути, креды, флаги и лимиты.
 *
 * Креды лежат ВНЕ репозитория — в ~/.telegram-mcp с правами 0600.
 * Строка сессии MTProto равносильна паролю от Telegram: кто её получил,
 * читает чаты и пишет от твоего имени, пока сессия не отозвана. Поэтому она
 * не попадает ни в аргументы инструментов, ни в вывод, ни в логи, ни в git.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';

export const DIR = process.env.TELEGRAM_MCP_HOME || join(homedir(), '.telegram-mcp');
export const CREDENTIALS_FILE = join(DIR, 'credentials.json');
export const SENT_LOG = join(DIR, 'sent.log');
export const RATE_FILE = join(DIR, 'ratelimit.json');

/** Флаги поведения. Все выключены по умолчанию: разрешать — осознанно. */
export const flags = {
  dryRun: process.env.TELEGRAM_MCP_DRY_RUN === '1',
  allowGroups: process.env.TELEGRAM_MCP_ALLOW_GROUPS === '1',
  allowBots: process.env.TELEGRAM_MCP_ALLOW_BOTS === '1',
};

/** Лимиты против случайной рассылки: за флуд Telegram банит навсегда. */
export const limits = {
  minIntervalSec: Number(process.env.TELEGRAM_MCP_MIN_INTERVAL_SEC ?? 5),
  maxPerHour: Number(process.env.TELEGRAM_MCP_MAX_PER_HOUR ?? 20),
  maxTextLength: 4096,
  maxCaptionLength: 1024, // лимит Telegram для подписи к файлу, не настраивается
  maxFileBytes: Number(process.env.TELEGRAM_MCP_MAX_FILE_MB ?? 50) * 1024 * 1024,
  maxReadMessages: 100,
  maxTranscribePerCall: 5, // голосовых/кружков за один вызов telegram_read_messages
  transcribeTimeoutMs: 20_000, // Telegram не всегда отдаёт текст сразу — ждём обновление
};

export function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DIR, 0o700);
  } catch {
    /* на некоторых ФС chmod недоступен — не критично */
  }
}

export class ConfigError extends Error {}

export function readCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new ConfigError(
      `Нет файла с кредами: ${CREDENTIALS_FILE}\n` +
        `Telegram-аккаунт ещё не подключён. Запусти вход один раз:\n` +
        `  cd ${process.cwd()} && npm run login`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Файл ${CREDENTIALS_FILE} повреждён: ${e.message}`);
  }
  for (const key of ['apiId', 'apiHash', 'session']) {
    if (!raw[key]) throw new ConfigError(`В ${CREDENTIALS_FILE} не хватает поля "${key}". Перезапусти npm run login.`);
  }
  // Предупреждаем, если права на файл шире 0600.
  try {
    const mode = fs.statSync(CREDENTIALS_FILE).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `[telegram-mcp] ВНИМАНИЕ: ${CREDENTIALS_FILE} доступен не только владельцу (${mode.toString(8)}). ` +
          `Исправь: chmod 600 ${CREDENTIALS_FILE}\n`,
      );
    }
  } catch {
    /* статистика недоступна — не блокируем работу */
  }
  return { apiId: Number(raw.apiId), apiHash: String(raw.apiHash), session: String(raw.session) };
}

export function writeCredentials({ apiId, apiHash, session }) {
  ensureDir();
  const body = JSON.stringify({ apiId: Number(apiId), apiHash, session }, null, 2);
  // Создаём сразу с 0600, чтобы файл ни на миг не был доступен другим.
  fs.writeFileSync(CREDENTIALS_FILE, body, { mode: 0o600 });
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

export function hasCredentials() {
  return fs.existsSync(CREDENTIALS_FILE);
}

/* --------------------------- лимит частоты --------------------------- */

function readRate() {
  try {
    return JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
  } catch {
    return { sends: [] };
  }
}

/**
 * Проверяет лимиты, НЕ записывая факт отправки.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkRateLimit(now = Date.now()) {
  const { sends } = readRate();
  const recent = sends.filter((t) => now - t < 3600_000);
  const last = sends.length ? Math.max(...sends) : 0;
  const sinceLast = (now - last) / 1000;

  if (last && sinceLast < limits.minIntervalSec) {
    const wait = Math.ceil(limits.minIntervalSec - sinceLast);
    return { ok: false, reason: `Слишком часто: между отправками нужно ${limits.minIntervalSec} с, подожди ещё ${wait} с.` };
  }
  if (recent.length >= limits.maxPerHour) {
    return {
      ok: false,
      reason:
        `Достигнут лимит ${limits.maxPerHour} сообщений в час (защита от случайной рассылки: ` +
        `за флуд через MTProto Telegram банит аккаунт навсегда). ` +
        `Подними TELEGRAM_MCP_MAX_PER_HOUR, если это осознанное решение.`,
    };
  }
  return { ok: true };
}

/** Записывает факт отправки — только после успеха. */
export function recordSend(now = Date.now()) {
  ensureDir();
  const { sends } = readRate();
  const kept = sends.filter((t) => now - t < 3600_000);
  kept.push(now);
  fs.writeFileSync(RATE_FILE, JSON.stringify({ sends: kept }), { mode: 0o600 });
}

/** Журнал отправок: что ушло, кому и когда. Текст сообщения пишем — это твои же слова. */
export function appendSentLog(entry) {
  ensureDir();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(SENT_LOG, line, { mode: 0o600 });
}
