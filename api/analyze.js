export default async function handler(req, res) {
  // Allow both cron (GET) and frontend (POST) triggers
  const isCron = req.method === 'GET';

  // Portfolio: use POST body if provided, otherwise fall back to env var
  let portfolio;
  if (!isCron && req.body?.portfolio) {
    portfolio = req.body.portfolio;
  } else {
    portfolio = JSON.parse(process.env.PORTFOLIO || '[]');
  }

  if (portfolio.length === 0) {
    return res.status(400).json({ error: 'No portfolio configured' });
  }

  const AV_KEY = process.env.ALPHA_VANTAGE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const EMAILJS_SERVICE = process.env.EMAILJS_SERVICE_ID;
  const EMAILJS_TEMPLATE = process.env.EMAILJS_TEMPLATE_ID;
  const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
  const USER_EMAIL = process.env.USER_EMAIL;

  if (!AV_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing API keys in environment' });
  }

  try {
    // 1. Fetch market data for all holdings + SPY
    const tickers = [...new Set(portfolio.map(s => s.ticker)), 'SPY'];
    const marketData = {};

    for (const symbol of tickers) {
      const quote = await fetchQuote(symbol, AV_KEY);
      if (quote) marketData[symbol] = quote;
      // Respect rate limit (5 calls/min on free tier)
      if (tickers.indexOf(symbol) < tickers.length - 1) {
        await sleep(1500);
      }
    }

    const spyData = marketData['SPY'] || null;

    // 2. Build analysis prompt
    const total = portfolio.reduce((s, x) => s + x.amount, 0);

    const holdingsLines = portfolio.map(s => {
      const q = marketData[s.ticker];
      const pct = ((s.amount / total) * 100).toFixed(1);
      let line = `${s.ticker} (${s.company}): $${s.amount} invested — ${pct}% of portfolio`;
      if (q) {
        line += `\n  Price: $${q.price.toFixed(2)} | Today: ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
        line += ` | Range: $${q.low.toFixed(2)}-$${q.high.toFixed(2)}`;
        line += ` | Prev close: $${q.prevClose.toFixed(2)} | Vol: ${q.volume.toLocaleString()}`;
      }
      return line;
    }).join('\n\n');

    let portfolioChangePct = 0;
    portfolio.forEach(s => {
      const q = marketData[s.ticker];
      if (q) portfolioChangePct += (s.amount / total) * q.changePct;
    });

    let benchmarkSection = '';
    if (spyData) {
      const alpha = portfolioChangePct - spyData.changePct;
      benchmarkSection = `
BENCHMARK COMPARISON (today):
- Portfolio weighted return: ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}%
- S&P 500 (SPY): $${spyData.price.toFixed(2)}, ${spyData.changePct >= 0 ? '+' : ''}${spyData.changePct.toFixed(2)}%
- Alpha: ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%
- SPY range: $${spyData.low.toFixed(2)}-$${spyData.high.toFixed(2)}, Vol: ${spyData.volume.toLocaleString()}`;
    }

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/New_York'
    });

    const prompt = `You are APEX, an elite AI portfolio strategist. Your mission: help this $${total.toLocaleString()} aggressive portfolio OUTPERFORM the S&P 500 over 1-3 years.

Today is ${today}.

PORTFOLIO HOLDINGS (with live market data):
${holdingsLines}
${benchmarkSection}

ANALYSIS FRAMEWORK — Evaluate each position on:
1. MOMENTUM: Is the stock trending up/down? How does today's action compare to recent behavior?
2. RELATIVE STRENGTH: Is this stock outperforming or underperforming SPY?
3. CONCENTRATION RISK: Any position >25% is dangerous.
4. SECTOR EXPOSURE: Is the portfolio too concentrated in one sector?
5. CATALYST AWARENESS: Any upcoming earnings, product launches, regulatory events?

RESPOND WITH:
1. PORTFOLIO SCORE (1-10): Rate ability to beat S&P 500.
2. OVERALL ASSESSMENT (2-3 sentences).
3. VERDICT: "HOLD — No changes needed" OR "ACT — Rebalance recommended"
4. If ACT: Specific trades with dollar amounts.
5. RISK FLAGS.
6. WATCHLIST: 2-3 stocks to consider adding.

Be direct, data-driven, specific. Every recommendation must reference actual data above.`;

    // 3. Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error ${claudeRes.status}`);
    }

    const claudeData = await claudeRes.json();
    const analysis = claudeData.content?.[0]?.text || 'No response received.';

    const needsAction = /\bact\b/i.test(analysis) && (/rebalance/i.test(analysis) || /trim|sell|reduce|exit/i.test(analysis));
    const verdict = needsAction ? 'ACTION REQUIRED' : 'HOLD';

    // 4. Send email if configured
    let emailSent = false;
    if (EMAILJS_SERVICE && EMAILJS_TEMPLATE && EMAILJS_PUBLIC_KEY && USER_EMAIL) {
      try {
        const subject = needsAction
          ? 'APEX ALERT — Portfolio Action Required'
          : 'APEX Daily Check — Portfolio Holding Steady';

        let benchLine = '';
        if (spyData) {
          benchLine = `\nSPY: $${spyData.price.toFixed(2)} (${spyData.changePct >= 0 ? '+' : ''}${spyData.changePct.toFixed(2)}%)`;
          benchLine += `\nYour Alpha: ${(portfolioChangePct - spyData.changePct).toFixed(2)}%`;
        }

        const message = `APEX PORTFOLIO MONITOR — ${today}
Verdict: ${verdict}

PORTFOLIO: $${total.toLocaleString()} | Today: ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}%
${portfolio.map(s => {
  const q = marketData[s.ticker];
  return `${s.ticker}: $${s.amount}${q ? ` ($${q.price.toFixed(2)}, ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)` : ''}`;
}).join('\n')}${benchLine}

AI ANALYSIS:
${analysis}

---
Generated by APEX AI Portfolio Monitor`;

        await fetch('https://api.emailjs.com/api/v1.0/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service_id: EMAILJS_SERVICE,
            template_id: EMAILJS_TEMPLATE,
            user_id: EMAILJS_PUBLIC_KEY,
            template_params: { to_email: USER_EMAIL, subject, message },
          }),
        });
        emailSent = true;
      } catch (emailErr) {
        console.error('Email failed:', emailErr);
      }
    }

    // 5. Return results
    return res.status(200).json({
      verdict,
      analysis,
      marketData,
      spyData,
      portfolioChangePct,
      alpha: spyData ? portfolioChangePct - spyData.changePct : null,
      emailSent,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Analysis failed:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchQuote(symbol, apiKey) {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data['Note'] || data['Information']) {
      console.warn(`Rate limited on ${symbol}`);
      return null;
    }

    const q = data['Global Quote'];
    if (!q || !q['05. price']) return null;

    return {
      symbol: q['01. symbol'],
      price: parseFloat(q['05. price']),
      change: parseFloat(q['09. change']),
      changePct: parseFloat(q['10. change percent']?.replace('%', '') || 0),
      high: parseFloat(q['03. high']),
      low: parseFloat(q['04. low']),
      volume: parseInt(q['06. volume']),
      prevClose: parseFloat(q['08. previous close']),
    };
  } catch (err) {
    console.error(`Failed to fetch ${symbol}:`, err);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
