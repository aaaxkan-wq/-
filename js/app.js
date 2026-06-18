/* app.js — UIコントローラ */
(function () {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);
  const S = window.Science, Store = window.Store, Charts = window.Charts;

  const PENDING_KEY = 'sleeplog.pendingBed.v1';

  /* ---------- タブ切替 ---------- */
  function go(tab) {
    $$('.tab').forEach(s => s.hidden = s.dataset.tab !== tab);
    $$('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.go === tab));
    if (tab === 'home') renderHome();
    if (tab === 'log') renderLog();
    if (tab === 'plan') renderPlan();
    if (tab === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  $$('.tabbtn').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.hidden = true, 2200);
  }

  /* ---------- datetime helpers ---------- */
  function localDTString(d) {
    // 'YYYY-MM-DDTHH:MM' (ローカル)
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function dateLabel(s) {
    const d = S.toDate(s);
    const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    return `${d.getMonth() + 1}/${d.getDate()}(${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ---------- ホーム ---------- */
  function renderHome() {
    const records = Store.loadRecords();
    const settings = Store.loadSettings();
    const d = S.computeDashboard(records, settings);

    // 推奨就床
    $('#recBedtime').textContent = S.fmtHM(d.recommendedBedtimeMin);
    $('#recBedtimeSub').textContent =
      `目標 ${settings.targetWake} 起床 / ${S.fmtDur(settings.targetMin)} 睡眠 から逆算`;

    // 規則性
    const rv = $('#regValue');
    if (d.sri == null) {
      rv.textContent = '—'; rv.className = 'metric-value';
      $('#regNote').textContent = `記録 ${d.nights}/2日`;
    } else {
      rv.textContent = Math.round(d.sri);
      rv.className = 'metric-value ' + (d.regularity.tone === 'good' ? 'good' : d.regularity.tone === 'warn' ? 'warn' : 'bad');
      $('#regNote').textContent = d.regularity.label + '（-100〜100）';
    }

    // 睡眠負債
    const dv = $('#debtValue');
    if (!d.debt.nights) {
      dv.textContent = '—'; dv.className = 'metric-value';
      $('#debtNote').textContent = '記録がありません';
    } else {
      dv.textContent = S.fmtDur(d.debt.debtMin);
      dv.className = 'metric-value ' + (d.debt.debtMin >= 300 ? 'bad' : d.debt.debtMin >= 120 ? 'warn' : 'good');
      $('#debtNote').textContent = `平均 ${S.fmtDur(d.debt.avgMin)}/夜 ・ ${d.debt.nights}夜`;
    }

    // 昨夜
    const lv = $('#lastValue');
    if (d.lastDuration != null) {
      lv.textContent = S.fmtDur(d.lastDuration);
      lv.className = 'metric-value ' + (d.lastDuration < 420 ? 'bad' : d.lastDuration < settings.targetMin ? 'warn' : 'good');
      $('#lastNote').textContent = dateLabel(d.last.bed) + ' →';
    } else {
      lv.textContent = '—'; $('#lastNote').textContent = '記録がありません';
    }

    // social jetlag
    const sv = $('#sjlValue');
    if (d.socialJetlagMin == null) {
      sv.textContent = '—'; sv.className = 'metric-value';
    } else {
      sv.textContent = S.fmtDur(d.socialJetlagMin);
      sv.className = 'metric-value ' + (d.socialJetlagMin >= 120 ? 'bad' : d.socialJetlagMin >= 60 ? 'warn' : 'good');
    }

    // 眠気カーブ
    const markers = [];
    if (d.curve.afternoonDip) markers.push({ hsw: d.curve.afternoonDip.hoursSinceWake, color: '#f59e0b' });
    Charts.drawSleepiness($('#sleepinessChart'), d.curve, markers);
    const legend = [];
    if (d.curve.afternoonDip)
      legend.push(`<span><span class="dot" style="background:#f59e0b"></span>午後の眠気 ${S.fmtHM(d.curve.afternoonDip.h * 60)}頃</span>`);
    if (d.curve.alertPeak)
      legend.push(`<span><span class="dot" style="background:#34d399"></span>集中しやすい ${S.fmtHM(d.curve.alertPeak.h * 60)}頃</span>`);
    legend.push(`<span><span class="dot" style="background:#818cf8"></span>寝つきにくい ${S.fmtHM(d.curve.wmz.start * 60)}〜${S.fmtHM(d.curve.wmz.end * 60)}</span>`);
    $('#curveLegend').innerHTML = legend.join('');

    // 睡眠時間推移
    const recent = S.recordsWithin(records, 14);
    const bars = recent.map(r => {
      const w = S.toDate(r.wake);
      return { label: `${w.getMonth() + 1}/${w.getDate()}`, min: S.durationMin(r) };
    });
    Charts.drawDuration($('#durationChart'), bars, settings.targetMin);
  }

  /* ---------- 記録 ---------- */
  function renderLog() {
    // クイックボタンの状態
    const pending = localStorage.getItem(PENDING_KEY);
    $('#btnSleepNow').textContent = pending ? '🌙 就床中…(取消)' : '🌙 今から寝る';
    $('#quickHint').textContent = pending
      ? `${dateLabel(pending)} に就床。起きたら「今起きた」を押してください。`
      : '「今から寝る」を押すと就床時刻を記録、起きたら「今起きた」で完了します。';

    // フォーム初期値
    if (!$('#inWake').value) {
      const now = new Date();
      const bed = new Date(now.getTime() - 7.5 * 3600000);
      $('#inBed').value = localDTString(bed);
      $('#inWake').value = localDTString(now);
    }

    // 一覧
    const records = Store.loadRecords().sort((a, b) => S.toDate(b.wake) - S.toDate(a.wake));
    const list = $('#recordList');
    if (!records.length) {
      list.innerHTML = '<p class="muted small">まだ記録がありません。</p>';
      return;
    }
    list.innerHTML = records.map(r => {
      const dur = S.durationMin(r);
      return `<div class="recitem">
        <div>
          <div class="rmain">${dateLabel(r.bed)} → ${dateLabel(r.wake).split(' ')[1]}</div>
          <div class="rsub">${r.note ? escapeHtml(r.note) : ''}${r.source === 'watch' ? ' ⌚' : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="rdur">${dur == null ? '?' : S.fmtDur(dur)}</span>
          <button class="del" data-del="${r.id}">×</button>
        </div>
      </div>`;
    }).join('');
    $$('#recordList .del').forEach(b => b.addEventListener('click', () => {
      Store.deleteRecord(b.dataset.del); renderLog(); toast('削除しました');
    }));
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  $('#btnSleepNow').addEventListener('click', () => {
    const pending = localStorage.getItem(PENDING_KEY);
    if (pending) { localStorage.removeItem(PENDING_KEY); toast('就床記録を取り消しました'); }
    else { localStorage.setItem(PENDING_KEY, localDTString(new Date())); toast('就床時刻を記録しました'); }
    renderLog();
  });

  $('#btnWakeNow').addEventListener('click', () => {
    const pending = localStorage.getItem(PENDING_KEY);
    if (!pending) { toast('先に「今から寝る」を押してください'); return; }
    Store.addRecord({ bed: pending, wake: localDTString(new Date()), note: '', source: 'manual' });
    localStorage.removeItem(PENDING_KEY);
    toast('おはようございます！記録しました');
    renderLog();
  });

  $('#btnAdd').addEventListener('click', () => {
    const bed = $('#inBed').value, wake = $('#inWake').value;
    if (!bed || !wake) { toast('就床・起床日時を入力してください'); return; }
    if (S.toDate(wake) <= S.toDate(bed)) { toast('起床は就床より後にしてください'); return; }
    Store.addRecord({ bed, wake, note: $('#inNote').value.trim(), source: 'manual' });
    $('#inNote').value = '';
    toast('記録を追加しました');
    renderLog();
  });

  /* ---------- 行動タイムライン ---------- */
  function renderPlan() {
    const settings = Store.loadSettings();
    const records = Store.loadRecords();
    const d = S.computeDashboard(records, settings);
    const bedMin = d.recommendedBedtimeMin;
    const wakeMin = S.parseHM(settings.targetWake);
    const dipMin = d.curve.afternoonDip ? Math.round(d.curve.afternoonDip.h * 60) : null;

    $('#planBed').textContent = S.fmtHM(bedMin);
    $('#planWake').textContent = settings.targetWake;

    const items = window.Timeline.buildTimeline(bedMin, wakeMin, dipMin);
    $('#timeline').innerHTML = items.map(it => `
      <div class="tl-item">
        <div class="tl-time">${S.fmtHM(it.time)}</div>
        <div class="tl-body">
          <div class="tl-title">${it.icon} ${escapeHtml(it.title)}
            <span class="tag ${it.kind}">${it.kind === 'do' ? '推奨' : it.kind === 'avoid' ? '避ける' : 'ヒント'}</span></div>
          <div class="tl-detail">${escapeHtml(it.detail)}</div>
          <div class="tl-src">出典: <a href="${it.src.url}" target="_blank" rel="noopener">${escapeHtml(it.src.label)}</a></div>
        </div>
      </div>`).join('');
  }

  /* ---------- 設定 ---------- */
  function renderSettings() {
    const s = Store.loadSettings();
    $('#setWake').value = s.targetWake;
    $('#setDur').value = String(s.targetMin);
    $('#setOnset').value = String(s.onsetMin);
  }
  $('#btnSaveSettings').addEventListener('click', () => {
    const s = Store.loadSettings();
    s.targetWake = $('#setWake').value || '06:30';
    s.targetMin = parseInt($('#setDur').value);
    s.onsetMin = parseInt($('#setOnset').value);
    Store.saveSettings(s);
    toast('保存しました');
  });

  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `nemurilog-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast('バックアップを書き出しました');
  });
  $('#fileImport').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { Store.importJSON(reader.result); toast('読み込みました'); go('home'); }
      catch (err) { toast('ファイルが読めませんでした'); }
    };
    reader.readAsText(f);
  });
  $('#btnClear').addEventListener('click', () => {
    if (confirm('すべての記録と設定を削除します。よろしいですか？')) {
      localStorage.removeItem('sleeplog.records.v1');
      localStorage.removeItem('sleeplog.settings.v1');
      localStorage.removeItem(PENDING_KEY);
      toast('削除しました'); go('home');
    }
  });

  /* ---------- info ポップ ---------- */
  const INFO = {
    regularity: '睡眠の「規則性」。毎日同じ時刻に寝起きできているかの指標(SRI近似, -100〜100)。大規模研究では規則性は睡眠時間より死亡率を強く予測しました。※自己申告の就床/起床時刻から近似計算しており、本来のSRI(加速度計ベース)より精度は劣ります。「とても規則的/不規則」の区切りは本アプリの目安(標準化された基準ではありません)。まずは「最も不規則な層から抜ける」のが目標。',
    debt: '直近14日の「目標−実績」の累積不足。睡眠負債は自覚しにくく、週末の寝だめでは完全には返せません。',
    sjl: '平日と休日の睡眠中央時刻のズレ(ソーシャル時差ぼけ)。大きいほど肥満・抑うつ・代謝リスクと関連。1時間未満が理想。',
    curve: 'これは集団平均に基づく「概念図」です。あなたの記録から個別計算したものではなく、起床+約7hに午後の眠気、就床1〜3h前に寝つきにくい帯(体内時計)が来るという文献の経験則を、あなたの起床・就床時刻に当てはめて描いています。高さは相対表示で絶対的な眠気量ではありません。',
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('.info');
    if (b) toast(INFO[b.dataset.info] || '');
  });

  /* ---------- 初期化 ---------- */
  const now = new Date();
  $('#todayLabel').textContent =
    `${now.getMonth() + 1}月${now.getDate()}日`;
  go('home');

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
