// Tests of the schedule model: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, formatDay, analyse, segments, setPeriod, deletePeriod, setChange, deleteChange } from '../ha-weekly-schedule-card.js';

const week = (texts) => texts.map(parseDay);
const texts = (days) => days.map(formatDay);
// Schedule copied from the TP-Link HS110 of the house (Mon, Wed, Thu, Sat 07:00-10:30; OFF at 10:30 every day)
const TPLINK = ['07:00/ON 10:30/OFF', '10:30/OFF', '07:00/ON 10:30/OFF', '07:00/ON 10:30/OFF', '10:30/OFF',
  '07:00/ON 10:30/OFF', '10:30/OFF'];

test('parse / format', () => {
  assert.equal(formatDay(parseDay(' 9:05/on  07:00/OFF ')), '07:00/OFF 09:05/ON');
  assert.deepEqual(parseDay(''), []);
  assert.throws(() => parseDay('25:00/ON'));
  assert.throws(() => parseDay('07:00/MAYBE'));
  assert.throws(() => parseDay('07:00/ON 07:00/OFF'));
});

test('TP-Link schedule: 4 periods, 3 single stops', () => {
  const { blocks, events, initial } = analyse(week(TPLINK));
  assert.equal(initial, false);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map((b) => [b.start.day, b.start.m, b.end.day, b.end.m]),
    [[0, 420, 0, 630], [2, 420, 2, 630], [3, 420, 3, 630], [5, 420, 5, 630]]);
  assert.deepEqual(events.filter((e) => !e.edge).map((e) => [e.day, e.m, e.on]), [[1, 630, false], [4, 630, false], [6, 630, false]]);
});

test('night period across midnight and week wrap', () => {
  let a = analyse(week(['22:00/ON', '02:00/OFF', '', '', '', '', '']));
  assert.equal(a.blocks.length, 1);
  assert.deepEqual(segments(a.blocks[0].start.t, 240), [{ day: 0, from: 1320, to: 1440 }, { day: 1, from: 0, to: 120 }]);
  a = analyse(week(['02:00/OFF', '', '', '', '', '', '22:00/ON']));
  assert.equal(a.initial, true);
  assert.deepEqual(segments(a.blocks[0].start.t, 240), [{ day: 6, from: 1320, to: 1440 }, { day: 0, from: 0, to: 120 }]);
});

test('ON all week / empty week', () => {
  const a = analyse(week(['07:00/ON', '', '', '', '', '', '']));
  assert.equal(a.initial, true);
  assert.deepEqual(a.blocks, [{ start: null, end: null }]);
  assert.deepEqual(analyse(week(['', '', '', '', '', '', ''])).blocks, []);
});

test('add, move, delete a period', () => {
  let d = week(TPLINK);
  d = setPeriod(d, null, 1, 18 * 60, 1, 20 * 60);
  assert.equal(texts(d)[1], '10:30/OFF 18:00/ON 20:00/OFF');
  const mon = analyse(d).blocks[0];
  d = setPeriod(d, mon, 0, 6 * 60, 0, 9 * 60);
  assert.equal(texts(d)[0], '06:00/ON 09:00/OFF');
  d = deletePeriod(d, analyse(d).blocks[0]);
  assert.equal(texts(d)[0], '');
  // night period created on Friday, ends Saturday
  d = setPeriod(week(TPLINK), null, 4, 23 * 60, 5, 60);
  assert.deepEqual([texts(d)[4], texts(d)[5]], ['10:30/OFF 23:00/ON', '01:00/OFF 07:00/ON 10:30/OFF']);
});

test('refuses overlaps and inverted periods', () => {
  const d = week(TPLINK);
  assert.throws(() => setPeriod(d, null, 0, 8 * 60, 0, 9 * 60), /overlap/);     // inside Monday's period
  assert.throws(() => setPeriod(d, null, 0, 6 * 60, 0, 8 * 60), /overlap/);     // contains Monday 07:00
  assert.throws(() => setPeriod(d, null, 1, 9 * 60, 1, 11 * 60), /overlap/);    // contains Tuesday's stop
  assert.throws(() => setPeriod(d, null, 1, 600, 1, 600), /order/);
  assert.equal(texts(setPeriod(d, null, 0, 630, 0, 700))[0], '07:00/ON 11:40/OFF');      // starts at the end: merged
  assert.equal(texts(setPeriod(d, null, 0, 360, 0, 420))[0], '06:00/ON 10:30/OFF');      // ends at the start: merged
  assert.equal(texts(setPeriod(d, null, 1, 630, 1, 700))[1], '10:30/ON 11:40/OFF');      // replaces Tuesday's stop
});

test('single changes', () => {
  let d = setChange(week(TPLINK), null, 2, 12 * 60, false);
  assert.equal(texts(d)[2], '07:00/ON 10:30/OFF 12:00/OFF');
  const stop = analyse(d).events.find((e) => e.day === 2 && e.m === 720);
  assert.equal(stop.edge, false);
  d = deleteChange(d, stop);
  assert.equal(texts(d)[2], TPLINK[2]);
});

test('at most 20 changes per day', () => {
  let d = week(['', '', '', '', '', '', '']);
  for (let i = 0; i < 10; i++) d = setPeriod(d, null, 0, i * 60, 0, i * 60 + 30);
  assert.equal(d[0].length, 20);
  assert.throws(() => setPeriod(d, null, 0, 20 * 60, 0, 21 * 60), /too_many/);
});
