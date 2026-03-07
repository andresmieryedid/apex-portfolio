import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const isCron = req.method === 'GET';

  // Auth check for non-cron requests
  if (!isCron) {
    const user = verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
  }

  const pfId = 'aggressive';
  const targetAlpha = 10;
  const budget = 5000;
  const startDate = '2026-03-09';

  // Check if we already have a portfolio saved in KV
  let savedPortfolio = await kv.get(`portfolio:${pfId}`);

  try {
    if (!savedPortfolio || savedPortfolio.length === 0) {
      // First run: AI builds the portfolio from scratch
      const result = await buildPortfolio({ pfId, targetAlpha, budget, startDate });
      return res.status(200).json(result);
    } else {
      // Subsequent runs: AI analyzes existing portfolio
      const pf = {
        id: pfId,
        name: 'Aggressive Growth',
        strategy: 'aggressive',
        targetAlpha,
        startDate,
        holdings: savedPortfolio,
      };
      const result = await runAnalysis(pf);
      return res.status(200).json(result);
    }
  } catch (err) {
    console.error('Analysis failed:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function buildPortfolio({ pfId, targetAlpha, budget, startDate }) {
  const AV_KEY = process.env.ALPHA_VANTAGE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!AV_KEY || !ANTHROPIC_KEY) throw new Error('Missing API keys');

  // Fetch SPY for context
  const spyData = await fetchQuote('SPY', AV_KEY);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York'
  });

  const prompt = `You are Vitru, the world's most elite AI portfolio strategist. You have deep expertise in technical analysis, macro trends, sector rotation, earnings catalysts, and momentum signals. Today is ${today}.

MISSION: BUILD A NEW $${budget.toLocaleString()} AGGRESSIVE GROWTH PORTFOLIO
- Goal: +${targetAlpha}% alpha over S&P 500 this year
- You have $${budget.toLocaleString()} in CASH to deploy RIGHT NOW
- Pick 4-7 high-conviction stocks. Concentrated bets, not diversification.
- Focus on: momentum, upcoming catalysts, sector tailwinds, technical breakouts
- This is aggressive growth — small/mid cap is fine, high-beta is fine
${spyData ? `- SPY is currently at $${spyData.price.toFixed(2)} (today: ${spyData.changePct >= 0 ? '+' : ''}${spyData.changePct.toFixed(2)}%)` : ''}

IMPORTANT: Do NOT guess stock prices. I will look up the real prices after you pick. Just focus on picking the best tickers, the dollar allocation, and your reasoning.

You MUST respond with valid JSON only:
{
  "grade": "A",
  "summary": "2-3 sentences explaining your portfolio construction thesis and why these picks will generate alpha",
  "verdict": "ACT",
  "holdings": [],
  "sells": [],
  "buys": [
    { "ticker": "TICKER", "company": "Company Name", "amount": 1000, "reason": "specific catalyst/edge", "isNew": true }
  ],
  "convictions": [
    { "ticker": "TICKER", "thesis": "specific alpha thesis with catalyst, timeline, and why this will outperform" }
  ],
  "risk": "1-2 sentence specific risk warning"
}

Rules:
- "buys" must contain ALL your picks. Total amounts must equal exactly $${budget.toLocaleString()}.
- Each buy MUST have: ticker, company name, dollar amount, specific reason.
- "holdings" and "sells" must be empty arrays (this is a new portfolio).
- Every pick must have a clear edge — earnings catalyst, technical setup, sector momentum, or macro tailwind.`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error ${claudeRes.status}`);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text || '{}';

  let analysis;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    analysis = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch {
    analysis = { grade: '?', summary: rawText, verdict: 'ACT', holdings: [], sells: [], buys: [], convictions: [], risk: 'Could not parse response.' };
  }

  // Fetch REAL prices for each pick and attach them
  const marketData = {};
  if (spyData) marketData['SPY'] = spyData;
  if (analysis.buys && analysis.buys.length > 0) {
    for (let i = 0; i < analysis.buys.length; i++) {
      const b = analysis.buys[i];
      const quote = await fetchQuote(b.ticker, AV_KEY);
      if (quote) {
        marketData[b.ticker] = quote;
        b.targetEntry = quote.price;
        // Set target exit as +30% from current price for aggressive
        b.targetExit = parseFloat((quote.price * 1.3).toFixed(2));
      }
      if (i < analysis.buys.length - 1) await sleep(1500);
    }
  }

  // Send email
  const EMAILJS_SERVICE = process.env.EMAILJS_SERVICE_ID;
  const EMAILJS_TEMPLATE = process.env.EMAILJS_TEMPLATE_ID;
  const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
  const USER_EMAIL = process.env.USER_EMAIL;
  let emailSent = false;

  if (EMAILJS_SERVICE && EMAILJS_TEMPLATE && EMAILJS_PUBLIC_KEY && USER_EMAIL) {
    const subject = `Vitru — NEW PORTFOLIO: Buy These Stocks Now`;
    const message = `Vitru Portfolio Builder — ${today}
Grade: ${analysis.grade}

${analysis.summary}

STOCKS TO BUY NOW:
${(analysis.buys || []).map(b => `- ${b.ticker} (${b.company}): $${b.amount} — Entry: $${b.targetEntry} → Target: $${b.targetExit}\n  ${b.reason}`).join('\n\n')}

${analysis.risk ? 'RISK: ' + analysis.risk : ''}
---
Generated by Vitru LLC`;

    try {
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
    } catch (e) {
      console.error('Email failed:', e);
    }
  }

  return {
    portfolioId: pfId,
    portfolioName: 'Aggressive Growth',
    strategy: 'aggressive',
    verdict: 'ACTION REQUIRED',
    analysis,
    marketData,
    spyData,
    portfolioChangePct: 0,
    alpha: 0,
    ytdAlpha: 0,
    ytdPortfolioReturn: 0,
    ytdSpyReturn: 0,
    targetAlpha,
    alphaGap: targetAlpha,
    tradingDaysLeft: 252,
    onTrack: true,
    startValue: budget,
    emailSent,
    timestamp: new Date().toISOString(),
  };
}

async function runAnalysis(pf) {
  const AV_KEY = process.env.ALPHA_VANTAGE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!AV_KEY || !ANTHROPIC_KEY) throw new Error('Missing API keys');

  const portfolio = pf.holdings;
  const targetAlpha = pf.targetAlpha || 10;
  const strategy = pf.strategy || 'aggressive';
  const pfId = pf.id || 'default';
  const total = portfolio.reduce((s, x) => s + x.amount, 0);

  // 1. Fetch market data
  const tickers = [...new Set(portfolio.map(s => s.ticker)), 'SPY'];
  const marketData = {};

  for (let i = 0; i < tickers.length; i++) {
    const quote = await fetchQuote(tickers[i], AV_KEY);
    if (quote) marketData[tickers[i]] = quote;
    if (i < tickers.length - 1) await sleep(1500);
  }

  const spyData = marketData['SPY'] || null;

  // 2. Build holdings summary
  const holdingsLines = portfolio.map(s => {
    const q = marketData[s.ticker];
    const pct = ((s.amount / total) * 100).toFixed(1);
    let line = `${s.ticker} (${s.company}): $${s.amount} invested — ${pct}% of portfolio`;
    if (q) {
      line += `\n  Price: $${q.price.toFixed(2)} | Today: ${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%`;
      line += ` | Range: $${q.low.toFixed(2)}-$${q.high.toFixed(2)} | Vol: ${q.volume.toLocaleString()}`;
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
    benchmarkSection = `\nBENCHMARK (today): Portfolio ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}% | SPY ${spyData.changePct >= 0 ? '+' : ''}${spyData.changePct.toFixed(2)}% | Alpha ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`;
  }

  // 3. YTD Tracking
  const startDate = pf.startDate || process.env.START_DATE || '2026-03-06';
  let initPrices = await kv.get(`init:prices:${pfId}`);

  if (!initPrices) {
    initPrices = {};
    for (const symbol of tickers) {
      if (marketData[symbol]) initPrices[symbol] = marketData[symbol].price;
    }
    await kv.set(`init:prices:${pfId}`, initPrices);
  }

  let portfolioReturn = 0;
  portfolio.forEach(s => {
    const cur = marketData[s.ticker]?.price;
    const start = initPrices[s.ticker];
    if (cur && start) portfolioReturn += (s.amount / total) * ((cur - start) / start) * 100;
  });

  let spyReturn = 0;
  if (marketData['SPY'] && initPrices['SPY']) {
    spyReturn = ((marketData['SPY'].price - initPrices['SPY']) / initPrices['SPY']) * 100;
  }

  const ytdAlpha = portfolioReturn - spyReturn;
  const dayOfYear = Math.floor((new Date() - new Date(startDate)) / 86400000);
  const tradingDaysLeft = Math.max(252 - Math.min(dayOfYear, 252), 1);
  const alphaGap = targetAlpha - ytdAlpha;
  const onTrack = ytdAlpha >= (targetAlpha / 252) * Math.min(dayOfYear, 252);

  // Save snapshot
  const todayKey = new Date().toISOString().split('T')[0];
  await kv.set(`daily:${pfId}:${todayKey}`, {
    date: todayKey,
    portfolioReturn: parseFloat(portfolioReturn.toFixed(4)),
    spyReturn: parseFloat(spyReturn.toFixed(4)),
    alpha: parseFloat(ytdAlpha.toFixed(4)),
    prices: Object.fromEntries(Object.entries(marketData).map(([k, v]) => [k, v.price])),
  });

  await kv.set(`ytd:latest:${pfId}`, {
    portfolioReturn: parseFloat(portfolioReturn.toFixed(4)),
    spyReturn: parseFloat(spyReturn.toFixed(4)),
    alpha: parseFloat(ytdAlpha.toFixed(4)),
    updatedAt: new Date().toISOString(),
  });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York'
  });

  // 4. Build prompt based on strategy
  const strategyInstructions = strategy === 'conservative'
    ? `STRATEGY: CONSERVATIVE
- This is a $${total.toLocaleString()} diversified portfolio with ${portfolio.length} positions.
- Target: +${targetAlpha}% alpha over S&P 500 this year.
- PATIENCE is paramount. You trade VERY rarely — maybe 3-5 times per year.
- Prefer large-cap, blue-chip, quality companies with strong balance sheets.
- Diversification matters here. No single position should exceed 12%.
- Only ACT when a position has fundamentally broken or a major sector rotation is needed.
- Volatility is expected and tolerated. Do NOT panic sell on red days.
- Dividend income and steady compounding are part of the alpha thesis.`
    : `STRATEGY: AGGRESSIVE GROWTH
- This is a $${total.toLocaleString()} concentrated portfolio with ${portfolio.length} positions.
- Target: +${targetAlpha}% alpha over S&P 500 this year.
- You are PATIENT but HIGH-CONVICTION. Trade only when there's a strong reason.
- Most days the answer is HOLD. Target 5-10 trades per year.
- Only ACT for: broken thesis, persistent underperformance (2+ weeks), clearly better opportunity, or position >30%.
- A single bad day is NOT a sell signal.`;

  const prompt = `You are Vitru, the world's most elite AI portfolio strategist. You have deep expertise in technical analysis, macro trends, sector rotation, earnings catalysts, and momentum signals. Today is ${today}.

${strategyInstructions}

MISSION: +${targetAlpha}% ALPHA OVER S&P 500 THIS YEAR
- Portfolio YTD return: ${portfolioReturn >= 0 ? '+' : ''}${portfolioReturn.toFixed(2)}%
- S&P 500 YTD return: ${spyReturn >= 0 ? '+' : ''}${spyReturn.toFixed(2)}%
- YTD alpha: ${ytdAlpha >= 0 ? '+' : ''}${ytdAlpha.toFixed(2)}% (target: +${targetAlpha}%)
- Alpha gap: ${alphaGap.toFixed(2)}% | Trading days left: ~${tradingDaysLeft}
- Status: ${onTrack ? 'ON TRACK' : 'BEHIND PACE'}

PORTFOLIO HOLDINGS:
${holdingsLines}
${benchmarkSection}

CRITICAL INSTRUCTIONS:
- For EVERY buy recommendation, you MUST provide a specific "targetEntry" price (the ideal buy price) and "targetExit" price (take-profit target).
- For EVERY sell recommendation, explain exactly WHY and what replaces it.
- In your convictions, explain the specific catalyst or edge — earnings date, technical breakout level, macro tailwind, sector momentum, etc.
- Be SPECIFIC. No generic advice. Reference the actual prices, levels, and data above.
- Show your brilliance: identify the highest-alpha opportunity available right now.

You MUST respond with valid JSON only:
{
  "grade": "A",
  "summary": "2-3 sentence razor-sharp assessment of portfolio positioning and biggest opportunity",
  "verdict": "HOLD" or "ACT",
  "holdings": [
    { "ticker": "TICKER", "amount": 1000, "price": 150.25, "changePct": 2.5, "allocation": "20%", "status": "OUTPERFORMING" or "UNDERPERFORMING" or "NEUTRAL", "signal": "brief technical/fundamental signal" }
  ],
  "sells": [
    { "ticker": "TICKER", "amount": 400, "reason": "specific reason with data" }
  ],
  "buys": [
    { "ticker": "TICKER", "amount": 400, "reason": "specific catalyst/edge", "isNew": false, "targetEntry": 150.00, "targetExit": 175.00 }
  ],
  "convictions": [
    { "ticker": "TICKER", "thesis": "specific alpha thesis with catalyst, timeline, and price target" }
  ],
  "risk": "1-2 sentence specific risk warning with levels to watch"
}

Rules:
- "holdings" MUST include ALL current positions with a "signal" for each.
- sells/buys SHOULD BE EMPTY most days. Only when there's a strong reason.
- Every sell must have a corresponding buy of equal total (rebalance, not cash out).
- Default is HOLD. Only ACT when it meaningfully improves alpha potential.
- Reference actual price data. Think in weeks/months.
- For buys: "targetEntry" = ideal buy price, "targetExit" = take-profit target. Be precise.`;

  // 5. Call Claude
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error ${claudeRes.status}`);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text || '{}';

  let analysis;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    analysis = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
  } catch {
    analysis = { grade: '?', summary: rawText, verdict: 'HOLD', holdings: [], sells: [], buys: [], convictions: [], risk: 'Could not parse response.' };
  }

  const needsAction = analysis.verdict === 'ACT';
  const verdict = needsAction ? 'ACTION REQUIRED' : 'HOLD';

  // 6. Send email notification
  const EMAILJS_SERVICE = process.env.EMAILJS_SERVICE_ID;
  const EMAILJS_TEMPLATE = process.env.EMAILJS_TEMPLATE_ID;
  const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
  const USER_EMAIL = process.env.USER_EMAIL;

  let emailSent = false;
  if (EMAILJS_SERVICE && EMAILJS_TEMPLATE && EMAILJS_PUBLIC_KEY && USER_EMAIL) {
    const subject = `Vitru — ${needsAction ? 'ACTION REQUIRED' : 'Holding Steady'}`;
    const message = `Vitru Portfolio (${strategy}) — ${today}
Grade: ${analysis.grade} | Verdict: ${verdict}

${analysis.summary}
${analysis.sells?.length ? '\nSELL:\n' + analysis.sells.map(s => `- ${s.ticker}: $${s.amount} — ${s.reason}`).join('\n') : ''}
${analysis.buys?.length ? '\nBUY:\n' + analysis.buys.map(b => `- ${b.ticker}: $${b.amount} — ${b.reason}`).join('\n') : ''}
${analysis.risk ? '\nRISK: ' + analysis.risk : ''}

YTD: Portfolio ${portfolioReturn >= 0 ? '+' : ''}${portfolioReturn.toFixed(2)}% | SPY ${spyReturn >= 0 ? '+' : ''}${spyReturn.toFixed(2)}% | Alpha ${ytdAlpha >= 0 ? '+' : ''}${ytdAlpha.toFixed(2)}%
---
Generated by Vitru LLC`;

    try {
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
    } catch (e) {
      console.error('Email failed:', e);
    }
  }

  return {
    portfolioId: pfId,
    portfolioName: pf.name,
    strategy,
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
    startValue: total,
    emailSent,
    timestamp: new Date().toISOString(),
  };
}

async function fetchQuote(symbol, apiKey) {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data['Note'] || data['Information']) return null;
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
  } catch { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function verifyToken(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString());
  } catch {
    return null;
  }
}
