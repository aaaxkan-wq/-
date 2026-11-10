/*
 * コンディション予報：計算部の単体テスト
 *   実行： node --test forecast/test/*.test.js
 * index.html から <script id="core"> を取り出し、ブラウザの機能が何もない環境で実行する。
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

/* 2026年3月の d 日目（1始まり、31を超えてよい）を YYYY-MM-DD にする */
function date(d) {
  return d <= 31 ? `2026-03-${pad(d)}` : `2026-04-${pad(d - 31)}`;
}

/*
 * n 晩ぶんの睡眠区間。k 晩目は「k日の夜」に寝て k+1 日の朝に起きる。
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

function run(params, clockNow = null) {
  const hash = '#' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  return plain(CF.run('', hash, clockNow).result);
}

function intervals(list) {
  return CF.mergeIntervals(list.map((piece) => {
    const [a, b] = piece.split('/');
    return { start: CF.parseDateTime(a), end: CF.parseDateTime(b) };
  }));
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

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual.toFixed(2)} は ${expected}±${tolerance} の外`);

const GOOD = nights(14, '23:00', '07:00');          // 23:00〜07:00 を14日
const GOOD_NOW = `${date(15)}T07:10`;               // 14晩目の起床の10分後

/* ---------- 仕様書 8 章：テストの基準値 ---------- */

test('カフェイン締切：bed=23:00, cafmg=107 → 14:12', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW, bed: '23:00', cafmg: '107' }).caffeine_cutoff, '14:12');
});

test('カフェイン締切：bed=23:00, cafmg=217.5 → 09:48', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW, bed: '23:00', cafmg: '217.5' }).caffeine_cutoff, '09:48');
});

test('カフェイン締切：中間量は線形補間、範囲外は両端の値', () => {
  assert.equal(CF.caffeineLeadMinutes(0), 528);
  assert.equal(CF.caffeineLeadMinutes(107), 528);
  assert.equal(CF.caffeineLeadMinutes(162.25), 660);
  assert.equal(CF.caffeineLeadMinutes(217.5), 792);
  assert.equal(CF.caffeineLeadMinutes(400), 792);
});

test('入浴時刻：bed=23:00 → 21:30', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW, bed: '23:00' }).bath_time, '21:30');
});

test('体内時計 c：shift=0 で 12:00→0.000, 15:00→0.207, 18:00→1.000, 20:00→1.299', () => {
  for (const [T, expected] of [[12, 0.000], [15, 0.207], [18, 1.000], [20, 1.299]]) {
    near(CF.circadian(T, 0), expected, 0.0005, `c(${T})`);
  }
});

test('体内時計 c：shift は頂点を後ろへずらす', () => {
  near(CF.circadian(19, 60), CF.circadian(18, 0), 1e-12, 'c(19, shift=60)');
});

test('十分な睡眠：23:00〜07:00 を14日 → 翌日 08:00〜17:00 の E は最小93.1、最大96.5', () => {
  const d = daytime(GOOD);
  near(d.min, 93.1, 0.5, '最小');
  near(d.max, 96.5, 0.5, '最大');
});

test('連続覚醒：同じ履歴の後、07:00 の起床から18.5時間覚醒 → E は74.8', () => {
  const d = daytime(GOOD);
  near(d.sim.e[d.wake + 18.5 * 60 - d.sim.t0], 74.8, 0.5, 'E');
});

test('寝不足の判定：起床までの24時間の睡眠が360分 → true、361分 → false', () => {
  const s360 = nights(14, '23:00', '07:00', { 14: { bed: '01:00' } });   // 01:00〜07:00
  const s361 = nights(14, '23:00', '07:00', { 14: { bed: '00:59' } });   // 00:59〜07:00
  assert.equal(run({ s: s360, now: GOOD_NOW }).short_sleep, true);
  assert.equal(run({ s: s361, now: GOOD_NOW }).short_sleep, false);
});

test('就寝時刻の比較：whatif=23:00,00:30 → 23:00 の next_day_avg の方が大きい', () => {
  const rows = run({ s: GOOD, now: GOOD_NOW, whatif: '23:00,00:30' }).bedtime_compare;
  assert.deepEqual(rows.map((row) => row.bed), ['23:00', '00:30']);
  assert.ok(rows[0].next_day_avg > rows[1].next_day_avg);
});

test('通知の上限：max=3 → notifications は3件以下', () => {
  const short = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });
  const all = run({ s: short, now: GOOD_NOW, gym: '18:30' });
  const capped = run({ s: short, now: GOOD_NOW, gym: '18:30', max: '3' });
  assert.equal(all.notifications.length, 5);
  assert.equal(capped.notifications.length, 3);
});

test('サンプル表示：パラメータなし → demo は true、notifications は空', () => {
  const r = plain(CF.run('', '', null).result);
  assert.equal(r.status, 'ok');
  assert.equal(r.demo, true);
  assert.deepEqual(r.notifications, []);
});

test('不正な入力：s の書式が不正 → status は error、notifications は空', () => {
  for (const s of ['abc', '2026-03-01T23:00', '2026-03-01 23:00/2026-03-02 07:00', '2026-13-01T23:00/2026-13-02T07:00',
    '2026-03-02T07:00/2026-03-01T23:00', '2026-03-01T23:00/2026-03-02T07:00,', '2026-02-30T23:00/2026-03-01T07:00']) {
    const r = run({ s, now: GOOD_NOW });
    assert.equal(r.status, 'error', s);
    assert.equal(typeof r.error, 'string');
    assert.deepEqual(r.notifications, []);
    assert.equal(r.demo, false);
  }
});

/* ---------- 仕様書 8 章の補足・10 章の試算値 ---------- */

test('同じ履歴での谷は14:30、ピーク時間帯は08:40〜10:10', () => {
  const r = run({ s: GOOD, now: GOOD_NOW });
  assert.deepEqual(r.valley, { time: '14:30', value: 93, at_edge: false });
  assert.deepEqual(r.peak, { start: '08:40', end: '10:10', avg: 96 });
  assert.equal(r.wake_time, '07:00');
});

test('数値の動き方：日中平均（08:00〜17:00）が10章の表と合う', () => {
  near(daytime(GOOD).avg, 94.7, 0.15, '8時間睡眠');
  near(daytime(nights(14, '23:00', '06:30')).avg, 93.3, 0.15, '7.5時間睡眠');
  near(daytime(nights(14, '00:30', '06:30')).avg, 90.0, 0.15, '6時間睡眠を14日');
  near(daytime(nights(14, '01:30', '06:30')).avg, 85.8, 0.15, '5時間睡眠を14日');
  near(daytime(nights(14, '23:00', '06:30', { 14: { bed: '02:30' } })).avg, 86.5, 0.15, '7.5時間の後に1晩だけ4時間');
  near(daytime(nights(14, '23:00', '06:30', { 14: { bed: '00:30' } })).avg, 91.3, 0.15, '就寝を00:30に遅らせた翌日');
});

/* ---------- 入力仕様（3 章） ---------- */

test('フラグメントとクエリの両方にあるキーは、フラグメントを優先する', () => {
  const s = GOOD.join(',');
  const r = plain(CF.run(`?s=${s}&now=${GOOD_NOW}&bed=22:00&cafmg=217.5`, '#bed=23:00', null).result);
  assert.equal(r.status, 'ok');
  assert.equal(r.bath_time, '21:30');          // bed はフラグメントの 23:00
  assert.equal(r.caffeine_cutoff, '09:48');    // cafmg はクエリの値がそのまま使われる
});

test('パーセントエンコードされた値も読める', () => {
  const s = encodeURIComponent(GOOD.join(','));
  const r = plain(CF.run('', `#s=${s}&now=${encodeURIComponent(GOOD_NOW)}`, null).result);
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, '07:00');
});

test('now が渡されていれば、ブラウザの時計には依存しない', () => {
  const a = run({ s: GOOD, now: GOOD_NOW }, '1999-01-01T00:00');
  const b = run({ s: GOOD, now: GOOD_NOW }, '2031-12-31T23:59');
  assert.deepEqual(a, b);
});

test('now が無ければ、渡された現在時刻を使う', () => {
  assert.equal(run({ s: GOOD }, GOOD_NOW).now, GOOD_NOW);
});

test('重なる区間・接する区間は結合する。途中覚醒で分かれた区間はそのまま受け付ける', () => {
  const whole = run({ s: GOOD, now: GOOD_NOW });
  const split = GOOD.slice(0, 13).concat([`${date(14)}T23:00/${date(15)}T03:00`, `${date(15)}T02:00/${date(15)}T07:00`]);
  assert.deepEqual(run({ s: split, now: GOOD_NOW }), whole);
  const touching = GOOD.slice(0, 13).concat([`${date(14)}T23:00/${date(15)}T03:00`, `${date(15)}T03:00/${date(15)}T07:00`]);
  assert.deepEqual(run({ s: touching, now: GOOD_NOW }), whole);

  // 途中覚醒で3つに分かれ、どれも3時間未満でも、起床時刻は最後の区間の終わり
  const pieces = GOOD.slice(0, 13).concat([
    `${date(14)}T23:00/${date(15)}T01:30`, `${date(15)}T01:40/${date(15)}T04:20`, `${date(15)}T04:30/${date(15)}T07:00`]);
  const r = run({ s: pieces, now: GOOD_NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, '07:00');
});

test('仮眠（3時間未満）は起床時刻を動かさない', () => {
  const s = GOOD.concat([`${date(15)}T13:00/${date(15)}T13:20`]);
  const r = run({ s, now: `${date(15)}T15:00` });
  assert.equal(r.wake_time, '07:00');
});

test('3時間以上の睡眠が直近24時間に無ければ、最後の睡眠区間の終わりを起床時刻にする', () => {
  const s = GOOD.slice(0, 13).concat([`${date(15)}T03:00/${date(15)}T05:30`]);
  const r = run({ s, now: `${date(15)}T07:10` });
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, '05:30');
  assert.equal(r.short_sleep, true);
});

test('既定値：need=450, bed=23:00, act=08:00-17:00, cafmg=107, max=5, whatif=bed,+60分,+90分', () => {
  const base = run({ s: GOOD, now: GOOD_NOW });
  const explicit = run({ s: GOOD, now: GOOD_NOW, need: '450', bed: '23:00', act: '08:00-17:00', cafmg: '107',
    whatif: '23:00,00:00,00:30', shift: '0', max: '5', wake: '07:00' });
  assert.deepEqual(explicit, base);
  assert.deepEqual(base.bedtime_compare.map((row) => row.bed), ['23:00', '00:00', '00:30']);
});

test('wake の既定値は、直近7日の起床時刻の中央値', () => {
  // 直近7日の起床：06:00 ×3、07:00 ×4 → 中央値 07:00。06:00 起床の方が多い履歴では 06:00
  const late = nights(14, '23:00', '07:00', { 8: { wake: '06:00' }, 9: { wake: '06:00' }, 10: { wake: '06:00' } });
  const early = nights(14, '23:00', '06:00', { 8: { wake: '07:00' }, 9: { wake: '07:00' }, 10: { wake: '07:00' } });
  const now = `${date(15)}T07:10`;
  assert.deepEqual(run({ s: late, now }), run({ s: late, now, wake: '07:00' }));
  assert.deepEqual(run({ s: early, now }), run({ s: early, now, wake: '06:00' }));
  assert.notDeepEqual(run({ s: early, now }).bedtime_compare, run({ s: early, now, wake: '07:00' }).bedtime_compare);
});

test('パラメータの書式が不正なら、キー名を含む理由でエラーにする', () => {
  const cases = { now: '2026-03-15', need: 'abc', bed: '25:00', wake: '7時', act: '08:00', cafmg: '-5', whatif: '23:00,xx',
    gym: '18', win: '19:00-19:00', shift: '1.5', max: '-1' };
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

test('now より後に終わる睡眠区間があればエラー（時計のずれを見逃さない）', () => {
  const r = run({ s: GOOD, now: `${date(14)}T22:10` });
  assert.equal(r.status, 'error');
  assert.match(r.error, /now/);
});

test('直前24時間に睡眠記録が無ければエラー', () => {
  const r = run({ s: GOOD, now: `${date(16)}T07:10` });
  assert.equal(r.status, 'error');
  assert.deepEqual(r.notifications, []);
});

/* ---------- 睡眠負債・身体機能・仮眠・集中に向く時間帯（4 章） ---------- */

test('睡眠負債：直近7日の（need − 睡眠合計）の和。0未満なら0', () => {
  assert.equal(run({ s: GOOD, now: GOOD_NOW }).sleep_debt_min, 0);                     // 480分×7 > 450分×7
  assert.equal(run({ s: GOOD, now: GOOD_NOW, need: '500' }).sleep_debt_min, 140);      // (500−480)×7
  const s = nights(14, '23:00', '06:30', { 14: { bed: '00:30' }, 3: { bed: '03:00' } });   // 8日以上前は数えない
  assert.equal(run({ s, now: `${date(15)}T06:40` }).sleep_debt_min, 90);
  assert.equal(plain(CF.run('', '', null).result).sleep_debt_min, 95);                 // サンプルの値
});

test('身体機能：gym あり・寝不足の日・運動が12:00以降のときだけ', () => {
  const short = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });
  const on = run({ s: short, now: GOOD_NOW, gym: '18:30' });
  assert.deepEqual(on.physical, { strength: 97, endurance: 90, advice: '重量は維持し、回数とセット数を控えめにしてください。' });
  assert.equal(run({ s: short, now: GOOD_NOW, gym: '11:59' }).physical, null);
  assert.equal(run({ s: short, now: GOOD_NOW, gym: '12:00' }).physical.strength, 97);
  assert.equal(run({ s: short, now: GOOD_NOW }).physical, null);
  assert.equal(run({ s: GOOD, now: GOOD_NOW, gym: '18:30' }).physical, null);
});

test('仮眠の助言：寝不足の日だけ。回復量の％は出さない', () => {
  const short = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });
  const advice = run({ s: short, now: GOOD_NOW }).nap_advice;
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

test('shift：正の値で谷とピークが後ろへずれる', () => {
  const base = run({ s: GOOD, now: GOOD_NOW });
  const shifted = run({ s: GOOD, now: GOOD_NOW, shift: '30' });
  assert.equal(shifted.valley.time, '15:00');
  assert.equal(shifted.peak.start, '09:10');
  assert.equal(base.valley.time, '14:30');
});

test('活動時間帯の端に最小があるときは、端の時刻と at_edge を返す', () => {
  const r = run({ s: GOOD, now: GOOD_NOW, act: '08:00-13:00' });
  assert.deepEqual(r.valley, { time: '13:00', value: 94, at_edge: true });
});

/* ---------- 通知ルールと文面（6 章） ---------- */

test('通常の日：morning・valley・night の3件を、時刻順に返す', () => {
  const r = run({ s: GOOD, now: GOOD_NOW });
  assert.deepEqual(r.notifications, [
    { time: '07:10', kind: 'morning', text: '今日の注意・反応は日中平均95%です。08:40〜10:10が最も高く、14:30ごろに谷が来ます。重い作業は08:40〜10:10に回してください。' },
    { time: '14:10', kind: 'valley', text: 'あと20分ほどで集中が落ちます。単純作業に切り替えてください。カフェインを摂るなら14:12までです。' },
    { time: '21:30', kind: 'night', text: '入浴の時間です（40〜42.5℃で10分以上）。23:00に寝ると明日の日中は平均95%、00:00なら94%、00:30なら93%の見込みです。' }
  ]);
});

test('morning の追加文：睡眠負債が0より大きいときだけ付く', () => {
  const r = run({ s: GOOD, now: GOOD_NOW, need: '500' });
  assert.ok(r.notifications[0].text.endsWith('に回してください。睡眠負債は2時間20分です。'));
  assert.ok(!run({ s: GOOD, now: GOOD_NOW }).notifications[0].text.includes('睡眠負債'));
});

test('valley の文面：通知時刻が締切以降なら「控えてください」になる', () => {
  const r = run({ s: GOOD, now: GOOD_NOW, cafmg: '217.5' });
  assert.equal(r.notifications[1].text,
    'あと20分ほどで集中が落ちます。単純作業に切り替えてください。カフェインは締切（09:48）を過ぎているため、控えてください。');
});

test('寝不足の日：nap は12:00、gym は運動の30分前に入る', () => {
  const short = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });
  const r = run({ s: short, now: GOOD_NOW, gym: '18:30' });
  assert.equal(r.valley.time, '14:25');   // 寝不足の日は谷が少し早まる（10章：谷は14:25〜14:30）
  assert.deepEqual(r.notifications.map((n) => [n.time, n.kind]),
    [['07:10', 'morning'], ['12:00', 'nap'], ['14:05', 'valley'], ['18:00', 'gym'], ['21:30', 'night']]);
  assert.equal(r.notifications[1].text,
    '昨夜の睡眠が6時間以下でした。13:00までに20分前後の仮眠をおすすめします。起きてから30分は重要な作業を避けてください。');
  assert.equal(r.notifications[3].text,
    '寝不足のため、筋力は約97%、筋持久力は約90%の見込みです。重量は維持し、回数とセット数を控えめにしてください。');
});

test('上限を超えるときは valley、morning、night、nap、gym の順に残す', () => {
  const short = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });
  const kinds = (max) => run({ s: short, now: GOOD_NOW, gym: '18:30', max: String(max) }).notifications.map((n) => n.kind);
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

test('就寝目標を過ぎて起きていても計算できる（過ぎた就寝時刻は比べない）', () => {
  const r = run({ s: GOOD, now: `${date(16)}T00:10` });
  assert.equal(r.status, 'ok');
  assert.equal(r.wake_time, '07:00');
  assert.deepEqual(r.bedtime_compare.map((row) => row.bed), ['00:30']);
  assert.deepEqual(r.notifications, []);
});

/* ---------- 出力仕様（5 章） ---------- */

const KEY_ORDER = ['status', 'error', 'demo', 'now', 'wake_time', 'attention_now', 'attention_day_avg', 'peak', 'valley',
  'sleep_debt_min', 'short_sleep', 'caffeine_cutoff', 'bath_time', 'bedtime_compare', 'physical', 'nap_advice',
  'focus_window', 'notifications'];

test('結果ブロック：キー名と順序は、正常・サンプル・エラーのどれでも同じ', () => {
  const outputs = [CF.run('', `#s=${GOOD}&now=${GOOD_NOW}`, null), CF.run('', '', null), CF.run('', '#s=abc', GOOD_NOW)];
  for (const out of outputs) {
    const text = CF.formatResult(out.result);
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), KEY_ORDER);
    assert.deepEqual(parsed, plain(out.result));
  }
});

test('結果ブロック：時刻は HH:MM、％は整数', () => {
  const short = nights(14, '23:00', '07:00', { 14: { bed: '02:00' } });
  const r = run({ s: short, now: GOOD_NOW, gym: '18:30', win: '19:00-22:00' });
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const value of [r.wake_time, r.peak.start, r.peak.end, r.valley.time, r.caffeine_cutoff, r.bath_time,
    r.nap_advice.before, r.focus_window.start, r.focus_window.end,
    ...r.bedtime_compare.map((row) => row.bed), ...r.notifications.map((n) => n.time)]) {
    assert.match(value, clock);
  }
  for (const value of [r.attention_now, r.attention_day_avg, r.peak.avg, r.valley.value, r.sleep_debt_min,
    r.focus_window.avg, ...r.bedtime_compare.flatMap((row) => [row.next_day_avg, row.next_day_min])]) {
    assert.ok(Number.isInteger(value), String(value));
  }
  assert.match(r.now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('エラーのときは、該当しない項目がすべて null になる', () => {
  const r = run({ s: 'abc', now: GOOD_NOW });
  assert.equal(r.now, GOOD_NOW);
  for (const key of KEY_ORDER.slice(4)) {
    if (key === 'bedtime_compare' || key === 'notifications') assert.deepEqual(r[key], []);
    else assert.equal(r[key], null, key);
  }
});

/* ---------- 時刻の扱い ---------- */

test('時刻は文字列と分単位の通し番号を行き来できる（月末・うるう年を含む）', () => {
  for (const text of ['2026-11-10T07:10', '2024-02-29T23:59', '2026-12-31T00:00', '1999-01-01T12:34', '2100-03-01T05:05']) {
    assert.equal(CF.formatDateTime(CF.parseDateTime(text)), text);
  }
  assert.equal(CF.parseDateTime('2026-03-01T00:00') - CF.parseDateTime('2026-02-28T00:00'), 1440);
  assert.equal(CF.parseDateTime('2024-03-01T00:00') - CF.parseDateTime('2024-02-28T00:00'), 2880);
  assert.equal(CF.parseDateTime('2026-11-10T07:10:45'), CF.parseDateTime('2026-11-10T07:10'));
  for (const bad of ['2026-02-29T00:00', '2026-11-10T24:00', '2026-11-10T07:60', '2026-11-10', '2026-11-10T07:10Z', '']) {
    assert.equal(CF.parseDateTime(bad), null, bad);
  }
});

/* ---------- 技術要件（8 章） ---------- */

test('計算部は Date・DOM・保存領域・乱数を使わない', () => {
  const code = coreSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const word of ['Date', 'document', 'window', 'location', 'navigator', 'localStorage', 'Math.random', 'setTimeout']) {
    assert.ok(!new RegExp(`\\b${word.replace('.', '\\.')}\\b`).test(code), word);
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
  assert.equal(allowed.length, 9);
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
