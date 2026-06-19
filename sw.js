/* sw.js — オフライン動作用サービスワーカー
 *
 * 方針: アプリ本体(HTML/JS/CSS)は「ネットワーク優先」にする。
 *   オンライン時は常に最新を取得し(=更新が即届く)、取得したものをキャッシュに保存。
 *   オフライン時のみキャッシュにフォールバックする。
 *   以前は「キャッシュ優先」で、コードを更新しても古い版が配信され続ける問題があった。
 */
const CACHE = 'nemurilog-v3';
const ASSETS = [
  '.',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/storage.js',
  'js/science.js',
  'js/timeline.js',
  'js/charts.js',
  'js/app.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ネットワーク優先（オンラインなら常に最新、失敗時のみキャッシュ）
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(c => c || caches.match('index.html')))
  );
});
