// Vercel Serverless Function: /api/proxy
// Meneruskan request ke Twelve Data / Finnhub dengan API key dari
// Environment Variables (di-set di dashboard Vercel). Key tidak pernah
// dikirim ke client — browser hanya memanggil endpoint ini.

export default async function handler(req, res) {
  const { provider, endpoint, ...rest } = req.query;

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
