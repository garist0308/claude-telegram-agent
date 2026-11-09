/**
 * Интеграционный тест MCP-сервера без Telegram.
 *
 * Проверяет то, что обычно и ломается в stdio-серверах: что сервер поднимается,
 * что в stdout идёт только JSON-RPC (лишняя строка там рвёт протокол),
 * что инструменты объявлены, и что без кредов пользователь получает понятное
 * объяснение, а не стектрейс.
 *
 * TELEGRAM_MCP_HOME уводится в пустую временную папку, поэтому настоящие
 * креды тест не видит и не трогает.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname тут не годится: его нет до Node 20.11, а engines
// в package.json обещает 18+.
const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');

/** Поднимает сервер, отправляет запросы, возвращает распарсенные ответы и сырой stdout. */
function talk(requests, { env = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-test-'));
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TELEGRAM_MCP_HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const responses = [];
    const wanted = requests.filter((r) => r.id !== undefined).length;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`таймаут; stdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (b) => {
      stdout += b.toString();
      for (const line of stdout.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const msg = JSON.parse(s);
          if (msg.id !== undefined && !responses.some((r) => r.id === msg.id)) responses.push(msg);
        } catch {
          /* строка могла прийти не целиком — дождёмся следующего чанка */
        }
      }
      if (responses.length >= wanted) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve({ responses, stdout, stderr });
      }
    });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);

    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
const INITED = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('сервер отвечает на initialize', async () => {
  const { responses } = await talk([INIT]);
  const init = responses.find((r) => r.id === 1);
  assert.ok(init, 'нет ответа на initialize');
  assert.equal(init.result.serverInfo.name, 'telegram-personal');
  assert.ok(init.result.instructions?.includes('telegram_find_recipient'), 'инструкции должны вести агента к поиску');
});

test('в stdout только JSON-RPC, без постороннего вывода', async () => {
  const { stdout } = await talk([INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length > 0, 'stdout пуст');
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `в stdout попала не-JSON строка: ${line}`);
  }
});

test('объявлены все семь инструментов', async () => {
  const { responses } = await talk([INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const names = responses.find((r) => r.id === 2).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'telegram_download_file',
    'telegram_find_recipient',
    'telegram_list_dialogs',
    'telegram_read_messages',
    'telegram_send_file',
    'telegram_send_message',
    'telegram_whoami',
  ]);
});

test('у отправки обязательны peer, text и expect_title; reply_to_message_id необязателен', async () => {
  const { responses } = await talk([INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const send = responses.find((r) => r.id === 2).result.tools.find((t) => t.name === 'telegram_send_message');
  assert.deepEqual(send.inputSchema.required.sort(), ['expect_title', 'peer', 'text']);
  assert.ok('reply_to_message_id' in send.inputSchema.properties, 'нет reply_to_message_id в схеме');
});

test('у чтения обязательны peer и expect_title; offset_id, limit, transcribe необязательны', async () => {
  const { responses } = await talk([INIT, INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const tools = responses.find((r) => r.id === 2).result.tools;
  const read = tools.find((t) => t.name === 'telegram_read_messages');
  assert.deepEqual(read.inputSchema.required.sort(), ['expect_title', 'peer']);
  assert.deepEqual(Object.keys(read.inputSchema.properties).sort(), [
    'expect_title',
    'limit',
    'offset_id',
    'peer',
    'transcribe',
  ]);

  const sendFile = tools.find((t) => t.name === 'telegram_send_file');
  assert.deepEqual(sendFile.inputSchema.required.sort(), ['expect_title', 'file_path', 'peer']);

  const download = tools.find((t) => t.name === 'telegram_download_file');
  assert.deepEqual(download.inputSchema.required.sort(), ['dest_dir', 'expect_title', 'message_id', 'peer']);
});

test('telegram_send_file отказывает по несуществующему файлу раньше, чем спрашивает креды', async () => {
  const { responses } = await talk([
    INIT,
    INITED,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'telegram_send_file',
        arguments: { peer: '@someone', file_path: '/no/such/file.txt', expect_title: 'Кто-то' },
      },
    },
  ]);
  const res = responses.find((r) => r.id === 2);
  assert.ok(res.result?.isError, 'несуществующий файл должен быть ошибкой');
  assert.match(res.result.content[0].text, /Файл не найден/);
});

test('telegram_send_file отказывает по относительному пути', async () => {
  const { responses } = await talk([
    INIT,
    INITED,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'telegram_send_file',
        arguments: { peer: '@someone', file_path: 'relative.txt', expect_title: 'Кто-то' },
      },
    },
  ]);
  const res = responses.find((r) => r.id === 2);
  assert.ok(res.result?.isError, 'относительный путь должен быть ошибкой');
  assert.match(res.result.content[0].text, /абсолютным путём/);
});

test('telegram_download_file отказывает по относительному dest_dir раньше, чем спрашивает креды', async () => {
  const { responses } = await talk([
    INIT,
    INITED,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'telegram_download_file',
        arguments: { peer: '@someone', message_id: '1', dest_dir: 'relative-dir', expect_title: 'Кто-то' },
      },
    },
  ]);
  const res = responses.find((r) => r.id === 2);
  assert.ok(res.result?.isError, 'относительный dest_dir должен быть ошибкой');
  assert.match(res.result.content[0].text, /абсолютным путём/);
});

test('без кредов telegram_read_messages приходит объяснение, а не падение', async () => {
  const { responses } = await talk([
    INIT,
    INITED,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'telegram_read_messages', arguments: { peer: '@someone', expect_title: 'Кто-то' } },
    },
  ]);
  const res = responses.find((r) => r.id === 2);
  assert.ok(res.result?.isError, 'вызов без кредов должен быть ошибкой инструмента');
  assert.match(res.result.content[0].text, /npm run login/);
});

test('без кредов приходит объяснение, а не падение', async () => {
  const { responses } = await talk([
    INIT,
    INITED,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'telegram_whoami', arguments: {} } },
  ]);
  const res = responses.find((r) => r.id === 2);
  assert.ok(res.result?.isError, 'вызов без кредов должен быть ошибкой инструмента');
  const text = res.result.content[0].text;
  assert.match(text, /npm run login/, 'в тексте должно быть, что делать дальше');
});

test('схема аргументов проверяется: пустой text не проходит', async () => {
  const { responses } = await talk([
    INIT,
    INITED,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'telegram_send_message', arguments: { peer: '@someone', text: '', expect_title: 'Кто-то' } },
    },
  ]);
  const res = responses.find((r) => r.id === 2);
  const text = JSON.stringify(res);
  assert.ok(res.error || res.result?.isError, `пустой text должен быть отклонён, получено: ${text}`);
});
