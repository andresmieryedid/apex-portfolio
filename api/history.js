import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [email] = decoded.split(':');
    if (email !== process.env.AUTH_EMAIL) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get all daily snapshots
    const keys = await kv.keys('daily:*');
    keys.sort(); // chronological order

    const snapshots = [];
    for (const key of keys) {
      const data = await kv.get(key);
      if (data) snapshots.push(data);
    }

    // Get initial prices
    const initPrices = await kv.get('init:prices');

    // Get latest YTD stats
    const ytdStats = await kv.get('ytd:latest');

    return res.status(200).json({
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
