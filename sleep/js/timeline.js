/*
 * timeline.js — 就床/起床時刻を基準にした「推奨行動タイムライン」
 *
 * 各項目はエビデンスに基づき、就床(bed)・起床(wake)からの相対時刻で生成する。
 * 出典は src フィールドに短縮表記で持たせ、UIで参照できるようにする。
 */

// 出典マスター
const SOURCES = {
  caffeine: { label: 'Drake 2013 (JCSM)', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3805807/' },
  meal: { label: 'AJMC / Sleep Foundation', url: 'https://www.sleepfoundation.org/nutrition/is-it-bad-to-eat-before-bed' },
  alcohol: { label: 'Sleep hygiene review', url: 'https://www.simplypsychology.com/articles/sleep-hygiene-guide' },
  exercise: { label: '高強度運動メタ解析 / Harvard', url: 'https://www.health.harvard.edu/staying-healthy/does-exercising-at-night-affect-sleep' },
  light_morning: { label: '光と概日リズム (PMC3841985)', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3841985/' },
  light_evening: { label: '睡眠衛生エビデンス', url: 'https://reachlink.com/advice/sleep-disorders/sleep-hygiene-evidence-based-habits-that-actually-work/' },
  nap: { label: 'Coffee nap (Sleep Foundation)', url: 'https://www.sleepfoundation.org/sleep-hygiene/coffee-nap' },
  wmz: { label: 'WMZ (PMC6054682)', url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6054682/' },
  env: { label: 'CDC/NIOSH', url: 'https://www.cdc.gov/niosh/bulletin/2020/sleep.html' },
  debt: { label: 'Van Dongen 2003', url: 'https://pubmed.ncbi.nlm.nih.gov/12683469/' },
};

// 分を「就床基準の相対」から実クロック時(分)に変換
function clock(bedMin, deltaMin) {
  return ((bedMin + deltaMin) % 1440 + 1440) % 1440;
}

/*
 * @param bedMin        実際の就床（0時からの分）
 * @param wakeMin       実際の起床（0時からの分）
 * @param dipMin        午後の眠気の谷の時刻（分, 任意）
 * @param targetWakeMin 目標起床（0時からの分, 任意）。実際の起床が目標より遅いとき、
 *                      朝の光で体内時計を前進させる助言を加えるために使う。
 */
function buildTimeline(bedMin, wakeMin, dipMin, targetWakeMin) {
  const F = window.Science.fmtHM;
  const items = [];

  // 朝: 光（基本は実際の起床に合わせる。ただし目標より遅起きなら前進の助言を足す）
  let lightDetail = '朝の光は体内時計を前進させ、早起きが楽になり夜のメラトニンも早く出る。カーテンを開ける/外に出る。';
  if (targetWakeMin != null) {
    let later = (wakeMin - targetWakeMin + 1440) % 1440;        // 実際が目標より何分遅いか
    if (later > 720) later -= 1440;
    if (later > 30) {
      lightDetail += ` 今は目標(${F(targetWakeMin)})より遅く起きています。早起きにしたいなら、起床後できるだけ早く（理想は目標時刻に近づけて）光を浴びると体内時計が前進します。`;
    }
  }
  items.push({
    time: wakeMin, icon: '☀️', kind: 'do',
    title: '起きたら強い光を浴びる',
    detail: lightDetail,
    src: SOURCES.light_morning,
  });

  // カフェイン締切（試験で6h前でも有意差。6h前を目安に）
  items.push({
    time: clock(bedMin, -6 * 60), icon: '☕', kind: 'avoid',
    title: 'カフェインはここまで（就床6h前）',
    detail: '400mg(コーヒー2〜3杯相当)を就床6時間前に摂っても総睡眠時間が有意に減ったとの試験あり。コーヒー・紅茶・エナドリ・濃い緑茶はこの時刻までを目安に。',
    src: SOURCES.caffeine,
  });

  // 午後の眠気の谷 → 仮眠/コーヒーナップ
  if (dipMin != null) {
    items.push({
      time: dipMin, icon: '😴', kind: 'tip',
      title: '眠気の谷（仮眠するならここ・20分まで）',
      detail: '起床6〜8h後は自然に眠くなる時間帯。仮眠は20分まで、夜の睡眠に干渉しにくい。コーヒー→即20分仮眠の「コーヒーナップ」が効果的。',
      src: SOURCES.nap,
    });
  }

  // アルコール締切（就床3〜4h前）
  items.push({
    time: clock(bedMin, -4 * 60), icon: '🍺', kind: 'avoid',
    title: 'お酒はここまで（就床3〜4h前）',
    detail: '寝つきは良くなるが、夜後半の睡眠を分断しREMを抑える。深い眠りを削るので就床直前は逆効果。',
    src: SOURCES.alcohol,
  });

  // 夕食/大きい食事（就床3h前まで）
  items.push({
    time: clock(bedMin, -3 * 60), icon: '🍽️', kind: 'avoid',
    title: '大きめの食事はここまで（就床3h前）',
    detail: '就床3時間以内の食事は夜中の覚醒を増やす。1時間以内だと入眠遅延・睡眠効率低下。どうしても空腹なら軽いものを。',
    src: SOURCES.meal,
  });

  // 激しい運動（エビデンスの線は就床1h前。安全側に余裕を見るなら2h前）
  items.push({
    time: clock(bedMin, -60), icon: '🏃', kind: 'avoid',
    title: '激しい運動はここまで（就床1h前）',
    detail: '高強度運動は就床1時間以内だと入眠を遅らせ質を下げるとの報告。1時間より前なら睡眠への悪影響は示されておらず、むしろ好影響との解析もある。軽いストレッチはOK。',
    src: SOURCES.exercise,
  });

  // 画面/ブルーライト（就床2h前）
  items.push({
    time: clock(bedMin, -2 * 60), icon: '📱', kind: 'do',
    title: '画面を暗く・暖色に切替（就床2h前）',
    detail: 'ブルーライトはメラトニンを抑制。Night Shift/ダークモード、照明を暖色・低照度に。',
    src: SOURCES.light_evening,
  });

  // WMZ（就床1〜3h前）— 寝つけなくて当たり前
  items.push({
    time: clock(bedMin, -2 * 60), icon: '🛋️', kind: 'tip',
    title: '「眠れない時間帯」＝正常（就床1〜3h前）',
    detail: '体内時計が最も覚醒を促す時間帯（wake maintenance zone）。ここで寝つけなくても異常ではない。無理に早寝しようと焦らない。',
    src: SOURCES.wmz,
  });

  // 寝室環境
  items.push({
    time: clock(bedMin, -30), icon: '🌡️', kind: 'do',
    title: '寝室を暗く・静かに・18〜20℃に',
    detail: '室温18〜20℃、暗く静かな環境が睡眠の質を上げる（CDC/NIOSH）。',
    src: SOURCES.env,
  });

  // 就床
  items.push({
    time: bedMin, icon: '🌙', kind: 'do',
    title: '就床（毎日できるだけ同じ時刻に）',
    detail: '規則性が最重要。就床・起床時刻を毎日そろえるほど、日中の集中力と長期の健康に効く。',
    src: SOURCES.debt,
  });

  // 時刻順にソート（朝の起床を先頭に、1日の流れで並べる）
  // wake を起点に「その日の流れ」を作るため、wake より前の時刻は翌日扱いにして後ろへ
  const ref = wakeMin;
  items.sort((a, b) => {
    const ra = (a.time - ref + 1440) % 1440;
    const rb = (b.time - ref + 1440) % 1440;
    return ra - rb;
  });
  return items;
}

window.Timeline = { buildTimeline, SOURCES };
