/*
 * コンディション予報：ブラウザでの確認（Playwright が使える環境だけで動く）
 *   実行： node --test forecast/test/*.test.js
 * 画面の要件（幅360px、外部通信なし、同期描画、# の変更で再計算）を、実際のブラウザで確かめる。
 * 睡眠記録はすべて合成データ。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) { /* 無ければ全テストを省略する */ }
const skip = chromium ? false : 'Playwright が入っていないため省略';

const file = path.join(__dirname, '..', 'index.html');
const url = 'file://' + file;
const sandbox = {};
vm.runInNewContext(/<script id="core">([\s\S]*?)<\/script>/.exec(fs.readFileSync(file, 'utf8'))[1], sandbox);
const CF = sandbox.ConditionForecast;

const pad = (n) => String(n).padStart(2, '0');
const GOOD = Array.from({ length: 14 }, (_, k) => `2026-03-${pad(k + 1)}T23:00/2026-03-${pad(k + 2)}T07:00`);
const SHORT = GOOD.slice(0, 13).concat(['2026-03-15T02:00/2026-03-15T07:00']);
const NOW = '2026-03-15T07:10';
const HASH = {
  sample: '',
  normal: `#s=${GOOD}&now=${NOW}`,
  short: `#s=${SHORT}&now=${NOW}&gym=18:30&win=19:00-22:30&whatif=22:30,23:00,23:30,00:00,00:30,01:00`,
  imputed: `#s=${GOOD.filter((_, k) => k !== 4 && k !== 11)}&now=${NOW}`,
  waiting: `#s=${GOOD.slice(0, 13)}&now=${NOW}`,
  sleepless: `#s=${GOOD.slice(0, 13)}&now=${NOW}&none=2026-03-15`,
  error: `#s=${'x'.repeat(300)}&now=${NOW}`
};

let browser;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(hash, options = {}) {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, ...options });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(url + hash, { waitUntil: 'domcontentloaded' });
  return { context, page, requests };
}

const readResult = (page) => page.evaluate(() => JSON.parse(document.getElementById('muse-result').textContent));

test('読み込み直後に結果ブロックがあり、計算部の結果と一致する', { skip }, async () => {
  for (const hash of Object.values(HASH)) {
    const { context, page } = await open(hash);
    const expected = JSON.parse(JSON.stringify(CF.run('', hash, null).result));
    assert.deepEqual(await readResult(page), expected);
    assert.equal(await page.locator('#muse-result').count(), 1);
    await context.close();
  }
});

test('幅360pxで横スクロールが出ない（ライト・ダーク）', { skip }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    for (const [name, hash] of Object.entries(HASH)) {
      const { context, page } = await open(hash, { colorScheme });
      const size = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        widest: Math.max(...[...document.querySelectorAll('body *')].map((node) => node.getBoundingClientRect().right))
      }));
      assert.ok(size.page <= 360, `${name}/${colorScheme}: ページ幅 ${size.page}`);
      assert.ok(size.widest <= 360, `${name}/${colorScheme}: はみ出す要素 ${size.widest}`);
      await context.close();
    }
  }
});

test('ライトとダークで配色が切り替わる', { skip }, async () => {
  const colors = [];
  for (const colorScheme of ['light', 'dark']) {
    const { context, page } = await open(HASH.normal, { colorScheme });
    colors.push(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
    await context.close();
  }
  assert.deepEqual(colors, ['rgb(249, 249, 247)', 'rgb(13, 13, 13)']);
});

test('外部通信をしない。保存もしない', { skip }, async () => {
  const { context, page, requests } = await open(HASH.short);
  await page.mouse.move(180, 400);
  await page.waitForTimeout(300);
  assert.deepEqual(requests, [url]);   // ページ自身の読み込みだけ。# 以降（睡眠記録）は要求に含まれない
  assert.deepEqual(await context.cookies(), []);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await context.close();
});

test('画面：状態表示・見出し・条件付きの項目・タイトル', { skip }, async () => {
  const visible = (page) => page.evaluate(() =>
    ['status', 'sec-now', 'sec-day', 'sec-chart', 'sec-plan', 'sec-compare', 'sec-cond'].filter((id) => !document.getElementById(id).hidden));

  let { context, page } = await open(HASH.normal);
  assert.deepEqual(await visible(page), ['sec-now', 'sec-day', 'sec-chart', 'sec-plan', 'sec-compare']);
  assert.equal(await page.title(), '注意・反応 93% ｜ 谷 14:30');
  assert.equal(await page.locator('#now-value').textContent(), '93');
  assert.equal(await page.locator('#now-label').textContent(), '注意・反応（07:10 時点・起床 07:00）');
  assert.deepEqual(await page.locator('#facts .k').allTextContents(),
    ['ピーク時間帯', '谷', '今夜の就寝', '限界の目安', '睡眠負債', '見落とし予告']);
  assert.deepEqual(await page.locator('#facts .v').allTextContents(),
    ['08:40〜10:10（平均96%）', '14:30（93%）', '遅くとも23:25まで（明日07:00起床）', '01:03から77%を下回る（起き続けた場合）',
      'なし（直近7日）', 'なし']);
  assert.equal(await page.locator('#compare .advice').textContent(), '明日07:00に起きるなら、遅くとも23:25までに寝てください。');
  assert.equal(await page.locator('#compare .advice + .note').textContent(), '7時間35分眠れて、明日の日中は平均94%の見込みです（普段は95%）。');
  assert.match(await page.locator('#compare .evening').textContent(), /^注意・反応は19:13ごろが夜のピークで/);
  assert.equal(await page.locator('#chart line.limit').count(), 1);
  assert.equal(await page.locator('#now-chip').textContent(), '良好');
  assert.equal(await page.locator('#now-like').textContent(), 'よく眠った日の日中と同じくらいです。');
  assert.deepEqual(await page.locator('#ladder li > span:first-child').allTextContents(),
    ['今', 'よく眠った日の日中', 'よく眠った人の夜11時ごろ', '深夜1時ごろ。酒気帯び（血中アルコール0.05%）と同じ水準', '徹夜した明け方5時ごろ']);
  assert.match(await page.locator('#now-detail').textContent(), /^いつもの今ごろとほぼ同じです。/);
  assert.equal(await page.locator('#day tbody tr').count(), 6);
  assert.equal(await page.locator('#plan tbody tr').count(), 3);
  assert.equal(await page.locator('#compare tbody tr').count(), 3);
  assert.equal(await page.locator('#chart svg path.curve').count(), 1);
  await context.close();

  ({ context, page } = await open(HASH.short));
  assert.deepEqual(await visible(page), ['sec-now', 'sec-day', 'sec-chart', 'sec-plan', 'sec-compare', 'sec-cond']);
  assert.deepEqual(await page.locator('#cond h3').allTextContents(), ['運動の助言（18:30）', '仮眠の助言', '集中に向く時間帯']);
  assert.equal(await page.locator('#plan tbody tr').count(), 5);
  await context.close();

  ({ context, page } = await open(HASH.sample));
  assert.deepEqual(await visible(page), ['status', 'sec-now', 'sec-day', 'sec-chart', 'sec-plan', 'sec-compare']);
  assert.match(await page.locator('#status').textContent(), /サンプル表示中/);
  assert.match(await page.title(), /^［サンプル］注意・反応 \d+% ｜ 谷 \d\d:\d\d$/);
  await context.close();

  ({ context, page } = await open(HASH.imputed));
  assert.deepEqual(await visible(page), ['status', 'sec-now', 'sec-day', 'sec-chart', 'sec-plan', 'sec-compare']);
  assert.match(await page.locator('#status').textContent(), /記録が欠けた晩を、普段の睡眠で補って計算しています（3\/6、3\/13 の朝までの晩）/);
  await context.close();

  ({ context, page } = await open(HASH.waiting));
  assert.deepEqual(await visible(page), ['status']);
  assert.match(await page.locator('#status').textContent(), /昨夜の記録待ち：昨夜の睡眠記録がありません/);
  assert.equal(await page.title(), '昨夜の記録待ち ｜ コンディション予報');
  assert.equal((await readResult(page)).status, 'need_last_night');
  await context.close();

  ({ context, page } = await open(HASH.sleepless));
  assert.deepEqual(await visible(page), ['sec-now', 'sec-day', 'sec-chart', 'sec-plan', 'sec-compare', 'sec-cond']);
  assert.equal(await page.locator('#now-label').textContent(), '注意・反応（07:10 時点・起床の記録なし）');
  const sleeplessFacts = await page.locator('#facts .v').allTextContents();
  assert.match(sleeplessFacts[5], /^あり（日中平均が普段より[\d.]+ポイント低い）$/);
  assert.equal(sleeplessFacts[3], 'すでに77%を下回っています');
  assert.equal(sleeplessFacts[2], '遅くとも20:00まで（明日07:00起床）');
  assert.equal(await page.locator('#now-chip').textContent(), '大きく低下');
  assert.deepEqual(await page.locator('#ladder li > span:first-child').allTextContents(),
    ['よく眠った日の日中', 'よく眠った人の夜11時ごろ', '深夜1時ごろ。酒気帯び（血中アルコール0.05%）と同じ水準', '今', '徹夜した明け方5時ごろ']);
  await context.close();

  ({ context, page } = await open(HASH.error));
  assert.deepEqual(await visible(page), ['status']);
  assert.match(await page.locator('#status').textContent(), /エラー：s の書式が不正/);
  assert.equal(await page.title(), 'エラー ｜ コンディション予報');
  await context.close();
});

test('同じタブで # 以降だけを変えても、計算し直す', { skip }, async () => {
  const { context, page } = await open(HASH.normal);
  assert.equal((await readResult(page)).caffeine_cutoff, '14:12');
  await page.evaluate((hash) => { location.hash = hash; }, HASH.normal + '&cafmg=217.5');
  await page.waitForFunction(() => document.getElementById('muse-result').textContent.includes('09:48'));
  await page.evaluate(() => { location.hash = 's=abc'; });
  await page.waitForFunction(() => document.title.startsWith('エラー'));
  assert.equal((await readResult(page)).status, 'error');
  await context.close();
});

test('クエリ文字列でも受け付け、フラグメントを優先する', { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await page.goto(`${url}?s=${GOOD}&now=${NOW}&bed=22:00#bed=23:00`);
  const result = await readResult(page);
  assert.equal(result.status, 'ok');
  assert.equal(result.bath_time, '21:30');
  await context.close();
});

test('now が無いときは時計の絶対時刻を tz で換算する。ブラウザのタイムゾーン設定には左右されない', { skip }, async () => {
  // 絶対時刻 2026-03-14T22:10Z は、tz の既定（+09:00）で 2026-03-15 07:10
  const results = [];
  for (const timezoneId of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-03-14T22:10:00Z'));
    await page.goto(`${url}#s=${GOOD}`);
    results.push(await readResult(page));
    await context.close();
  }
  assert.equal(results[0].now, NOW);
  assert.equal(results[0].status, 'ok');
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.deepEqual(results[0], JSON.parse(JSON.stringify(CF.run('', HASH.normal, null).result)));

  // now を渡せば、時計がいつを指していても結果は同じ
  const context = await browser.newContext({ timezoneId: 'UTC' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2031-07-01T03:00:00Z'));
  await page.goto(url + HASH.normal);
  assert.deepEqual(await readResult(page), results[0]);
  await context.close();
});
