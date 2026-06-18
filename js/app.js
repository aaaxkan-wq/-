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

    // 規則性（恣意的な閾値・色分けはしない。生の値と中立的な注記のみ）
    const rv = $('#regValue');
    if (d.sri == null) {
      rv.textContent = '—'; rv.className = 'metric-value';
      $('#regNote').textContent = `連続2日分の記録が必要（現在 ${d.nights}夜）`;
    } else {
      rv.textContent = Math.round(d.sri);
      rv.className = 'metric-value';
      $('#regNote').textContent = '高いほど規則的（-100〜100, 自己申告の近似）';
    }

    // 睡眠負債（色分けは7時間=AASM基準のみ。平均が7h未満なら注意色）
    const dv = $('#debtValue');
    if (!d.debt.nights) {
      dv.textContent = '—'; dv.className = 'metric-value';
      $('#debtNote').textContent = '記録がありません';
    } else {
      dv.textContent = S.fmtDur(d.debt.debtMin);
      dv.className = 'metric-value ' + (d.debt.avgMin < S.AASM_MIN ? 'bad' : '');
      $('#debtNote').textContent = `目標との不足の累積 ・ 平均 ${S.fmtDur(d.debt.avgMin)}/夜`;
    }

    // 昨夜（色分けは7時間=AASM/CDCの推奨下限のみ）
    const lv = $('#lastValue');
    if (d.lastDuration != null) {
      lv.textContent = S.fmtDur(d.lastDuration);
      lv.className = 'metric-value ' + (d.lastDuration < S.AASM_MIN ? 'bad' : '');
      $('#lastNote').textContent = dateLabel(d.last.bed) + ' →';
    } else {
      lv.textContent = '—'; $('#lastNote').textContent = '記録がありません';
    }

    // social jetlag（恣意的な閾値・色分けはしない。値と出典文脈のみ）
    const sv = $('#sjlValue');
    if (d.socialJetlagMin == null) {
      sv.textContent = '—'; sv.className = 'metric-value';
      $('#sjlNote').textContent = '平日と休日の記録が必要';
    } else {
      sv.textContent = S.fmtDur(d.socialJetlagMin);
      sv.className = 'metric-value';
      $('#sjlNote').textContent = '平日と休日の睡眠中央時刻のズレ';
    }

    // 体内時計の目安となる時間帯（集団平均・出典あり）
    $('#hintAfternoon').innerHTML =
      `😴 <strong>${S.fmtHM(d.hints.afternoon.start)}〜${S.fmtHM(d.hints.afternoon.end)}</strong> 頃：午後に眠気が出やすい時間帯（起床の6〜8時間後）`;
    $('#hintWmz').innerHTML =
      `🛋️ <strong>${S.fmtHM(d.hints.wmz.start)}〜${S.fmtHM(d.hints.wmz.end)}</strong> 頃：体内時計の影響で寝つきにくい時間帯（就床の1〜3時間前）`;

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
    // 午後の眠気帯は集団平均の範囲(起床+6〜8h)。その開始時刻を仮眠の目安に使う。
    const dipMin = d.hints.afternoon.start;

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
    regularity: '睡眠の「規則性」の近似指標(-100〜100, 高いほど規則的)。本来のSRIは加速度計の連続データから計算しますが、本アプリは自己申告の就床/起床時刻から近似するため、公表されているSRI値とは直接比較できません。良い/悪いの標準的な閾値は存在しないため区切りや色分けはせず、自分の推移を追う用途で使ってください。大規模研究では規則性は睡眠時間より死亡率を強く予測したと報告されています(UK Biobank)。',
    debt: '直近14日の「あなたの目標睡眠時間 − 実際の睡眠時間」の不足分の累積です(生理的な睡眠負債そのものの測定ではありません)。不足のみを足し、寝だめでの相殺はしません(週末の回復では完全に返せないとの研究に基づく)。色は平均が7時間=AASM/CDCの推奨下限を下回る場合のみ表示します。',
    sjl: '平日と休日の睡眠中央時刻のズレ(ソーシャル時差ぼけ, Roenneberg 2012)。土日を休日とみなす簡易計算です。大きいほど肥満・抑うつ・代謝リスクとの関連が報告されていますが、明確な良い/悪いの境界はないため色分けはしません。',
    hints: 'あなたの記録から計算した個人予測ではありません。「午後の眠気は起床の6〜8時間後」「体内時計の影響で就床の1〜3時間前は寝つきにくい」という集団平均の知見(Sleep Foundation / PMC6054682)を、あなたの起床・就床時刻に当てはめて時間帯を表示しているだけです。個人差があります。',
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
