/**
 * Импортируется ПЕРВЫМ в server.mjs.
 *
 * В MCP-транспорте stdio stdout — это канал JSON-RPC. Любая посторонняя строка
 * там ломает протокол, а GramJS и часть зависимостей пишут в console.log.
 * Поэтому все console.* уводятся в stderr: туда писать можно сколько угодно,
 * Клод показывает stderr как логи MCP-сервера.
 *
 * process.stdout.write не трогаем — им пользуется сам транспорт.
 */
const toStderr =
  (prefix) =>
  (...args) => {
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    process.stderr.write(`${prefix}${line}\n`);
  };

console.log = toStderr('');
console.info = toStderr('');
console.debug = toStderr('');
console.warn = toStderr('[warn] ');
console.error = toStderr('[error] ');
