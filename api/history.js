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

  // Check if user has access to this portfolio
  const portfolioId = req.query.id || 'aggressive';
  if (user.portfolios && user.portfolios.length > 0 && !user.portfolios.includes(portfolioId)) {
    return res.status(403).json({ error: 'No access to this portfolio' });
  }

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

    // Also return list of available portfolios
    const allPortfolios = JSON.parse(process.env.PORTFOLIOS || '[]');
    const portfolioList = allPortfolios.map(p => ({ id: p.id, name: p.name, strategy: p.strategy, targetAlpha: p.targetAlpha }));

    return res.status(200).json({
      portfolioId,
      portfolioList,
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
