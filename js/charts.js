/*
 * charts.js — 依存ゼロの軽量キャンバス描画
 * 眠気予測（二プロセスモデル）と睡眠時間推移（棒）を描く。Retina対応。
 */

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth || 320;
  const h = parseInt(canvas.getAttribute('height')) || 180;
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

/* 眠気予測カーブ（二プロセスモデル）。fc = sleepinessForecast の戻り値 */
function drawForecast(canvas, fc) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!fc || !fc.pts || !fc.pts.length) return;
  const padL = 6, padR = 6, padT = 16, padB = 20;
  const cw = w - padL - padR, ch = h - padT - padB;
  const pts = fc.pts;
  const cx = t => padL + (t / 24) * cw;
  const cy = v => padT + ch - (v / 100) * ch;

  // grid（横）
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  [0, 25, 50, 75, 100].forEach(v => { ctx.beginPath(); ctx.moveTo(padL, cy(v)); ctx.lineTo(w - padR, cy(v)); ctx.stroke(); });
  ctx.setLineDash([]);

  // x軸: 起床からの経過に対応する時計時刻
  ctx.fillStyle = COL.text; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
  for (let t = 0; t <= 24; t += 4) {
    const clock = (fc.wH + t) % 24;
    ctx.fillText(String(Math.round(clock)).padStart(2, '0'), cx(t), h - 5);
  }

  // 縦線ヘルパ
  const vline = (t, color, label) => {
    if (t == null) return;
    const x = cx(((t) + 24) % 24);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
    ctx.setLineDash([]);
    if (label) { ctx.fillStyle = color; ctx.font = '8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(label, x, padT - 5); }
  };
  // 睡眠ゲート（自然に眠くなる夜の時刻）
  if (fc.gate) vline(fc.gate.t, 'rgba(96,165,250,0.6)', '眠くなる');

  // 睡眠圧 S（破線）
  ctx.strokeStyle = COL.pressure; ctx.lineWidth = 1.3; ctx.setLineDash([5, 3]);
  ctx.beginPath(); pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.pressure); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  // 概日（破線）
  ctx.strokeStyle = COL.circ; ctx.setLineDash([2, 4]);
  ctx.beginPath(); pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.circ); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  ctx.setLineDash([]);

  // 眠気スコア（塗り＋線）
  const grad = ctx.createLinearGradient(0, cy(100), 0, cy(0));
  grad.addColorStop(0, 'rgba(248,113,113,0.30)'); grad.addColorStop(1, 'rgba(248,113,113,0.02)');
  ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(cx(pts[0].t), cy(0));
  pts.forEach(p => ctx.lineTo(cx(p.t), cy(p.score)));
  ctx.lineTo(cx(pts[pts.length - 1].t), cy(0)); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = COL.sleep; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
  ctx.beginPath(); pts.forEach((p, i) => { const x = cx(p.t), y = cy(p.score); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();

  // 現在時刻マーカー
  const ex = Math.max(0, Math.min(24, fc.elapsed));
  ctx.strokeStyle = COL.marker; ctx.lineWidth = 2; ctx.setLineDash([3, 2]);
  ctx.beginPath(); ctx.moveTo(cx(ex), padT); ctx.lineTo(cx(ex), padT + ch); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = COL.marker; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('今', cx(ex), padT - 5);
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

window.Charts = { drawDuration, drawForecast };
