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
    if (tab === 'trend') renderTrends();
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
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  function dateLabel(s) {
    const d = S.toDate(s);
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 1夜を見やすく整形: 「6/18(水) の睡眠 / 🌙23:00 → ☀06:30(翌) / 7時間30分」
  function nightLabel(rec) {
    const b = S.toDate(rec.bed), w = S.toDate(rec.wake);
    const nextDay = w.getDate() !== b.getDate() || w.getMonth() !== b.getMonth();
    return {
      head: `${w.getMonth() + 1}/${w.getDate()}(${WD[w.getDay()]}) の睡眠`,
      span: `🌙 ${hm(b)} → ☀️ ${nextDay ? '翌' : ''}${hm(w)}`,
    };
  }

  /* ---------- ホーム ---------- */
  function renderHome() {
    const records = Store.loadRecords();
    const settings = Store.loadSettings();
    const d = S.computeDashboard(records, settings);

    // 推奨就床（負債に応じて適応）
    const rec = d.recommendation;
    $('#recBedtime').textContent = S.fmtHM(d.recommendedBedtimeMin);
    if (rec.inDebt) {
      $('#recBedtimeSub').textContent =
        `起床 ${settings.targetWake} 固定・睡眠負債のため目標より ${S.fmtDur(rec.advanceMin)} 早め（約${S.fmtDur(rec.recDurMin)}）`;
    } else {
      $('#recBedtimeSub').textContent =
        `起床 ${settings.targetWake} 固定 / ${S.fmtDur(settings.targetMin)} 睡眠 から逆算（負債ほぼ無し）`;
    }

    // 回復プラン（負債がある時だけ表示）
    const rc = $('#recoveryCard');
    if (rec.inDebt) {
      rc.hidden = false;
      const parts = [];
      parts.push(`<div class="card-title">😴 回復プラン</div>`);
      parts.push(`<p class="small">直近14日の睡眠負債は <strong>${S.fmtDur(rec.debtMin)}</strong>。1晩では返せないので、<strong>起床時刻は ${settings.targetWake} のまま固定</strong>し、就床を <strong>${S.fmtHM(d.recommendedBedtimeMin)}</strong>（目標より${S.fmtDur(rec.advanceMin)}早め）にして少しずつ返します。`);
      if (rec.nightsToRecover > 1) parts.push(`<p class="small muted">この前倒しを続けた場合、解消の目安は<strong>あと約${rec.nightsToRecover}晩</strong>です（実際は体調次第。無理のない範囲で）。</p>`);
      if (rec.muchEarlierThanUsual) parts.push(`<p class="small" style="color:var(--warn)">⚠️ 普段の就床よりかなり早い提案です。就床直前は体内時計の影響で寝つきにくい時間帯（WMZ）に当たることがあるので、眠れなければ無理せず。徐々に前倒しでOKです。</p>`);
      parts.push(`<p class="muted small">根拠: 起床固定＝規則性重視 / 多晩で回復(<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC2910531/" target="_blank" rel="noopener">Banks 2010</a>, <a href="https://www.cell.com/current-biology/fulltext/S0960-9822(19)30098-3" target="_blank" rel="noopener">Depner 2019</a>) / 9時間を超えない(U字)。前倒しの上限45分は保守的な実務目安です。</p>`);
      $('#recoveryBody').innerHTML = parts.join('');
    } else {
      rc.hidden = true;
    }

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

    updateDurPreview();

    // 一覧（1夜ずつ、起床日を見出しにして日付またぎを「翌」で表現）
    const records = Store.loadRecords().sort((a, b) => S.toDate(b.wake) - S.toDate(a.wake));
    const list = $('#recordList');
    if (!records.length) {
      list.innerHTML = '<p class="muted small">まだ記録がありません。</p>';
      return;
    }
    list.innerHTML = records.map(r => {
      const dur = S.durationMin(r);
      const nl = nightLabel(r);
      const short = dur != null && dur < S.AASM_MIN; // 7時間未満を控えめに示す
      return `<div class="recitem">
        <div class="rleft">
          <div class="rhead">${nl.head}</div>
          <div class="rspan">${nl.span}${r.note ? ' ・ ' + escapeHtml(r.note) : ''}</div>
        </div>
        <div class="rright">
          <span class="rdur${short ? ' low' : ''}">${dur == null ? '?' : S.fmtDur(dur)}</span>
          <button class="iconbtn" data-edit="${r.id}" aria-label="編集">✎</button>
          <button class="iconbtn del" data-del="${r.id}" aria-label="削除">×</button>
        </div>
      </div>`;
    }).join('');
    $$('#recordList [data-del]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('この記録を削除しますか？')) return;
      Store.deleteRecord(b.dataset.del); renderLog(); toast('削除しました');
    }));
    $$('#recordList [data-edit]').forEach(b => b.addEventListener('click', () => startEdit(b.dataset.edit)));
  }

  /* ---------- 入力中の睡眠時間プレビュー & 編集 ---------- */
  function updateDurPreview() {
    const bed = $('#inBed').value, wake = $('#inWake').value;
    const el = $('#durPreview');
    if (!bed || !wake) { el.textContent = ''; el.className = 'durpreview'; return; }
    const mins = (S.toDate(wake) - S.toDate(bed)) / 60000;
    if (mins <= 0) { el.textContent = '⚠️ 起床は就床より後にしてください'; el.className = 'durpreview warn'; return; }
    el.textContent = `この記録の睡眠時間: ${S.fmtDur(Math.round(mins))}`;
    el.className = 'durpreview' + (mins < S.AASM_MIN ? ' low' : '');
  }
  $('#inBed').addEventListener('input', updateDurPreview);
  $('#inWake').addEventListener('input', updateDurPreview);

  let editingId = null;
  function startEdit(id) {
    const r = Store.loadRecords().find(x => x.id === id);
    if (!r) return;
    editingId = id;
    $('#inBed').value = r.bed; $('#inWake').value = r.wake; $('#inNote').value = r.note || '';
    $('#formTitle').textContent = '記録を編集';
    $('#btnAdd').textContent = '更新する';
    $('#btnCancelEdit').hidden = false;
    updateDurPreview();
    $('#inBed').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function endEdit() {
    editingId = null;
    $('#formTitle').textContent = '手入力で追加';
    $('#btnAdd').textContent = '記録を追加';
    $('#btnCancelEdit').hidden = true;
    $('#inNote').value = '';
  }
  $('#btnCancelEdit').addEventListener('click', () => { endEdit(); renderLog(); });

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
    const note = $('#inNote').value.trim();
    if (editingId) {
      Store.updateRecord(editingId, { bed, wake, note });
      endEdit(); toast('更新しました');
    } else {
      Store.addRecord({ bed, wake, note, source: 'manual' });
      $('#inNote').value = '';
      toast('記録を追加しました');
    }
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

  /* ---------- 傾向（実データの集計） ---------- */
  function renderTrends() {
    const records = Store.loadRecords();
    const settings = Store.loadSettings();

    // 基本統計
    const st = S.personalStats(records, 14);
    if (!st) {
      $('#statsBody').innerHTML = '<p class="muted small">記録がまだありません。数日分つけると傾向が出ます。</p>';
    } else {
      $('#statsBody').innerHTML = `
        <div class="statgrid">
          <div><div class="statk">平均就床</div><div class="statv">${S.fmtHM(st.avgBed)}</div></div>
          <div><div class="statk">平均起床</div><div class="statv">${S.fmtHM(st.avgWake)}</div></div>
          <div><div class="statk">平均睡眠</div><div class="statv">${S.fmtDur(st.avgDur)}</div></div>
          <div><div class="statk">睡眠中央</div><div class="statv">${S.fmtHM(st.avgMid)}</div></div>
        </div>
        <p class="muted small">直近 ${st.nights} 夜の平均（時刻は深夜またぎを考慮した円周平均）。睡眠時間は最短 ${S.fmtDur(st.minDur)}〜最長 ${S.fmtDur(st.maxDur)}。</p>`;
    }

    // クロノタイプ（MSFsc）
    const ch = S.chronotypeMSFsc(records);
    if (!ch) {
      $('#chronoBody').innerHTML = '<p class="muted small">休日（土日）と平日の両方の記録が貯まると、あなたの朝型/夜型の目安を計算できます。</p>';
    } else {
      $('#chronoBody').innerHTML = `
        <div class="bigstat">睡眠の中央時刻（補正後）<strong>${S.fmtHM(ch.msfscMin)}</strong></div>
        <p class="muted small">MCTQ の MSFsc（休日の睡眠中央時刻を睡眠負債で補正した、朝型/夜型の標準的な目安）。<strong>早いほど朝型寄り、遅いほど夜型寄り</strong>です。出典: <a href="https://www.thewep.org/documentations/mctq" target="_blank" rel="noopener">MCTQ (Roenneberg)</a><br>※入眠時刻の代わりに就床時刻を使う簡易計算で、やや早めに出ます。土日=休日とみなしています（休日${ch.freeNights}夜/平日${ch.workNights}夜）。目安としてご利用ください。</p>`;
    }

    // 最近の変化（直近7日 vs その前7日）
    const tr = S.durationTrend(records);
    if (!tr) {
      $('#trendBody').innerHTML = '<p class="muted small">直近7日の記録が必要です。</p>';
    } else if (tr.deltaMin == null) {
      $('#trendBody').innerHTML = `<p class="small">直近7日の平均睡眠: <strong>${S.fmtDur(tr.current)}</strong>（前週との比較は記録が貯まると表示）</p>`;
    } else {
      const sign = tr.deltaMin > 0 ? '＋' : tr.deltaMin < 0 ? '−' : '±';
      const arrow = tr.deltaMin > 0 ? '📈' : tr.deltaMin < 0 ? '📉' : '➡️';
      $('#trendBody').innerHTML = `<p class="small">直近7日の平均睡眠 <strong>${S.fmtDur(tr.current)}</strong> ${arrow} 前週（${S.fmtDur(tr.previous)}）より ${sign}${S.fmtDur(Math.abs(tr.deltaMin))}</p>`;
    }

    // 気づき（記録から事実のみ。出典のある閾値だけ使う）
    const ins = [];
    if (st) {
      if (st.avgDur < S.AASM_MIN) ins.push(`直近の平均睡眠は ${S.fmtDur(st.avgDur)} で、7時間（AASM/CDCの推奨下限）を下回っています。`);
      else ins.push(`直近の平均睡眠は ${S.fmtDur(st.avgDur)} で、7時間以上を満たしています。`);
    }
    const sjl = S.socialJetlag(records);
    if (sjl != null) ins.push(`平日と休日の睡眠中央時刻のズレ（ソーシャル時差ぼけ）は ${S.fmtDur(sjl)} です。`);
    const sri = S.sleepRegularityIndex(records);
    if (sri != null) ins.push(`規則性スコア（自己申告の近似）は ${Math.round(sri)} です（高いほど規則的）。`);
    const debt = S.sleepDebt(records, settings.targetMin);
    if (debt.nights) ins.push(`直近14日で、目標 ${S.fmtDur(settings.targetMin)} に対する不足の累積は ${S.fmtDur(debt.debtMin)} です。`);
    $('#insightBody').innerHTML = ins.length
      ? '<ul class="insights">' + ins.map(t => `<li>${t}</li>`).join('') + '</ul>'
      : '<p class="muted small">記録が貯まると、事実ベースの気づきを表示します。</p>';
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
    rec: '今夜の推奨就床は、目標から逆算した時刻を基準に、積み上がった睡眠負債に応じて自動で前倒しします。科学的根拠: ①起床時刻は固定が最善(規則性が最重要。寝だめ=起床を遅らせるのは社会的時差ぼけを悪化させる)ので就床だけ早める ②負債は1晩で返せず数晩かけて回復(Banks 2010 / Depner 2019) ③総睡眠9時間は超えない(U字カーブ)。前倒しの上限45分は、就床直前の覚醒帯(WMZ)で寝つけない制約と「多晩で回復」に基づく保守的な実務目安です(検証された精密な処方ではありません)。',
    trend: 'この画面は、あなたが入力した記録そのものの集計（記述統計）です。AIによる予測や、根拠のないスコアは一切含みません。時刻の平均は、深夜をまたぐ時刻を正しく扱うため円周平均で計算しています。',
    chrono: 'あなたの休日の睡眠中央時刻から、朝型/夜型の標準的な目安(MCTQのMSFsc)を計算したものです。本来は入眠時刻を使いますが、就床時刻で代用しているためやや早めに出ます。土日を休日とみなす簡易計算で、少数の記録では不安定です。診断ではなく目安です。',
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
