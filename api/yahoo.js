const YAHOO = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (compatible; AI-DNA/3.1; +https://ai-dna-mu.vercel.app)';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function raw(value) {
  return finite(value?.raw ?? value?.reportedValue?.raw ?? value);
}

function firstFinite(...values) {
  for (const value of values) {
    const n = raw(value);
    if (n !== null) return n;
  }
  return null;
}

function latestRaw(series, keys) {
  for (const key of keys) {
    const rows = series.filter((item) => item && (item.meta?.type === key || Object.prototype.hasOwnProperty.call(item, key)));
    for (const row of rows) {
      const values = row?.[key];
      if (!Array.isArray(values)) continue;
      for (let i = values.length - 1; i >= 0; i -= 1) {
        const n = raw(values[i]);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

async function yahooJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error('Yahoo returned an unreadable response'); }
}

function chartResult(payload) {
  return payload?.chart?.result?.[0] || null;
}

function validPrices(result) {
  const quote = result?.indicators?.quote?.[0] || {};
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  return adjusted.map(finite).filter((value) => value !== null);
}

function normalizeRatio(value) {
  const n = finite(value);
  if (n === null) return null;
  return Math.abs(n) <= 2 ? n * 100 : n;
}

function normalizeDebtEquity(value) {
  const n = finite(value);
  if (n === null) return null;
  return Math.abs(n) > 10 ? n / 100 : n;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');

  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.^=\-]{1,20}$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const fundamentalsStart = now - 6 * 365 * 24 * 60 * 60;
    const types = [
      'trailingPe', 'forwardPe', 'trailingEps', 'forwardEps',
      'annualDilutedEPS', 'quarterlyDilutedEPS',
      'returnOnEquity', 'annualReturnOnEquity', 'quarterlyReturnOnEquity',
      'debtToEquity', 'annualTotalDebtEquity', 'quarterlyTotalDebtEquity',
      'marketCap', 'enterpriseValue',
      'revenueGrowth', 'earningsGrowth', 'earningsQuarterlyGrowth',
      'operatingMargins', 'profitMargins', 'grossMargins',
      'freeCashflow', 'operatingCashflow', 'totalRevenue',
      'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'beta'
    ];
    const typeParams = types.map((type) => `type=${encodeURIComponent(type)}`).join('&');
    const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';

    const urls = {
      short: `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=30m&events=div%2Csplits&includeAdjustedClose=true`,
      five: `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`,
      fundamentals: `${YAHOO}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&${typeParams}&period1=${fundamentalsStart}&period2=${now}`,
      summary: `${YAHOO}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${encodeURIComponent(modules)}`,
    };

    const [shortSettled, fiveSettled, fundamentalsSettled, summarySettled] = await Promise.allSettled([
      yahooJson(urls.short), yahooJson(urls.five), yahooJson(urls.fundamentals), yahooJson(urls.summary),
    ]);

    const short = shortSettled.status === 'fulfilled' ? chartResult(shortSettled.value) : null;
    const five = fiveSettled.status === 'fulfilled' ? chartResult(fiveSettled.value) : null;
    const summary = summarySettled.status === 'fulfilled'
      ? summarySettled.value?.quoteSummary?.result?.[0] || null
      : null;
    if (!short && !five && !summary) throw new Error('Symbol not found or temporarily unavailable');

    const primary = short || five;
    const meta = primary?.meta || {};
    const shortPrices = validPrices(short);
    const fivePrices = validPrices(five);
    const series = fundamentalsSettled.status === 'fulfilled'
      ? fundamentalsSettled.value?.timeseries?.result || []
      : [];

    const price = firstFinite(summary?.price?.regularMarketPrice, meta.regularMarketPrice, shortPrices.at(-1), fivePrices.at(-1));
    const previousClose = firstFinite(
      summary?.summaryDetail?.previousClose,
      summary?.price?.regularMarketPreviousClose,
      meta.regularMarketPreviousClose,
      meta.chartPreviousClose,
      shortPrices.length > 1 ? shortPrices[shortPrices.length - 2] : null
    );
    const change = firstFinite(summary?.price?.regularMarketChange,
      price !== null && previousClose !== null ? price - previousClose : null);
    const changePercent = firstFinite(summary?.price?.regularMarketChangePercent,
      change !== null && previousClose ? (change / previousClose) * 100 : null);

    const firstFive = fivePrices[0] ?? null;
    const lastFive = fivePrices.at(-1) ?? price;
    const fiveYear = firstFive && lastFive ? ((lastFive / firstFive) - 1) * 100 : null;
    const cagr = firstFive && lastFive ? (Math.pow(lastFive / firstFive, 1 / 5) - 1) * 100 : null;

    const trailingEps = firstFinite(summary?.defaultKeyStatistics?.trailingEps,
      latestRaw(series, ['trailingEps', 'annualDilutedEPS', 'quarterlyDilutedEPS']));
    const forwardEps = firstFinite(summary?.defaultKeyStatistics?.forwardEps,
      latestRaw(series, ['forwardEps']));
    let trailingPe = firstFinite(summary?.summaryDetail?.trailingPE,
      summary?.defaultKeyStatistics?.trailingPE, latestRaw(series, ['trailingPe']));
    const forwardPe = firstFinite(summary?.summaryDetail?.forwardPE,
      summary?.defaultKeyStatistics?.forwardPE, latestRaw(series, ['forwardPe']));
    if (trailingPe === null && trailingEps !== null && trailingEps > 0 && price !== null) trailingPe = price / trailingEps;

    const roe = normalizeRatio(firstFinite(summary?.financialData?.returnOnEquity,
      latestRaw(series, ['returnOnEquity', 'annualReturnOnEquity', 'quarterlyReturnOnEquity'])));
    const debtToEquity = normalizeDebtEquity(firstFinite(summary?.financialData?.debtToEquity,
      latestRaw(series, ['debtToEquity', 'annualTotalDebtEquity', 'quarterlyTotalDebtEquity'])));
    const revenueGrowth = normalizeRatio(firstFinite(summary?.financialData?.revenueGrowth,
      latestRaw(series, ['revenueGrowth'])));
    const earningsGrowth = normalizeRatio(firstFinite(summary?.financialData?.earningsGrowth,
      summary?.defaultKeyStatistics?.earningsQuarterlyGrowth,
      latestRaw(series, ['earningsGrowth', 'earningsQuarterlyGrowth'])));
    const operatingMargin = normalizeRatio(firstFinite(summary?.financialData?.operatingMargins,
      latestRaw(series, ['operatingMargins'])));
    const profitMargin = normalizeRatio(firstFinite(summary?.financialData?.profitMargins,
      summary?.summaryDetail?.profitMargins, latestRaw(series, ['profitMargins'])));

    const marketCap = firstFinite(summary?.price?.marketCap, summary?.summaryDetail?.marketCap,
      latestRaw(series, ['marketCap']));
    const freeCashFlow = firstFinite(summary?.financialData?.freeCashflow,
      latestRaw(series, ['freeCashflow']));
    const fiftyTwoWeekHigh = firstFinite(summary?.summaryDetail?.fiftyTwoWeekHigh,
      meta.fiftyTwoWeekHigh, latestRaw(series, ['fiftyTwoWeekHigh']));
    const fiftyTwoWeekLow = firstFinite(summary?.summaryDetail?.fiftyTwoWeekLow,
      meta.fiftyTwoWeekLow, latestRaw(series, ['fiftyTwoWeekLow']));
    const beta = firstFinite(summary?.summaryDetail?.beta, summary?.defaultKeyStatistics?.beta,
      latestRaw(series, ['beta']));

    const spark = shortPrices.length > 80
      ? shortPrices.filter((_, index) => index % Math.ceil(shortPrices.length / 80) === 0)
      : shortPrices;

    const fields = {
      trailingPe, forwardPe, trailingEps, forwardEps, roe, debtToEquity,
      marketCap, revenueGrowth, earningsGrowth, operatingMargin, profitMargin,
      freeCashFlow, fiftyTwoWeekHigh, fiftyTwoWeekLow, beta,
    };
    const missing = Object.entries(fields).filter(([, value]) => value === null).map(([key]) => key);

    return res.status(200).json({
      symbol,
      price,
      currency: summary?.price?.currency || meta.currency || 'USD',
      exchange: summary?.price?.exchangeName || meta.exchangeName || meta.fullExchangeName || '',
      change,
      changePercent,
      marketCap,
      trailingPe,
      forwardPe,
      trailingEps,
      forwardEps,
      roe,
      debtToEquity,
      revenueGrowth,
      earningsGrowth,
      operatingMargin,
      profitMargin,
      freeCashFlow,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      beta,
      fiveYear,
      cagr,
      spark,
      marketTime: firstFinite(summary?.price?.regularMarketTime, meta.regularMarketTime),
      delayedBy: firstFinite(meta.exchangeDataDelayedBy) || 0,
      missing,
      partial: missing.length > 0 || !short || !five,
      source: 'Yahoo Finance',
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Yahoo data unavailable' });
  }
}
