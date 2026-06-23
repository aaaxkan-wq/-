/*
 * charts.js — 依存ゼロの軽量キャンバス描画
 * 眠気予測（二プロセスモデル）と睡眠時間推移（棒）を描く。Retina対応。
 */

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth || 320;
  // 論理高さは初回に確定して保持する。canvas.height を設定すると height 属性も
  // 書き換わるため、毎回属性から読むと再描画ごとに dpr 倍に膨張してしまう（バグ）。
  if (!canvas._logicalH) canvas._logicalH = parseInt(canvas.getAttribute('height')) || 180;
  const h = canvas._logicalH;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

const COL = {
  grid: 'rgba(148,163,184,0.18)',
  axis: 'rgba(148,163,184,0.5)',
  line: '#818cf8',
  fill: 'rgba(129,140,248,0.18)',
  text: 'rgba(226,232,240,0.7)',
  bar: '#6366f1',
  barLow: '#ef4444',
  marker: '#f59e0b',
  sleep: '#f87171',          // 眠気スコア(赤=眠い)
  pressure: '#818cf8',       // 睡眠圧 S
  circ: '#34d399',           // 概日の眠気寄与
};

/* 眠気予測カーブ（二プロセスモデル）。スマホ縦でも見やすいよう、背景を眠気レベルで
 * 色分けし、メインの眠気カーブを主役に。opts.detail で睡眠圧S・概日の補助線を表示。
 * napFc を渡すと仮眠後カーブを重ね描き。 */
function drawForecast(canvas, fc, napFc, opts) {
  opts = opts || {};
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!fc || !fc.pts || !fc.pts.length) return;
  const padL = 30, padR = 8, padT = 14, padB = 22;
  const cw = w - padL - padR, ch = h - padT - padB;
  const pts = fc.pts;
  const cx = t => padL + (t / 24) * cw;
  const cy = v => padT + ch - (v / 100) * ch;

  // 眠気レベルの背景帯（高さ＝意味、を一目で）
  [[0, 35, 'rgba(52,211,153,0.10)'], [35, 55, 'rgba(251,191,36,0.07)'],
   [55, 72, 'rgba(251,146,60,0.10)'], [72, 100, 'rgba(248,113,113,0.13)']]
    .forEach(([lo, hi, col]) => { ctx.fillStyle = col; ctx.fillRect(padL, cy(hi), cw, cy(lo) - cy(hi)); });

  // y軸ラベル
  ctx.fillStyle = 'rgba(226,232,240,0.6)'; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  ctx.fillText('眠い', padL - 5, cy(86)); ctx.fillText('覚醒', padL - 5, cy(12));

  // x軸: 3hごとの時計時刻
  ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(226,232,240,0.6)'; ctx.font = '10px system-ui';
  for (let t = 0; t <= 24; t += 3) {
    const clock = (fc.wH + t) % 24;
    ctx.fillText(String(Math.round(clock)).padStart(2, '0'), cx(t), h - 6);
  }

  // 補助線（既定OFF）: 睡眠圧S・概日
  if (opts.detail) {
    ctx.strokeStyle = 'rgba(129,140,248,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]);
    ctx.beginPath(); pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.pressure); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.strokeStyle = 'rgba(52,211,153,0.55)'; ctx.setLineDash([2, 4]);
    ctx.beginPath(); pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.circ); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 睡眠ゲート（夜に自然に眠くなる時刻）
  if (fc.gate) {
    const x = cx(fc.gate.t);
    ctx.strokeStyle = 'rgba(96,165,250,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#60a5fa'; ctx.font = '9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('眠くなる', x, padT - 3);
  }

  // 眠気スコア（メイン: 塗り＋太線）
  const grad = ctx.createLinearGradient(0, cy(100), 0, cy(0));
  grad.addColorStop(0, 'rgba(248,113,113,0.32)'); grad.addColorStop(1, 'rgba(248,113,113,0.02)');
  ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(cx(pts[0].t), cy(0));
  pts.forEach(p => ctx.lineTo(cx(p.t), cy(p.score)));
  ctx.lineTo(cx(pts[pts.length - 1].t), cy(0)); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = napFc ? 'rgba(248,113,113,0.30)' : COL.sleep;
  ctx.lineWidth = napFc ? 1.5 : 3; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.score); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();

  // 仮眠後カーブ
  if (napFc) {
    ctx.fillStyle = 'rgba(96,165,250,0.16)';
    ctx.fillRect(cx(napFc.napStart), padT, cx(napFc.napEnd) - cx(napFc.napStart), ch);
    ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.beginPath(); napFc.pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.score); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  }

  // 現在地マーカー（縦線＋カーブ上の点＋スコア）
  const ex = Math.max(0, Math.min(24, fc.elapsed));
  let curP = pts[0]; for (const p of pts) if (Math.abs(p.t - ex) < Math.abs(curP.t - ex)) curP = p;
  ctx.strokeStyle = COL.marker; ctx.lineWidth = 2; ctx.setLineDash([3, 2]);
  ctx.beginPath(); ctx.moveTo(cx(ex), padT); ctx.lineTo(cx(ex), padT + ch); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = COL.marker; ctx.beginPath(); ctx.arc(cx(ex), cy(curP.score), 4, 0, 2 * Math.PI); ctx.fill();
  ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('今 ' + curP.score, cx(ex), padT - 3);
}

/* 睡眠時間の棒グラフ: bars=[{label, min, target}]
 * 記録された実値をそのまま描く（加工なし）。赤=7時間(420分, AASM/CDCの推奨下限)未満。*/
function drawDuration(canvas, bars, targetMin) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 8, padR = 8, padT = 10, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  if (!bars.length) {
    ctx.fillStyle = COL.text; ctx.textAlign = 'center';
    ctx.font = '12px system-ui';
    ctx.fillText('記録がありません', w / 2, h / 2);
    return;
  }
  const maxMin = Math.max(600, targetMin + 60, ...bars.map(b => b.min || 0));
  const sy = v => padT + (1 - v / maxMin) * plotH;
  const n = bars.length;
  const bw = Math.min(28, (plotW / n) * 0.6);
  const gap = plotW / n;

  // 7時間ライン（AASM/CDCの推奨下限, 420分）
  ctx.strokeStyle = COL.marker; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
  const ty = sy(420);
  ctx.beginPath(); ctx.moveTo(padL, ty); ctx.lineTo(w - padR, ty); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COL.marker; ctx.textAlign = 'left'; ctx.font = '9px system-ui';
  ctx.fillText('7時間', padL + 2, ty - 3);

  bars.forEach((b, i) => {
    const cx = padL + gap * (i + 0.5);
    const bh = b.min ? (plotH - (sy(b.min) - padT)) : 0;
    ctx.fillStyle = (b.min && b.min < 420) ? COL.barLow : COL.bar;
    ctx.beginPath();
    const x = cx - bw / 2, y = sy(b.min || 0);
    const r = 4;
    ctx.moveTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.arcTo(x + bw, y, x + bw, y + r, r);
    ctx.lineTo(x + bw, padT + plotH);
    ctx.lineTo(x, padT + plotH);
    ctx.closePath(); ctx.fill();
    // label
    ctx.fillStyle = COL.text; ctx.textAlign = 'center'; ctx.font = '9px system-ui';
    ctx.fillText(b.label, cx, h - 6);
  });
}

/* 睡眠ラスター図: 各行=1日(正午→翌正午), 横=時刻, 睡眠帯を塗る。
 * 時間生物学の定番可視化。記録から直接描くだけ(加工・推定なし)。*/
function drawRaster(canvas, records, days) {
  days = days || 21;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 340;
  const cutoff = Date.now() - days * 86400000;
  const rows = {};
  for (const r of records) {
    const b = new Date(r.bed), wk = new Date(r.wake);
    if (isNaN(b) || isNaN(wk) || wk <= b) continue;
    if (wk.getTime() < cutoff) continue;
    const origin = new Date(b);
    if (origin.getHours() < 12) origin.setDate(origin.getDate() - 1);
    origin.setHours(12, 0, 0, 0);
    const key = origin.getTime();
    const s = Math.max(0, (b - origin) / 60000), e = Math.min(1440, (wk - origin) / 60000);
    (rows[key] = rows[key] || { bars: [] }).bars.push({ s, e, nap: r.kind === 'nap' });
  }
  const keys = Object.keys(rows).map(Number).sort((a, b) => b - a);
  const rowH = 14, padT = 16, padB = 6, padL = 40, padR = 8;
  const n = Math.max(keys.length, 1);
  const H = padT + padB + n * rowH;
  canvas.width = w * dpr; canvas.height = H * dpr; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const plotW = w - padL - padR;
  const X = m => padL + m / 1440 * plotW;

  ctx.font = '9px system-ui'; ctx.textAlign = 'center';
  [[0, '12'], [360, '18'], [720, '0'], [1080, '6'], [1440, '12']].forEach(([m, lb]) => {
    ctx.strokeStyle = 'rgba(148,163,184,0.13)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(m), padT); ctx.lineTo(X(m), padT + n * rowH); ctx.stroke();
    ctx.fillStyle = 'rgba(226,232,240,0.5)'; ctx.fillText(lb, X(m), 11);
  });
  if (!keys.length) {
    ctx.fillStyle = 'rgba(226,232,240,0.5)'; ctx.font = '12px system-ui';
    ctx.fillText('記録がありません', w / 2, padT + 16); return;
  }
  keys.forEach((k, i) => {
    const y = padT + i * rowH, d = new Date(k);
    ctx.fillStyle = 'rgba(226,232,240,0.45)'; ctx.textAlign = 'right'; ctx.font = '9px system-ui';
    ctx.fillText((d.getMonth() + 1) + '/' + d.getDate(), padL - 4, y + rowH - 3);
    rows[k].bars.forEach(bar => {
      ctx.fillStyle = bar.nap ? '#fbbf24' : '#818cf8';  // 仮眠は黄色
      ctx.fillRect(X(bar.s), y + 1, Math.max(1, X(bar.e) - X(bar.s)), rowH - 3);
    });
  });
}

window.Charts = { drawDuration, drawForecast, drawRaster };
