import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  try {
    user = JSON.parse(Buffer.from(token, 'base64').toString());
    if (!user.email) return res.status(401).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const portfolioId = 'aggressive';

  try {
    const keys = await kv.keys(`daily:${portfolioId}:*`);
    keys.sort();

    const snapshots = [];
    for (const key of keys) {
      const data = await kv.get(key);
      if (data) snapshots.push(data);
    }

    const initPrices = await kv.get(`init:prices:${portfolioId}`);
    const ytdStats = await kv.get(`ytd:latest:${portfolioId}`);

    return res.status(200).json({
      portfolioId,
      snapshots,
      initPrices,
      ytdStats,
      totalDays: snapshots.length,
    });
  } catch (err) {
    console.error('History fetch failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
