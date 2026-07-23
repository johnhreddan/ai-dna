const YAHOO = 'https://query1.finance.yahoo.com';
const ALPHA = 'https://www.alphavantage.co/query';
const UA = 'Mozilla/5.0 (compatible; AI-DNA/3.2; +https://ai-dna-mu.vercel.app)';
const fundamentalCache = new Map();
const FUNDAMENTAL_TTL = 24 * 60 * 60 * 1000;

function finite(value) {
  if (value === null || value === undefined || value === '' || value === 'None' || value === '-') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function firstFinite(...values) { for (const value of values) { const n = finite(value?.raw ?? value); if (n !== null) return n; } return null; }
function percentValue(value) { const n = finite(value); return n === null ? null : (Math.abs(n) <= 2 ? n * 100 : n); }
async function jsonFetch(url, label) {
  const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned unreadable data`); }
}
function chartResult(payload) { return payload?.chart?.result?.[0] || null; }
function validPrices(result) {
  const quote = result?.indicators?.quote?.[0] || {};
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  return adjusted.map(finite).filter((value) => value !== null);
}
function alphaSymbol(symbol) {
  const map = { 'BRK-B': 'BRK.B', 'BF-B': 'BF.B' };
  return map[symbol] || symbol;
}
async function alphaOverview(symbol) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return { configured: false, data: null, error: 'ALPHA_VANTAGE_API_KEY is not configured' };
  const key = alphaSymbol(symbol);
  const cached = fundamentalCache.get(key);
  if (cached && Date.now() - cached.savedAt < FUNDAMENTAL_TTL) return { configured: true, data: cached.data, cached: true };
  const url = `${ALPHA}?function=OVERVIEW&symbol=${encodeURIComponent(key)}&apikey=${encodeURIComponent(apiKey)}`;
  try {
    const data = await jsonFetch(url, 'Alpha Vantage');
    if (data.Note || data.Information) throw new Error(data.Note || data.Information);
    if (!data.Symbol) throw new Error('No fundamental profile was returned for this ticker');
    fundamentalCache.set(key, { savedAt: Date.now(), data });
    return { configured: true, data, cached: false };
  } catch (error) {
    return { configured: true, data: null, error: error.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.^=\-]{1,20}$/.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  try {
    const shortUrl = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=30m&events=div%2Csplits&includeAdjustedClose=true`;
    const fiveUrl = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
    const [shortSettled, fiveSettled, alpha] = await Promise.all([
      jsonFetch(shortUrl, 'Yahoo Finance').catch(() => null),
      jsonFetch(fiveUrl, 'Yahoo Finance').catch(() => null),
      alphaOverview(symbol),
    ]);

    const short = chartResult(shortSettled);
    const five = chartResult(fiveSettled);
    if (!short && !five) throw new Error('Yahoo price data is temporarily unavailable');
    const primary = short || five;
    const meta = primary?.meta || {};
    const shortPrices = validPrices(short);
    const fivePrices = validPrices(five);
    const price = firstFinite(meta.regularMarketPrice, shortPrices.at(-1), fivePrices.at(-1));
    const previousClose = firstFinite(meta.regularMarketPreviousClose, meta.chartPreviousClose,
      shortPrices.length > 1 ? shortPrices[shortPrices.length - 2] : null);
    const change = price !== null && previousClose !== null ? price - previousClose : null;
    const changePercent = change !== null && previousClose ? (change / previousClose) * 100 : null;
    const firstFive = fivePrices[0] ?? null;
    const lastFive = fivePrices.at(-1) ?? price;
    const fiveYear = firstFive && lastFive ? ((lastFive / firstFive) - 1) * 100 : null;
    const cagr = firstFive && lastFive ? (Math.pow(lastFive / firstFive, 1 / 5) - 1) * 100 : null;
    const a = alpha.data || {};

    const trailingEps = firstFinite(a.DilutedEPSTTM, a.EPS);
    let trailingPe = firstFinite(a.PERatio, a.TrailingPE);
    if (trailingPe === null && trailingEps !== null && trailingEps > 0 && price !== null) trailingPe = price / trailingEps;
    const forwardPe = firstFinite(a.ForwardPE);
    const marketCap = firstFinite(a.MarketCapitalization);
    const fiftyTwoWeekHigh = firstFinite(a['52WeekHigh'], meta.fiftyTwoWeekHigh);
    const fiftyTwoWeekLow = firstFinite(a['52WeekLow'], meta.fiftyTwoWeekLow);

    const result = {
      symbol,
      price,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || meta.fullExchangeName || a.Exchange || '',
      change,
      changePercent,
      marketCap,
      trailingPe,
      forwardPe,
      trailingEps,
      forwardEps: firstFinite(a.ForwardAnnualEPS),
      roe: percentValue(a.ReturnOnEquityTTM),
      debtToEquity: firstFinite(a.DebtToEquity),
      revenueGrowth: percentValue(a.QuarterlyRevenueGrowthYOY),
      earningsGrowth: percentValue(a.QuarterlyEarningsGrowthYOY),
      operatingMargin: percentValue(a.OperatingMarginTTM),
      profitMargin: percentValue(a.ProfitMargin),
      freeCashFlow: firstFinite(a.FreeCashFlowTTM),
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      beta: firstFinite(a.Beta),
      fiveYear,
      cagr,
      spark: shortPrices.length > 80 ? shortPrices.filter((_, i) => i % Math.ceil(shortPrices.length / 80) === 0) : shortPrices,
      marketTime: firstFinite(meta.regularMarketTime),
      delayedBy: firstFinite(meta.exchangeDataDelayedBy) || 0,
      analystTarget: firstFinite(a.AnalystTargetPrice),
      dividendYield: percentValue(a.DividendYield),
      bookValue: firstFinite(a.BookValue),
      priceToBook: firstFinite(a.PriceToBookRatio),
      evToEbitda: firstFinite(a.EVToEBITDA),
      sources: {
        price: 'Yahoo Finance',
        fundamentals: alpha.data ? 'Alpha Vantage' : null,
      },
      fundamentalsConfigured: alpha.configured,
      fundamentalsError: alpha.error || null,
    };
    const tracked = ['marketCap','trailingPe','forwardPe','trailingEps','roe','revenueGrowth','earningsGrowth','operatingMargin','fiftyTwoWeekHigh','fiftyTwoWeekLow','beta'];
    result.missing = tracked.filter((key) => result[key] === null);
    result.partial = result.missing.length > 0;
    return res.status(200).json(result);
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Market data unavailable' });
  }
}
