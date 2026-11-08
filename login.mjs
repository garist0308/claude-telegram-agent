#!/usr/bin/env node
/**
 * Одноразовый вход в Telegram. Запускается человеком в терминале: npm run login
 *
 * Код входа приходит в приложение Telegram, пароль двухфакторной авторизации
 * знает только владелец аккаунта — поэтому и то и другое вводится здесь руками,
 * а не передаётся агенту. Ввод api_hash и пароля не отображается на экране.
 *
 * Результат — ~/.telegram-mcp/credentials.json с правами 0600. Строка сессии
 * никуда не печатается: она равносильна паролю от Telegram.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { writeCredentials, CREDENTIALS_FILE, hasCredentials, DIR } from './config.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let finished = false;

const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

/** Ввод без эха: api_hash и пароль 2FA не должны оставаться на экране. */
function askHidden(q) {
  return new Promise((resolve) => {
    let shown = false;
    const original = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (chunk) => {
      if (!shown) {
        original(q);
        shown = true;
        return;
      }
      if (chunk.includes('\n') || chunk.includes('\r')) original('\n');
    };
    rl.question(q, (a) => {
      rl._writeToOutput = original;
      resolve(a.trim());
    });
  });
}

function bail(msg) {
  // fs.writeSync, а не console.error: запись в пайп асинхронна, и process.exit()
  // сразу после console.error успевает обрезать вывод.
  fs.writeSync(2, `\n✖ ${msg}\n`);
  finished = true; // причину уже назвали — обработчику close добавлять нечего
  rl.close();
  process.exit(1);
}

async function main() {
  // Здесь вводят код входа и пароль двухфакторной авторизации. При вводе не из
  // терминала readline теряет строки, а скрытый ввод не скрывает ничего, —
  // поэтому лучше честно отказаться, чем работать с паролем вслепую.
  if (!process.stdin.isTTY) {
    bail(
      'Нужен интерактивный терминал: здесь вводятся код входа и пароль 2FA.\n' +
        '  Запусти вручную:  cd telegram-mcp && npm run login\n' +
        '  Передавать код и пароль через пайп или переменные окружения нельзя.',
    );
  }

  console.log('Подключение личного аккаунта Telegram к MCP-серверу для Клода.\n');

  if (hasCredentials()) {
    console.log(`Уже есть ${CREDENTIALS_FILE}.`);
    const again = await ask('Войти заново и перезаписать? [y/N]: ');
    if (again.toLowerCase() !== 'y') {
      console.log('Ничего не меняю.');
      rl.close();
      return;
    }
  }

  // Переиспользуем api_id/api_hash, если они уже сохранены: получать их заново
  // на my.telegram.org при повторном входе не нужно.
  let apiId = '';
  let apiHash = '';
  if (hasCredentials()) {
    try {
      const prev = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
      if (prev.apiId && prev.apiHash) {
        const reuse = await ask(`Взять прежние api_id (${prev.apiId}) и api_hash? [Y/n]: `);
        if (reuse.toLowerCase() !== 'n') {
          apiId = String(prev.apiId);
          apiHash = String(prev.apiHash);
        }
      }
    } catch {
      /* старый файл нечитаем — спросим всё заново */
    }
  }

  if (!apiId) {
    console.log('\nШаг 1. api_id и api_hash приложения Telegram.');
    console.log('Где взять: https://my.telegram.org → API development tools (открывается и с телефона).');
    console.log('Это идентификаторы приложения, а не твой пароль. Вводятся один раз.\n');
    apiId = await ask('api_id (число): ');
    if (!/^\d+$/.test(apiId)) bail('api_id должен быть числом. Проверь страницу my.telegram.org.');
    apiHash = await askHidden('api_hash (ввод скрыт): ');
    if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
      bail('api_hash должен быть строкой из 32 шестнадцатеричных символов.');
    }
  }

  console.log('\nШаг 2. Вход в аккаунт.');
  console.log('Учти: Telegram ограничивает число попыток входа на один номер в сутки (порядка пяти).');
  console.log('Остальные твои устройства получат уведомление о новом входе — это ожидаемо.\n');
  const phone = await ask('Номер телефона в международном формате (+79001234567): ');
  if (!/^\+\d{7,15}$/.test(phone)) bail('Номер должен начинаться с + и содержать только цифры.');

  const session = new StringSession('');
  const client = new TelegramClient(session, Number(apiId), apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.ERROR),
  });

  let authError = null;
  try {
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        console.log('\nКод отправлен в приложение Telegram. Он живёт недолго — введи сразу.');
        return await ask('Код из Telegram: ');
      },
      password: async () => {
        console.log('\nНа аккаунте включена двухфакторная авторизация.');
        return await askHidden('Пароль 2FA (ввод скрыт): ');
      },
      onError: (err) => {
        authError = err;
        return true; // не повторять попытку автоматически: попытки входа лимитированы
      },
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes('PHONE_CODE_EXPIRED')) bail('Код входа истёк. Запусти npm run login снова и введи код быстрее.');
    if (msg.includes('PHONE_CODE_INVALID')) bail('Неверный код входа.');
    if (msg.includes('PASSWORD_HASH_INVALID')) bail('Неверный пароль двухфакторной авторизации.');
    if (msg.includes('PHONE_NUMBER_UNOCCUPIED')) bail('На этом номере нет аккаунта Telegram. Сначала зарегистрируйся в приложении.');
    if (/FLOOD_WAIT_(\d+)/.test(msg)) {
      bail(`Telegram ограничил попытки входа. Подожди ${msg.match(/FLOOD_WAIT_(\d+)/)[1]} с.`);
    }
    bail(`Не удалось войти: ${msg}`);
  }
  if (authError) bail(`Не удалось войти: ${authError.message ?? authError}`);

  const me = await client.getMe();
  const sessionString = client.session.save();
  if (!sessionString) bail('Telegram не вернул строку сессии. Повтори вход.');

  writeCredentials({ apiId, apiHash, session: sessionString });

  console.log('\n✔ Готово.');
  console.log(`  Аккаунт: ${[me.firstName, me.lastName].filter(Boolean).join(' ')}${me.username ? ` (@${me.username})` : ''}`);
  console.log(`  Креды:   ${CREDENTIALS_FILE} (права 0600, вне репозитория)`);
  console.log('  Строка сессии на экран не выводится и в git не попадает.');
  console.log(`\n  Отозвать доступ в любой момент: Telegram → Settings → Devices → удалить сессию.`);
  console.log(`  Удалить креды с машины: rm -rf ${DIR}`);

  // Безопасная проверка отправки: в «Избранное», то есть самому себе.
  const test = await ask('\nОтправить тестовое сообщение самому себе в «Избранное»? [Y/n]: ');
  if (test.toLowerCase() !== 'n') {
    try {
      await client.sendMessage('me', { message: 'telegram-mcp подключён ✓' });
      console.log('✔ Сообщение ушло. Проверь «Избранное» (Saved Messages) в Telegram.');
    } catch (e) {
      console.error(`✖ Отправка не удалась: ${e?.message ?? e}`);
    }
  }

  await client.destroy();
  rl.close();
}

rl.on('close', () => {
  if (!finished) {
    fs.writeSync(2, '\n✖ Ввод прерван — вход не завершён. Ничего не сохранено.\n');
    process.exit(1);
  }
});

main()
  .then(() => {
    finished = true;
  })
  .catch((e) => {
    finished = true;
    fs.writeSync(2, `\n✖ ${e?.stack ?? e}\n`);
    rl.close();
    process.exit(1);
  });
