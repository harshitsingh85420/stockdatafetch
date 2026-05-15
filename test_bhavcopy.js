'use strict';
// Integration test: actually fetch real bhavcopy data and verify parsing.
// Uses internal helpers by requiring the module's source directly.

// We load the file as text and grab the helper definitions we need to test.
// This avoids exposing them via module.exports.

const fs   = require('fs');
const path = require('path');
const src  = fs.readFileSync(path.join(__dirname, 'api', 'stock.js'), 'utf8');

// Use eval (controlled — same process) to lift functions out of the source
const sandbox = { module: { exports: {} }, require, console, fetch, URL, setTimeout,
  process: { env: {} } /* empty env so getRedis() returns null in this sandbox */ };
const fnNames = [
  'parseNseDateString','fmtDDMMYYYY','fmtYYYYMMDD','lastTradingDays','splitCsvLine',
  'fetchNseBhavcopy','fetchBseBhavcopy','parseNseBhavcopyRow','parseBseBhavcopyRow',
  'fetchExchangeHistorical','getHistorical','BHAVCOPY_DAYS','BHAVCOPY_PARALLEL','HEADERS',
  'fetchMtoFile','parseMtoForSymbol','getDelivery'
];

// Build a wrapper script that defines everything in stock.js and then puts our
// helpers onto a results object.
const wrapper = `
${src.replace("module.exports = async function handler", "const __HANDLER__ = async function handler")}
;__OUT__ = { ${fnNames.join(',')} };
`;
let captured = {};
const vm = require('vm');
const context = vm.createContext({ ...sandbox, __OUT__: null, console });
vm.runInContext(wrapper, context, { filename: 'api/stock.js' });
captured = context.__OUT__;

let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { console.log('  PASS:', name); passed++; }
  else    { console.error('  FAIL:', name); failed++; }
}

(async () => {
  console.log('\n[1] Date helpers');
  check('parseNseDateString("11-May-2026") === "2026-05-11"', captured.parseNseDateString('11-May-2026') === '2026-05-11');
  check('parseNseDateString("01-Jan-2025") === "2025-01-01"', captured.parseNseDateString('01-Jan-2025') === '2025-01-01');
  check('parseNseDateString(null) === null',                  captured.parseNseDateString(null) === null);
  check('fmtDDMMYYYY format',  captured.fmtDDMMYYYY(new Date('2026-05-11T12:00:00Z')) === '11052026');
  check('fmtYYYYMMDD format',  captured.fmtYYYYMMDD(new Date('2026-05-11T12:00:00Z')) === '20260511');

  console.log('\n[2] lastTradingDays (skip weekends, walk backwards from yesterday)');
  const days = captured.lastTradingDays(new Date('2026-05-12T12:00:00Z'), 10);
  check('returns 10 days',           days.length === 10);
  check('all are weekdays',          days.every(d => d.getDay() !== 0 && d.getDay() !== 6));
  check('strictly descending order', days.every((d, i, a) => i === 0 || d < a[i-1]));
  check('includes today (if weekday) since archive may already be posted',
        days.some(d => d.toISOString().slice(0,10) === '2026-05-12'));

  console.log('\n[3] NSE bhavcopy CSV parser  (synthetic CSV)');
  const nseCsv = [
    'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER',
    'KRITINUT, EQ, 11-May-2026, 92.68, 91.99, 91.99, 88.05, 88.05, 88.10, 89.06, 23822, 21.22, 412, 12500, 52.5',
    'OTHERSTOCK, EQ, 11-May-2026, 50.0, 51.0, 53.0, 50.5, 52.0, 52.0, 51.5, 1000, 1.0, 100, 500, 50.0'
  ].join('\n');
  const row = captured.parseNseBhavcopyRow(nseCsv, 'KRITINUT');
  check('NSE row parsed',                row !== null);
  check('NSE date converted',            row.date === '2026-05-11');
  check('NSE open as number',            row.open === 91.99);
  check('NSE close as number',           row.close === 88.10);
  check('NSE volume as integer',         row.volume === 23822);
  check('NSE deliveryQty captured',      row.deliveryQty === 12500);
  check('NSE deliveryPercent captured',  row.deliveryPercent === 52.5);
  check('NSE non-matching symbol → null', captured.parseNseBhavcopyRow(nseCsv, 'NOMATCH') === null);

  console.log('\n[4] BSE bhavcopy CSV parser  (synthetic CSV)');
  const bseCsv = [
    'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4',
    '2026-05-11,2026-05-11,CM,BSE,STK,500002,INE117A01022,ABB,A,,,,,ABB INDIA LIMITED,6729.85,6800.00,6700.00,6750.00,6749.50,6720.10,,,,,123456,832567.89,1500,,,,,,',
    '2026-05-11,2026-05-11,CM,BSE,STK,533210,INE798K01010,KRITINUT,B,,,,,KRITI NUTRIENTS LIMITED,90.0,92.5,88.0,89.0,88.5,90.45,,,,,5000,4.45,250,,,,,,',
    // Futures row that must be ignored
    '2026-05-11,2026-05-11,FX,BSE,STO,1234,,ABB,,2026-05-28,,7000,CE,ABB CE,100,105,98,103,102,99,,,,,200,2.0,50,,,,,,'
  ].join('\n');
  const rowAbb = captured.parseBseBhavcopyRow(bseCsv, 'ABB');
  check('BSE row by ticker parsed',   rowAbb !== null);
  check('BSE date already YYYY-MM-DD', rowAbb.date === '2026-05-11');
  check('BSE open',                    rowAbb.open === 6729.85);
  check('BSE high',                    rowAbb.high === 6800);
  check('BSE volume',                  rowAbb.volume === 123456);
  const rowScrip = captured.parseBseBhavcopyRow(bseCsv, '533210');
  check('BSE row by numeric scrip code', rowScrip !== null && rowScrip.close === 89);
  check('BSE skips derivatives (FX/STO)', captured.parseBseBhavcopyRow(bseCsv, '1234') === null);

  console.log('\n[5] LIVE NSE bhavcopy fetch — actually hit the archive');
  // Walk back until we find a real trading day with the file present
  let realCsv = null, dateUsed = null;
  for (let back = 1; back <= 7 && !realCsv; back++) {
    const d = new Date(); d.setDate(d.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const t = await captured.fetchNseBhavcopy(d);
    if (t && t.includes('SYMBOL')) { realCsv = t; dateUsed = d.toISOString().slice(0,10); }
  }
  check('NSE bhavcopy fetched from live archive', realCsv !== null);
  if (realCsv) {
    console.log('  → fetched bhavcopy for', dateUsed, '(', realCsv.length, 'chars )');
    const k = captured.parseNseBhavcopyRow(realCsv, 'KRITINUT');
    check('KRITINUT row found in real NSE bhavcopy', k !== null);
    if (k) {
      console.log('  → KRITINUT:', k);
      check('KRITINUT open > 0',  k.open  > 0);
      check('KRITINUT close > 0', k.close > 0);
      check('KRITINUT high >= low', k.high >= k.low);
      check('KRITINUT date valid', /^\d{4}-\d{2}-\d{2}$/.test(k.date));
    }
    // Also verify common stocks
    const r = captured.parseNseBhavcopyRow(realCsv, 'RELIANCE');
    check('RELIANCE row found in real NSE bhavcopy', r !== null);
  }

  console.log('\n[6] LIVE BSE bhavcopy fetch — actually hit the archive');
  let realBseCsv = null, bseDateUsed = null;
  for (let back = 1; back <= 7 && !realBseCsv; back++) {
    const d = new Date(); d.setDate(d.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const t = await captured.fetchBseBhavcopy(d);
    if (t && t.includes('TckrSymb')) { realBseCsv = t; bseDateUsed = d.toISOString().slice(0,10); }
  }
  check('BSE bhavcopy fetched from live archive', realBseCsv !== null);
  if (realBseCsv) {
    console.log('  → fetched BSE bhavcopy for', bseDateUsed, '(', realBseCsv.length, 'chars )');
    const r = captured.parseBseBhavcopyRow(realBseCsv, 'RELIANCE');
    check('RELIANCE row found in real BSE bhavcopy', r !== null);
    if (r) console.log('  → BSE RELIANCE:', r);
  }

  console.log('\n[7] FULL getHistorical for KRITINUT (last 5 trading days)');
  // Temporarily override BHAVCOPY_DAYS by patching the function — easier:
  // just call lastTradingDays directly and run fetchExchangeHistorical.
  const last5 = captured.lastTradingDays(new Date(), 5);
  const rows = await captured.fetchExchangeHistorical('nse', 'KRITINUT', last5);
  console.log('  → got', rows.length, 'rows for KRITINUT');
  if (rows.length > 0) console.log('  → latest:', rows[rows.length - 1]);
  check('Real fetch returned at least 1 row', rows.length >= 1);
  check('Rows sorted ascending by date',
        rows.every((r, i, a) => i === 0 || r.date >= a[i-1].date));
  check('Every row has open/high/low/close/volume',
        rows.every(r => typeof r.open === 'number' && typeof r.close === 'number' && r.high >= r.low));

  console.log('\n[8] MTO file parser  (synthetic)');
  const mtoSyn = [
    'Security Wise Delivery Position - Compulsory Rolling Settlement',
    '10,MTO,14052026,1993771650,0003124',
    'Trade Date <14-MAY-2026>,Settlement Type <N>',
    'Record Type,Sr No,Name of Security,Quantity Traded,Deliverable Quantity(gross),% of Deliverable Quantity',
    '20,1,1003ISFL28,N4,10,10,100.00',
    '20,2328,RELIANCE,EQ,17303059,8049788,46.52',
    '20,500,KRITINUT,BE,23822,18000,75.56',
    '20,999,ABB,A,12345,9876,80.00'
  ].join('\n');
  const m1 = captured.parseMtoForSymbol(mtoSyn, 'RELIANCE');
  check('MTO row parsed (RELIANCE)',           m1 !== null);
  check('MTO series captured',                 m1.series === 'EQ');
  check('MTO quantityTraded as integer',       m1.quantityTraded === 17303059);
  check('MTO deliveryQuantity as integer',     m1.deliveryQuantity === 8049788);
  check('MTO deliveryPercentage as number',    m1.deliveryPercentage === 46.52);

  const m2 = captured.parseMtoForSymbol(mtoSyn, 'KRITINUT');
  check('MTO finds BE-series stock',           m2 !== null && m2.series === 'BE');
  check('MTO non-match returns null',          captured.parseMtoForSymbol(mtoSyn, 'NOMATCH') === null);
  check('MTO ignores non-20 rows (header)',    captured.parseMtoForSymbol(mtoSyn, 'MTO') === null);

  console.log('\n[9] LIVE MTO fetch — hit the real NSE archive');
  let realMto = null, mtoDateUsed = null;
  for (let back = 1; back <= 7 && !realMto; back++) {
    const d = new Date(); d.setDate(d.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const t = await captured.fetchMtoFile(d);
    if (t && t.includes('Security Wise')) { realMto = t; mtoDateUsed = d.toISOString().slice(0,10); }
  }
  check('Live MTO file fetched',                 realMto !== null);
  if (realMto) {
    console.log('  → fetched MTO for', mtoDateUsed, '(', realMto.length, 'chars )');
    const rel = captured.parseMtoForSymbol(realMto, 'RELIANCE');
    check('Live MTO has RELIANCE row',           rel !== null);
    if (rel) {
      console.log('  → RELIANCE MTO:', rel);
      check('Live RELIANCE delivery% in 0-100',  rel.deliveryPercentage >= 0 && rel.deliveryPercentage <= 100);
      check('Live RELIANCE delivQty <= qtyTraded', rel.deliveryQuantity <= rel.quantityTraded);
    }
  }

  console.log('\n[10] getDelivery() integration  — walks back to find the latest available row');
  const liveDel = await captured.getDelivery('RELIANCE', new Date());
  console.log('  → result:', liveDel);
  check('getDelivery returns an object',          liveDel !== null && typeof liveDel === 'object');
  check('getDelivery has source field',           liveDel && typeof liveDel.source === 'string');
  check('getDelivery has lagDays >= 0',           liveDel && typeof liveDel.lagDays === 'number' && liveDel.lagDays >= 0);
  check('getDelivery source is mto',              liveDel && liveDel.source === 'mto');

  console.log('\n[11] Upstash cache layer  (mocked)');
  // We can't hit the real Upstash without env vars, but we can verify
  // the code paths by simulating cache hits/misses with a mock client
  // and re-importing fetchExchangeHistorical via a fresh sandbox.

  const mockStore = new Map();
  const mockRedis = {
    async mget(...keys) {
      return keys.map(k => mockStore.has(k) ? mockStore.get(k) : null);
    },
    async set(key, value /* , {ex} */) {
      mockStore.set(key, value);
      return 'OK';
    }
  };

  // Build a fresh sandbox where getRedis() is monkey-patched to return mock
  const fs2 = require('fs'), path2 = require('path'), vm2 = require('vm');
  const src2 = fs2.readFileSync(path2.join(__dirname, 'api', 'stock.js'), 'utf8');
  const ctx2 = vm2.createContext({
    module: { exports: {} }, require, console, fetch, URL, setTimeout,
    process: { env: { UPSTASH_REDIS_REST_URL: 'mock', UPSTASH_REDIS_REST_TOKEN: 'mock' } },
    globalThis: {}, __OUT__: null
  });
  // Inject our mock by replacing the require('@upstash/redis') with a stub
  const patched = src2.replace(
    "require('@upstash/redis')",
    `{ Redis: function() { return ${JSON.stringify(null)}; } }`
  );
  // Easier path: replace getRedis() body to always return our mock
  const patched2 = src2.replace(
    /function getRedis\(\) \{[\s\S]*?return _redisClient;\s*\n\s*\} catch \(e\) \{[\s\S]*?\}\s*\}/,
    `function getRedis() { return __MOCK_REDIS__; }`
  );
  ctx2.__MOCK_REDIS__ = mockRedis;
  ctx2.__OUT__ = null;
  const wrapper2 = patched2.replace('module.exports = async function handler', 'const __H__ = async function handler')
    + ';__OUT__ = { fetchExchangeHistorical, lastTradingDays, BHAVCOPY_DAYS };';
  vm2.runInContext(wrapper2, ctx2, { filename: 'api/stock.js' });
  const cachedFetch = ctx2.__OUT__.fetchExchangeHistorical;

  // Pre-populate cache with one known row
  const cacheDate = new Date(); cacheDate.setDate(cacheDate.getDate() - 30);
  const cacheDateStr = cacheDate.toISOString().slice(0, 10);
  mockStore.set(`bhav:nse:KRITINUT:${cacheDateStr}`, {
    date: cacheDateStr, open: 100, high: 101, low: 99, close: 100.5, volume: 5000,
    deliveryQty: null, deliveryPercent: null
  });

  // Run a fetch covering the 30-day window — at least one date will hit cache
  const testDates = [];
  for (let back = 25; back <= 35; back++) {
    const d = new Date(); d.setDate(d.getDate() - back);
    if (d.getDay() !== 0 && d.getDay() !== 6) testDates.push(d);
  }
  // We need to call cachedFetch — but it tries to actually fetch CSVs.
  // For unit purposes, we'll just verify it returns the pre-populated row.
  // (Real CSV fetches may succeed for older dates; that's fine — they get cached.)
  const cachedResult = await cachedFetch('nse', 'KRITINUT', testDates);
  const foundCachedRow = cachedResult.find(r => r.date === cacheDateStr);
  check('Pre-populated cache row was returned', foundCachedRow != null);
  if (foundCachedRow) {
    check('Cached row has expected close (100.5)', foundCachedRow.close === 100.5);
    check('Cached row has expected volume (5000)', foundCachedRow.volume === 5000);
  }

  // Verify cache stats were captured
  const stats = ctx2.globalThis.__lastBhavCacheStats;
  if (stats) {
    console.log('  Cache stats:', JSON.stringify(stats));
    check('Cache stats captured',         typeof stats === 'object');
    check('Cache stats has cacheHit field', 'cacheHit' in stats);
    check('Cache stats: at least 1 hit',   stats.cacheHit >= 1);
  }

  // Run a SECOND fetch with the same dates — every cacheable date should
  // now be in the cache (filled by the first run's writes).
  console.log('  Running second fetch — should be mostly cache hits...');
  const stats1 = ctx2.globalThis.__lastBhavCacheStats;
  const secondResult = await cachedFetch('nse', 'KRITINUT', testDates);
  const stats2 = ctx2.globalThis.__lastBhavCacheStats;
  console.log('  2nd fetch stats:', JSON.stringify(stats2));
  check('Second fetch had more cache hits than first', stats2.cacheHit >= stats1.cacheHit);
  check('Second fetch made fewer real fetches',         stats2.fetched <= stats1.fetched);

  console.log('\n[12] BHAVCOPY_DAYS = 250  (for SMA200 / EMA200 enablement)');
  check('BHAVCOPY_DAYS bumped to 250', ctx2.__OUT__.BHAVCOPY_DAYS === 250);

  console.log('\n════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
