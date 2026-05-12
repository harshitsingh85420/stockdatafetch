// api/stock.js  –  CommonJS (no "type":"module" in package.json)
'use strict';

const { SMA, EMA, RSI, MACD, BollingerBands, ATR, ADX, OBV } = require('technicalindicators');
const cheerio = require('cheerio');
const xml2js  = require('xml2js');

// ─── Constants ────────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept'          : '*/*',
  'Accept-Language' : 'en-US,en;q=0.9'
};

const cache    = new Map();
const CACHE_TTL = 120 * 1000; // 2 minutes

// ─── NSE Cookie Session ───────────────────────────────────────────────────────

let nseCookies    = '';
let nseCookieTime = 0;

async function getNseCookies() {
  if (nseCookies && (Date.now() - nseCookieTime < 5 * 60 * 1000)) return nseCookies;
  try {
    const res = await fetch('https://www.nseindia.com', { headers: HEADERS });
    const raw = res.headers.get('set-cookie');
    if (raw) {
      nseCookies    = raw.split(',').map(c => c.split(';')[0]).join('; ');
      nseCookieTime = Date.now();
    }
  } catch (e) {
    console.error('NSE Cookie Error:', e.message);
  }
  return nseCookies;
}

async function fetchNSE(url, type = 'json') {
  const cookies = await getNseCookies();
  const res = await fetch(url, {
    headers: { ...HEADERS, Cookie: cookies }
  });
  if (!res.ok) throw new Error(`NSE ${url} → ${res.status}`);
  return type === 'json' ? res.json() : res.text();
}

// ─── A. Real-Time Quote ───────────────────────────────────────────────────────

async function getQuote(symbol, exchange) {
  // Try NSE first (unless exchange is explicitly 'bse')
  if (exchange !== 'bse') {
    try {
      const data      = await fetchNSE(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
      const priceInfo = data.priceInfo    || {};
      const metadata  = data.info         || {};
      const preOpen   = data.preOpenMarket|| {};
      const mktDept   = data.marketDeptOrderBook || {};

      const bid = mktDept.bid && mktDept.bid.length > 0
        ? { price: mktDept.bid[0].price, qty: mktDept.bid[0].quantity } : null;
      const ask = mktDept.ask && mktDept.ask.length > 0
        ? { price: mktDept.ask[0].price, qty: mktDept.ask[0].quantity } : null;

      return {
        source: 'nse',
        quote : {
          ltp               : priceInfo.lastPrice                    ?? null,
          open              : priceInfo.open                         ?? null,
          high              : priceInfo.intraDayHighLow?.max         ?? null,
          low               : priceInfo.intraDayHighLow?.min         ?? null,
          previousClose     : priceInfo.previousClose                ?? null,
          change            : priceInfo.change                       ?? null,
          pChange           : priceInfo.pChange                      ?? null,
          lowerCircuit      : priceInfo.lowerCP                      ?? null,
          upperCircuit      : priceInfo.upperCP                      ?? null,
          totalTradedVolume : preOpen.totalTradedVolume              ?? null,
          vwap              : priceInfo.vwap                         ?? null,
          bid, ask,
          week52High        : priceInfo.weekHighLow?.max             ?? null,
          week52Low         : priceInfo.weekHighLow?.min             ?? null,
          faceValue         : metadata.faceValue                     ?? null,
          lastUpdateTime    : data.metadata?.lastUpdateTime          ?? new Date().toISOString()
        }
      };
    } catch (e) {
      if (exchange === 'nse') throw e; // hard-fail if user specified NSE
      // otherwise fall through to BSE
    }
  }

  // BSE fallback
  const res  = await fetch(
    `https://api.bseindia.com/BseIndiaAPI/api/StockData/w?scripcode=${symbol}`,
    { headers: { ...HEADERS, Referer: 'https://www.bseindia.com/' } }
  );
  if (!res.ok) throw new Error('Quote fetch failed for both NSE and BSE');
  const data = await res.json();
  return {
    source: 'bse',
    quote : {
      ltp               : parseFloat(data.CurrentPr)  || null,
      open              : parseFloat(data.Open)        || null,
      high              : parseFloat(data.High)        || null,
      low               : parseFloat(data.Low)         || null,
      previousClose     : parseFloat(data.PrevClose)   || null,
      change            : parseFloat(data.Change)      || null,
      pChange           : parseFloat(data.pChange)     || null,
      lowerCircuit      : parseFloat(data.LowerCP)     || null,
      upperCircuit      : parseFloat(data.UpperCP)     || null,
      totalTradedVolume : parseFloat(data.Volume)      || null,
      vwap              : null,
      bid               : null,
      ask               : null,
      week52High        : parseFloat(data.Week52High)  || null,
      week52Low         : parseFloat(data.Week52Low)   || null,
      faceValue         : parseFloat(data.FaceValue)   || null,
      lastUpdateTime    : data.UpdatedOn               ?? new Date().toISOString()
    }
  };
}

// ─── B. Historical OHLCV via Daily Bhavcopy Archives (NSE & BSE official) ────
//
// The NSE `/api/historical/...` endpoint has been intermittently returning 503
// in 2026 — and the BSE `api.bseindia.com` host blocks datacenter IPs.
// The most reliable AUTHORITATIVE sources we have are NSE and BSE's own daily
// bhavcopy archives, which are plain CSV files published every trading day:
//
//   NSE: https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv
//   BSE: https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV
//
// Each file contains OHLCV for EVERY listed stock on that exchange that day.
// We fetch the last N trading days in parallel (batches of 10) and extract
// only the rows matching the requested symbol.

const BHAVCOPY_DAYS    = 60;   // ~3 trading months — gives SMA50, EMA50, all swing-trading indicators
const BHAVCOPY_PARALLEL = 10;  // batch size to keep within Vercel's 30-s budget

const NSE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parseNseDateString(s) {
  // "11-May-2026"  →  "2026-05-11"
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const month = NSE_MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return `${m[3]}-${String(month+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

function fmtDDMMYYYY(d) {
  return `${String(d.getDate()).padStart(2,'0')}${String(d.getMonth()+1).padStart(2,'0')}${d.getFullYear()}`;
}
function fmtYYYYMMDD(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function lastTradingDays(endDate, count) {
  // Walk backwards from endDate, skipping Sat/Sun, until we have `count` dates.
  // Holidays cannot be predicted, so we let the fetch return 404/HTML and we
  // simply drop those days from the result set.
  const days = [];
  const d = new Date(endDate);
  d.setHours(12, 0, 0, 0);  // avoid TZ edge cases
  // step back one extra day, because today's bhavcopy may not be posted yet
  d.setDate(d.getDate() - 1);
  let safety = 0;
  while (days.length < count && safety++ < count * 2 + 10) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return days;
}

function splitCsvLine(line) {
  // Simple split — bhavcopy CSVs don't use quoted commas
  return line.split(',').map(c => c.trim());
}

async function fetchNseBhavcopy(date) {
  const url = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${fmtDDMMYYYY(date)}.csv`;
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Referer: 'https://www.nseindia.com/' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) return null;   // 404 disguise (shouldn't happen for NSE archives, defensive)
    return await res.text();
  } catch { return null; }
}

async function fetchBseBhavcopy(date) {
  const url = `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${fmtYYYYMMDD(date)}_F_0000.CSV`;
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Referer: 'https://www.bseindia.com/' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    // BSE returns 200 with HTML when the file doesn't exist (weekend / holiday / future date)
    if (ct.includes('text/html')) return null;
    return await res.text();
  } catch { return null; }
}

function parseNseBhavcopyRow(csv, symbol) {
  if (!csv) return null;
  const lines  = csv.split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const iSym   = header.indexOf('SYMBOL');
  const iSer   = header.indexOf('SERIES');
  const iDate  = header.indexOf('DATE1');
  const iOpen  = header.indexOf('OPEN_PRICE');
  const iHigh  = header.indexOf('HIGH_PRICE');
  const iLow   = header.indexOf('LOW_PRICE');
  const iClose = header.indexOf('CLOSE_PRICE');
  const iVol   = header.indexOf('TTL_TRD_QNTY');
  const iDelQ  = header.indexOf('DELIV_QTY');
  const iDelP  = header.indexOf('DELIV_PER');
  if (iSym < 0 || iOpen < 0) return null;

  const upper = symbol.toUpperCase();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = splitCsvLine(lines[i]);
    if (c[iSym] !== upper) continue;
    if (!['EQ','BE','BZ','BL'].includes(c[iSer])) continue;  // equity-class series only
    return {
      date           : parseNseDateString(c[iDate]),
      open           : parseFloat(c[iOpen]),
      high           : parseFloat(c[iHigh]),
      low            : parseFloat(c[iLow]),
      close          : parseFloat(c[iClose]),
      volume         : parseInt(c[iVol], 10) || 0,
      deliveryQty    : iDelQ >= 0 ? (parseInt(c[iDelQ], 10) || null) : null,
      deliveryPercent: iDelP >= 0 ? (parseFloat(c[iDelP]) || null)   : null
    };
  }
  return null;
}

function parseBseBhavcopyRow(csv, symbol) {
  if (!csv) return null;
  const lines  = csv.split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const iSym   = header.indexOf('TckrSymb');
  const iScrip = header.indexOf('FinInstrmId');
  const iSeg   = header.indexOf('Sgmt');
  const iTp    = header.indexOf('FinInstrmTp');
  const iDate  = header.indexOf('TradDt');
  const iOpen  = header.indexOf('OpnPric');
  const iHigh  = header.indexOf('HghPric');
  const iLow   = header.indexOf('LwPric');
  const iClose = header.indexOf('ClsPric');
  const iVol   = header.indexOf('TtlTradgVol');
  if (iSym < 0 || iOpen < 0) return null;

  const upper     = symbol.toUpperCase();
  const isScrip   = /^\d+$/.test(symbol);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = splitCsvLine(lines[i]);
    if (iSeg >= 0 && c[iSeg] !== 'CM')  continue;   // cash market only
    if (iTp  >= 0 && c[iTp]  !== 'STK') continue;   // stocks, not derivatives
    const matches = isScrip ? c[iScrip] === symbol : c[iSym] === upper;
    if (!matches) continue;
    return {
      date  : c[iDate],   // already YYYY-MM-DD
      open  : parseFloat(c[iOpen]),
      high  : parseFloat(c[iHigh]),
      low   : parseFloat(c[iLow]),
      close : parseFloat(c[iClose]),
      volume: parseInt(c[iVol], 10) || 0,
      deliveryQty    : null,
      deliveryPercent: null
    };
  }
  return null;
}

async function fetchExchangeHistorical(exchange, symbol, dates) {
  const fetcher = exchange === 'bse' ? fetchBseBhavcopy : fetchNseBhavcopy;
  const parser  = exchange === 'bse' ? parseBseBhavcopyRow : parseNseBhavcopyRow;
  const rows    = [];

  // batched-parallel fetching to stay under the 30-s Vercel cap
  for (let i = 0; i < dates.length; i += BHAVCOPY_PARALLEL) {
    const batch = dates.slice(i, i + BHAVCOPY_PARALLEL);
    const csvs  = await Promise.all(batch.map(d => fetcher(d)));
    csvs.forEach((csv, j) => {
      const row = parser(csv, symbol);
      if (row && row.date) rows.push(row);
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function getHistorical(symbol, exchange, endDate) {
  const end   = endDate instanceof Date ? new Date(endDate) : new Date();
  const dates = lastTradingDays(end, BHAVCOPY_DAYS);

  // Caller passed exchange?  Only try that one.
  if (exchange === 'nse' || exchange === 'bse') {
    const rows = await fetchExchangeHistorical(exchange, symbol, dates);
    return { exchange, data: rows };
  }

  // Auto-detect: NSE first, then BSE only if NSE returned nothing
  const nseRows = await fetchExchangeHistorical('nse', symbol, dates);
  if (nseRows.length > 0) return { exchange: 'nse', data: nseRows };

  const bseRows = await fetchExchangeHistorical('bse', symbol, dates);
  return { exchange: 'bse', data: bseRows };
}

// ─── C. Technical Indicators ──────────────────────────────────────────────────

function computeIndicators(hist) {
  if (!hist || hist.length === 0) return { sma:{}, ema:{}, rsi14:null, macd:null, bollingerBands:null, atr14:null, adx14:null, obv:null, volumeSma20:null };

  const close  = hist.map(h => h.close);
  const high   = hist.map(h => h.high);
  const low    = hist.map(h => h.low);
  const volume = hist.map(h => h.volume);

  const last = arr => arr && arr.length ? arr[arr.length - 1] : null;

  const sma5   = SMA.calculate({ period:5,   values: close });
  const sma10  = SMA.calculate({ period:10,  values: close });
  const sma20  = SMA.calculate({ period:20,  values: close });
  const sma50  = SMA.calculate({ period:50,  values: close });
  const sma200 = SMA.calculate({ period:200, values: close });

  const ema5   = EMA.calculate({ period:5,   values: close });
  const ema10  = EMA.calculate({ period:10,  values: close });
  const ema20  = EMA.calculate({ period:20,  values: close });
  const ema50  = EMA.calculate({ period:50,  values: close });
  const ema200 = EMA.calculate({ period:200, values: close });

  const rsi14     = RSI.calculate({ period: 14, values: close });
  const macdArr   = MACD.calculate({ values: close, fastPeriod:12, slowPeriod:26, signalPeriod:9, SimpleMAOscillator:false, SimpleMASignal:false });
  const bbArr     = BollingerBands.calculate({ period:20, values: close, stdDev:2 });
  const atrArr    = ATR.calculate({ high, low, close, period:14 });
  const adxArr    = ADX.calculate({ high, low, close, period:14 });
  const obvArr    = OBV.calculate({ close, volume });
  const volSma20  = SMA.calculate({ period:20, values: volume });

  const latestMacd = last(macdArr);
  const latestBb   = last(bbArr);
  const latestAdx  = last(adxArr);

  // Pivot Points from previous day's HLC
  let pivots = null;
  if (hist.length >= 2) {
    const prev = hist[hist.length - 2];
    const p = (prev.high + prev.low + prev.close) / 3;
    pivots = {
      p  : parseFloat(p.toFixed(2)),
      r1 : parseFloat(((2 * p) - prev.low).toFixed(2)),
      r2 : parseFloat((p + (prev.high - prev.low)).toFixed(2)),
      r3 : parseFloat((prev.high + 2 * (p - prev.low)).toFixed(2)),
      s1 : parseFloat(((2 * p) - prev.high).toFixed(2)),
      s2 : parseFloat((p - (prev.high - prev.low)).toFixed(2)),
      s3 : parseFloat((prev.low - 2 * (prev.high - p)).toFixed(2))
    };
  }

  return {
    sma : { '5': last(sma5), '10': last(sma10), '20': last(sma20), '50': last(sma50), '200': last(sma200) },
    ema : { '5': last(ema5), '10': last(ema10), '20': last(ema20), '50': last(ema50), '200': last(ema200) },
    rsi14       : last(rsi14),
    macd        : latestMacd ? { macd: latestMacd.MACD, signal: latestMacd.signal, histogram: latestMacd.histogram } : null,
    bollingerBands: latestBb  ? { upper: latestBb.upper, middle: latestBb.middle, lower: latestBb.lower } : null,
    atr14       : last(atrArr),
    adx14       : latestAdx   ? { adx: latestAdx.adx, plusDI: latestAdx.pdi, minusDI: latestAdx.mdi } : null,
    obv         : last(obvArr),
    volumeSma20 : last(volSma20),
    pivots
  };
}

// ─── D. Candlestick Pattern Detection (inline – no external package) ──────────

function detectCandles(hist) {
  const result = { mostRecent: [], last5Days: [] };
  if (!hist || hist.length < 2) return result;

  const isBull = c => c.close > c.open;
  const isBear = c => c.close < c.open;

  for (let i = Math.max(1, hist.length - 5); i < hist.length; i++) {
    const curr = hist[i];
    const prev = hist[i - 1];

    const body      = Math.abs(curr.close - curr.open);
    const range     = curr.high - curr.low;
    const prevBody  = Math.abs(prev.close - prev.open);
    const topWick   = curr.high - Math.max(curr.open, curr.close);
    const botWick   = Math.min(curr.open, curr.close) - curr.low;
    const date      = curr.date;
    const matches   = [];

    // Doji
    if (range > 0 && body / range < 0.1)
      matches.push({ pattern: 'doji', date, confidence: 0.85 });

    // Use range-relative wick tolerance so tiny-body candles are handled correctly
    const smallUpperWick = range > 0 && topWick / range <= 0.15;  // upper wick ≤ 15 % of range
    const smallLowerWick = range > 0 && botWick / range <= 0.15;  // lower wick ≤ 15 % of range

    // Hammer  (long lower wick, small body at top, little/no upper wick)
    if (body > 0 && botWick >= 2 * body && smallUpperWick)
      matches.push({ pattern: 'hammer', date, confidence: 0.80 });

    // Inverted Hammer  (long upper wick, small body at bottom, little/no lower wick)
    if (body > 0 && topWick >= 2 * body && smallLowerWick)
      matches.push({ pattern: 'invertedHammer', date, confidence: 0.75 });

    // Shooting Star  (bearish, long upper wick, small lower wick)
    if (isBear(curr) && topWick >= 2 * body && smallLowerWick)
      matches.push({ pattern: 'shootingStar', date, confidence: 0.80 });

    // Hanging Man  (bullish shape, long lower wick, small upper wick)
    if (isBull(curr) && botWick >= 2 * body && smallUpperWick)
      matches.push({ pattern: 'hangingMan', date, confidence: 0.75 });

    // Bullish Engulfing
    if (isBear(prev) && isBull(curr) && curr.open < prev.close && curr.close > prev.open)
      matches.push({ pattern: 'bullishEngulfing', date, confidence: 0.90 });

    // Bearish Engulfing
    if (isBull(prev) && isBear(curr) && curr.open > prev.close && curr.close < prev.open)
      matches.push({ pattern: 'bearishEngulfing', date, confidence: 0.90 });

    // Bullish Harami  (small bullish inside large bearish)
    if (isBear(prev) && isBull(curr) && curr.open > prev.close && curr.close < prev.open && body < prevBody * 0.5)
      matches.push({ pattern: 'bullishHarami', date, confidence: 0.75 });

    // Bearish Harami
    if (isBull(prev) && isBear(curr) && curr.open < prev.close && curr.close > prev.open && body < prevBody * 0.5)
      matches.push({ pattern: 'bearishHarami', date, confidence: 0.75 });

    // Piercing Line
    if (isBear(prev) && isBull(curr) && curr.open < prev.low && curr.close > (prev.open + prev.close) / 2)
      matches.push({ pattern: 'piercingLine', date, confidence: 0.80 });

    // Dark Cloud Cover
    if (isBull(prev) && isBear(curr) && curr.open > prev.high && curr.close < (prev.open + prev.close) / 2)
      matches.push({ pattern: 'darkCloudCover', date, confidence: 0.80 });

    // Marubozu (body fills ≥95 % of range — no/tiny wicks)
    if (range > 0 && body / range >= 0.95) {
      if (isBull(curr)) matches.push({ pattern: 'bullishMarubozu', date, confidence: 0.85 });
      if (isBear(curr)) matches.push({ pattern: 'bearishMarubozu', date, confidence: 0.85 });
    }

    result.last5Days.push(...matches);
    if (i === hist.length - 1) result.mostRecent.push(...matches);
  }

  // Three White Soldiers / Three Black Crows  (need 3 candles)
  if (hist.length >= 3) {
    const [c1, c2, c3] = hist.slice(hist.length - 3);
    if ([c1,c2,c3].every(isBull) && c2.open > c1.open && c3.open > c2.open && c2.close > c1.close && c3.close > c2.close) {
      const m = { pattern: 'threeWhiteSoldiers', date: c3.date, confidence: 0.85 };
      result.mostRecent.push(m);
      result.last5Days.push(m);
    }
    if ([c1,c2,c3].every(isBear) && c2.open < c1.open && c3.open < c2.open && c2.close < c1.close && c3.close < c2.close) {
      const m = { pattern: 'threeBlackCrows', date: c3.date, confidence: 0.85 };
      result.mostRecent.push(m);
      result.last5Days.push(m);
    }
  }

  // Morning Star (3-candle reversal at bottom)
  if (hist.length >= 3) {
    const [c1, c2, c3] = hist.slice(hist.length - 3);
    const c1Body = Math.abs(c1.close - c1.open);
    const c3Body = Math.abs(c3.close - c3.open);
    if (isBear(c1) && Math.abs(c2.close - c2.open) < c1Body * 0.3 && isBull(c3) && c3Body > c1Body * 0.5) {
      const m = { pattern: 'morningstar', date: c3.date, confidence: 0.85 };
      result.mostRecent.push(m);
      result.last5Days.push(m);
    }
  }

  // Evening Star
  if (hist.length >= 3) {
    const [c1, c2, c3] = hist.slice(hist.length - 3);
    const c1Body = Math.abs(c1.close - c1.open);
    const c3Body = Math.abs(c3.close - c3.open);
    if (isBull(c1) && Math.abs(c2.close - c2.open) < c1Body * 0.3 && isBear(c3) && c3Body > c1Body * 0.5) {
      const m = { pattern: 'eveningStar', date: c3.date, confidence: 0.85 };
      result.mostRecent.push(m);
      result.last5Days.push(m);
    }
  }

  return result;
}

// ─── E. Chart Pattern Detection ───────────────────────────────────────────────

function detectChartPatterns(hist) {
  if (!hist || hist.length < 20) {
    return { doubleBottom: null, doubleTop: null, flag: null, headAndShoulders: null, triangle: null, cupAndHandle: null };
  }

  const closes = hist.map(h => h.close);
  const highs  = hist.map(h => h.high);
  const lows   = hist.map(h => h.low);
  const n      = closes.length;

  // Find local extrema
  const localLows  = [];
  const localHighs = [];
  for (let i = 2; i < n - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      localLows.push({ idx: i, val: lows[i] });
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      localHighs.push({ idx: i, val: highs[i] });
  }

  // Double Bottom
  let doubleBottom = null;
  if (localLows.length >= 2) {
    const [b1, b2] = localLows.slice(-2);
    if (Math.abs(b1.val - b2.val) / b1.val < 0.03 && b2.idx > b1.idx + 5) {
      const neckline = Math.max(...highs.slice(b1.idx, b2.idx));
      doubleBottom   = { present: true, neckline: parseFloat(neckline.toFixed(2)), target: parseFloat((neckline + (neckline - b2.val)).toFixed(2)), confidence: 0.75 };
    }
  }

  // Double Top
  let doubleTop = null;
  if (localHighs.length >= 2) {
    const [t1, t2] = localHighs.slice(-2);
    if (Math.abs(t1.val - t2.val) / t1.val < 0.03 && t2.idx > t1.idx + 5) {
      const neckline = Math.min(...lows.slice(t1.idx, t2.idx));
      doubleTop      = { present: true, neckline: parseFloat(neckline.toFixed(2)), target: parseFloat((neckline - (t2.val - neckline)).toFixed(2)), confidence: 0.75 };
    }
  }

  // Bullish Flag  (sharp rise followed by tight consolidation)
  let flag = null;
  if (n >= 20) {
    const pole        = closes.slice(n - 20, n - 10);
    const consolid    = closes.slice(n - 10);
    const poleReturn  = (pole[pole.length-1] - pole[0]) / pole[0];
    const consolidRange = (Math.max(...consolid) - Math.min(...consolid)) / consolid[0];
    if (poleReturn > 0.05 && consolidRange < 0.03) {
      flag = { present: true, type: 'bullish', target: parseFloat((closes[n-1] * (1 + poleReturn)).toFixed(2)), confidence: 0.70 };
    } else if (poleReturn < -0.05 && consolidRange < 0.03) {
      flag = { present: true, type: 'bearish', target: parseFloat((closes[n-1] * (1 + poleReturn)).toFixed(2)), confidence: 0.70 };
    }
  }

  return {
    doubleBottom,
    doubleTop,
    flag,
    headAndShoulders: null,   // complex – requires full detection algo; best-effort null
    triangle        : null,
    cupAndHandle    : null
  };
}

// ─── L. Derived Signals ───────────────────────────────────────────────────────

function computeSignals(hist, indicators) {
  const signals = [];
  if (!indicators || !hist || hist.length === 0) return signals;

  const ltp = hist[hist.length - 1].close;
  const { sma, ema, rsi14, macd, volumeSma20 } = indicators;
  const vol = hist[hist.length - 1].volume;

  // Trend
  if (sma['20'] && sma['50']) {
    if (ltp > sma['20'] && sma['20'] > sma['50'])
      signals.push({ type: 'trend', status: 'uptrend',   desc: 'Price > 20 SMA > 50 SMA' });
    else if (ltp < sma['20'] && sma['20'] < sma['50'])
      signals.push({ type: 'trend', status: 'downtrend', desc: 'Price < 20 SMA < 50 SMA' });
    else
      signals.push({ type: 'trend', status: 'sideways',  desc: 'Mixed SMA alignment' });
  }

  // Golden / Death Cross
  if (sma['50'] && sma['200']) {
    if (sma['50'] > sma['200'])
      signals.push({ type: 'crossover', status: 'goldenCross', desc: '50 SMA above 200 SMA' });
    else
      signals.push({ type: 'crossover', status: 'deathCross',  desc: '50 SMA below 200 SMA' });
  }

  // RSI
  if (rsi14 != null) {
    if (rsi14 < 30)      signals.push({ type: 'rsi', status: 'oversold',   desc: `RSI ${rsi14.toFixed(1)} – below 30` });
    else if (rsi14 > 70) signals.push({ type: 'rsi', status: 'overbought', desc: `RSI ${rsi14.toFixed(1)} – above 70` });
    else                 signals.push({ type: 'rsi', status: 'neutral',    desc: `RSI ${rsi14.toFixed(1)}` });
  }

  // MACD crossover
  if (macd) {
    if (macd.histogram > 0) signals.push({ type: 'macd', status: 'bullish', desc: 'MACD above signal line' });
    else                    signals.push({ type: 'macd', status: 'bearish', desc: 'MACD below signal line' });
  }

  // EMA 5/20 crossover
  if (ema['5'] && ema['20']) {
    if (ema['5'] > ema['20']) signals.push({ type: 'emaCrossover', status: 'bullish', desc: 'EMA5 above EMA20' });
    else                      signals.push({ type: 'emaCrossover', status: 'bearish', desc: 'EMA5 below EMA20' });
  }

  // Volume
  if (vol && volumeSma20) {
    if (vol > volumeSma20 * 1.5) signals.push({ type: 'volume', status: 'high', desc: 'Volume >1.5x 20-day average' });
    else if (vol < volumeSma20 * 0.5) signals.push({ type: 'volume', status: 'low', desc: 'Volume <0.5x 20-day average' });
    else signals.push({ type: 'volume', status: 'normal', desc: 'Volume near average' });
  }

  return signals;
}

// ─── F. Fundamentals ─────────────────────────────────────────────────────────

async function scrapeFundamentals(symbol) {
  // Best-effort: try to scrape Screener.in (public, no auth required)
  try {
    const url  = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;
    const res  = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`screener ${res.status}`);
    const html = await res.text();
    const $    = cheerio.load(html);

    const ratioMap = {};
    $('#top-ratios li').each((_, el) => {
      const name  = $(el).find('.name').text().trim().toLowerCase();
      const value = parseFloat($(el).find('.value, .number').first().text().replace(/[^\d.-]/g, ''));
      if (name && !isNaN(value)) ratioMap[name] = value;
    });

    return {
      pe                    : ratioMap['p/e']                      ?? null,
      pb                    : ratioMap['price to book value']       ?? null,
      epsTTM                : null,
      roe                   : ratioMap['return on equity']          ?? null,
      roce                  : ratioMap['roce']                      ?? null,
      debtToEquity          : ratioMap['debt to equity']            ?? null,
      netProfitMargin       : null,
      operatingProfitMargin : ratioMap['opm']                       ?? null,
      salesGrowth3Y         : null,
      profitGrowth3Y        : null,
      dividendYield         : ratioMap['dividend yield']            ?? null,
      bookValuePerShare     : ratioMap['book value']                ?? null,
      faceValue             : null,
      marketCapCr           : ratioMap['market cap']                ?? null,
      currentRatio          : null,
      promoterHolding       : null,
      fiiHolding            : null,
      diiHolding            : null,
      pledging              : null,
      lastFilingDate        : null,
      source                : 'screener.in'
    };
  } catch (e) {
    return {
      pe: null, pb: null, epsTTM: null, roe: null, roce: null, debtToEquity: null,
      netProfitMargin: null, operatingProfitMargin: null, salesGrowth3Y: null,
      profitGrowth3Y: null, dividendYield: null, bookValuePerShare: null,
      faceValue: null, marketCapCr: null, currentRatio: null,
      promoterHolding: null, fiiHolding: null, diiHolding: null,
      pledging: null, lastFilingDate: null, source: null
    };
  }
}

// ─── G. News & Corporate Announcements ───────────────────────────────────────

async function getNews(symbol) {
  try {
    const query = encodeURIComponent(`${symbol} stock India`);
    const res   = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`, { headers: HEADERS });
    const text  = await res.text();
    const result = await xml2js.parseStringPromise(text, { explicitArray: true });
    const items  = result?.rss?.channel?.[0]?.item ?? [];
    return items.slice(0, 5).map(item => ({
      headline  : item.title?.[0]   ?? null,
      url       : item.link?.[0]    ?? null,
      source    : 'googleNews',
      published : item.pubDate?.[0] ? new Date(item.pubDate[0]).toISOString() : null
    }));
  } catch (e) {
    return [];
  }
}

async function getAnnouncements(symbol) {
  try {
    const data = await fetchNSE(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`);
    if (Array.isArray(data) && data.length > 0) {
      return data.slice(0, 5).map(item => ({
        date    : item.anDt    ?? null,
        desc    : item.desc    ?? null,
        category: item.smName  ?? null
      }));
    }
  } catch (e) { /* ignore */ }
  return [];
}

// ─── H. Delivery & Block Deals ───────────────────────────────────────────────

async function getDelivery(symbol) {
  try {
    const data = await fetchNSE(`https://www.nseindia.com/api/security-wise-deliverable?symbol=${encodeURIComponent(symbol)}`);
    if (data?.data?.length > 0) {
      const latest = data.data[0];
      return {
        date              : latest.secDate,
        deliveryQuantity  : parseInt(latest.deliveryQuantity,    10)  || null,
        deliveryPercentage: parseFloat(latest.deliveryToTradedQuantity) || null
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function getBlockDeals(symbol) {
  try {
    const data = await fetchNSE('https://www.nseindia.com/api/block-deals');
    if (Array.isArray(data)) {
      const filtered = data.filter(d => d.symbol && d.symbol.toUpperCase() === symbol.toUpperCase());
      return filtered.slice(0, 3).map(d => ({
        date      : d.date    ?? null,
        buySell   : d.buySell ?? null,
        quantity  : d.qty     ?? null,
        price     : d.price   ?? null,
        client    : d.clientN ?? null
      }));
    }
  } catch (e) { /* ignore */ }
  return [];
}

// ─── I. Surveillance ─────────────────────────────────────────────────────────

async function getSurveillance(symbol) {
  try {
    const data = await fetchNSE('https://www.nseindia.com/api/asm');
    if (Array.isArray(data)) {
      const inAsm = data.some(d => d.symbol && d.symbol.toUpperCase() === symbol.toUpperCase());
      return { asm: inAsm, gsm: false, t2t: false, description: inAsm ? 'Under ASM' : null };
    }
  } catch (e) { /* ignore */ }
  return { asm: false, gsm: false, t2t: false, description: null };
}

// ─── J. F&O Data ─────────────────────────────────────────────────────────────

async function getFNO(symbol) {
  try {
    const deriv = await fetchNSE(`https://www.nseindia.com/api/quote-derivative?symbol=${encodeURIComponent(symbol)}`);
    if (!deriv || !deriv.stocks || deriv.stocks.length === 0) return { available: false, pcr: null, maxPain: null, iv: null, lotSize: null };

    const lotSize = deriv.stocks[0]?.marketDeptOrderBook?.tradeInfo?.marketLot ?? null;

    // Try option chain
    try {
      const oc       = await fetchNSE(`https://www.nseindia.com/api/option-chain-equities?symbol=${encodeURIComponent(symbol)}`);
      const records  = oc?.filtered?.data ?? [];
      let totalPutOI = 0, totalCallOI = 0;
      const strikePutOI  = {};
      const strikeCallOI = {};

      records.forEach(row => {
        if (row.PE) { totalPutOI  += row.PE.openInterest || 0; strikePutOI[row.strikePrice]  = (strikePutOI[row.strikePrice]  || 0) + row.PE.openInterest; }
        if (row.CE) { totalCallOI += row.CE.openInterest || 0; strikeCallOI[row.strikePrice] = (strikeCallOI[row.strikePrice] || 0) + row.CE.openInterest; }
      });

      // Max Pain
      const strikes = [...new Set(records.map(r => r.strikePrice))].sort((a,b) => a - b);
      let minPain = Infinity, maxPainStrike = null;
      strikes.forEach(strike => {
        const pain = strikes.reduce((sum, k) => {
          const callLoss = k < strike ? (strike - k) * (strikeCallOI[k] || 0) : 0;
          const putLoss  = k > strike ? (k - strike) * (strikePutOI[k]  || 0) : 0;
          return sum + callLoss + putLoss;
        }, 0);
        if (pain < minPain) { minPain = pain; maxPainStrike = strike; }
      });

      const pcr = totalCallOI > 0 ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : null;
      return { available: true, pcr, maxPain: maxPainStrike, iv: null, lotSize };
    } catch (e) {
      return { available: true, pcr: null, maxPain: null, iv: null, lotSize };
    }
  } catch (e) {
    return { available: false, pcr: null, maxPain: null, iv: null, lotSize: null };
  }
}

// ─── K. Sector ────────────────────────────────────────────────────────────────

async function getSector(symbol) {
  try {
    const data = await fetchNSE(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
    const industry = data?.info?.industry ?? null;
    return { name: industry, pe: null };
  } catch (e) {
    return { name: null, pe: null };
  }
}

// ─── Historical Quote Reconstruction (when date param is in the past) ────────

function buildHistoricalQuote(hist, asOfDateStr) {
  if (!hist || hist.length === 0) return null;
  // last entry whose date ≤ asOfDateStr
  const usable = hist.filter(h => h.date <= asOfDateStr);
  if (usable.length === 0) return null;
  const target  = usable[usable.length - 1];
  const prev    = usable.length >= 2 ? usable[usable.length - 2] : null;
  const prevClose = prev ? prev.close : null;
  const change    = prevClose != null ? parseFloat((target.close - prevClose).toFixed(2)) : null;
  const pChange   = prevClose != null && prevClose !== 0
    ? parseFloat((((target.close - prevClose) / prevClose) * 100).toFixed(2))
    : null;

  // 52-week extremes from the historical window passed in
  const week52High = Math.max(...hist.map(h => h.high));
  const week52Low  = Math.min(...hist.map(h => h.low));

  return {
    ltp               : target.close,
    open              : target.open,
    high              : target.high,
    low               : target.low,
    previousClose     : prevClose,
    change,
    pChange,
    lowerCircuit      : null,  // not available for historical dates
    upperCircuit      : null,
    totalTradedVolume : target.volume,
    vwap              : null,
    bid               : null,
    ask               : null,
    week52High,
    week52Low,
    faceValue         : null,
    lastUpdateTime    : target.date
  };
}

// ─── Date window filter for news / announcements ──────────────────────────────

function withinDateWindow(items, dateField, endDate, daysBack = 30) {
  if (!Array.isArray(items)) return [];
  const end   = new Date(endDate);
  const start = new Date(endDate);
  start.setDate(start.getDate() - daysBack);

  return items.filter(item => {
    const raw = item[dateField];
    if (!raw) return true;  // keep entries with no date
    const d = new Date(raw);
    if (isNaN(d.getTime())) return true;
    return d >= start && d <= end;
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { symbol = 'KRITINUT', exchange, date } = req.query;
  const upperSymbol = symbol.toUpperCase();

  // ── Parse & validate `date` parameter ────────────────────────────────────
  const todayStr = new Date().toISOString().split('T')[0];
  let requestedDate, requestedDateStr;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    requestedDate    = new Date(date + 'T00:00:00Z');
    requestedDateStr = date;
  } else {
    requestedDate    = new Date();
    requestedDateStr = todayStr;
  }
  const isHistorical = requestedDateStr < todayStr;
  const cacheKey     = `${upperSymbol}_${exchange || 'auto'}_${requestedDateStr}`;

  // ── Cache ────────────────────────────────────────────────────────────────
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      res.setHeader('Cache-Control', 'public, max-age=120');
      return res.status(200).json(cached.data);
    }
  }

  const errors = {};

  try {
    // ── 1. Historical first (bhavcopy archives, last 60 trading days) ─────
    const histResult = await getHistorical(upperSymbol, exchange, requestedDate)
      .catch(e => { errors.historical = e.message; return { exchange: exchange || null, data: [] }; });

    const detectedExchange = histResult.exchange || exchange || 'nse';
    const historical       = histResult.data.filter(h => h.date <= requestedDateStr);
    const actualDataDate   = historical.length > 0 ? historical[historical.length - 1].date : null;

    if (historical.length === 0 && !errors.historical) {
      errors.historical = `No bhavcopy rows found for ${upperSymbol} in last ${BHAVCOPY_DAYS} trading days on ${(exchange || 'auto').toUpperCase()}`;
    }

    // ── 2. Quote ──────────────────────────────────────────────────────────
    let quote, usedExchange;
    if (isHistorical) {
      // Past date — reconstruct quote from historical OHLCV
      quote        = buildHistoricalQuote(historical, requestedDateStr);
      usedExchange = detectedExchange;
      if (!quote) errors.quote = 'No historical data found for requested date';
    } else {
      // Live quote — try NSE first (its quote API is reliable), then BSE,
      // and finally fall back to the most recent bhavcopy row.
      try {
        const quoteData = await getQuote(upperSymbol, exchange || detectedExchange);
        quote           = quoteData.quote;
        usedExchange    = quoteData.source;
      } catch (e) {
        errors.quote = e.message;
        // Graceful fallback: derive quote from latest historical row
        if (historical.length > 0) {
          quote        = buildHistoricalQuote(historical, requestedDateStr);
          usedExchange = detectedExchange;
          if (quote) errors.quoteNote = 'Live quote unavailable; using latest bhavcopy row';
        } else {
          quote        = null;
          usedExchange = detectedExchange;
        }
      }
    }

    // ── 3. Everything else in parallel ────────────────────────────────────
    const [
      fundamentals, newsAll, announcementsAll,
      delivery, blockDeals, surveillance, fno, sector
    ] = await Promise.all([
      scrapeFundamentals(upperSymbol).catch(e => { errors.fundamentals  = e.message; return null; }),
      getNews(upperSymbol)           .catch(e => { errors.news          = e.message; return [];   }),
      getAnnouncements(upperSymbol)  .catch(e => { errors.announcements = e.message; return [];   }),
      getDelivery(upperSymbol)       .catch(e => { errors.delivery      = e.message; return null; }),
      getBlockDeals(upperSymbol)     .catch(e => { errors.blockDeals    = e.message; return [];   }),
      getSurveillance(upperSymbol)   .catch(e => { errors.surveillance  = e.message; return null; }),
      getFNO(upperSymbol)            .catch(e => { errors.fno           = e.message; return null; }),
      getSector(upperSymbol)         .catch(e => { errors.sector        = e.message; return null; })
    ]);

    // ── 4. Filter news / announcements by requested-date window ───────────
    const news          = isHistorical ? withinDateWindow(newsAll,          'published', requestedDate, 30) : newsAll;
    const announcements = isHistorical ? withinDateWindow(announcementsAll, 'date',      requestedDate, 30) : announcementsAll;

    // ── 5. Technicals — computed strictly on the sliced (≤ requestedDate) data ─
    const indicators                            = computeIndicators(historical);
    const { pivots, ...indicatorsWithoutPivots } = indicators;
    const candlePatterns                        = detectCandles(historical);
    const chartPatterns                         = detectChartPatterns(historical);
    const signals                               = computeSignals(historical, indicators);

    // ── 6. Build response ─────────────────────────────────────────────────
    const responseData = {
      meta: {
        symbol         : upperSymbol,
        exchange       : usedExchange,
        requestedDate  : requestedDateStr,
        actualDataDate : actualDataDate,
        timestamp      : new Date().toISOString()
      },
      quote,
      technicals: {
        historical,
        indicators : indicatorsWithoutPivots,
        pivots     : pivots ?? null,
        patterns   : { candles: candlePatterns, chart: chartPatterns },
        signals
      },
      fundamentals,
      news,
      announcements,
      delivery,
      blockDeals,
      surveillance,
      fno,
      sector,
      errors: Object.keys(errors).length > 0 ? errors : null
    };

    cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: error.message });
  }
};
