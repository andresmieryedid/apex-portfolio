export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const FINNHUB_KEY = process.env.FINNHUB_KEY;
  if (!FINNHUB_KEY) return res.status(500).json({ error: 'Missing Finnhub key' });

  const symbols = (req.query.symbols || 'SPY').split(',').map(s => s.trim().toUpperCase());

  const prices = {};
  for (const symbol of symbols) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`);
      const data = await res.json();
      if (data.c && data.c > 0) {
        prices[symbol] = {
          price: data.c,
          change: data.d,
          changePct: data.dp,
          high: data.h,
          low: data.l,
          open: data.o,
          prevClose: data.pc,
        };
      }
    } catch (e) {
      console.error(`Finnhub error for ${symbol}:`, e);
    }
  }

  return res.status(200).json({ prices, timestamp: new Date().toISOString() });
}
