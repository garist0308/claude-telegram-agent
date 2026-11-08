#!/usr/bin/env node
/**
 * Диагностика: npm run check
 *
 * Отвечает на один вопрос — что именно не готово. Работает и до входа в
 * Telegram, и после: если кредов нет, это не ошибка, а следующий шаг.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DIR, CREDENTIALS_FILE, SENT_LOG, hasCredentials, flags, limits } from './config.mjs';

let failures = 0;
let todos = 0;

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => { console.log(`  ✖ ${m}`); failures++; };
const todo = (m) => { console.log(`  → ${m}`); todos++; };

console.log('\ntelegram-mcp: проверка\n');

/* 1. Окружение */
console.log('Окружение');
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node}, нужен 18+`);

// Читаем package.json файлом, а не через require: у части пакетов exports-карта
// подменяет './package.json' внутренним файлом без полей name и version.
for (const pkg of ['@modelcontextprotocol/sdk', 'telegram', 'zod']) {
  try {
    const file = new URL(`./node_modules/${pkg}/package.json`, import.meta.url);
    const { name, version } = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(`${name} ${version}`);
  } catch {
    bad(`не установлен ${pkg} — запусти установку зависимостей (см. README)`);
  }
}

/* 2. Модули сервера */
console.log('\nМодули');
for (const m of ['./match.mjs', './config.mjs', './tg.mjs']) {
  try {
    await import(m);
    ok(`${m} загружается`);
  } catch (e) {
    bad(`${m}: ${e.message}`);
  }
}

/* 3. Креды */
console.log('\nДоступ к Telegram');
console.log(`  папка: ${DIR}`);
if (!hasCredentials()) {
  todo(`аккаунт ещё не подключён. Войди один раз: npm run login`);
} else {
  const mode = fs.statSync(CREDENTIALS_FILE).mode & 0o777;
  mode & 0o077
    ? bad(`${CREDENTIALS_FILE} доступен не только владельцу (${mode.toString(8)}): chmod 600 ${CREDENTIALS_FILE}`)
    : ok(`креды на месте, права ${mode.toString(8)}`);

  process.stdout.write('  … проверяю сессию в Telegram\n');
  try {
    const { whoami } = await import('./tg.mjs');
    const { disconnect } = await import('./tg.mjs');
    const me = await whoami();
    ok(`сессия живая: ${me.name}${me.username ? ` (@${me.username})` : ''}, id ${me.id}`);
    await disconnect();
  } catch (e) {
    bad(`сессия не работает: ${e.message.split('\n')[0]}`);
  }
}

/* 4. Регистрация в Клоде */
console.log('\nРегистрация в Claude Code');
try {
  const out = execFileSync('claude', ['mcp', 'get', 'telegram'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok('сервер зарегистрирован как "telegram"');
  const scope = out.match(/Scope:\s*(.+)/)?.[1]?.trim();
  if (scope) console.log(`     область: ${scope}`);
} catch {
  todo('сервер не зарегистрирован. Команда есть в README (claude mcp add telegram …)');
}

/* 5. Режим работы */
console.log('\nРежим');
console.log(`  сухой прогон (ничего не отправляется): ${flags.dryRun ? 'ВКЛ' : 'выкл'}`);
console.log(`  группы и каналы: ${flags.allowGroups ? 'РАЗРЕШЕНЫ' : 'запрещены'}`);
console.log(`  боты: ${flags.allowBots ? 'РАЗРЕШЕНЫ' : 'запрещены'}`);
console.log(`  лимиты: 1 отправка в ${limits.minIntervalSec} с, не больше ${limits.maxPerHour} в час`);
console.log(`  максимальный размер файла: ${Math.round(limits.maxFileBytes / (1024 * 1024))} МБ`);

if (fs.existsSync(SENT_LOG)) {
  const lines = fs.readFileSync(SENT_LOG, 'utf8').trim().split('\n').filter(Boolean);
  console.log(`\nЖурнал отправок: ${lines.length} записей в ${SENT_LOG}`);
  for (const l of lines.slice(-3)) {
    try {
      const e = JSON.parse(l);
      console.log(`  ${e.at} → ${e.title}${e.dryRun ? ' [сухой прогон]' : ''}: ${String(e.text).slice(0, 60)}`);
    } catch { /* битая строка журнала не важна */ }
  }
}

console.log('');
if (failures) {
  console.log(`Итог: ${failures} проблем(ы). Выше отмечены знаком ✖.\n`);
  process.exit(1);
}
console.log(todos ? `Итог: всё исправно, осталось ${todos} шаг(а) — отмечены знаком →.\n` : 'Итог: всё готово.\n');
