/**
 * Сопоставление имени из живой речи («Маше», «Сергею», «@ivanov») с диалогами.
 *
 * Чистые функции, без сети и без Telegram: всё тестируется локально (test-match.mjs).
 *
 * Принцип: функция НИКОГДА не решает сама, кому отправлять. Она возвращает
 * список кандидатов с уровнем уверенности, а решение принимает агент (Клод).
 * Неоднозначность — это нормальный результат, а не ошибка.
 */

/** Окончания русских косвенных падежей, от длинных к коротким. */
const RU_ENDINGS = [
  'ою', 'ею', 'ой', 'ей', 'ую', 'юю', 'ами', 'ями', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев',
  'а', 'я', 'у', 'ю', 'е', 'и', 'ы', 'о', 'й', 'ь',
];

const CYRILLIC = /[Ѐ-ӿ]/;

/** ё → е, й-варианты регистра, обрезка пробелов. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/й/g, 'й')
    .trim();
}

/** Разбивает «Маша Иванова | Дизайн 🌸» на ['маша','иванова','дизайн']. */
export function tokenize(s) {
  return normalize(s)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Основа слова: отбрасывает одно падежное окончание.
 * Только для кириллицы — у латиницы отсечение гласных склеивает разные имена
 * (Mike/Mika), поэтому латиница сравнивается как есть.
 */
export function stem(word) {
  const w = normalize(word);
  if (!CYRILLIC.test(w)) return w;
  for (const end of RU_ENDINGS) {
    if (w.length - end.length >= 2 && w.endsWith(end)) {
      return w.slice(0, -end.length);
    }
  }
  return w;
}

/**
 * Уровень совпадения одного токена запроса с одним токеном имени.
 * 'exact' — буквальное равенство; 'stem' — равенство основ при длине ≥ 3;
 * 'weak'  — равенство коротких основ (2 символа); null — не совпало.
 */
export function matchToken(queryToken, titleToken) {
  const q = normalize(queryToken);
  const t = normalize(titleToken);
  if (!q || !t) return null;
  if (q === t) return 'exact';

  const qs = stem(q);
  const ts = stem(t);
  if (qs !== ts) return null;
  return qs.length >= 3 ? 'stem' : 'weak';
}

const LEVEL_RANK = { exact: 3, stem: 2, weak: 1 };
const worst = (a, b) => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

/**
 * Сопоставляет запрос с одним диалогом.
 * @returns {{level: 'exact'|'stem'|'weak', reason: string}|null}
 */
export function matchDialog(query, dialog) {
  const raw = normalize(query);
  if (!raw) return null;

  // 1. @username — самый надёжный путь, падежей там не бывает.
  const asUsername = raw.replace(/^@/, '');
  const dialogUsernames = [dialog.username, ...(dialog.usernames ?? [])]
    .filter(Boolean)
    .map(normalize);
  if (asUsername && dialogUsernames.includes(asUsername)) {
    return { level: 'exact', reason: `username @${asUsername}` };
  }
  // Запрос начинался с «@», но username не совпал — дальше не угадываем.
  if (raw.startsWith('@')) return null;

  const queryTokens = tokenize(raw);
  const titleTokens = tokenize(dialog.title ?? '');
  if (queryTokens.length === 0 || titleTokens.length === 0) return null;

  // 2. Полное равенство имени целиком.
  if (queryTokens.join(' ') === titleTokens.join(' ')) {
    return { level: 'exact', reason: 'полное совпадение имени' };
  }

  // 3. Каждый токен запроса должен найти свой, ещё не занятый токен имени.
  const used = new Set();
  let level = 'exact';
  const hits = [];
  for (const qt of queryTokens) {
    let found = null;
    for (let i = 0; i < titleTokens.length; i++) {
      if (used.has(i)) continue;
      const m = matchToken(qt, titleTokens[i]);
      if (m) {
        found = { i, m };
        break;
      }
    }
    if (!found) return null;
    used.add(found.i);
    level = worst(level, found.m);
    hits.push(`${qt}→${titleTokens[found.i]}`);
  }

  // Один токен запроса против многословного имени — это всё ещё совпадение
  // («Маша» находит «Маша Иванова»), но уверенности меньше, чем при полном.
  if (level === 'exact' && titleTokens.length > queryTokens.length) level = 'stem';

  return { level, reason: hits.join(', ') };
}

/**
 * Ранжирует все диалоги по совпадению с запросом.
 * @param {string} query как пользователь назвал получателя
 * @param {Array} dialogs список из telegram_list_dialogs
 * @returns {Array} кандидаты, лучшие первыми
 */
export function findCandidates(query, dialogs) {
  const out = [];
  for (const d of dialogs) {
    const m = matchDialog(query, d);
    if (m) out.push({ ...d, matchLevel: m.level, matchReason: m.reason });
  }
  out.sort((a, b) => {
    const byLevel = LEVEL_RANK[b.matchLevel] - LEVEL_RANK[a.matchLevel];
    if (byLevel !== 0) return byLevel;
    // При равном уровне — свежий диалог вперёд: скорее всего имели в виду его.
    return (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0);
  });
  return out;
}
