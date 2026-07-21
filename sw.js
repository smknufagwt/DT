// sw.js — cache app shell biar load instan & tetap jalan pas koneksi jelek,
// TANPA mengurangi kesegaran data trading (API tidak di-cache-first, hanya
// dipakai sebagai fallback offline). Kuota API dihemat di sisi server
// (lihat api/proxy.js), bukan lewat SW ini.

const SHELL_CACHE = 'dt-shell-v2';
const API_FALLBACK_CACHE = 'dt-api-fallback-v1';
const SHELL_ASSETS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== API_FALLBACK_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Data API/trading: network-first. Kalau online, selalu ambil yang terbaru
  // (server sudah punya cache-nya sendiri dengan TTL yang tepat). Kalau
  // network gagal (offline/HP di area sinyal jelek), baru pakai cache
  // terakhir yang tersimpan supaya UI tidak kosong total.
  if (url.pathname.startsWith('/api/proxy')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(API_FALLBACK_CACHE).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cross-origin (mis. Binance klines/WS untuk panel korelasi): biarkan lewat
  // apa adanya, jangan disimpan di cache SW ini -- data realtime harus selalu segar.
  if (url.origin !== self.location.origin) {
    return;
  }

  // App shell & aset statis: network-first. Selalu coba ambil versi terbaru dari
  // server dulu (must-revalidate, lihat header di vercel.json) supaya deploy/push
  // commit baru langsung kepakai tanpa nunggu buka-tutup app. Cache cuma dipakai
  // sebagai fallback kalau offline.
  if (event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
