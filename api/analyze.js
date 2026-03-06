import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // Allow both cron (GET) and frontend (POST) triggers
  const isCron = req.method === 'GET';

  // Cron requests are trusted (Vercel internal). POST requests need auth.
  if (!isCron) {
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
  }

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

    // ─── YTD Tracking via Vercel KV ────────────────────────────────────────
    const startValue = parseFloat(process.env.START_VALUE || '5000');
    const startDate = process.env.START_DATE || '2026-03-06';
    const targetAlpha = 10;

    // Check if we have initial prices stored
    let initPrices = await kv.get('init:prices');

    if (!initPrices) {
      // First run ever — save today's prices as the baseline
      initPrices = {};
      for (const symbol of tickers) {
        if (marketData[symbol]) {
          initPrices[symbol] = marketData[symbol].price;
        }
      }
      await kv.set('init:prices', initPrices);
    }

    // Calculate YTD returns from initial prices
    let portfolioReturn = 0;
    portfolio.forEach(s => {
      const currentPrice = marketData[s.ticker]?.price;
      const startPrice = initPrices[s.ticker];
      if (currentPrice && startPrice) {
        const stockReturn = ((currentPrice - startPrice) / startPrice) * 100;
        const weight = s.amount / total;
        portfolioReturn += weight * stockReturn;
      }
    });

    let spyReturn = 0;
    if (marketData['SPY'] && initPrices['SPY']) {
      spyReturn = ((marketData['SPY'].price - initPrices['SPY']) / initPrices['SPY']) * 100;
    }

    const ytdAlpha = portfolioReturn - spyReturn;

    // Calculate pace
    const dayOfYear = Math.floor((new Date() - new Date(startDate)) / 86400000);
    const tradingDaysLeft = Math.max(252 - Math.min(dayOfYear, 252), 1);
    const requiredPacePerDay = targetAlpha / 252;
    const requiredPaceSoFar = requiredPacePerDay * Math.min(dayOfYear, 252);
    const alphaGap = targetAlpha - ytdAlpha;
    const requiredDailyAlpha = alphaGap / tradingDaysLeft;
    const onTrack = ytdAlpha >= requiredPaceSoFar;

    // Save today's snapshot to KV
    const todayKey = new Date().toISOString().split('T')[0];
    await kv.set(`daily:${todayKey}`, {
      date: todayKey,
      portfolioReturn: parseFloat(portfolioReturn.toFixed(4)),
      spyReturn: parseFloat(spyReturn.toFixed(4)),
      alpha: parseFloat(ytdAlpha.toFixed(4)),
      prices: Object.fromEntries(
        Object.entries(marketData).map(([k, v]) => [k, v.price])
      ),
    });

    // Save latest YTD stats for quick access
    await kv.set('ytd:latest', {
      portfolioReturn: parseFloat(portfolioReturn.toFixed(4)),
      spyReturn: parseFloat(spyReturn.toFixed(4)),
      alpha: parseFloat(ytdAlpha.toFixed(4)),
      updatedAt: new Date().toISOString(),
    });

    const ytdSection = `
MISSION OBJECTIVE: +10% ALPHA OVER S&P 500 THIS YEAR
- Starting capital: $${startValue.toLocaleString()} (${startDate})
- Portfolio YTD return: ${portfolioReturn >= 0 ? '+' : ''}${portfolioReturn.toFixed(2)}%
- S&P 500 YTD return: ${spyReturn >= 0 ? '+' : ''}${spyReturn.toFixed(2)}%
- YTD alpha: ${ytdAlpha >= 0 ? '+' : ''}${ytdAlpha.toFixed(2)}%
- Target alpha: +${targetAlpha}%
- Alpha needed to hit target: +${alphaGap.toFixed(2)}%
- Trading days remaining: ~${tradingDaysLeft}
- Required daily alpha pace: +${requiredDailyAlpha.toFixed(3)}%/day
- Status: ${onTrack ? 'ON TRACK' : 'BEHIND PACE — need to be more aggressive'}`;

    const prompt = `You are Vitru, an elite AI portfolio strategist with ONE MISSION: generate +10% ALPHA over the S&P 500 this year on a $${total.toLocaleString()} portfolio.

+10% alpha means if SPY returns 12%, this portfolio must return 22%.

CRITICAL TRADING PHILOSOPHY:
- You are a PATIENT, HIGH-CONVICTION manager. You do NOT trade every day.
- The goal is +10% alpha over a FULL YEAR — not daily trading.
- Only recommend a trade when there is a STRONG, clear reason: broken thesis, major catalyst, extreme underperformance, or a significantly better opportunity.
- Most days the correct answer is HOLD. A good portfolio manager makes 5-10 trades per year, not 5-10 per week.
- Trading costs money (commissions, spread, taxes). Every trade must justify its friction.
- Think in WEEKS and MONTHS, not hours and days.

Verdict "ACT" should only trigger when:
1. A position has fundamentally broken (thesis destroyed, not just a bad day)
2. A position has persistently underperformed SPY for 2+ weeks with no catalyst ahead
3. A clearly superior opportunity exists that meaningfully improves alpha potential
4. A position has grown past 30% allocation and needs trimming for risk

A single bad day is NOT a reason to sell. Volatility is normal.

Today is ${today}.

${ytdSection}

PORTFOLIO HOLDINGS (with live market data):
${holdingsLines}
${benchmarkSection}

ANALYSIS FRAMEWORK:
1. POSITION HEALTH: Is each holding's investment thesis still intact? Any broken stories?
2. RELATIVE STRENGTH: Over recent weeks (not just today), which positions are leading vs lagging SPY?
3. UPCOMING CATALYSTS: Earnings, product launches, macro events in the next 2-4 weeks?
4. CONCENTRATION: Any position dangerously oversized (>30%)?
5. ALPHA MATH: Are we on pace for +10%? If behind, what's the minimum change needed?

You MUST respond with valid JSON only. No markdown, no text outside the JSON. Use this exact structure:

{
  "grade": "A",
  "summary": "2-3 sentence overall assessment",
  "verdict": "HOLD" or "ACT",
  "holdings": [
    { "ticker": "TICKER", "amount": 1000, "price": 150.25, "changePct": 2.5, "allocation": "20%", "status": "OUTPERFORMING" or "UNDERPERFORMING" or "NEUTRAL" }
  ],
  "sells": [
    { "ticker": "TICKER", "amount": 400, "reason": "brief reason" }
  ],
  "buys": [
    { "ticker": "TICKER", "amount": 400, "reason": "brief reason", "isNew": false }
  ],
  "convictions": [
    { "ticker": "TICKER", "thesis": "1-2 sentence alpha thesis" }
  ],
  "risk": "1-2 sentence risk warning"
}

Rules:
- "holdings" MUST include ALL current positions with their live data and status vs SPY.
- "isNew" in buys = true if it's a stock NOT currently in the portfolio (new position to add).
- sells and buys arrays SHOULD BE EMPTY most days. Only populate when there's a strong reason.
- Every sell must have a corresponding buy of equal total amount (rebalance, not cash out).
- Reference actual price data in reasons.
- Default verdict is HOLD. Only say ACT when a trade would meaningfully improve alpha by 1%+ over the coming weeks.
- A single day's underperformance is NOT a sell signal.
- Think in weeks/months. Be patient. Fewer trades = better after-tax returns.`;

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
    const rawText = claudeData.content?.[0]?.text || '{}';

    // Parse structured JSON from Claude
    let analysis;
    try {
      // Extract JSON if wrapped in code blocks
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch {
      analysis = {
        grade: '?',
        summary: rawText,
        verdict: 'HOLD',
        sells: [],
        buys: [],
        convictions: [],
        risk: 'Could not parse structured response.',
      };
    }

    const needsAction = analysis.verdict === 'ACT';
    const verdict = needsAction ? 'ACTION REQUIRED' : 'HOLD';

    // 4. Send email if configured
    let emailSent = false;
    if (EMAILJS_SERVICE && EMAILJS_TEMPLATE && EMAILJS_PUBLIC_KEY && USER_EMAIL) {
      try {
        const subject = needsAction
          ? 'Vitru ALERT — Portfolio Action Required'
          : 'Vitru Daily Check — Portfolio Holding Steady';

        let benchLine = '';
        if (spyData) {
          benchLine = `\nSPY: $${spyData.price.toFixed(2)} (${spyData.changePct >= 0 ? '+' : ''}${spyData.changePct.toFixed(2)}%)`;
          benchLine += `\nYour Alpha: ${(portfolioChangePct - spyData.changePct).toFixed(2)}%`;
        }

        const message = `Vitru PORTFOLIO MONITOR — ${today}
Verdict: ${verdict}

PORTFOLIO: $${total.toLocaleString()} | Today: ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}%
${portfolio.map(s => {
  const q = marketData[s.ticker];
  return `${s.ticker}: $${s.amount}${q ? ` ($${q.price.toFixed(2)}, ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)` : ''}`;
}).join('\n')}${benchLine}

AI ANALYSIS:
Grade: ${analysis.grade} | Verdict: ${analysis.verdict}
${analysis.summary}
${analysis.sells.length ? '\nSELL:\n' + analysis.sells.map(s => `- ${s.ticker}: $${s.amount} — ${s.reason}`).join('\n') : ''}
${analysis.buys.length ? '\nBUY:\n' + analysis.buys.map(b => `- ${b.ticker}: $${b.amount} — ${b.reason}`).join('\n') : ''}
${analysis.risk ? '\nRISK: ' + analysis.risk : ''}

---
Generated by Vitru AI Portfolio Monitor`;

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
      ytdAlpha,
      ytdPortfolioReturn: portfolioReturn,
      ytdSpyReturn: spyReturn,
      targetAlpha,
      alphaGap,
      tradingDaysLeft,
      onTrack,
      startValue,
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
