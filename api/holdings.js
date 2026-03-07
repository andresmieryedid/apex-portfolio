import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const user = JSON.parse(Buffer.from(token, 'base64').toString());
    if (!user.email) return res.status(401).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const pfId = 'aggressive';

  if (req.method === 'POST') {
    const { holdings } = req.body || {};
    if (!holdings || !Array.isArray(holdings)) {
      return res.status(400).json({ error: 'Invalid holdings' });
    }

    // Save to KV
    await kv.set(`portfolio:${pfId}`, holdings);

    // Update init prices from avg buy prices
    const initPrices = {};
    holdings.forEach(h => {
      if (h.avgPrice) initPrices[h.ticker] = h.avgPrice;
    });
    // Keep SPY init price if it exists
    const existing = await kv.get(`init:prices:${pfId}`);
    if (existing?.SPY) initPrices['SPY'] = existing.SPY;
    await kv.set(`init:prices:${pfId}`, initPrices);

    return res.status(200).json({ saved: true, count: holdings.length });
  }

  if (req.method === 'GET') {
    const holdings = await kv.get(`portfolio:${pfId}`) || [];
    return res.status(200).json({ holdings });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
