/*
 * charts.js — 依存ゼロの軽量キャンバス描画
 * 眠気カーブ（折れ線）と睡眠時間推移（棒）を描く。Retina対応。
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
};

/* 眠気カーブ: points=[{h(clock 0-24), sleepiness 0-100}], markers=[{h,label,color}] */
function drawSleepiness(canvas, curve, markers) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const padL = 8, padR = 8, padT = 16, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const pts = curve.points;
  const x0 = pts[0].hoursSinceWake, x1 = pts[pts.length - 1].hoursSinceWake;
  const sx = hsw => padL + ((hsw - x0) / (x1 - x0)) * plotW;
  const sy = v => padT + (1 - v / 100) * plotH;

  // grid (横線 25/50/75)
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.font = '10px system-ui';
  [0, 25, 50, 75, 100].forEach(v => {
    const y = sy(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  });

  // x軸目盛り: 3hごとのクロック時
  ctx.fillStyle = COL.text; ctx.textAlign = 'center';
  for (let hsw = 0; hsw <= 24; hsw += 6) {
    const clock = (pts[0].h + hsw) % 24;
    const x = sx(hsw);
    ctx.fillText(String(Math.round(clock)).padStart(2, '0'), x, h - 6);
  }

  // markers (縦線)
  (markers || []).forEach(m => {
    const x = sx(m.hsw);
    ctx.strokeStyle = m.color || COL.marker; ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
  });

  // area fill
  ctx.beginPath();
  ctx.moveTo(sx(pts[0].hoursSinceWake), sy(0));
  pts.forEach(p => ctx.lineTo(sx(p.hoursSinceWake), sy(p.sleepiness)));
  ctx.lineTo(sx(pts[pts.length - 1].hoursSinceWake), sy(0));
  ctx.closePath(); ctx.fillStyle = COL.fill; ctx.fill();

  // line
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = sx(p.hoursSinceWake), y = sy(p.sleepiness);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = COL.line; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
}

/* 睡眠時間の棒グラフ: bars=[{label, min, target}] */
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

  // 目標ライン
  ctx.strokeStyle = COL.marker; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
  const ty = sy(targetMin);
  ctx.beginPath(); ctx.moveTo(padL, ty); ctx.lineTo(w - padR, ty); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COL.marker; ctx.textAlign = 'left'; ctx.font = '9px system-ui';
  ctx.fillText('目標', padL + 2, ty - 3);

  bars.forEach((b, i) => {
    const cx = padL + gap * (i + 0.5);
    const bh = b.min ? (plotH - (sy(b.min) - padT)) : 0;
    ctx.fillStyle = (b.min && b.min < targetMin * 0.85) ? COL.barLow : COL.bar;
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

window.Charts = { drawSleepiness, drawDuration };
