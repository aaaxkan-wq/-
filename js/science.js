/*
 * science.js — 睡眠科学エンジン
 *
 * 設計方針（リサーチ結論に基づく）:
 *  - 「90分サイクルで起こす」逆算は採用しない（周期長は90分固定でなく個人差・
 *    夜間変動が大きく、入眠潜時のばらつきと体動センサーの段階推定精度の低さで
 *    破綻するため）。
 *  - 代わりに、エビデンスの強い「睡眠の規則性」「7時間以上の総量」「睡眠負債」
 *    を中心に据える。
 *  - 「いつ眠くなるか」は二プロセスモデル(Borbély)で推定する（あくまで推定）。
 *
 * 主な出典:
 *  - 睡眠規則性(SRI)と死亡率: Windred 2024 SLEEP zsad253 / eLife 88359
 *  - 推奨7時間以上: AASM/SRS consensus (Watson 2015) / CDC
 *  - 睡眠負債は自覚しにくく蓄積: Van Dongen 2003 Sleep
 *  - 二プロセスモデル(Process S τ≈18.2h覚醒/4.2h睡眠, Process C): Borbély 2022;
 *    Daan/Beersma/Borbély 1984
 *  - 午後の眠気=起床+6〜8h, WMZ=就床1〜3h前: Sleep Foundation / PMC6054682
 *  - social jetlag: Roenneberg 2012 Current Biology
 */

const MIN_PER_DAY = 1440;

/* ---------- 基本ユーティリティ ---------- */

// 'YYYY-MM-DDTHH:MM' を Date に
function toDate(s) {
  return s ? new Date(s) : null;
}

// レコードの睡眠時間（分）。bed > wake のような不整合は null
function durationMin(rec) {
  const b = toDate(rec.bed), w = toDate(rec.wake);
  if (!b || !w) return null;
  const d = (w - b) / 60000;
  return d > 0 && d < MIN_PER_DAY ? Math.round(d) : null;
}

// 睡眠中央時刻（mid-sleep）を「基準日0時からの分」で返す（時計上の分, 0-1440）
function midSleepClockMin(rec) {
  const b = toDate(rec.bed), w = toDate(rec.wake);
  if (!b || !w) return null;
  const mid = new Date((b.getTime() + w.getTime()) / 2);
  return mid.getHours() * 60 + mid.getMinutes();
}

function fmtHM(mins) {
  mins = ((Math.round(mins) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDur(mins) {
  if (mins == null) return '—';
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}時間${String(m).padStart(2, '0')}分`;
}

/* ---------- 睡眠規則性 (SRI 近似) ----------
 * 本来のSRIは加速度計の30秒エポックから「24h離れた2時点で同じ状態にある確率」を
 * 計算する(Phillips 2017)。ここでは自己申告の就床/起床時刻から各日の睡眠マスクを
 * 作り、隣接日ペアで分単位の一致率を平均して近似する。
 * 値域 -100..100（100=完全に規則的）。自己申告ベースなので精度は本来のSRIに劣る点に注意。
 */
function buildDayMask(rec) {
  // 正午(12:00)起点の24h窓に睡眠区間を割り当てる（夜間睡眠を分断しないため）。
  // 戻り値: 長さ1440のUint8（1=睡眠）。窓の起点は bed の属する「正午〜翌正午」。
  const b = toDate(rec.bed), w = toDate(rec.wake);
  if (!b || !w || w <= b) return null;
  const origin = new Date(b);
  if (origin.getHours() < 12) origin.setDate(origin.getDate() - 1);
  origin.setHours(12, 0, 0, 0);
  const mask = new Uint8Array(MIN_PER_DAY);
  const start = Math.floor((b - origin) / 60000);
  const end = Math.floor((w - origin) / 60000);
  for (let i = Math.max(0, start); i < Math.min(MIN_PER_DAY, end); i++) mask[i] = 1;
  return { origin: origin.getTime(), mask };
}

function sleepRegularityIndex(records) {
  const masks = records.map(buildDayMask).filter(Boolean)
    .sort((a, b) => a.origin - b.origin);
  if (masks.length < 2) return null;
  let total = 0, pairs = 0;
  for (let i = 1; i < masks.length; i++) {
    // 連続する暦日(約24h差)のペアのみ比較
    const gapDays = Math.round((masks[i].origin - masks[i - 1].origin) / 86400000);
    if (gapDays !== 1) continue;
    let same = 0;
    for (let m = 0; m < MIN_PER_DAY; m++) {
      if (masks[i].mask[m] === masks[i - 1].mask[m]) same++;
    }
    total += same / MIN_PER_DAY;
    pairs++;
  }
  if (!pairs) return null;
  return Math.round((200 * (total / pairs) - 100) * 10) / 10; // -100..100
}

// SRI を 0-100 のわかりやすいスコアと評価ラベルに
function regularityLabel(sri) {
  if (sri == null) return { score: null, label: '記録不足', tone: 'muted' };
  // 文献の死亡リスク低減は概ね上位四分位で頭打ち。SRI~80前後を「良好」目安に。
  if (sri >= 80) return { score: sri, label: 'とても規則的', tone: 'good' };
  if (sri >= 70) return { score: sri, label: '規則的', tone: 'good' };
  if (sri >= 55) return { score: sri, label: 'やや不規則', tone: 'warn' };
  return { score: sri, label: '不規則', tone: 'bad' };
}

/* ---------- 睡眠負債 ----------
 * 直近N日について (目標 - 実績) を合計。寝だめでは完全に返せない(Banks 2010,
 * Depner 2019)ため、貯金(マイナス負債)は0で頭打ちにする保守的な扱い。
 */
function sleepDebt(records, targetMin, days = 14) {
  const recent = recordsWithin(records, days);
  if (!recent.length) return { debtMin: 0, nights: 0, avgMin: null };
  let sumDur = 0, debt = 0, nights = 0;
  for (const r of recent) {
    const d = durationMin(r);
    if (d == null) continue;
    nights++;
    sumDur += d;
    const nightly = targetMin - d;
    if (nightly > 0) debt += nightly; // 不足のみ累積、寝だめでは相殺しすぎない
  }
  return {
    debtMin: debt,
    nights,
    avgMin: nights ? Math.round(sumDur / nights) : null,
  };
}

function recordsWithin(records, days) {
  const cutoff = Date.now() - days * 86400000;
  return records
    .filter(r => toDate(r.wake) && toDate(r.wake).getTime() >= cutoff)
    .sort((a, b) => toDate(a.wake) - toDate(b.wake));
}

/* ---------- social jetlag ----------
 * 平日と休日の睡眠中央時刻の差の絶対値(Roenneberg 2012)。
 */
function socialJetlag(records) {
  const wk = [], we = [];
  for (const r of records) {
    const mid = midSleepClockMin(r);
    if (mid == null) continue;
    const wakeDay = toDate(r.wake).getDay(); // 0=日,6=土
    // 起床日が土日 = 休日扱い
    (wakeDay === 0 || wakeDay === 6 ? we : wk).push(mid);
  }
  if (wk.length < 1 || we.length < 1) return null;
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const diff = Math.abs(avg(we) - avg(wk));
  return Math.round(diff); // 分
}

/* ---------- 推奨就床時刻 ----------
 * 目標起床時刻 − 目標睡眠時間 − 入眠潜時。サイクル数では計算しない。
 */
function recommendBedtime(settings) {
  const wake = parseHM(settings.targetWake);          // 分
  const need = settings.targetMin + settings.onsetMin; // 就床から起床までに必要な分
  return (wake - need + MIN_PER_DAY) % MIN_PER_DAY;
}

function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/* ---------- 二プロセスモデルによる眠気推定 ----------
 * Process S: 覚醒中 S=1-(1-S0)e^(-t/τw), τw≈18.2h / 睡眠中 S=S0 e^(-t/τs), τs≈4.2h
 * Process C: 概日の睡眠傾性。深部体温最低点(CBTmin)≈起床の約2.5h前にピーク。
 *            12h高調波を加えて午後の眠気(post-lunch dip)を表現。
 * 眠気スコア = w_s·S + w_c·C を 0-100 に正規化。あくまで推定（実測ではない）。
 */
const TAU_W = 18.2, TAU_S = 4.2;

function processS_wake(hoursSinceWake, s0) {
  return 1 - (1 - s0) * Math.exp(-hoursSinceWake / TAU_W);
}

// 概日睡眠傾性（クロック時hに対して）。CBTmin時刻にピーク=1付近。
function processC(hourOfDay, cbtMinHour) {
  const w = (2 * Math.PI) / 24;
  const main = Math.cos(w * (hourOfDay - cbtMinHour));
  const harm = 0.28 * Math.cos(2 * w * (hourOfDay - cbtMinHour)); // 午後の二峰性
  return main + harm; // 約 -1.28..1.28
}

// ガウス関数（特徴の局所的な山/谷を表現するため）
function gauss(x, mean, sd) {
  const d = x - mean;
  return Math.exp(-(d * d) / (2 * sd * sd));
}

/*
 * 24時間分の眠気カーブを生成。
 *
 * 合成 = 睡眠圧S（単調増加）＋ 概日成分C（夜にピーク）
 *        ＋ 午後の眠気の山（起床+7h付近, post-lunch dip）
 *        − 夕方の覚醒帯の谷（就床2h前付近, wake maintenance zone）
 * これにより文献の landmark（午後の谷=起床6〜8h, 夕方は寝つきにくい）が形に出る。
 * 値はあくまで推定。
 *
 * @param wakeHour    今日の起床クロック時（例 7.0）
 * @param s0AtWake    起床時のS（前夜よく寝たら低い ~0.22、寝不足だと高い）
 * @param bedtimeHour 推奨就床のクロック時
 */
function sleepinessCurve(wakeHour, s0AtWake, bedtimeHour) {
  const cbtMin = (wakeHour - 2.5 + 24) % 24; // CBTmin ≈ 起床2.5h前
  const wmzCenter = (bedtimeHour - 2 + 24) % 24;
  const points = [];
  for (let i = 0; i <= 48; i++) {     // 30分刻みで24h
    const h = i / 2;
    const clock = (wakeHour + h) % 24;
    const S = processS_wake(h, s0AtWake);                 // 0..1 単調増加
    const C = (processC(clock, cbtMin) + 1.28) / 2.56;    // 0..1 夜にピーク
    const afternoon = gauss(h, 7, 1.6);                   // 起床+7h の山
    // WMZ: 就床前は「眠くなりにくい」= 眠気を下げる
    const wmzDist = Math.min(
      Math.abs(clock - wmzCenter),
      24 - Math.abs(clock - wmzCenter)
    );
    const wmz = gauss(wmzDist, 0, 1.5);
    let s = 0.5 * S + 0.4 * C + 0.13 * afternoon - 0.16 * wmz;
    points.push({ h: clock, hoursSinceWake: h, sleepiness: s });
  }
  // 0-100 に正規化
  const vals = points.map(p => p.sleepiness);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  for (const p of points) p.sleepiness = Math.round(((p.sleepiness - lo) / (hi - lo)) * 100);

  // landmark は確立した経験則で決める（カーブの形ではなく文献値）:
  //  午後の眠気の谷 = 起床+7h、最も覚醒 = 起床+2.5h
  const nearest = targetHsw => points.reduce((best, p) =>
    Math.abs(p.hoursSinceWake - targetHsw) < Math.abs(best.hoursSinceWake - targetHsw) ? p : best);
  const afternoonDip = nearest(7);
  const alertPeak = nearest(2.5);
  // WMZ（寝つきにくい時間帯）= 就床1〜3h前
  const wmz = { start: (bedtimeHour - 3 + 24) % 24, end: (bedtimeHour - 1 + 24) % 24 };
  return { points, afternoonDip, alertPeak, wmz };
}

/* ---------- 起床時のS0推定 ---------- */
// 前夜の睡眠時間が長いほど睡眠圧は十分に解消され、起床時S0は低い。
function estimateS0(prevDurationMin) {
  if (prevDurationMin == null) return 0.30;
  const h = prevDurationMin / 60;
  // 8h睡眠で~0.22、5hで~0.40 程度のゆるい近似
  const s0 = 0.22 + Math.max(0, (8 - h)) * 0.045;
  return Math.min(0.55, Math.max(0.18, s0));
}

/* ---------- まとめてダッシュボード指標を計算 ---------- */
function computeDashboard(records, settings) {
  const sorted = [...records].sort((a, b) => toDate(a.wake) - toDate(b.wake));
  const last = sorted[sorted.length - 1] || null;
  const sri = sleepRegularityIndex(records);
  const debt = sleepDebt(records, settings.targetMin);
  const sjl = socialJetlag(records);
  const recBed = recommendBedtime(settings);

  // 眠気カーブの起点: 直近の起床時刻、無ければ目標起床
  let wakeHour, s0;
  if (last) {
    const w = toDate(last.wake);
    wakeHour = w.getHours() + w.getMinutes() / 60;
    s0 = estimateS0(durationMin(last));
  } else {
    wakeHour = parseHM(settings.targetWake) / 60;
    s0 = 0.30;
  }
  const bedHour = recBed / 60;
  const curve = sleepinessCurve(wakeHour, s0, bedHour);

  return {
    last,
    lastDuration: last ? durationMin(last) : null,
    sri,
    regularity: regularityLabel(sri),
    debt,
    socialJetlagMin: sjl,
    recommendedBedtimeMin: recBed,
    curve,
    nights: sorted.length,
  };
}

window.Science = {
  durationMin, midSleepClockMin, fmtHM, fmtDur, parseHM,
  sleepRegularityIndex, regularityLabel, sleepDebt, socialJetlag,
  recommendBedtime, sleepinessCurve, estimateS0, computeDashboard,
  recordsWithin, toDate,
};
