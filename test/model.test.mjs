// Tests of the schedule model: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, formatDay, rulesFromDays, applyRule, changedDays } from '../ha-weekly-schedule-card.js';

const week = (texts) => texts.map((t, i) => parseDay(t, i));
const texts = (days) => days.map(formatDay);
const D = (s) => [...'1234567'].map((c) => s.includes(c));   // '1346' → Monday, Wednesday, Thursday, Saturday
// Rules of the TP-Link HS110 of the house (Kasa app), disabled ones included
const KASA = [
  '#03:00/ON #06:00/OFF 07:00/ON 10:30/OFF', '#06:00/OFF 10:30/OFF', '#03:00/ON #06:00/OFF 07:00/ON 10:30/OFF',
  '#03:00/ON #06:00/OFF 07:00/ON 10:30/OFF', '#06:00/OFF #07:00/ON #09:00/OFF 10:30/OFF',
  '#03:00/ON #06:00/OFF 07:00/ON 10:30/OFF', '#06:00/OFF #07:00/ON 10:30/OFF'];

test('parse / format (order of the device, # = disabled)', () => {
  assert.equal(formatDay(parseDay(' 9:05/on  #07:00/on 07:00/OFF ')), '07:00/OFF #07:00/ON 09:05/ON');
  assert.deepEqual(parseDay(''), []);
  assert.deepEqual(parseDay('#03:00/ON'), [{ m: 180, on: true, enabled: false }]);
  for (const bad of ['25:00/ON', '07:00/MAYBE', '07:00/ON 07:00/OFF', '07:00/ON 07:00/ON', '#07:00/ON #07:00/ON', '##07:00/ON',
    Array.from({ length: 21 }, (_, i) => `#${i}:00/ON`).join(' ')]) {
    assert.throws(() => parseDay(bad, 2), (e) => e.day === 2, bad);
  }
  assert.equal(formatDay(parseDay('07:00/ON #07:00/OFF')), '07:00/ON #07:00/OFF');
});

test('Kasa rules: grouped by time, action and state', () => {
  const rules = rulesFromDays(week(KASA));
  assert.deepEqual(rules.map((r) => [r.m, r.on, r.enabled, r.days.map(Number).join('')]), [
    [180, true, false, '1011010'],
    [360, false, false, '1111111'],
    [420, true, true, '1011010'],
    [420, true, false, '0000101'],
    [540, false, false, '0000100'],
    [630, false, true, '1111111'],
  ]);
});

test('add, change, delete a rule', () => {
  const days = week(['', '', '', '', '', '', '']);
  let d = applyRule(days, null, { m: 420, on: true, enabled: true, days: D('1346') });
  d = applyRule(d, null, { m: 630, on: false, enabled: true, days: D('1234567') });
  assert.deepEqual(texts(d), ['07:00/ON 10:30/OFF', '10:30/OFF', '07:00/ON 10:30/OFF', '07:00/ON 10:30/OFF', '10:30/OFF',
    '07:00/ON 10:30/OFF', '10:30/OFF']);
  const [r7] = rulesFromDays(d);
  d = applyRule(d, r7, { ...r7, m: 450, days: D('16') });           // 07:30, Monday and Saturday only
  assert.deepEqual(texts(d).slice(0, 6), ['07:30/ON 10:30/OFF', '10:30/OFF', '10:30/OFF', '10:30/OFF', '10:30/OFF', '07:30/ON 10:30/OFF']);
  d = applyRule(d, rulesFromDays(d)[0], null);
  assert.deepEqual(texts(d), Array(7).fill('10:30/OFF'));
  assert.throws(() => applyRule(d, null, { m: 60, on: true, enabled: true, days: D('') }), { code: 'no_day' });
  assert.throws(() => applyRule(d, null, { m: NaN, on: true, enabled: true, days: D('1') }), { code: 'time' });
});

test('disable / enable a rule; conflicts only between enabled rules', () => {
  let d = week(KASA);
  const fri7 = rulesFromDays(d).find((r) => r.m === 420 && !r.enabled);   // Friday + Sunday 07:00 ON, disabled
  d = applyRule(d, fri7, { ...fri7, enabled: true });
  assert.equal(formatDay(d[4]), '#06:00/OFF 07:00/ON #09:00/OFF 10:30/OFF');
  assert.equal(formatDay(d[6]), '#06:00/OFF 07:00/ON 10:30/OFF');
  // enabled again on Fri and Sun: it is now the same rule as Mon/Wed/Thu/Sat 07:00 ON → merged
  assert.deepEqual(rulesFromDays(d).filter((r) => r.m === 420).map((r) => r.days.map(Number).join('')), ['1011111']);
  // an enabled OFF at 07:00 on Monday conflicts with the enabled ON; a disabled one does not
  assert.throws(() => applyRule(d, null, { m: 420, on: false, enabled: true, days: D('15') }), { code: 'conflict', day: 0 });
  d = applyRule(d, null, { m: 420, on: false, enabled: false, days: D('1') });
  assert.equal(formatDay(d[0]), '#03:00/ON #06:00/OFF 07:00/ON #07:00/OFF 10:30/OFF');
  const off7 = rulesFromDays(d).find((r) => r.m === 420 && !r.on);
  assert.throws(() => applyRule(d, off7, { ...off7, enabled: true }), { code: 'conflict', day: 0 });
});

test('same rule added twice on a day: merged, not doubled', () => {
  const d = applyRule(week(KASA), null, { m: 630, on: false, enabled: true, days: D('1') });
  assert.deepEqual(texts(d), KASA);
});

test('only the changed days are written; unreadable days are never touched', () => {
  const before = week(KASA);
  before[1] = null;                                                  // Tuesday unreadable
  const r = rulesFromDays(before).find((x) => x.m === 540);         // Friday 09:00 OFF
  const after = applyRule(before, r, { ...r, enabled: true });
  assert.deepEqual(changedDays(before, after), [4]);
  const every = rulesFromDays(before).find((x) => x.m === 630);
  assert.deepEqual(every.days.map(Number).join(''), '1011111');     // the unreadable day is not in any rule
  assert.deepEqual(changedDays(before, applyRule(before, every, { ...every, m: 640 })), [0, 2, 3, 4, 5, 6]);
  assert.throws(() => applyRule(before, every, { ...every, days: D('1234567') }), { code: 'unreadable', day: 1 });
});

test('at most 20 changes per day', () => {
  let d = week(['', '', '', '', '', '', '']);
  for (let i = 0; i < 20; i++) d = applyRule(d, null, { m: i * 60, on: i % 2 === 0, enabled: i % 3 !== 0, days: D('1') });
  assert.equal(d[0].length, 20);
  assert.throws(() => applyRule(d, null, { m: 1430, on: false, enabled: false, days: D('12') }), { code: 'too_many', day: 0 });
});
