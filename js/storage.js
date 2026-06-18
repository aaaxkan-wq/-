/*
 * storage.js — 端末内データ保存（localStorage）
 * 睡眠記録は小さいので localStorage で十分。すべて端末内に閉じ、外部送信なし。
 */
const REC_KEY = 'sleeplog.records.v1';
const SET_KEY = 'sleeplog.settings.v1';

const DEFAULT_SETTINGS = {
  targetWake: '06:30',  // 目標起床
  targetMin: 450,       // 目標睡眠時間（分）= 7.5h
  onsetMin: 15,         // 想定入眠潜時（分）
};

function loadRecords() {
  try {
    const raw = localStorage.getItem(REC_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveRecords(records) {
  localStorage.setItem(REC_KEY, JSON.stringify(records));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SET_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (e) { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  localStorage.setItem(SET_KEY, JSON.stringify(s));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addRecord(rec) {
  const records = loadRecords();
  rec.id = uid();
  records.push(rec);
  saveRecords(records);
  return rec;
}

function deleteRecord(id) {
  saveRecords(loadRecords().filter(r => r.id !== id));
}

function exportJSON() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    settings: loadSettings(),
    records: loadRecords(),
  }, null, 2);
}

function importJSON(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data.records)) saveRecords(data.records);
  if (data.settings) saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
}

window.Store = {
  DEFAULT_SETTINGS, loadRecords, saveRecords, loadSettings, saveSettings,
  addRecord, deleteRecord, exportJSON, importJSON,
};
