// Vercel Serverless Function: /api/proxy
// Meneruskan request ke Twelve Data / Finnhub dengan API key dari
// Environment Variables (di-set di dashboard Vercel). Key tidak pernah
// dikirim ke client — browser hanya memanggil endpoint ini.

// Presence tracker sederhana (in-memory, per instance serverless yang sedang
// "warm"). Bukan sumber kebenaran mutlak untuk skala besar/multi-region,
// tapi cukup untuk mendeteksi ada/tidaknya pengunjung aktif pada trafik kecil.
const PRESENCE_TTL_MS = 90 * 1000;
const visitors = globalThis.__dtVisitors || (globalThis.__dtVisitors = new Map());
function cleanupVisitors() {
  const now = Date.now();
  for (const [id, ts] of visitors) if (now - ts > PRESENCE_TTL_MS) visitors.delete(id);
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

  if (!provider || !endpoint) {
    return res.status(400).json({ error: 'Parameter provider & endpoint wajib diisi.' });
  }

  let url;
  if (provider === 'td') {
    const qs = new URLSearchParams({ ...rest, apikey: process.env.TWELVEDATA_KEY || '' });
    url = `https://api.twelvedata.com/${endpoint}?${qs.toString()}`;
  } else if (provider === 'fh') {
    const qs = new URLSearchParams({ ...rest, token: process.env.FINNHUB_KEY || '' });
    url = `https://finnhub.io/api/v1/${endpoint}?${qs.toString()}`;
  } else {
    return res.status(400).json({ error: 'Provider tidak dikenal (pakai "td" atau "fh").' });
  }

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Gagal fetch upstream: ' + e.message });
  }
}
