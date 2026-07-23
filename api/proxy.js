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
// In-flight dedupe: kalau 2+ request identik (key sama) datang BARENGAN sebelum
// yang pertama selesai, request ke-2 dst nunggu promise yang sama alih-alih
// ikut fetch ke upstream lagi -- kasus nyata: banyak visitor auto-scan pair
// yang sama persis di detik yang hampir bersamaan.
const inFlight = globalThis.__dtInFlight || (globalThis.__dtInFlight = new Map());

async function fetchUpstream(url, timeoutMs=10000){
  const ac=new AbortController();
  const timer=setTimeout(()=>ac.abort(), timeoutMs);
  try{ return await fetch(url, { signal:ac.signal }); }
  finally{ clearTimeout(timer); }
}
 
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
  if (provider === 'cot') {
    return 12 * 60 * 60 * 1000; // CFTC COT cuma update mingguan (Jumat) -> cache lama aman
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
 
  if (!provider || (!endpoint && provider !== 'cot')) {
    return res.status(400).json({ error: 'Parameter provider & endpoint wajib diisi.' });
  }
  if (provider !== 'td' && provider !== 'fh' && provider !== 'mx' && provider !== 'cot') {
    return res.status(400).json({ error: 'Provider tidak dikenal (pakai "td", "fh", "mx", atau "cot").' });
  }
  const endpointKey = endpoint || 'cot';
 
  const key = cacheKey(provider, endpointKey, rest);
  const now = Date.now();
  const cached = cacheStore.get(key);
  const ttl = ttlFor(provider, endpointKey, rest);
 
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
  } else if (provider === 'cot') {
    // CFTC Commitment of Traders (Legacy Futures Only, Socrata Open Data).
    // Data publik, TIDAK butuh API key -> aman & gratis selamanya.
    // rest.market = nama kontrak persis (market_and_exchange_names di CFTC),
    // rest.limit = jumlah baris (2 = minggu ini + minggu lalu, buat hitung delta).
    const market = rest.market || '';
    const limit = rest.limit || '2';
    const where = encodeURIComponent(`market_and_exchange_names='${market}'`);
    url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=${where}&$order=report_date_as_yyyy_mm_dd DESC&$limit=${limit}`;
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
 
  const wrap = (d, meta) => Array.isArray(d) ? d : { ...d, _cacheMeta: meta }; // array (mis. CFTC) jangan di-spread, rusak strukturnya

  // Kalau ada request identik yang lagi in-flight (key sama), ikut nunggu promise itu
  // alih-alih ikut fetch baru ke upstream -- kasus nyata: banyak visitor auto-scan
  // pair yang sama persis nyaris berbarengan.
  if (inFlight.has(key)) {
    try {
      const data = await inFlight.get(key);
      return res.status(200).json(wrap(data, { cached: false, ageMs: 0, deduped: true }));
    } catch (e) { /* request yg di-dedupe gagal -> lanjut coba fetch sendiri di bawah */ }
  }

  const doFetch = (async () => {
    const upstream = await fetchUpstream(url);
    const data = await upstream.json();
    if (!(data && data.status === 'error')) {
      cacheStore.set(key, { ts: Date.now(), data });
      bumpQuota(provider);
      return data;
    }
    throw Object.assign(new Error('upstream_error'), { data, status: upstream.status });
  })();
  inFlight.set(key, doFetch);

  try {
    const data = await doFetch;
    return res.status(200).json(wrap(data, { cached: false, ageMs: 0 }));
  } catch (e) {
    // Upstream error/timeout -> kalau ada cache lama (meski sudah expired), pakai itu
    // daripada nampilin error ke user. Lebih baik data agak basi daripada tidak ada sama sekali.
    if (cached) {
      return res.status(200).json(wrap(cached.data, { cached: true, stale: true, ageMs: now - cached.ts }));
    }
    if (e.data) return res.status(e.status || 500).json(e.data);
    return res.status(500).json({ error: 'Gagal fetch upstream: ' + e.message });
  } finally {
    inFlight.delete(key);
  }
}
