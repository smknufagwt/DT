// Vercel Serverless Function: /api/proxy
// Meneruskan request ke Twelve Data / Finnhub dengan API key dari
// Environment Variables (di-set di dashboard Vercel). Key tidak pernah
// dikirim ke client — browser hanya memanggil endpoint ini.
//
// CACHE SERVER-SIDE (in-memory, shared ke SEMUA pengunjung):
// Ini kunci hemat kuota. Sebelumnya tiap browser fetch langsung ke upstream
// setiap auto-scan -> N pengunjung = N x request meski minta data yang sama
// persis (symbol+interval sama). Sekarang: request pertama yang isi cache,
// request berikutnya (dari visitor manapun) selama TTL belum habis akan
// dilayani dari cache tanpa menyentuh upstream sama sekali.
//
// Catatan: cache ini hidup selama instance serverless "warm" (sama seperti
// presence tracker di bawah) — bukan persisten lintas cold-start, tapi
// cukup untuk menekan request harian secara signifikan pada traffic kecil.

const PRESENCE_TTL_MS = 90 * 1000;
const visitors = globalThis.__dtVisitors || (globalThis.__dtVisitors = new Map());
function cleanupVisitors() {
  const now = Date.now();
  for (const [id, ts] of visitors) if (now - ts > PRESENCE_TTL_MS) visitors.delete(id);
}

const cacheStore = globalThis.__dtCache || (globalThis.__dtCache = new Map());

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
const QUOTA_LIMIT_TD = 800; // free tier Twelve Data (referensi tampilan saja, bukan hard-limit dari sisi kita)
const quota = globalThis.__dtQuota || (globalThis.__dtQuota = { td: 0, fh: 0, mx: 0, day: todayKey() });
function bumpQuota(provider) {
  const tk = todayKey();
  if (quota.day !== tk) { quota.td = 0; quota.fh = 0; quota.mx = 0; quota.day = tk; }
  if (provider === 'td') quota.td++;
  else if (provider === 'fh') quota.fh++;
  else if (provider === 'mx') quota.mx++;
}

// TTL (ms) per jenis data. Timeframe besar -> TTL lebih panjang, karena candle
// baru memang belum terbentuk secepat itu. Ini yang paling menentukan total
// request/hari: makin panjang TTL relatif ke periode candle, makin hemat.
const TD_CANDLE_TTL = {
  '1min': 90 * 1000,
  '5min': 5 * 60 * 1000,
  '15min': 10 * 60 * 1000,
  '1h': 30 * 60 * 1000,
  '4h': 60 * 60 * 1000,
  '1day': 6 * 60 * 60 * 1000,
};
function ttlFor(provider, endpoint, params) {
  if (provider === 'td') {
    if (endpoint === 'time_series') {
      const outputsize = +(params.outputsize || 0);
      if (outputsize && outputsize <= 2) return 6 * 60 * 60 * 1000; // dipakai untuk pivot harian
      return TD_CANDLE_TTL[params.interval] || 5 * 60 * 1000;
    }
    if (endpoint === 'quote') return 45 * 1000;
    return 60 * 1000;
  }
  if (provider === 'fh') {
    if (endpoint === 'news') return 5 * 60 * 1000;
    if (endpoint === 'stock/metric') return 6 * 60 * 60 * 1000;
    return 2 * 60 * 1000;
  }
  if (provider === 'mx') {
    return 5 * 60 * 1000; // news, sama seperti Finnhub
  }
  return 60 * 1000;
}

function cacheKey(provider, endpoint, params) {
  const sortedKeys = Object.keys(params).sort();
  const parts = sortedKeys.map(k => `${k}=${params[k]}`);
  return `${provider}|${endpoint}|${parts.join('&')}`;
}

export default async function handler(req, res) {
  const { provider, endpoint, ...rest } = req.query;

  if (provider === 'presence') {
    const { action, id } = req.query;
    cleanupVisitors();
    if (action === 'ping') {
      if (id) visitors.set(id, Date.now());
      return res.status(200).json({ ok: true, count: visitors.size });
    }
    if (action === 'count') {
      return res.status(200).json({ count: visitors.size });
    }
    return res.status(400).json({ error: 'action presence tidak dikenal (pakai "ping" atau "count").' });
  }

  if (provider === 'quota') {
    const tk = todayKey();
    if (quota.day !== tk) { quota.td = 0; quota.fh = 0; quota.mx = 0; quota.day = tk; }
    return res.status(200).json({ td: quota.td, fh: quota.fh, mx: quota.mx, day: quota.day, limit: QUOTA_LIMIT_TD });
  }

  if (!provider || !endpoint) {
    return res.status(400).json({ error: 'Parameter provider & endpoint wajib diisi.' });
  }
  if (provider !== 'td' && provider !== 'fh' && provider !== 'mx') {
    return res.status(400).json({ error: 'Provider tidak dikenal (pakai "td", "fh", atau "mx").' });
  }

  const key = cacheKey(provider, endpoint, rest);
  const now = Date.now();
  const cached = cacheStore.get(key);
  const ttl = ttlFor(provider, endpoint, rest);

  if (cached && (now - cached.ts) < ttl) {
    return res.status(200).json({ ...cached.data, _cacheMeta: { cached: true, ageMs: now - cached.ts } });
  }

  let url;
  if (provider === 'td') {
    const qs = new URLSearchParams({ ...rest, apikey: process.env.TWELVEDATA_KEY || '' });
    url = `https://api.twelvedata.com/${endpoint}?${qs.toString()}`;
  } else if (provider === 'fh') {
    const qs = new URLSearchParams({ ...rest, token: process.env.FINNHUB_KEY || '' });
    url = `https://finnhub.io/api/v1/${endpoint}?${qs.toString()}`;
  } else {
    // Marketaux: opsional. Kalau MARKETAUX_KEY belum di-set di Vercel env,
    // sengaja dibalikin error supaya client (fetchMarketauxNews) gagal dengan
    // rapi dan di-skip oleh Promise.allSettled — situs tetap jalan normal
    // hanya pakai Finnhub saja.
    if (!process.env.MARKETAUX_KEY) {
      return res.status(200).json({ error: 'MARKETAUX_KEY belum di-set, sumber ini dilewati.' });
    }
    const qs = new URLSearchParams({ ...rest, api_token: process.env.MARKETAUX_KEY });
    url = `https://api.marketaux.com/v1/${endpoint}?${qs.toString()}`;
  }

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();

    // Kalau upstream sukses (bukan error rate-limit dsb), simpan ke cache & hitung kuota.
    const looksOk = !(data && data.status === 'error');
    if (looksOk) {
      cacheStore.set(key, { ts: now, data });
      bumpQuota(provider);
      return res.status(upstream.status).json({ ...data, _cacheMeta: { cached: false, ageMs: 0 } });
    }

    // Upstream error (misal limit habis) -> kalau ada cache lama (meski sudah expired), pakai itu
    // daripada nampilin error ke user. Lebih baik data agak basi daripada tidak ada sama sekali.
    if (cached) {
      return res.status(200).json({ ...cached.data, _cacheMeta: { cached: true, stale: true, ageMs: now - cached.ts } });
    }
    return res.status(upstream.status).json(data);
  } catch (e) {
    if (cached) {
      return res.status(200).json({ ...cached.data, _cacheMeta: { cached: true, stale: true, ageMs: now - cached.ts } });
    }
    return res.status(500).json({ error: 'Gagal fetch upstream: ' + e.message });
  }
}
