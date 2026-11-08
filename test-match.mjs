import test from 'node:test';
import assert from 'node:assert/strict';
import { stem, matchToken, matchDialog, findCandidates, tokenize } from './match.mjs';

const user = (id, title, username = null, extra = {}) => ({
  id, title, username, type: 'user', isBot: false, lastMessageDate: 0, ...extra,
});

test('основа слова снимает падежное окончание', () => {
  assert.equal(stem('Маше'), stem('Маша'));
  assert.equal(stem('Машу'), stem('Маша'));
  assert.equal(stem('Маши'), stem('Маша'));
  assert.equal(stem('Сергею'), stem('Сергей'));
  assert.equal(stem('Пете'), stem('Петя'));
  assert.equal(stem('Анну'), stem('Анна'));
  assert.equal(stem('Игорю'), stem('Игорь'));
  assert.equal(stem('Дмитрию'), stem('Дмитрий'));
  assert.equal(stem('Петру'), stem('Пётр'), 'ё и е должны совпадать');
  assert.equal(stem('Ивану'), stem('Иван'));
});

test('разные имена с похожим началом не склеиваются', () => {
  assert.notEqual(stem('Маша'), stem('Миша'));
  assert.notEqual(stem('Маша'), stem('Марина'));
  assert.notEqual(stem('Аня'), stem('Анна'));
  assert.notEqual(stem('Лена'), stem('Леонид'));
});

test('латиница не режется по гласным', () => {
  assert.notEqual(stem('mike'), stem('mika'));
  assert.equal(stem('mike'), 'mike');
});

test('совпадение внутрь слова не считается', () => {
  assert.equal(matchToken('Маше', 'Машинист'), null);
  assert.equal(matchToken('Ян', 'Януковичу'), null);
});

test('уровни уверенности', () => {
  assert.equal(matchToken('Маша', 'Маша'), 'exact');
  assert.equal(matchToken('Маше', 'Маша'), 'stem');
  assert.equal(matchToken('Маша', 'Миша'), null);
});

test('@username — точное совпадение, без догадок', () => {
  const d = user('1', 'Маша Иванова', 'mashaiv');
  assert.equal(matchDialog('@mashaiv', d).level, 'exact');
  assert.equal(matchDialog('mashaiv', d).level, 'exact');
  // @ указан, но не тот — не пытаемся искать по имени
  assert.equal(matchDialog('@masha', d), null);
});

test('имя находит многословный title', () => {
  const d = user('1', 'Маша Иванова');
  const m = matchDialog('Маше', d);
  assert.ok(m, 'Маше должно находить Машу Иванову');
  assert.equal(m.level, 'stem');
});

test('имя и фамилия вместе', () => {
  const d = user('1', 'Анна Петрова');
  assert.ok(matchDialog('Анне Петровой', d));
  assert.equal(matchDialog('Анне Сидоровой', d), null);
});

test('полное совпадение имени даёт exact', () => {
  assert.equal(matchDialog('Анна Петрова', user('1', 'Анна Петрова')).level, 'exact');
});

test('эмодзи и разделители в title не мешают', () => {
  assert.ok(matchDialog('Маша', user('1', 'Маша 🌸 | Дизайн')));
  assert.deepEqual(tokenize('Маша 🌸 | Дизайн'), ['маша', 'дизайн']);
});

test('findCandidates возвращает всех однофамильцев, а не угадывает', () => {
  const dialogs = [
    user('1', 'Маша Иванова', 'mashaiv'),
    user('2', 'Маша Петрова'),
    user('3', 'Миша Сидоров'),
  ];
  const c = findCandidates('Маше', dialogs);
  assert.equal(c.length, 2, 'две Маши — две кандидатуры');
  assert.ok(!c.some((x) => x.id === '3'), 'Миша не должен попадать');
});

test('при равном уровне свежий диалог идёт первым', () => {
  const dialogs = [
    user('1', 'Маша Иванова', null, { lastMessageDate: 100 }),
    user('2', 'Маша Петрова', null, { lastMessageDate: 900 }),
  ];
  assert.equal(findCandidates('Маша', dialogs)[0].id, '2');
});

test('точное совпадение бьёт падежное', () => {
  const dialogs = [
    user('1', 'Маше', null, { lastMessageDate: 1 }),
    user('2', 'Маша', null, { lastMessageDate: 1 }),
  ];
  assert.equal(findCandidates('Маша', dialogs)[0].id, '2');
});

test('пустой и мусорный запрос ничего не находит', () => {
  const dialogs = [user('1', 'Маша')];
  assert.equal(findCandidates('', dialogs).length, 0);
  assert.equal(findCandidates('   ', dialogs).length, 0);
  assert.equal(findCandidates('???', dialogs).length, 0);
});
