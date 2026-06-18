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

// SRI の説明。標準化された「良い/悪い」の閾値は存在しない（自己申告近似なので
// 公表SRI値とも直接比較できない）ため、恣意的なバンド分け・色分けはしない。
// 高いほど規則的、という方向性と「自分の推移を追う」用途のみ伝える。
function regularityLabel(sri) {
  if (sri == null) return { score: null };
  return { score: sri };
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

/* ---------- 体内時計の目安となる時間帯（集団平均・出典あり） ----------
 * 以前はここで「眠気カーブ」を生成していたが、係数の手調整・正規化・ラベルの
 * 決め打ちなど科学的に正当化できない要素が多かったため撤去した。
 * 代わりに、文献で確立した集団平均の時間帯を「範囲」で返すだけにする。
 * 個人データから計算したものではなく、あくまで一般的な目安（個人差あり）。
 *
 *  - 午後に眠気が出やすい時間帯: 起床の約6〜8時間後(post-lunch dip)
 *      出典: Sleep Foundation (Sleep Drive and Your Body Clock)
 *  - 夜に寝つきにくい時間帯(体内時計の覚醒帯, WMZ): 就床の約1〜3時間前
 *      出典: PMC6054682 (wake maintenance zone)
 */
function circadianHints(wakeMin, bedMin) {
  return {
    afternoon: { start: (wakeMin + 6 * 60) % MIN_PER_DAY, end: (wakeMin + 8 * 60) % MIN_PER_DAY },
    wmz: { start: (bedMin - 3 * 60 + MIN_PER_DAY) % MIN_PER_DAY, end: (bedMin - 1 * 60 + MIN_PER_DAY) % MIN_PER_DAY },
  };
}

/* ---------- 適応的な「今夜の推奨」 ----------
 * 固定の目標から逆算するだけでなく、積み上がった睡眠負債に応じて就床を早める。
 *
 * 科学的に確定している原則（これに厳密に従う）:
 *   1) 起床時刻は固定が正解（規則性が最重要。寝だめ=起床を遅らせるのは社会的時差ぼけを
 *      悪化させるため不可）→ 回復は「就床を早める」方向のみ。
 *   2) 睡眠負債は1晩では返せず、数晩かけて回復する(Banks 2010, Depner 2019)。
 *   3) 就床直前は体内時計の覚醒帯(WMZ)で寝つけない → 前倒しには上限が要る。
 *   4) 総睡眠は約7〜9時間が最適、9h超は避ける(U字カーブ)。
 *
 * 実務的ヒューリスティック（方向は科学で確定、具体的な数値は下記で明示）:
 *   - 負債がある夜は、目標より最大 RECOVERY_CAP_MIN 分だけ就床を前倒し。
 *   - 推奨睡眠機会は MAX_OPPORTUNITY_MIN(9h) を超えない。
 *   - 残った負債は翌日以降へ。回復に要する目安の晩数も提示する。
 */
const RECOVERY_CAP_MIN = 45;     // 1晩の前倒し上限（WMZの制約＋多晩で回復、の保守的上限）
const MAX_OPPORTUNITY_MIN = 540; // 推奨睡眠機会の上限 = 9時間（U字カーブの上側を避ける）
const DEBT_DEADBAND_MIN = 30;    // この未満の負債はノイズとみなし前倒ししない（過剰反応の抑制）

function recommendTonight(records, settings) {
  const baseBed = recommendBedtime(settings);             // 目標どおりの就床（負債ゼロ時）
  const debt = sleepDebt(records, settings.targetMin);    // 14日累積の不足
  const debtMin = debt.nights ? debt.debtMin : 0;

  // 負債があれば最大45分まで前倒し（合計9hを超えない範囲で）。
  // ごく軽微な負債(デッドバンド未満)はノイズとみなし適応しない。
  let advance = debtMin >= DEBT_DEADBAND_MIN ? Math.min(RECOVERY_CAP_MIN, debtMin) : 0;
  let recDur = settings.targetMin + advance;
  if (recDur > MAX_OPPORTUNITY_MIN) { recDur = MAX_OPPORTUNITY_MIN; advance = Math.max(0, recDur - settings.targetMin); }

  // 起床は目標時刻に固定し、就床だけを前倒し
  const recBed = (parseHM(settings.targetWake) - recDur - settings.onsetMin + MIN_PER_DAY * 2) % MIN_PER_DAY;

  // 全部は1晩で返せない。今夜の前倒し量で割った概算の晩数。
  const nightsToRecover = advance > 0 ? Math.ceil(debtMin / advance) : 0;

  // 参考: 直近の習慣的な就床（前倒しが普段よりかなり早いと寝つけない可能性を注意喚起）
  const stats = personalStats(records, 14);
  let muchEarlierThanUsual = false;
  if (stats && stats.avgBed != null) {
    // 推奨就床が習慣就床より90分以上早いか（円周上の差）
    let diff = (stats.avgBed - recBed + MIN_PER_DAY) % MIN_PER_DAY;
    if (diff > MIN_PER_DAY / 2) diff -= MIN_PER_DAY; // -720..720
    muchEarlierThanUsual = diff > 90; // 習慣より90分以上早い
  }

  return {
    bedMin: recBed,
    baseBedMin: baseBed,
    advanceMin: advance,
    recDurMin: recDur,
    targetDurMin: settings.targetMin,
    debtMin,
    nightsToRecover,
    inDebt: advance > 0,
    muchEarlierThanUsual,
    habitualBed: stats ? stats.avgBed : null,
  };
}

/* ---------- まとめてダッシュボード指標を計算 ---------- */
function computeDashboard(records, settings) {
  const sorted = [...records].sort((a, b) => toDate(a.wake) - toDate(b.wake));
  const last = sorted[sorted.length - 1] || null;
  const sri = sleepRegularityIndex(records);
  const debt = sleepDebt(records, settings.targetMin);
  const sjl = socialJetlag(records);
  const rec = recommendTonight(records, settings);   // 負債に応じて適応した今夜の推奨
  const recBed = rec.bedMin;

  // 体内時計の目安の時間帯（集団平均）: 起点は直近の起床、無ければ目標起床
  const wakeMin = last ? (toDate(last.wake).getHours() * 60 + toDate(last.wake).getMinutes())
                       : parseHM(settings.targetWake);
  const hints = circadianHints(wakeMin, recBed);

  return {
    last,
    lastDuration: last ? durationMin(last) : null,
    sri,
    debt,
    socialJetlagMin: sjl,
    recommendedBedtimeMin: recBed,
    recommendation: rec,
    hints,
    wakeMinForHints: wakeMin,
    nights: sorted.length,
  };
}

/* ---------- 個人の記録の集計（「学習」＝実データの記述統計。推測・予測はしない） ----------
 * ここで返すのは全て「あなたが入力した記録そのものの集計値」で、検証されていない
 * 予測モデルや恣意的なスコアは含まない。唯一の派生指標 chronotypeMSFsc は出典のある
 * 公表手法(MCTQ)で、適用上の制約を明記する。
 */

// クロック時刻(分)の円周平均。深夜をまたぐ時刻(23:30と0:30など)を正しく平均するため。
function circularMeanMin(minsArr) {
  const xs = minsArr.filter(m => m != null);
  if (!xs.length) return null;
  let sx = 0, sy = 0;
  for (const m of xs) {
    const a = (m / MIN_PER_DAY) * 2 * Math.PI;
    sx += Math.cos(a); sy += Math.sin(a);
  }
  let ang = Math.atan2(sy / xs.length, sx / xs.length);
  if (ang < 0) ang += 2 * Math.PI;
  return Math.round((ang / (2 * Math.PI)) * MIN_PER_DAY) % MIN_PER_DAY;
}

function bedClockMin(rec) { const b = toDate(rec.bed); return b ? b.getHours() * 60 + b.getMinutes() : null; }
function wakeClockMin(rec) { const w = toDate(rec.wake); return w ? w.getHours() * 60 + w.getMinutes() : null; }

// 直近days日の記述統計（時刻は円周平均、睡眠時間は通常平均）
function personalStats(records, days = 14) {
  const recent = recordsWithin(records, days).filter(r => durationMin(r) != null);
  if (!recent.length) return null;
  const durs = recent.map(durationMin);
  return {
    nights: recent.length,
    avgBed: circularMeanMin(recent.map(bedClockMin)),
    avgWake: circularMeanMin(recent.map(wakeClockMin)),
    avgMid: circularMeanMin(recent.map(midSleepClockMin)),
    avgDur: Math.round(durs.reduce((s, x) => s + x, 0) / durs.length),
    minDur: Math.min(...durs), maxDur: Math.max(...durs),
  };
}

// 土日を休日(free day)とみなす簡易判定
function isFreeDay(rec) { const d = toDate(rec.wake).getDay(); return d === 0 || d === 6; }

/* クロノタイプの目安: MCTQ の MSFsc(休日の睡眠中央時刻を睡眠負債で補正した値)。
 *   MSFsc = MSF − (SDf − SDweek)/2   (Roenneberg, MCTQ)
 * 値が早い=朝型寄り、遅い=夜型寄り（連続量。恣意的なカテゴリ分けはしない）。
 * ⚠️適用上の制約(正直な記載):
 *   - MCTQ本来は「入眠」時刻を使うが、本アプリは入眠時刻を持たないため「就床」時刻を
 *     代理に使う → 中央時刻はやや早めに出る。
 *   - 「土日=休日」という簡易判定。交代勤務や週末も同時刻起床の人には当てはまらない。
 *   - 自己申告・少数夜だと不安定。あくまで目安。
 */
function chronotypeMSFsc(records, days = 60) {
  const recent = recordsWithin(records, days).filter(r => durationMin(r) != null);
  const free = recent.filter(isFreeDay);
  if (free.length < 1 || recent.length < 2) return null;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const msf = circularMeanMin(free.map(midSleepClockMin));        // 休日の睡眠中央時刻
  const sdf = mean(free.map(durationMin));                         // 休日の平均睡眠時間
  const sdweek = mean(recent.map(durationMin));                    // 全日の平均睡眠時間
  let msfsc = msf - (sdf - sdweek) / 2;
  msfsc = ((Math.round(msfsc) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return { msfscMin: msfsc, freeNights: free.length, workNights: recent.length - free.length };
}

// 直近7日 vs その前7日 の平均睡眠時間の比較（実データの差分）
function durationTrend(records) {
  const inWindow = (lo, hi) => records.filter(r => {
    const w = toDate(r.wake); if (!w || durationMin(r) == null) return false;
    const age = (Date.now() - w.getTime()) / 86400000;
    return age >= lo && age < hi;
  });
  const avg = arr => arr.length ? Math.round(arr.reduce((s, r) => s + durationMin(r), 0) / arr.length) : null;
  const cur = avg(inWindow(0, 7));
  if (cur == null) return null;
  const prev = avg(inWindow(7, 14));
  return { current: cur, previous: prev, deltaMin: prev == null ? null : cur - prev };
}

window.Science = {
  durationMin, midSleepClockMin, fmtHM, fmtDur, parseHM,
  sleepRegularityIndex, regularityLabel, sleepDebt, socialJetlag,
  recommendBedtime, recommendTonight, circadianHints, computeDashboard,
  personalStats, chronotypeMSFsc, durationTrend, circularMeanMin,
  recordsWithin, toDate, AASM_MIN: 420,
};
