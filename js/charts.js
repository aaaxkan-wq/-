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

window.Charts = { drawDuration };
