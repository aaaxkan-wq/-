/*
 * コンディション予報：計算部の単体テスト
 *   実行： node --test forecast/test/*.test.js
 * index.html から <script id="core"> を取り出し、ブラウザの機能が何もない環境で実行する。
 * 睡眠記録はすべて合成データ（実際の記録は含めない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const coreSource = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const sandbox = {};
vm.runInNewContext(coreSource, sandbox);   // window も document も Date も渡さない
const CF = sandbox.ConditionForecast;

/* ---------- 補助 ---------- */

const pad = (n) => String(n).padStart(2, '0');
const plain = (value) => JSON.parse(JSON.stringify(value));

/* 2026年3月の d 日目（1始まり、31を超えてよい）を YYYY-MM-DD にする。3月1日は日曜 */
function date(d) {
  return d <= 31 ? `2026-03-${pad(d)}` : `2026-04-${pad(d - 31)}`;
}

/*
 * n 晩ぶんの睡眠記録。k 晩目は「k日の夜」に寝て k+1 日の朝に起きる。
 * bed が正午より前（00:30 など）なら、就寝は翌日の日付になる。
 * overrides で特定の晩（1始まり）の就寝・起床を差し替える。
 */
function nights(n, bed, wake, overrides = {}) {
  const out = [];
  for (let k = 1; k <= n; k++) {
    const b = (overrides[k] && overrides[k].bed) || bed;
    const w = (overrides[k] && overrides[k].wake) || wake;
    const bedDay = CF.parseClock(b) >= 720 ? k : k + 1;
    out.push(`${date(bedDay)}T${b}/${date(k + 1)}T${w}`);
  }
  return out;
}

function hashOf(params) {
  return '#' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
}

function run(params, clockMs = null) {
  return plain(CF.run('', hashOf(params), clockMs).result);
}

/* 1つの記録を、時刻の範囲を変えずに書き換える（分割・書式の変更用） */
function rewrite(list, fn) {
  return list.flatMap((piece) => {
    const [a, b] = piece.split('/').map((x) => CF.parseDateTime(x));
    return fn(a, b);
  });
}
const stamp = (t, suffix = '') => CF.formatDateTime(t) + suffix;

/* モデル用につないだ区間 */
function intervals(list) {
  return CF.joinIntervals(list.map((piece) => {
    const [a, b] = piece.split('/');
    return { start: CF.parseDateTime(a), end: CF.parseDateTime(b) };
  }), 9);
}

/* 最後の起床の日の 08:00〜17:00 について、1分刻みの最小・最大・平均を返す */
function daytime(list) {
  const iv = intervals(list);
  const wake = iv[iv.length - 1].end;
  const day = Math.floor(wake / 1440) * 1440;
  const sim = CF.simulate(iv, day + 1440 + 600, 0);
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let t = day + 480; t <= day + 1020; t++) {
    const e = sim.e[t - sim.t0];
    min = Math.min(min, e); max = Math.max(max, e); sum += e; n++;
  }
  return { min, max, avg: sum / n, sim, wake };
}

/* 仕様書 8 章の許容差：値は ±0.5、時刻は ±5分 */
const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${Number(actual).toFixed(2)} は ${expected}±${tolerance} の外`);
const nearClock = (actual, expected, label) =>
  near(CF.parseClock(actual), CF.parseClock(expected), 5, `${label}（${actual}）`);

const GOOD = nights(14, '23:00', '07:00');          // 23:00〜07:00 を14日
const GOOD_NOW = `${date(15)}T07:10`;
const BASE = nights(14, '23:00', '06:30');          // 23:00〜06:30 を14日
const BASE_NOW = `${date(15)}T06:40`;
const SHORT = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });   // 最後の晩だけ5時間

/* ---------- 仕様書 8 章：テストの基準値 ---------- */

test('カフェイン締切：bed=23:00, cafmg=107 → 14:12 ／ cafmg=217.5 → 09:48', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW, bed: '23:00', cafmg: '107' }).caffeine_cutoff, '14:12');
  assert.equal(run({ s: GOOD, now: GOOD_NOW, bed: '23:00', cafmg: '217.5' }).caffeine_cutoff, '09:48');
  assert.deepEqual([0, 107, 162.25, 217.5, 400].map(CF.caffeineLeadMinutes), [528, 528, 660, 792, 792]);
});

test('入浴時刻：bed=23:00 → 21:30', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW, bed: '23:00' }).bath_time, '21:30');
});

test('体内時計 c：位置を18:00に固定し、T = 12:00 / 15:00 / 18:00 / 20:00 → 0.000 / 0.207 / 1.000 / 1.299', () => {
  for (const [T, expected] of [[12, 0.000], [15, 0.207], [18, 1.000], [20, 1.299]]) {
    near(CF.circadian(T, 18), expected, 0.0005, `c(${T})`);
  }
  near(CF.circadian(19, 19), CF.circadian(18, 18), 1e-12, '位置を1時間ずらす');
});

test('十分な睡眠：23:00〜07:00 を14日 → E は最小93.1・最大96.5、谷14:30、ピーク08:40〜10:10、体内時計の位置18:00', () => {
  const d = daytime(GOOD);
  near(d.min, 93.1, 0.5, '最小');
  near(d.max, 96.5, 0.5, '最大');
  const r = run({ s: GOOD, now: GOOD_NOW });
  assert.deepEqual(r.valley, { time: '14:30', value: 93, at_edge: false });
  assert.deepEqual(r.peak, { start: '08:40', end: '10:10', avg: 96 });
  assert.equal(r.clock_peak, '18:00');
  assert.equal(r.wake_time, '07:00');
});

test('連続覚醒：同じ履歴の後、07:00 の起床から18.5時間覚醒 → E は74.8', () => {
  const d = daytime(GOOD);
  near(d.sim.e[d.wake + 18.5 * 60 - d.sim.t0], 74.8, 0.5, 'E');
});

test('体内時計の調整：01:30〜06:45 を14日 → 体内時計の位置19:07、谷15:32', () => {
  const r = run({ s: nights(14, '01:30', '06:45'), now: `${date(15)}T07:00` });
  assert.equal(r.clock_peak, '19:07');
  assert.equal(r.valley.time, '15:32');
});

test('調整の速さ：金・土の夜だけ起床を10:00にすると、2週目の日曜21:00の位置が約31分遅い', () => {
  // 3月2日（2日目）が月曜。金曜の夜は 6・13 晩目、土曜の夜は 7・14 晩目
  const late = { 6: { wake: '10:00' }, 7: { wake: '10:00' }, 13: { wake: '10:00' }, 14: { wake: '10:00' } };
  const sunday = CF.parseDateTime(`${date(15)}T21:00`);
  const position = (list) => {
    const sim = CF.simulate(intervals(list), sunday, 0);
    return sim.cp[sunday - sim.t0] * 60;
  };
  const start = nights(15, '23:00', '07:00').slice(1);            // 2日目（月曜）の夜から
  const withLate = nights(15, '23:00', '07:00', late).slice(1);
  near(position(withLate.slice(0, 13)) - position(start.slice(0, 13)), 31, 5, '位置の差（分）');

  // 月曜の谷は 14:30 から 15:13 に遅れる（10章）
  const monday = run({ s: withLate, now: `${date(16)}T07:10` });
  assert.equal(monday.valley.time, '15:13');
});

test('細切れの記録：各晩を30区間に等分しても、1区間で渡した場合と同じ結果', () => {
  const pieces = rewrite(BASE, (a, b) =>
    Array.from({ length: 30 }, (_, k) => `${stamp(a + k * (b - a) / 30)}/${stamp(a + (k + 1) * (b - a) / 30)}`));
  assert.equal(pieces.length, 14 * 30);
  assert.deepEqual(run({ s: pieces, now: BASE_NOW }), run({ s: BASE, now: BASE_NOW }));
});

test('短い中断：各晩に2分の中断を8回入れても、中断なしと同じ結果（睡眠合計だけは中断の分だけ減る）', () => {
  const broken = rewrite(BASE, (a, b) =>
    Array.from({ length: 9 }, (_, k) => `${stamp(a + k * 50)}/${stamp(k === 8 ? b : a + k * 50 + 48)}`));
  const whole = run({ s: BASE, now: BASE_NOW });
  const r = run({ s: broken, now: BASE_NOW });
  for (const key of ['status', 'wake_time', 'attention_now', 'attention_day_avg', 'peak', 'valley', 'clock_peak',
    'short_sleep', 'overeat_note', 'caffeine_cutoff', 'bath_time', 'bedtime_compare']) {
    assert.deepEqual(r[key], whole[key], key);
  }
  assert.equal(r.caution.flag, false);
  assert.equal(whole.last_night_sleep_min, 450);
  assert.equal(r.last_night_sleep_min, 434);

  // 10分以上の中断はつながない（その晩は2つの睡眠区間として計算され、値が少し下がる）
  const tenMinutes = rewrite(BASE, (a, b) => [`${stamp(a)}/${stamp(a + 200)}`, `${stamp(a + 210)}/${stamp(b)}`]);
  const nineMinutes = rewrite(BASE, (a, b) => [`${stamp(a)}/${stamp(a + 200)}`, `${stamp(a + 209)}/${stamp(b)}`]);
  assert.deepEqual(run({ s: nineMinutes, now: BASE_NOW }).bedtime_compare, whole.bedtime_compare);
  assert.notDeepEqual(run({ s: tenMinutes, now: BASE_NOW }).bedtime_compare, whole.bedtime_compare);
});

test('時刻の換算：同じ履歴を Z 付き（UTC）と +09:00 付きで渡しても同じ結果', () => {
  const plainTimes = run({ s: BASE, now: BASE_NOW });
  const utc = rewrite(BASE, (a, b) => [`${stamp(a - 540, 'Z')}/${stamp(b - 540, 'Z')}`]);
  const jst = rewrite(BASE, (a, b) => [`${stamp(a, '+09:00')}/${stamp(b, '+09:00')}`]);
  const mixed = rewrite(BASE, (a, b) => [`${stamp(a - 540, 'Z')}/${stamp(b + 300, '+14:00')}`]);
  assert.deepEqual(run({ s: utc, now: BASE_NOW }), plainTimes);
  assert.deepEqual(run({ s: jst, now: BASE_NOW + '+09:00' }), plainTimes);
  assert.deepEqual(run({ s: mixed, now: stamp(CF.parseDateTime(BASE_NOW) - 540, 'Z') }), plainTimes);
  assert.deepEqual(run({ s: utc, now: BASE_NOW, tz: '+09:00' }), plainTimes);
});

test('+ の扱い：+09:00 の + をそのまま渡しても、空白に変わっても、%2B でも同じ結果', () => {
  const jst = rewrite(BASE, (a, b) => [`${stamp(a, '+09:00')}/${stamp(b, '+09:00')}`]).join(',');
  const expected = run({ s: BASE, now: BASE_NOW });
  const open = (s, now, tz) => plain(CF.run('', `#s=${s}&now=${now}&tz=${tz}`, null).result);
  assert.deepEqual(open(jst, BASE_NOW + '+09:00', '+09:00'), expected);
  assert.deepEqual(open(jst.replaceAll('+', ' '), BASE_NOW + ' 09:00', ' 09:00'), expected);
  assert.deepEqual(open(jst.replaceAll('+', '%2B'), BASE_NOW + '%2B09:00', '%2B09:00'), expected);
  assert.deepEqual(open(jst.replaceAll('+', '%20'), BASE_NOW + '%2009:00', '09:00'), expected);
});

test('now の省略：時計が 2026-11-10T22:10:00Z → now は 2026-11-11T07:10（tz で換算する）', () => {
  const clock = Date.UTC(2026, 10, 10, 22, 10, 0);
  const r = run({ s: CF.SAMPLE.s }, clock);
  assert.equal(r.status, 'ok');
  assert.equal(r.now, '2026-11-11T07:10');
  assert.equal(r.tz, '+09:00');
  assert.equal(r.notifications[0].at, '2026-11-11T07:10+09:00');
  // tz を変えると、同じ絶対時刻が別の現地時刻になる
  const records = rewrite(CF.SAMPLE.s.split(','), (a, b) => [`${stamp(a - 540, 'Z')}/${stamp(b - 540, 'Z')}`]);
  const london = run({ s: records, tz: '+00:00' }, clock);
  assert.equal(london.now, '2026-11-10T22:10');
  assert.equal(london.wake_time, '21:50');
});

test('昨夜の欠け：23:00〜06:30 を13日、最後の晩は記録なし → status は need_last_night、notifications は空', () => {
  const r = run({ s: BASE.slice(0, 13), now: BASE_NOW });
  assert.equal(r.status, 'need_last_night');
  assert.equal(r.error, '昨夜の睡眠記録がありません');
  assert.deepEqual(r.notifications, []);
  assert.equal(r.demo, false);
  assert.equal(r.now, BASE_NOW);
  assert.equal(r.attention_now, null);
});

test('睡眠なしの確認：同じ入力に none で当日の日付を指定 → status は ok。最後の晩を睡眠なしとして計算する', () => {
  const r = run({ s: BASE.slice(0, 13), now: BASE_NOW, none: date(15) });
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, null);
  assert.equal(r.last_night_sleep_min, 0);
  assert.deepEqual(r.imputed_nights, []);
  assert.equal(r.short_sleep, true);
  assert.equal(r.overeat_note, true);
  assert.equal(r.sleep_debt_min, 450);
  near(r.attention_now, 69, 3, '24時間起き続けた朝の値');
  near(r.caution.drop, 25, 1.5, '日中平均の低下（4.11節：約25ポイント）');
  // 普段の起床時刻（06:30）から1日が始まるものとして、今日の通知を作る
  assert.deepEqual(r.notifications.map((n) => n.kind), ['morning', 'nap', 'valley', 'night']);
});

test('古い晩の欠け：3晩前の記録なし → 欠けのない場合と同じ結果。imputed_nights に3晩前の日付', () => {
  const r = run({ s: BASE.filter((_, k) => k !== 11), now: BASE_NOW });
  assert.deepEqual(r.imputed_nights, [date(13)]);            // 12日の夜〜13日の朝
  assert.deepEqual({ ...r, imputed_nights: [] }, run({ s: BASE, now: BASE_NOW }));
});

test('見落とし予告：23:00〜06:30 を14日 → caution.flag は false', () => {
  assert.deepEqual(run({ s: BASE, now: BASE_NOW }).caution, { flag: false, type: null, drop: 0, avg7_sleep_min: 450 });
});

test('見落とし予告（急な低下）：最後の晩だけ 01:30〜06:30 → true、type は drop、drop は約4.3', () => {
  const c = run({ s: nights(14, '23:00', '06:30', { 14: { bed: '01:30' } }), now: BASE_NOW }).caution;
  assert.equal(c.flag, true);
  assert.equal(c.type, 'drop');
  near(c.drop, 4.3, 0.5, 'drop');
});

test('見落とし予告（不足の蓄積）：00:30〜06:30 を14日 → true、type は accumulated', () => {
  const c = run({ s: nights(14, '00:30', '06:30'), now: BASE_NOW }).caution;
  assert.deepEqual(c, { flag: true, type: 'accumulated', drop: 0, avg7_sleep_min: 360 });
  // 両方に当てはまる場合は accumulated
  const both = run({ s: nights(14, '00:30', '06:30', { 14: { bed: '03:30' } }), now: BASE_NOW }).caution;
  assert.equal(both.type, 'accumulated');
  assert.ok(both.drop >= 2);
});

test('見落とし予告（該当なし）：23:30〜06:30 を14日 → false', () => {
  const c = run({ s: nights(14, '23:30', '06:30'), now: BASE_NOW }).caution;
  assert.equal(c.flag, false);
  assert.equal(c.type, null);
  assert.equal(c.avg7_sleep_min, 420);
});

test('食べすぎ注意：昨夜の睡眠合計が330分 → true、331分 → false', () => {
  const r330 = run({ s: nights(14, '23:00', '06:30', { 14: { bed: '01:00' } }), now: BASE_NOW });
  const r331 = run({ s: nights(14, '23:00', '06:30', { 14: { bed: '00:59' } }), now: BASE_NOW });
  assert.deepEqual([r330.last_night_sleep_min, r330.overeat_note], [330, true]);
  assert.deepEqual([r331.last_night_sleep_min, r331.overeat_note], [331, false]);
});

test('寝不足の判定：起床までの24時間の睡眠が360分 → true、361分 → false', () => {
  assert.equal(run({ s: nights(14, '23:00', '06:30', { 14: { bed: '00:30' } }), now: BASE_NOW }).short_sleep, true);
  assert.equal(run({ s: nights(14, '23:00', '06:30', { 14: { bed: '00:29' } }), now: BASE_NOW }).short_sleep, false);
});

test('就寝時刻の比較：whatif=23:00,00:30 → 23:00 の next_day_avg の方が大きい', () => {
  const rows = run({ s: GOOD, now: GOOD_NOW, whatif: '23:00,00:30' }).bedtime_compare;
  assert.deepEqual(rows.map((row) => row.bed), ['23:00', '00:30']);
  assert.ok(rows[0].next_day_avg > rows[1].next_day_avg);
});

test('通知の上限：max=3 → notifications は3件以下', () => {
  assert.equal(run({ s: SHORT, now: GOOD_NOW, gym: '18:30' }).notifications.length, 5);
  assert.equal(run({ s: SHORT, now: GOOD_NOW, gym: '18:30', max: '3' }).notifications.length, 3);
});

test('サンプル表示：パラメータなし → demo は true、notifications は空', () => {
  const r = plain(CF.run('', '', null).result);
  assert.equal(r.status, 'ok');
  assert.equal(r.demo, true);
  assert.deepEqual(r.notifications, []);
  assert.equal(r.now, '2026-11-11T07:10');
  assert.equal(r.sleep_debt_min, 95);
});

test('不正な入力：s の書式が不正 → status は error、notifications は空', () => {
  for (const s of ['abc', '2026-03-01T23:00', '2026-03-01 23:00/2026-03-02 07:00', '2026-13-01T23:00/2026-13-02T07:00',
    '2026-03-02T07:00/2026-03-01T23:00', '2026-03-01T23:00/2026-03-02T07:00,', '2026-02-30T23:00/2026-03-01T07:00',
    '2026-03-01T23:00+25:00/2026-03-02T07:00']) {
    const r = run({ s, now: GOOD_NOW });
    assert.equal(r.status, 'error', s);
    assert.equal(typeof r.error, 'string');
    assert.deepEqual(r.notifications, []);
    assert.equal(r.demo, false);
  }
});

/* ---------- 10 章の試算値 ---------- */

test('数値の動き方：日中平均（08:00〜17:00）と谷の時刻が10章の表と合う', () => {
  near(daytime(GOOD).avg, 94.7, 0.15, '8時間睡眠');
  near(daytime(BASE).avg, 93.7, 0.15, '7.5時間睡眠');
  near(daytime(nights(14, '00:30', '06:30')).avg, 89.3, 0.15, '6時間睡眠を14日');
  near(daytime(nights(14, '01:30', '06:30')).avg, 84.5, 0.15, '5時間睡眠を14日');
  near(daytime(nights(14, '23:00', '06:30', { 14: { bed: '02:30' } })).avg, 86.6, 0.15, '7.5時間の後に1晩だけ4時間');
  near(daytime(nights(14, '23:00', '06:30', { 14: { bed: '00:30' } })).avg, 91.5, 0.15, '就寝を00:30に遅らせた翌日');
  assert.equal(run({ s: BASE, now: BASE_NOW }).valley.time, '14:14');
  assert.equal(run({ s: nights(14, '00:30', '06:30'), now: BASE_NOW }).valley.time, '14:57');
});

/* ---------- 入力仕様（3 章） ---------- */

test('フラグメントとクエリの両方にあるキーは、フラグメントを優先する', () => {
  const r = plain(CF.run(`?s=${GOOD}&now=${GOOD_NOW}&bed=22:00&cafmg=217.5`, '#bed=23:00', null).result);
  assert.equal(r.status, 'ok');
  assert.equal(r.bath_time, '21:30');          // bed はフラグメントの 23:00
  assert.equal(r.caffeine_cutoff, '09:48');    // cafmg はクエリの値がそのまま使われる
});

test('パーセントエンコードされた値も読める', () => {
  const r = plain(CF.run('', `#s=${encodeURIComponent(GOOD.join(','))}&now=${encodeURIComponent(GOOD_NOW)}`, null).result);
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, '07:00');
});

test('now が渡されていれば、時計には依存しない', () => {
  assert.deepEqual(run({ s: GOOD, now: GOOD_NOW }, Date.UTC(1999, 0, 1)), run({ s: GOOD, now: GOOD_NOW }, Date.UTC(2031, 11, 31)));
});

test('重なる記録・接する記録はつなぐ', () => {
  const whole = run({ s: GOOD, now: GOOD_NOW });
  const overlapping = GOOD.slice(0, 13).concat([`${date(14)}T23:00/${date(15)}T03:00`, `${date(15)}T02:00/${date(15)}T07:00`]);
  const touching = GOOD.slice(0, 13).concat([`${date(14)}T23:00/${date(15)}T03:00`, `${date(15)}T03:00/${date(15)}T07:00`]);
  const oneMinute = GOOD.slice(0, 13).concat([`${date(14)}T23:00/${date(15)}T03:00`, `${date(15)}T03:01/${date(15)}T07:00`]);
  assert.deepEqual(run({ s: overlapping, now: GOOD_NOW }), whole);
  assert.deepEqual(run({ s: touching, now: GOOD_NOW }), whole);
  assert.deepEqual(run({ s: oneMinute, now: GOOD_NOW }), whole);   // 間が1分以下なら睡眠合計も同じ
});

test('途中覚醒で分かれ、どれも3時間未満でも、起床時刻は最後の区間の終わり', () => {
  const pieces = GOOD.slice(0, 13).concat([
    `${date(14)}T23:00/${date(15)}T01:30`, `${date(15)}T01:45/${date(15)}T04:20`, `${date(15)}T04:35/${date(15)}T07:00`]);
  const r = run({ s: pieces, now: GOOD_NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, '07:00');
  assert.equal(r.last_night_sleep_min, 450);
});

test('仮眠（3時間未満）は起床時刻を動かさない', () => {
  const r = run({ s: GOOD.concat([`${date(15)}T13:00/${date(15)}T13:20`]), now: `${date(15)}T15:00` });
  assert.equal(r.wake_time, '07:00');
});

test('既定値：tz=+09:00, need=450, bed=23:00, act=08:00-17:00, cafmg=107, shift=0, max=5, whatif=bed,+60分,+90分', () => {
  const base = run({ s: GOOD, now: GOOD_NOW });
  const explicit = run({ s: GOOD, now: GOOD_NOW, tz: '+09:00', need: '450', bed: '23:00', act: '08:00-17:00', cafmg: '107',
    whatif: '23:00,00:00,00:30', shift: '0', max: '5', wake: '07:00' });
  assert.deepEqual(explicit, base);
  assert.deepEqual(base.bedtime_compare.map((row) => row.bed), ['23:00', '00:00', '00:30']);
});

test('wake の既定値は、直近7日の起床時刻の中央値', () => {
  const late = nights(14, '23:00', '07:00', { 8: { wake: '06:00' }, 9: { wake: '06:00' }, 10: { wake: '06:00' } });
  const early = nights(14, '23:00', '06:00', { 8: { wake: '07:00' }, 9: { wake: '07:00' }, 10: { wake: '07:00' } });
  const now = `${date(15)}T07:10`;
  assert.deepEqual(run({ s: late, now }), run({ s: late, now, wake: '07:00' }));
  assert.deepEqual(run({ s: early, now }), run({ s: early, now, wake: '06:00' }));
  assert.notDeepEqual(run({ s: early, now }).bedtime_compare, run({ s: early, now, wake: '07:00' }).bedtime_compare);
});

test('パラメータの書式が不正なら、キー名を含む理由でエラーにする', () => {
  const cases = { now: '2026-03-15', tz: '9時間', need: 'abc', bed: '25:00', wake: '7時', act: '08:00', cafmg: '-5',
    whatif: '23:00,xx', gym: '18', win: '19:00-19:00', shift: '1.5', none: '2026-3-15', max: '-1' };
  for (const [key, value] of Object.entries(cases)) {
    const r = run({ s: GOOD, now: GOOD_NOW, [key]: value });
    assert.equal(r.status, 'error', key);
    assert.ok(r.error.includes(key), `${key}: ${r.error}`);
    assert.deepEqual(r.notifications, []);
  }
});

test('s が無いのに他のパラメータがある → エラー（サンプルにはしない）', () => {
  const r = plain(CF.run('', `#now=${GOOD_NOW}`, null).result);
  assert.equal(r.status, 'error');
  assert.equal(r.demo, false);
});

test('関係のないキーだけなら、パラメータなしとして扱う', () => {
  assert.equal(plain(CF.run('?utm_source=x', '#top', null).result).demo, true);
});

test('睡眠記録が7日分に足りなければエラー', () => {
  assert.equal(run({ s: nights(7, '23:00', '07:00'), now: `${date(8)}T07:10` }).status, 'ok');
  const r = run({ s: nights(6, '23:00', '07:00'), now: `${date(7)}T07:10` });
  assert.equal(r.status, 'error');
  assert.match(r.error, /7日分/);
});

test('now より後に終わる睡眠記録があればエラー（now や tz の取り違えを見逃さない）', () => {
  const r = run({ s: GOOD, now: `${date(14)}T22:10` });
  assert.equal(r.status, 'error');
  assert.match(r.error, /now/);
});

/* ---------- 記録の欠け（4.11 節） ---------- */

test('昨夜の欠けは、普段の睡眠の中央の時刻を過ぎてから判定する（寝る前の質問では聞き返さない）', () => {
  // 普段は 23:00〜06:30 → 中央は 02:45
  const late = run({ s: BASE, now: `${date(16)}T00:10` });
  assert.equal(late.status, 'ok');
  assert.equal(late.wake_time, '06:30');
  assert.deepEqual(late.bedtime_compare.map((row) => row.bed), ['00:30']);   // 過ぎた就寝時刻は比べない
  assert.deepEqual(late.notifications, []);
  assert.equal(run({ s: BASE, now: `${date(16)}T02:44` }).status, 'ok');
  assert.equal(run({ s: BASE, now: `${date(16)}T02:45` }).status, 'need_last_night');
  assert.equal(run({ s: BASE, now: `${date(16)}T15:00` }).status, 'need_last_night');
});

test('昨夜の記録が3時間未満のときも need_last_night。none を付ければ、その記録を使って計算する', () => {
  const partial = BASE.slice(0, 13).concat([`${date(15)}T02:00/${date(15)}T04:30`]);
  assert.equal(run({ s: partial, now: `${date(15)}T11:00` }).status, 'need_last_night');
  const r = run({ s: partial, now: `${date(15)}T11:00`, none: date(15) });
  assert.equal(r.status, 'ok');
  assert.equal(r.last_night_sleep_min, 150);
  assert.equal(r.short_sleep, true);
  assert.ok(r.attention_now > run({ s: BASE.slice(0, 13), now: `${date(15)}T11:00`, none: date(15) }).attention_now);
});

test('古い晩の欠けは複数でも補う。一部だけ記録がある晩も、普段の睡眠で埋める', () => {
  const whole = run({ s: BASE, now: BASE_NOW });
  const two = run({ s: BASE.filter((_, k) => k !== 4 && k !== 11), now: BASE_NOW });
  assert.deepEqual(two.imputed_nights, [date(6), date(13)]);
  assert.deepEqual({ ...two, imputed_nights: [] }, whole);
  const cut = run({ s: BASE.map((piece, k) => (k === 11 ? `${date(13)}T05:00/${date(13)}T06:30` : piece)), now: BASE_NOW });
  assert.deepEqual(cut.imputed_nights, [date(13)]);
  assert.deepEqual({ ...cut, imputed_nights: [] }, whole);
});

test('none に含まれる古い晩は、補わずに睡眠なしとして計算する', () => {
  const r = run({ s: BASE.filter((_, k) => k !== 11), now: BASE_NOW, none: date(13) });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.imputed_nights, []);
  assert.equal(r.sleep_debt_min, 450);
  assert.ok(r.attention_day_avg < run({ s: BASE, now: BASE_NOW }).attention_day_avg);
});

/* ---------- 睡眠負債・身体機能・仮眠・集中に向く時間帯（4 章） ---------- */

test('睡眠負債：直近7日の（need − 睡眠合計）の和。0未満なら0', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW }).sleep_debt_min, 0);                     // 480分×7 > 450分×7
  assert.equal(run({ s: GOOD, now: GOOD_NOW, need: '500' }).sleep_debt_min, 140);      // (500−480)×7
  const s = nights(14, '23:00', '06:30', { 14: { bed: '00:30' }, 3: { bed: '03:00' } });   // 8日以上前は数えない
  assert.equal(run({ s, now: BASE_NOW }).sleep_debt_min, 90);
});

test('身体機能：gym あり・寝不足の日・運動が12:00以降のときだけ', () => {
  const on = run({ s: SHORT, now: GOOD_NOW, gym: '18:30' });
  assert.deepEqual(on.physical, { strength: 97, endurance: 90, advice: '重量は維持し、回数とセット数を控えめにしてください。' });
  assert.equal(run({ s: SHORT, now: GOOD_NOW, gym: '11:59' }).physical, null);
  assert.equal(run({ s: SHORT, now: GOOD_NOW, gym: '12:00' }).physical.strength, 97);
  assert.equal(run({ s: SHORT, now: GOOD_NOW }).physical, null);
  assert.equal(run({ s: GOOD, now: GOOD_NOW, gym: '18:30' }).physical, null);
});

test('仮眠の助言：寝不足の日だけ。回復量の％は出さない', () => {
  const advice = run({ s: SHORT, now: GOOD_NOW }).nap_advice;
  assert.deepEqual(Object.keys(advice), ['before', 'minutes', 'text']);
  assert.equal(advice.before, '13:00');
  assert.equal(advice.minutes, 20);
  assert.ok(!advice.text.includes('%'));
  assert.equal(run({ s: GOOD, now: GOOD_NOW }).nap_advice, null);
});

test('集中に向く時間帯：win の範囲内で60分の平均が最大の区間。now より前は選ばない', () => {
  const evening = run({ s: GOOD, now: GOOD_NOW, win: '19:00-23:00' }).focus_window;
  assert.deepEqual(Object.keys(evening), ['start', 'end', 'avg']);
  assert.equal(CF.parseClock(evening.end) - CF.parseClock(evening.start), 60);
  assert.ok(CF.parseClock(evening.start) >= 19 * 60 && CF.parseClock(evening.end) <= 23 * 60);

  assert.equal(run({ s: GOOD, now: GOOD_NOW, win: '08:00-12:00' }).focus_window.start, '08:55');
  assert.equal(run({ s: GOOD, now: `${date(15)}T10:02`, win: '08:00-12:00' }).focus_window.start, '10:05');
  assert.equal(run({ s: GOOD, now: `${date(15)}T11:30`, win: '08:00-12:00' }).focus_window, null);
  assert.equal(run({ s: GOOD, now: GOOD_NOW }).focus_window, null);
});

test('shift：推定した体内時計の位置への追加補正。正の値で谷とピークが後ろへずれる', () => {
  const shifted = run({ s: GOOD, now: GOOD_NOW, shift: '30' });
  assert.equal(shifted.valley.time, '15:00');
  assert.equal(shifted.peak.start, '09:10');
  assert.equal(shifted.clock_peak, '18:00');    // clock_peak は推定した位置そのもの
});

test('活動時間帯の端に最小があるときは、端の時刻と at_edge を返す', () => {
  assert.deepEqual(run({ s: GOOD, now: GOOD_NOW, act: '08:00-13:00' }).valley, { time: '13:00', value: 94, at_edge: true });
});

/* ---------- 通知ルールと文面（6 章） ---------- */

test('通常の日：morning・valley・night の3件を時刻順に返す。at はオフセット付きの日時', () => {
  assert.deepEqual(run({ s: GOOD, now: GOOD_NOW }).notifications, [
    { at: `${date(15)}T07:10+09:00`, time: '07:10', kind: 'morning',
      text: '今日の注意・反応は日中平均95%です。08:40〜10:10が最も高く、14:30ごろに谷が来ます。重い作業は08:40〜10:10に回してください。' },
    { at: `${date(15)}T14:10+09:00`, time: '14:10', kind: 'valley',
      text: 'あと20分ほどで集中が落ちます。単純作業に切り替えてください。カフェインを摂るなら14:12までです。' },
    { at: `${date(15)}T21:30+09:00`, time: '21:30', kind: 'night',
      text: '入浴の時間です（40〜42.5℃で10分以上）。明日07:00に起きるなら、遅くとも23:25までに寝てください（7時間35分眠れて、明日の日中は平均94%の見込み）。'
        + '23:00に寝ると明日の日中は平均95%、00:00なら94%、00:30なら93%の見込みです。'
        + '01:03を過ぎても起きていると、注意・反応が18.5時間起き続けたのと同じ水準（77%）を下回ります。' }
  ]);
});

test('at の日付は通知ごとに決まる（就寝目標が深夜なら、night は翌日の日付になる）', () => {
  const r = run({ s: GOOD, now: GOOD_NOW, bed: '01:00', tz: '+09:00' });
  assert.deepEqual(r.notifications.map((n) => n.at), [`${date(15)}T07:10+09:00`, `${date(15)}T14:10+09:00`, `${date(15)}T23:30+09:00`]);
  const late = run({ s: GOOD, now: GOOD_NOW, bed: '02:00' });
  assert.equal(late.notifications[2].at, `${date(16)}T00:30+09:00`);
  assert.equal(late.notifications[2].time, '00:30');
});

test('morning の追加文：睡眠負債、見落とし予告（drop / accumulated）の順に付く', () => {
  const debt = run({ s: GOOD, now: GOOD_NOW, need: '500' }).notifications[0].text;
  assert.ok(debt.endsWith('に回してください。睡眠負債は2時間20分です。'));
  assert.ok(!run({ s: GOOD, now: GOOD_NOW }).notifications[0].text.includes('睡眠負債'));

  const drop = run({ s: nights(14, '23:00', '06:30', { 14: { bed: '01:30' } }), now: BASE_NOW });
  assert.ok(drop.notifications[0].text.endsWith('に回してください。睡眠負債は2時間30分です。'
    + `今日は普段より見落としが増えやすい日です（日中平均が普段より${drop.caution.drop}ポイント低い見込み）。提出・入力・送信の前に見直しを1回足してください。`));

  const accumulated = run({ s: nights(14, '00:30', '06:30'), now: BASE_NOW });
  assert.ok(accumulated.notifications[0].text.endsWith('睡眠負債は10時間30分です。'
    + '直近7日の睡眠は平均6時間0分です。この状態が続くと、自覚がなくても見落としが増えます。提出・入力・送信の前に見直しを1回足してください。'));
});

test('valley の文面：締切の前後で変わり、見落とし予告と食べすぎ注意は1行ずつ添える', () => {
  const head = 'あと20分ほどで集中が落ちます。単純作業に切り替えてください。';
  const caution = '見落としが増えやすい日です。提出の前に見直しを。';
  const overeat = '睡眠が5.5時間以下の翌日は、食べる量が増えやすくなります（研究では平均385kcal増）。間食の量に気をつけてください。';
  const valleyText = (params) => run(params).notifications.find((n) => n.kind === 'valley').text;

  assert.equal(valleyText({ s: GOOD, now: GOOD_NOW, cafmg: '217.5' }),
    head + 'カフェインは締切（09:48）を過ぎているため、控えてください。');
  assert.equal(valleyText({ s: nights(14, '23:00', '06:30', { 14: { bed: '01:30' } }), now: BASE_NOW }),
    head + 'カフェインを摂るなら14:12までです。' + caution + overeat);
  assert.equal(valleyText({ s: nights(14, '00:30', '06:30'), now: BASE_NOW }),
    head + 'カフェインは締切（14:12）を過ぎているため、控えてください。' + caution);
  // 見落とし予告と食べすぎ注意は、新しい通知を作らない
  assert.deepEqual(run({ s: nights(14, '23:00', '06:30', { 14: { bed: '01:30' } }), now: BASE_NOW }).notifications.map((n) => n.kind),
    ['morning', 'nap', 'valley', 'night']);
});

test('寝不足の日：nap は12:00、gym は運動の30分前に入る', () => {
  const r = run({ s: SHORT, now: GOOD_NOW, gym: '18:30' });
  assert.deepEqual(r.notifications.map((n) => [n.time, n.kind]),
    [['07:10', 'morning'], ['12:00', 'nap'], [CF.formatClock(CF.parseClock(r.valley.time) - 20), 'valley'], ['18:00', 'gym'], ['21:30', 'night']]);
  assert.equal(r.notifications[1].text,
    '昨夜の睡眠が6時間以下でした。13:00までに20分前後の仮眠をおすすめします。起きてから30分は重要な作業を避けてください。');
  assert.equal(r.notifications[3].text,
    '寝不足のため、筋力は約97%、筋持久力は約90%の見込みです。重量は維持し、回数とセット数を控えめにしてください。');
});

test('上限を超えるときは valley、morning、night、nap、gym の順に残す', () => {
  const kinds = (max) => run({ s: SHORT, now: GOOD_NOW, gym: '18:30', max: String(max) }).notifications.map((n) => n.kind);
  assert.deepEqual(kinds(4), ['morning', 'nap', 'valley', 'night']);
  assert.deepEqual(kinds(3), ['morning', 'valley', 'night']);
  assert.deepEqual(kinds(2), ['morning', 'valley']);
  assert.deepEqual(kinds(1), ['valley']);
  assert.deepEqual(kinds(0), []);
});

test('now より前の時刻になる通知は入れない。morning は起床から3時間以内だけ', () => {
  const kinds = (now) => run({ s: GOOD, now: `${date(15)}T${now}` }).notifications.map((n) => n.kind);
  assert.deepEqual(kinds('10:00'), ['morning', 'valley', 'night']);   // ちょうど3時間
  assert.deepEqual(kinds('10:01'), ['valley', 'night']);
  assert.deepEqual(kinds('14:10'), ['valley', 'night']);              // 通知時刻が now ちょうど
  assert.deepEqual(kinds('14:11'), ['night']);
  assert.deepEqual(kinds('21:31'), []);
});

/* ---------- 今夜のおすすめ就寝時刻（追加機能） ---------- */

const ADVICE_TOLERANCE = 0.5;

/* 就寝時刻 bed（通し番号）から nextWake まで眠ったときの、翌日 08:00〜17:00 の起きている分の平均 */
function nextDayAverage(list, now, bed, nextWake) {
  const nowT = CF.parseDateTime(now);
  const sim = CF.simulate(CF.joinIntervals(intervals(list).concat([{ start: bed, end: nextWake }]), 9),
    Math.floor(nextWake / 1440) * 1440 + 1020, 0);
  const day = Math.floor(nextWake / 1440) * 1440;
  let sum = 0, n = 0;
  for (let t = Math.max(day + 480, nextWake); t <= day + 1020; t++) { sum += CF.clampE(sim.e[t - sim.t0]); n++; }
  assert.ok(nowT <= bed);
  return sum / n;
}

test('おすすめ就寝：普段どおりに寝ている人には、起床予定から必要睡眠時間をさかのぼった時刻', () => {
  const r = run({ s: BASE, now: BASE_NOW });
  assert.deepEqual(r.bedtime_advice, {
    by: '23:00', wake: '06:30', sleep_min: 450, next_day_avg: 94, usual_avg: 94,
    text: '明日06:30に起きるなら、遅くとも23:00までに寝てください（7時間30分眠れて、明日の日中は平均94%の見込み）。'
  });
  // need を増やせば、その分だけ早まる
  assert.equal(run({ s: BASE, now: BASE_NOW, need: '480' }).bedtime_advice.by, '22:30');
  // 起床予定は wake で変えられる
  assert.deepEqual(run({ s: BASE, now: BASE_NOW, wake: '07:30' }).bedtime_advice.by, '00:00');
});

test('おすすめ就寝：寝不足の翌日は、明日を普段どおりに戻せる、いちばん遅い時刻まで早める', () => {
  const short = nights(14, '23:00', '06:30', { 14: { bed: '01:30' } });   // 最後の晩だけ5時間
  const r = run({ s: short, now: BASE_NOW });
  const a = r.bedtime_advice;
  assert.equal(a.by, '21:55');
  assert.equal(a.sleep_min, 515);
  assert.equal(a.usual_avg, 94);
  // その時刻なら普段を 0.5 ポイント以上は下回らず、5分遅らせると下回る
  const nextWake = CF.parseDateTime(`${date(16)}T06:30`);
  const by = CF.parseDateTime(`${date(15)}T21:55`);
  const usual = nextDayAverage(short, BASE_NOW, by, nextWake);
  assert.ok(nextDayAverage(short, BASE_NOW, by + 5, nextWake) < nextDayAverage(short, BASE_NOW, by, nextWake));
  assert.ok(usual >= 93.5 - ADVICE_TOLERANCE);
  // 就寝目標どおり（23:00）に寝ると、普段より低い
  assert.ok(r.bedtime_compare[0].next_day_avg < a.usual_avg);
});

test('おすすめ就寝：普段の水準に届かない日は、就寝目標の3時間前（無理のない範囲でいちばん早い時刻）', () => {
  const a = run({ s: BASE.slice(0, 13), now: BASE_NOW, none: date(15) }).bedtime_advice;   // 寝ていない日
  assert.equal(a.by, '20:00');
  assert.equal(a.sleep_min, 630);
  assert.ok(a.next_day_avg < a.usual_avg);
  assert.equal(run({ s: BASE.slice(0, 13), now: BASE_NOW, none: date(15), bed: '00:00' }).bedtime_advice.by, '21:00');
});

test('おすすめ就寝：不足が続いている人には、普段の水準ではなく必要睡眠時間で決める', () => {
  const a = run({ s: nights(14, '00:30', '06:30'), now: BASE_NOW }).bedtime_advice;
  assert.equal(a.by, '23:00');
  assert.equal(a.sleep_min, 450);
  assert.ok(a.next_day_avg > a.usual_avg);
});

test('おすすめ就寝：時刻を過ぎていれば「すぐに」。起床予定まで1時間を切ったら出さない', () => {
  const late = run({ s: BASE, now: `${date(16)}T00:10` }).bedtime_advice;
  assert.equal(late.by, '00:10');
  assert.equal(late.sleep_min, 380);
  assert.equal(late.text, '明日06:30に起きるなら、すぐに寝てください（今寝ると6時間20分眠れます）。');
  assert.equal(run({ s: BASE, now: `${date(15)}T23:45`, wake: '00:30' }).bedtime_advice, null);
});

test('おすすめ就寝：night の文面で、通知の時刻にもう過ぎているときは「すぐに」', () => {
  const short = nights(14, '23:00', '06:30', { 14: { bed: '03:30' } });   // 最後の晩だけ3時間
  const r = run({ s: short, now: BASE_NOW });
  assert.equal(r.bedtime_advice.by, '20:20');
  const night = r.notifications.find((n) => n.kind === 'night');
  assert.ok(night.text.startsWith('入浴の時間です（40〜42.5℃で10分以上）。明日06:30に起きるなら、すぐに寝てください（今寝ると9時間0分眠れます）。'));
});

test('おすすめ就寝：翌日の活動時間帯が起床予定より前に終わるときは、平均を出さずに必要睡眠時間で決める', () => {
  const a = run({ s: BASE, now: BASE_NOW, wake: '18:00' }).bedtime_advice;
  assert.equal(a.next_day_avg, null);
  assert.equal(a.sleep_min, 450);
  assert.equal(a.text, '明日18:00に起きるなら、遅くとも10:30までに寝てください（7時間30分眠れます）。');
});

/* ---------- 夜のピークと 77% を下回る時刻（追加機能） ---------- */

test('夜の下がり方：夜のピークと、起き続けたときに77%を下回る時刻（1分刻み）', () => {
  const r = run({ s: GOOD, now: GOOD_NOW });
  assert.deepEqual(r.evening, {
    top: '19:13', limit: '01:03', limit_reached: false,
    text: '注意・反応は19:13ごろが夜のピークで、その後は下がり続けます。'
      + '01:03を過ぎても起きていると、注意・反応が18.5時間起き続けたのと同じ水準（77%）を下回ります。'
  });
  const d = daytime(GOOD);
  const limit = CF.parseDateTime(`${date(16)}T01:03`);
  assert.ok(d.sim.e[limit - d.sim.t0] < 77);
  assert.ok(d.sim.e[limit - 1 - d.sim.t0] >= 77);
  // 夜のピークは、谷から翌03:00までで E が最大の時刻
  let best = -Infinity, at = null;
  for (let t = CF.parseDateTime(`${date(15)}T14:30`); t <= CF.parseDateTime(`${date(16)}T03:00`); t++) {
    if (d.sim.e[t - d.sim.t0] > best + 1e-9) { best = d.sim.e[t - d.sim.t0]; at = t; }
  }
  assert.equal(CF.formatClock(at), '19:13');
  // 体内時計が遅い人ほど、夜のピークも遅い
  const lateTop = run({ s: nights(14, '01:30', '06:45'), now: `${date(15)}T07:00` }).evening.top;
  assert.ok(CF.parseClock(lateTop) - CF.parseClock('19:13') >= 60, lateTop);
});

test('夜の下がり方：就寝目標より前に77%を下回る日は、朝の通知でも運転や危険な作業を控えるよう伝える', () => {
  const r = run({ s: nights(14, '23:00', '06:30', { 14: { bed: '03:30' } }), now: BASE_NOW });
  assert.equal(r.evening.limit, '22:47');
  assert.equal(r.evening.limit_reached, false);
  const warning = '22:47ごろから、注意・反応が18.5時間起き続けたのと同じ水準（77%）を下回る見込みです。それ以降は車の運転や危険を伴う作業を控えてください。';
  assert.ok(r.notifications.find((n) => n.kind === 'morning').text.endsWith(warning));
  assert.ok(r.notifications.find((n) => n.kind === 'night').text.endsWith(warning));
  // 就寝目標より後なら、朝の通知には入れない
  assert.ok(!run({ s: GOOD, now: GOOD_NOW }).notifications[0].text.includes('77%'));
});

test('夜の下がり方：すでに77%を下回っていれば limit_reached が true', () => {
  const r = run({ s: BASE.slice(0, 13), now: BASE_NOW, none: date(15) });
  assert.equal(r.evening.limit, '06:40');
  assert.equal(r.evening.limit_reached, true);
  const reached = '注意・反応はすでに18.5時間起き続けたのと同じ水準（77%）を下回っています。車の運転や危険を伴う作業は控えてください。';
  assert.ok(r.evening.text.endsWith(reached));
  assert.ok(r.notifications.find((n) => n.kind === 'morning').text.endsWith(reached));
});

test('夜の下がり方：起床予定までに77%を下回らなければ limit は null', () => {
  const r = run({ s: BASE, now: `${date(15)}T23:45`, wake: '00:30' });
  assert.equal(r.evening.limit, null);
  assert.equal(r.evening.limit_reached, false);
  assert.equal(r.evening.text, '注意・反応は18:59ごろが夜のピークで、その後は下がり続けます。');
});

/* ---------- 出力仕様（5 章） ---------- */

const KEY_ORDER = ['status', 'error', 'demo', 'tz', 'now', 'wake_time', 'last_night_sleep_min', 'imputed_nights',
  'attention_now', 'attention_day_avg', 'peak', 'valley', 'clock_peak', 'sleep_debt_min', 'short_sleep', 'caution',
  'overeat_note', 'caffeine_cutoff', 'bath_time', 'bedtime_compare', 'bedtime_advice', 'evening', 'physical',
  'nap_advice', 'focus_window', 'notifications'];

test('結果ブロック：キー名と順序は、正常・サンプル・記録待ち・エラーのどれでも同じ', () => {
  const outputs = [CF.run('', hashOf({ s: GOOD, now: GOOD_NOW }), null), CF.run('', '', null),
    CF.run('', hashOf({ s: BASE.slice(0, 13), now: BASE_NOW }), null), CF.run('', '#s=abc', Date.UTC(2026, 2, 15))];
  assert.deepEqual(outputs.map((out) => out.result.status), ['ok', 'ok', 'need_last_night', 'error']);
  for (const out of outputs) {
    const parsed = JSON.parse(CF.formatResult(out.result));
    assert.deepEqual(Object.keys(parsed), KEY_ORDER);
    assert.deepEqual(parsed, plain(out.result));
  }
  const ok = plain(outputs[0].result);
  assert.deepEqual(Object.keys(ok.caution), ['flag', 'type', 'drop', 'avg7_sleep_min']);
  assert.deepEqual(Object.keys(ok.notifications[0]), ['at', 'time', 'kind', 'text']);
  assert.deepEqual(Object.keys(ok.bedtime_advice), ['by', 'wake', 'sleep_min', 'next_day_avg', 'usual_avg', 'text']);
  assert.deepEqual(Object.keys(ok.evening), ['top', 'limit', 'limit_reached', 'text']);
});

test('結果ブロック：時刻は HH:MM、％は整数', () => {
  const r = run({ s: SHORT, now: GOOD_NOW, gym: '18:30', win: '19:00-22:00' });
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const value of [r.wake_time, r.peak.start, r.peak.end, r.valley.time, r.clock_peak, r.caffeine_cutoff, r.bath_time,
    r.nap_advice.before, r.focus_window.start, r.focus_window.end, r.bedtime_advice.by, r.bedtime_advice.wake,
    r.evening.top, r.evening.limit,
    ...r.bedtime_compare.map((row) => row.bed), ...r.notifications.map((n) => n.time)]) {
    assert.match(value, clock);
  }
  for (const value of [r.attention_now, r.attention_day_avg, r.peak.avg, r.valley.value, r.sleep_debt_min,
    r.last_night_sleep_min, r.caution.avg7_sleep_min, r.focus_window.avg, r.bedtime_advice.sleep_min,
    r.bedtime_advice.next_day_avg, r.bedtime_advice.usual_avg,
    ...r.bedtime_compare.flatMap((row) => [row.next_day_avg, row.next_day_min])]) {
    assert.ok(Number.isInteger(value), String(value));
  }
  assert.match(r.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(r.tz, '+09:00');
  for (const n of r.notifications) assert.match(n.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+09:00$/);
});

test('ok 以外のときは、該当しない項目がすべて null になる', () => {
  for (const r of [run({ s: 'abc', now: GOOD_NOW }), run({ s: BASE.slice(0, 13), now: BASE_NOW })]) {
    assert.equal(r.tz, '+09:00');
    for (const key of KEY_ORDER.slice(5)) {
      if (['imputed_nights', 'bedtime_compare', 'notifications'].includes(key)) assert.deepEqual(r[key], []);
      else assert.equal(r[key], null, key);
    }
  }
});

/* ---------- 時刻の扱い ---------- */

test('時刻は文字列と分単位の通し番号を行き来できる（月末・うるう年・時差を含む）', () => {
  for (const text of ['2026-11-10T07:10', '2024-02-29T23:59', '2026-12-31T00:00', '1999-01-01T12:34', '2100-03-01T05:05']) {
    assert.equal(CF.formatDateTime(CF.parseDateTime(text)), text);
  }
  assert.equal(CF.parseDateTime('2026-03-01T00:00') - CF.parseDateTime('2026-02-28T00:00'), 1440);
  assert.equal(CF.parseDateTime('2024-03-01T00:00') - CF.parseDateTime('2024-02-28T00:00'), 2880);
  assert.equal(CF.parseDateTime('2026-11-10T07:10:45'), CF.parseDateTime('2026-11-10T07:10'));
  assert.equal(CF.parseDateTime('1970-01-01T00:00Z', 0), 0);
  // 末尾の Z やオフセットは tz（第2引数、分）の現地時刻に換算する
  const local = CF.parseDateTime('2026-11-11T07:10');
  for (const text of ['2026-11-10T22:10Z', '2026-11-10T22:10:30.250Z', '2026-11-11T07:10+09:00', '2026-11-11T07:10 09:00',
    '2026-11-11T07:10+0900', '2026-11-10T17:10-05:00', '2026-11-11T03:40+05:30']) {
    assert.equal(CF.parseDateTime(text, 540), local, text);
  }
  assert.equal(CF.parseDateTime('2026-11-10T22:10Z', -300), CF.parseDateTime('2026-11-10T17:10'));
  for (const bad of ['2026-02-29T00:00', '2026-11-10T24:00', '2026-11-10T07:60', '2026-11-10', '2026-11-10T07:10+15:00', '']) {
    assert.equal(CF.parseDateTime(bad), null, bad);
  }
  assert.deepEqual(['+09:00', ' 09:00', '09:00', '-05:00', '+05:30', 'Z', '+0900'].map(CF.parseOffset), [540, 540, 540, -300, 330, 0, 540]);
  assert.deepEqual([540, -300, 330, 0].map(CF.formatOffset), ['+09:00', '-05:00', '+05:30', '+00:00']);
});

/* ---------- 技術要件（8 章） ---------- */

test('計算部は Date・DOM・保存領域・乱数を使わない', () => {
  const code = coreSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const word of ['Date', 'document', 'window', 'location', 'navigator', 'localStorage', 'Math.random', 'setTimeout',
    'URLSearchParams']) {
    assert.ok(!new RegExp(`\\b${word.replace('.', '\\.')}\\b`).test(code), word);
  }
});

test('画面部が時計を読むのは Date.now() の1か所だけ。ローカルタイムゾーンへの変換は使わない', () => {
  const ui = /<script id="ui">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal((ui.match(/\bDate\b/g) || []).length, 1);
  assert.ok(ui.includes('Date.now()'));
  for (const word of ['getHours', 'getTimezoneOffset', 'toLocale', 'Intl', 'URLSearchParams']) {
    assert.ok(!html.includes(word), word);
  }
});

test('index.html は外部の資源を読み込まず、保存も送信もしない', () => {
  assert.ok(!/<script[^>]*\ssrc=/i.test(html), 'script src');
  for (const tag of ['<link', '<img', '<iframe', '<object', '<embed', '<form', '@import', 'url(']) {
    assert.ok(!html.toLowerCase().includes(tag), tag);
  }
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'fetch(', 'XMLHttpRequest',
    'sendBeacon', 'WebSocket', 'EventSource', 'serviceWorker', 'import(']) {
    assert.ok(!html.includes(api), api);
  }
  // http(s) の文字列は、出典リンクの href と SVG の名前空間だけ
  const allowed = [...html.matchAll(/<a rel="noopener noreferrer" href="(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(allowed.length, 18);
  const found = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  for (const url of found) {
    assert.ok(url === 'http://www.w3.org/2000/svg' || allowed.includes(url), url);
  }
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
});

test('操作を必要とする要素（ボタン・折りたたみ・入力欄・タブ）を置かない', () => {
  for (const tag of ['<button', '<details', '<input', '<select', '<textarea', 'role="tab"', 'onclick']) {
    assert.ok(!html.toLowerCase().includes(tag), tag);
  }
  assert.match(html, /<pre id="muse-result">/);
});
