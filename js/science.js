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

// 直近days日だけで計算する（全履歴で計算すると最近の変化が薄まり、値が動かなく
// 見えるため。SRIは元来7〜14日程度の窓で評価する指標）。
function sleepRegularityIndex(records, days = 14) {
  const masks = recordsWithin(records, days).map(buildDayMask).filter(Boolean)
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

/* ---------- 睡眠負債（ローリング収支） ----------
 * 記録を古い順に処理し、各夜 balance += (目標 − 実績) を加算する。
 *  - 目標より短い夜 → 負債が増える
 *  - 目標より長い夜（回復睡眠） → 負債が減る（Banks 2010 で回復睡眠は神経行動機能を
 *    部分的に改善）
 *  - 下限0でクランプ（寝過ぎを「貯金」にはしない）。
 * 旧実装は不足だけを合計し回復を一切反映しなかったため、しっかり寝ても負債が動かない
 * 不具合があった。これを修正。
 * 注: 1晩の極端な寝過ぎで全部返せるわけではない（代謝面は週末回復で戻らない: Depner 2019）
 *     が、就床/起床のみの自己申告から扱える範囲の近似として収支方式を用いる。
 */
function sleepDebt(records, targetMin, days = 14) {
  const recent = recordsWithin(records, days); // wake昇順
  let balance = 0, sumDur = 0, nights = 0;
  for (const r of recent) {
    const d = durationMin(r);
    if (d == null) continue;
    nights++; sumDur += d;
    balance += (targetMin - d);     // 不足は+、回復(余剰)は−
    if (balance < 0) balance = 0;    // 負債の下限は0（貯金しない）
  }
  return {
    debtMin: Math.round(balance),
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
  // 円周平均＋最短角距離（睡眠中央時刻が深夜をまたいでも正しく扱う）
  const wkMean = circularMeanMin(wk), weMean = circularMeanMin(we);
  let diff = Math.abs(weMean - wkMean);
  if (diff > MIN_PER_DAY / 2) diff = MIN_PER_DAY - diff;
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

/* ---------- 眠気予測（二プロセスモデル） ----------
 * Borbély(1982) / Daan & Beersma & Borbély(1984) の二プロセスモデルの素直な実装。
 *   Process S(睡眠恒常性): 覚醒中は上限へ指数上昇、睡眠中は下限へ指数減衰
 *                          （文献の時定数 τ覚醒≈18.2h, τ睡眠≈4.2h）
 *   Process C(概日): 深部体温最低点(CBTmin)を基準にした余弦波
 *   眠気スコア = f(S − C) をモデルの理論的最小〜最大で0-100に正規化（データ依存の
 *               恣意的な正規化ではない）。
 * ⚠️ これは「集団モデルによる推定の forecast」であり、あなたの眠気を実測したもの
 *    ではない（個人差あり）。曲線の起点はあなたの実際の起床に合わせる。
 */
const TP = { tauW: 18.18, tauS: 4.2, sMax: 0.95, sMin: 0.17, cAmp: 0.15 };
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function tpSw(e, S) { return TP.sMax - (TP.sMax - S) * Math.exp(-e / TP.tauW); }   // 覚醒中
function tpSs(e, S) { return TP.sMin + (S - TP.sMin) * Math.exp(-e / TP.tauS); }   // 睡眠中
function tpCt(h, cb) { return TP.cAmp * Math.cos(2 * Math.PI * (((h - cb + 48) % 24)) / 24); }
// 眠気 = 睡眠圧S + 概日の睡眠傾性C（CでなくCBTminで眠気が最大になる向き）。
// 深夜(CBTmin)で最眠・夕方の覚醒帯(WMZ)で最も眠くない、という生理に一致させる。
function tpScore(s, c) {
  const lo = TP.sMin - TP.cAmp, hi = TP.sMax + TP.cAmp;
  return clampN(Math.round(((s + c - lo) / (hi - lo)) * 100), 0, 100);
}
function tpSteady(sd, wd) {
  const ew = Math.exp(-wd / TP.tauW), es = Math.exp(-sd / TP.tauS), d = 1 - ew * es;
  return Math.abs(d) < 1e-9 ? 0.5 : (TP.sMin * (1 - es) + TP.sMax * (1 - ew) * es) / d;
}

function sleepinessForecast(records) {
  const recent = recordsWithin(records, 14).filter(r => durationMin(r) != null).slice(-7);
  if (recent.length < 2) return null;
  const wks = [], sls = [], drs = [];
  for (const r of recent) {
    const w = toDate(r.wake), b = toDate(r.bed);
    wks.push(w.getHours() + w.getMinutes() / 60);
    sls.push(b.getHours() + b.getMinutes() / 60);
    drs.push(durationMin(r) / 60);
  }
  for (let i = 0; i < drs.length; i++) if (!(drs[i] > 0 && drs[i] <= 24)) return null;

  // 概日の基準: 実際の習慣的な起床(加重平均)の約2h前を CBTmin とする
  const sched = actualSchedule(records);
  const habW = sched && sched.wake != null ? sched.wake / 60 : wks.reduce((a, b) => a + b, 0) / wks.length;
  const cbtMin = (habW - 2 + 24) % 24;

  // 定常状態の S を反復で求め、最後の起床時点の S0 を得る
  let S = tpSteady(drs[0], 24 - drs[0]);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < recent.length; i++) {
      S = tpSs(drs[i], S);
      const wd = i < recent.length - 1 ? ((sls[i + 1] - wks[i]) + 24) % 24
                                       : ((sls[0] - wks[recent.length - 1]) + 48) % 24;
      S = tpSw(wd, S);
    }
  }
  for (let i = 0; i < recent.length - 1; i++) { S = tpSs(drs[i], S); S = tpSw(((sls[i + 1] - wks[i]) + 24) % 24, S); }
  const S0 = tpSs(drs[recent.length - 1], S);
  const wH = wks[recent.length - 1];

  // 起床起点に24h投影
  const pts = [];
  for (let i = 0; i <= 96; i++) {
    const t = i * 0.25, cH = (wH + t) % 24;
    const sv = tpSw(t, S0), cv = tpCt(cH, cbtMin);
    pts.push({
      t, clock: cH, score: tpScore(sv, cv),
      pressure: clampN(Math.round((sv - TP.sMin) / (TP.sMax - TP.sMin) * 100), 0, 100),
      circ: clampN(Math.round((cv + TP.cAmp) / (2 * TP.cAmp) * 100), 0, 100),
    });
  }
  // landmark: 午後の眠気(起床+5〜10h の極大), 夜の眠気ピーク(起床+14〜22h)
  let dip = null, peak = null;
  for (const p of pts) {
    if (p.t >= 5 && p.t <= 10 && (!dip || p.score > dip.score)) dip = p;
    if (p.t >= 14 && p.t <= 22 && (!peak || p.score > peak.score)) peak = p;
  }
  // 睡眠ゲート: 起床14h以降で眠気が一定以上に上がる最初の時刻
  let gate = null;
  for (const p of pts) { if (p.t >= 14 && p.score >= 55) { gate = p; break; } }

  const now = new Date(), nowH = now.getHours() + now.getMinutes() / 60;
  const elapsed = ((nowH - wH) + 24) % 24;
  let cur = pts[0];
  for (const p of pts) if (Math.abs(p.t - elapsed) < Math.abs(cur.t - elapsed)) cur = p;

  return {
    pts, wH, cbtMin, dip, peak, gate,
    currentScore: cur.score, elapsed,
    sleepGateMin: gate ? Math.round(((wH + gate.t) % 24) * 60) : null,
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

  // 「実際の睡眠スケジュール」= 直近の就床・起床（新しい夜ほど重い加重平均）。
  // 推奨行動・体内時計の目安は、目標/推奨ではなく "実際" に合わせる。
  const sched = actualSchedule(records);
  let actualBed, actualWake, hasActualSchedule = true;
  if (sched) {
    actualBed = sched.bed; actualWake = sched.wake;
  } else if (last) {
    actualBed = bedClockMin(last); actualWake = wakeClockMin(last);
  } else {
    // 記録ゼロのときだけ、暫定的に推奨/目標で代用
    actualBed = recBed; actualWake = parseHM(settings.targetWake); hasActualSchedule = false;
  }

  // 体内時計の目安は実際の起床・就床に合わせる
  const hints = circadianHints(actualWake, actualBed);
  // 二プロセスモデルによる眠気予測（記録2日以上で算出, モデル推定）
  const forecast = sleepinessForecast(records);

  return {
    last,
    lastDuration: last ? durationMin(last) : null,
    sri,
    debt,
    socialJetlagMin: sjl,
    recommendedBedtimeMin: recBed,
    recommendation: rec,
    hints,
    forecast,
    actualBed,
    actualWake,
    hasActualSchedule,
    nights: sorted.length,
  };
}

/* ---------- 個人の記録の集計（「学習」＝実データの記述統計。推測・予測はしない） ----------
 * ここで返すのは全て「あなたが入力した記録そのものの集計値」で、検証されていない
 * 予測モデルや恣意的なスコアは含まない。唯一の派生指標 chronotypeMSFsc は出典のある
 * 公表手法(MCTQ)で、適用上の制約を明記する。
 */

// 重み付き円周平均。pairs=[{min, w}]。深夜またぎを正しく扱う。
function weightedCircularMeanMin(pairs) {
  let sx = 0, sy = 0, sw = 0;
  for (const { min, w } of pairs) {
    if (min == null) continue;
    const a = (min / MIN_PER_DAY) * 2 * Math.PI;
    sx += w * Math.cos(a); sy += w * Math.sin(a); sw += w;
  }
  if (!sw) return null;
  let ang = Math.atan2(sy / sw, sx / sw);
  if (ang < 0) ang += 2 * Math.PI;
  return Math.round((ang / (2 * Math.PI)) * MIN_PER_DAY) % MIN_PER_DAY;
}

/* 「実際の睡眠スケジュール」= 直近の就床・起床を、新しい夜ほど重く見た加重平均。
 * 半減期 halfLife 日（既定3日）の指数減衰で重み付け。
 *  - 直近の生活リズムを強く反映しつつ、1晩の例外には過剰反応しない。
 *  - 体内時計は習慣的な就寝時刻で決まる（1晩では動かない）ため、平均ベースが妥当。
 */
function actualSchedule(records, days = 7, halfLife = 3) {
  const recent = recordsWithin(records, days).filter(r => durationMin(r) != null);
  if (!recent.length) return null;
  const now = Date.now();
  const bedPairs = [], wakePairs = [];
  for (const r of recent) {
    const ageDays = (now - toDate(r.wake).getTime()) / 86400000;
    const w = Math.pow(0.5, Math.max(0, ageDays) / halfLife);
    bedPairs.push({ min: bedClockMin(r), w });
    wakePairs.push({ min: wakeClockMin(r), w });
  }
  return {
    bed: weightedCircularMeanMin(bedPairs),
    wake: weightedCircularMeanMin(wakePairs),
    nights: recent.length,
  };
}

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
  recommendBedtime, recommendTonight, circadianHints, sleepinessForecast, computeDashboard,
  personalStats, chronotypeMSFsc, durationTrend, circularMeanMin, actualSchedule,
  recordsWithin, toDate, AASM_MIN: 420,
};
