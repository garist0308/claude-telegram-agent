/**
 * Тесты лимитов частоты. Это защита от случайной рассылки: за флуд через
 * MTProto Telegram банит аккаунт навсегда, поэтому лимит должен работать
 * и при обрыве, и при повторных вызовах.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tgmcp-cfg-'));
process.env.TELEGRAM_MCP_HOME = home;
process.env.TELEGRAM_MCP_MIN_INTERVAL_SEC = '5';
process.env.TELEGRAM_MCP_MAX_PER_HOUR = '3';

const { checkRateLimit, recordSend, writeCredentials, readCredentials, CREDENTIALS_FILE, appendSentLog, SENT_LOG } =
  await import('./config.mjs');

test('на пустом состоянии отправка разрешена', () => {
  assert.equal(checkRateLimit().ok, true);
});

test('сразу после отправки — отказ по интервалу', () => {
  const now = Date.now();
  recordSend(now);
  const r = checkRateLimit(now + 1000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Слишком часто/);
});

test('через интервал снова можно', () => {
  const now = Date.now();
  recordSend(now);
  assert.equal(checkRateLimit(now + 6000).ok, true);
});

test('часовой лимит останавливает серию', () => {
  const t0 = Date.now();
  // три отправки с интервалом в минуту — укладываются в лимит maxPerHour=3
  writeFileSync(join(home, 'ratelimit.json'), JSON.stringify({ sends: [t0, t0 + 60_000, t0 + 120_000] }));
  const r = checkRateLimit(t0 + 180_000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /лимит 3 сообщени/);
});

test('старые отправки выпадают из часового окна', () => {
  const t0 = Date.now();
  writeFileSync(join(home, 'ratelimit.json'), JSON.stringify({ sends: [t0, t0 + 1000, t0 + 2000] }));
  assert.equal(checkRateLimit(t0 + 3_600_001 + 2000).ok, true);
});

test('битый файл состояния не блокирует отправку', () => {
  writeFileSync(join(home, 'ratelimit.json'), 'не json');
  assert.equal(checkRateLimit().ok, true);
});

test('креды пишутся с правами 0600 и читаются обратно', () => {
  writeCredentials({ apiId: 123456, apiHash: 'a'.repeat(32), session: 'секрет' });
  assert.ok(existsSync(CREDENTIALS_FILE));
  const mode = statSync(CREDENTIALS_FILE).mode & 0o777;
  assert.equal(mode, 0o600, `права должны быть 600, получено ${mode.toString(8)}`);
  const c = readCredentials();
  assert.equal(c.apiId, 123456);
  assert.equal(c.session, 'секрет');
});

test('журнал отправок дописывается построчным JSON', () => {
  appendSentLog({ peer: '@a', title: 'A', text: 'раз' });
  appendSentLog({ peer: '@b', title: 'B', text: 'два' });
  const lines = readFileSync(SENT_LOG, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).text, 'два');
  assert.ok(JSON.parse(lines[0]).at, 'в записи должно быть время');
});
