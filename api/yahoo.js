const YAHOO = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (compatible; AI-DNA/2.1; +https://ai-dna-mu.vercel.app)';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function latestRaw(series, keys) {
  for (const key of keys) {
    const rows = series.filter((item) => item && (item.meta?.type === key || Object.prototype.hasOwnProperty.call(item, key)));
    for (const row of rows) {
      const values = row?.[key];
      if (!Array.isArray(values)) continue;
      for (let i = values.length - 1; i >= 0; i -= 1) {
        const item = values[i];
        const value = item?.reportedValue?.raw ?? item?.raw ?? item;
        const n = finite(value);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

async function yahooJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json,text/plain,*/*',
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Yahoo returned an unreadable response');
  }
}

function chartResult(payload) {
  return payload?.chart?.result?.[0] || null;
}

function validPrices(result) {
  const quote = result?.indicators?.quote?.[0] || {};
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose || quote.close || [];
  return adjusted.map(finite).filter((value) => value !== null);
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
      'trailingPe',
      'trailingEps',
      'annualDilutedEPS',
      'quarterlyDilutedEPS',
      'returnOnEquity',
      'annualReturnOnEquity',
      'quarterlyReturnOnEquity',
      'debtToEquity',
      'annualTotalDebtEquity',
      'quarterlyTotalDebtEquity',
    ];
    const typeParams = types.map((type) => `type=${encodeURIComponent(type)}`).join('&');

    const shortUrl = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=30m&events=div%2Csplits&includeAdjustedClose=true`;
    const fiveYearUrl = `${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
    const fundamentalsUrl = `${YAHOO}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&${typeParams}&period1=${fundamentalsStart}&period2=${now}`;

    const [shortSettled, fiveSettled, fundamentalsSettled] = await Promise.allSettled([
      yahooJson(shortUrl),
      yahooJson(fiveYearUrl),
      yahooJson(fundamentalsUrl),
    ]);

    const short = shortSettled.status === 'fulfilled' ? chartResult(shortSettled.value) : null;
    const five = fiveSettled.status === 'fulfilled' ? chartResult(fiveSettled.value) : null;
    if (!short && !five) throw new Error('Symbol not found or temporarily unavailable');

    const primary = short || five;
    const meta = primary?.meta || {};
    const shortPrices = validPrices(short);
    const fivePrices = validPrices(five);

    const price = finite(meta.regularMarketPrice) ?? shortPrices.at(-1) ?? fivePrices.at(-1) ?? null;
    const previousClose =
      finite(meta.regularMarketPreviousClose) ??
      finite(meta.chartPreviousClose) ??
      (shortPrices.length > 1 ? shortPrices[shortPrices.length - 2] : null);

    const change = price !== null && previousClose !== null ? price - previousClose : null;
    const changePercent = change !== null && previousClose ? (change / previousClose) * 100 : null;

    const firstFive = fivePrices[0] ?? null;
    const lastFive = fivePrices.at(-1) ?? price;
    const fiveYear = firstFive && lastFive ? ((lastFive / firstFive) - 1) * 100 : null;
    const cagr = firstFive && lastFive ? (Math.pow(lastFive / firstFive, 1 / 5) - 1) * 100 : null;

    const series = fundamentalsSettled.status === 'fulfilled'
      ? fundamentalsSettled.value?.timeseries?.result || []
      : [];

    let eps = latestRaw(series, ['trailingEps', 'annualDilutedEPS', 'quarterlyDilutedEPS']);
    let pe = latestRaw(series, ['trailingPe']);
    let roe = latestRaw(series, ['returnOnEquity', 'annualReturnOnEquity', 'quarterlyReturnOnEquity']);
    let debtToEquity = latestRaw(series, ['debtToEquity', 'annualTotalDebtEquity', 'quarterlyTotalDebtEquity']);

    if (pe === null && eps !== null && eps > 0 && price !== null) pe = price / eps;
    if (roe !== null && Math.abs(roe) <= 2) roe *= 100;
    if (debtToEquity !== null && Math.abs(debtToEquity) > 10) debtToEquity /= 100;

    const spark = shortPrices.length > 80
      ? shortPrices.filter((_, index) => index % Math.ceil(shortPrices.length / 80) === 0)
      : shortPrices;

    return res.status(200).json({
      symbol,
      price,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || meta.fullExchangeName || '',
      change,
      changePercent,
      pe,
      eps,
      roe,
      de: debtToEquity,
      fiveYear,
      cagr,
      spark,
      marketTime: meta.regularMarketTime || null,
      delayedBy: meta.exchangeDataDelayedBy || 0,
      partial: !short || !five || fundamentalsSettled.status !== 'fulfilled',
      source: 'Yahoo Finance',
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Yahoo data unavailable' });
  }
}
