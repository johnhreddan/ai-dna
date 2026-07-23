const YAHOO = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (compatible; AI-DNA/2.0; +https://ai-dna-mu.vercel.app)';
function latestRaw(series, keys) { for (const key of keys) { const row = series.find(x => x && (x.meta?.type === key || Object.prototype.hasOwnProperty.call(x, key))); const values = row?.[key]; if (Array.isArray(values) && values.length) { const item = values[values.length - 1]; const value = item?.reportedValue?.raw ?? item?.raw ?? item; if (Number.isFinite(Number(value))) return Number(value); } } return null; }
async function yahooJson(url) { const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } }); if (!response.ok) throw new Error(`Yahoo returned ${response.status}`); return response.json(); }
export default async function handler(req, res) {
 res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
 const symbol = String(req.query.symbol || '').trim().toUpperCase(); if (!/^[A-Z0-9.^=\-]{1,20}$/.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
 try {
  const now=Math.floor(Date.now()/1000), start=now-400*24*60*60;
  const types=['trailingPe','trailingEps','returnOnEquity','debtToEquity','annualReturnOnEquity','quarterlyReturnOnEquity','annualTotalDebtEquity','quarterlyTotalDebtEquity'];
  const typeParams=types.map(t=>`type=${encodeURIComponent(t)}`).join('&');
  const chart5y=`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  const chart5d=`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=30m&includeAdjustedClose=true`;
  const fundamentals=`${YAHOO}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&${typeParams}&period1=${start}&period2=${now}`;
  const [five,short,fund]=await Promise.allSettled([yahooJson(chart5y),yahooJson(chart5d),yahooJson(fundamentals)]); if(five.status!=='fulfilled')throw five.reason;
  const result=five.value?.chart?.result?.[0]; if(!result)throw new Error('Symbol not found'); const meta=result.meta||{}, quote=result.indicators?.quote?.[0]||{};
  const adjusted=result.indicators?.adjclose?.[0]?.adjclose||quote.close||[], valid=adjusted.filter(Number.isFinite), first=valid[0]??null, last=meta.regularMarketPrice??valid.at(-1)??null;
  const fiveYear=first&&last?((last/first)-1)*100:null, cagr=first&&last?(Math.pow(last/first,1/5)-1)*100:null;
  const series=fund.status==='fulfilled'?(fund.value?.timeseries?.result||[]):[]; const pe=latestRaw(series,['trailingPe']), eps=latestRaw(series,['trailingEps']);
  let roe=latestRaw(series,['returnOnEquity','annualReturnOnEquity','quarterlyReturnOnEquity']), de=latestRaw(series,['debtToEquity','annualTotalDebtEquity','quarterlyTotalDebtEquity']); if(roe!==null&&Math.abs(roe)<=2)roe*=100;if(de!==null&&Math.abs(de)>10)de/=100;
  const sr=short.status==='fulfilled'?short.value?.chart?.result?.[0]:null; const spark=(sr?.indicators?.quote?.[0]?.close||[]).filter(Number.isFinite); const prev=meta.chartPreviousClose??meta.previousClose??null; const change=last!=null&&prev!=null?last-prev:null, changePercent=change!=null&&prev?change/prev*100:null;
  return res.status(200).json({symbol,price:last,currency:meta.currency||'USD',exchange:meta.exchangeName||meta.fullExchangeName||'',change,changePercent,pe,eps,roe,de,fiveYear,cagr,spark:spark.length>80?spark.filter((_,i)=>i%Math.ceil(spark.length/80)===0):spark,marketTime:meta.regularMarketTime||null,delayedBy:meta.exchangeDataDelayedBy||0,source:'Yahoo Finance'});
 } catch(error){return res.status(502).json({error:error.message||'Yahoo data unavailable'});}
}
