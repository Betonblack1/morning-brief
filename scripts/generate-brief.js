import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "data");

const FINNHUB_KEY   = process.env.FINNHUB_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MASSIVE_KEY   = process.env.MASSIVE_API_KEY;

if (!FINNHUB_KEY)   throw new Error("Missing FINNHUB_API_KEY");
if (!ANTHROPIC_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
if (!MASSIVE_KEY)   throw new Error("Missing MASSIVE_API_KEY");

const FH_BASE  = "https://finnhub.io/api/v1";
const MV_BASE  = "https://api.massive.com/v2";

function wait(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function fh(endpoint, params) {
  params = params || {};
  const url = new URL(FH_BASE + endpoint);
  url.searchParams.set("token", FINNHUB_KEY);
  for (const k of Object.keys(params)) url.searchParams.set(k, params[k]);
  const resp = await fetch(url.toString());
  if (!resp.ok) { console.error("Finnhub error " + resp.status + " on " + endpoint); return null; }
  return resp.json();
}

async function mv(endpoint, params) {
  params = params || {};
  const url = new URL(MV_BASE + endpoint);
  for (const k of Object.keys(params)) url.searchParams.set(k, params[k]);
  const resp = await fetch(url.toString(), {
    headers: { "Authorization": "Bearer " + MASSIVE_KEY }
  });
  if (!resp.ok) { console.error("Massive error " + resp.status + " on " + endpoint); return null; }
  return resp.json();
}

function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcSMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function proximityPct(price, ma) {
  if (!ma || ma === 0) return null;
  return ((price - ma) / ma) * 100;
}

function gradeProximity(pct) {
  if (pct === null) return "unknown";
  const abs = Math.abs(pct);
  if (pct > 0 && abs <= 3)  return "zone";
  if (pct > 0 && abs <= 8)  return "approaching";
  if (pct < 0 && abs <= 2)  return "zone";
  return "extended";
}

const SECTOR_PILLARS = [
  { sector: "Technology",    tickers: ["NVDA","MSFT","AAPL","META","AMD"] },
  { sector: "Semis",         tickers: ["ARM","AVGO","ANET","MRVL","AMAT"] },
  { sector: "Financials",    tickers: ["JPM","GS","V","MA"] },
  { sector: "Cons Cyclical", tickers: ["AMZN","TSLA","HD"] },
  { sector: "Industrials",   tickers: ["GE","CAT","RTX"] },
  { sector: "Energy",        tickers: ["XOM","CVX"] },
  { sector: "Healthcare",    tickers: ["UNH","LLY","ABBV"] },
  { sector: "Communication", tickers: ["GOOGL","NFLX"] },
  { sector: "Defense",       tickers: ["LMT","NOC","RKLB"] }
];

const ON_THE_MOVE = [
  { sector: "Semis",     tickers: ["NVDA","AMD","ARM","AVGO","MRVL","AMAT"] },
  { sector: "Photonics", tickers: ["COHR","LITE","NPAB","IIVI"] },
  { sector: "Memory",    tickers: ["MU","WDC","NAND"] },
  { sector: "Space",     tickers: ["RKLB","ASTS","RDW","LUNR"] },
  { sector: "Drones",    tickers: ["JOBY","ACHR","ONDS","UMAC"] },
  { sector: "Defense",   tickers: ["LMT","NOC","RTX","PLTR"] }
];

// ─────────────────────────────────────────────────────────────
// FETCH SINGLE TICKER — live price from Finnhub + MAs from Massive
// ─────────────────────────────────────────────────────────────
async function fetchTickerData(ticker) {
  try {
    const toDate   = new Date().toISOString().split("T")[0];
    const fromDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Fetch candles (for MA calc) and live quote in parallel
    const [candleData, quoteData] = await Promise.all([
      mv("/aggs/ticker/" + ticker + "/range/1/day/" + fromDate + "/" + toDate, {
        adjusted: "true",
        sort: "asc",
        limit: "60"
      }),
      fh("/quote", { symbol: ticker })
    ]);

    if (!candleData || !candleData.results || candleData.results.length < 22) {
      console.log("  Skipping " + ticker + " — not enough candle data");
      return null;
    }

    // ── LIVE price + change from Finnhub quote ──
    // q.c = current price, q.dp = % change from prev close (LIVE intraday)
    const price     = quoteData && quoteData.c ? quoteData.c : candleData.results[candleData.results.length - 1].c;
    const changePct = quoteData && quoteData.dp != null ? quoteData.dp : 0;
    const volume    = quoteData && quoteData.v  ? quoteData.v  : candleData.results[candleData.results.length - 1].v;

    // ── MAs from historical daily closes ──
    const closes = candleData.results.map(r => r.c);
    const ema21  = calcEMA(closes, 21);
    const sma50  = calcSMA(closes, 50);

    const pct21 = proximityPct(price, ema21);
    const pct50 = proximityPct(price, sma50);

    const closerPct = (pct21 !== null && pct50 !== null)
      ? (Math.abs(pct21) < Math.abs(pct50) ? pct21 : pct50)
      : (pct21 !== null ? pct21 : pct50);

    const grade = gradeProximity(closerPct);

    return {
      ticker,
      price:     parseFloat(price.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(2)),
      volume,
      ema21:     ema21 ? parseFloat(ema21.toFixed(2)) : null,
      sma50:     sma50 ? parseFloat(sma50.toFixed(2)) : null,
      pct21:     pct21 ? parseFloat(pct21.toFixed(2)) : null,
      pct50:     pct50 ? parseFloat(pct50.toFixed(2)) : null,
      grade
    };
  } catch(err) {
    console.error("  Error fetching " + ticker + ": " + err.message);
    return null;
  }
}

async function fetchWatchlist() {
  console.log("Fetching watchlist data...");

  const allTickers = new Set();
  SECTOR_PILLARS.forEach(s => s.tickers.forEach(t => allTickers.add(t)));
  ON_THE_MOVE.forEach(s => s.tickers.forEach(t => allTickers.add(t)));

  const tickerData = {};
  for (const ticker of allTickers) {
    console.log("  Fetching " + ticker + "...");
    const data = await fetchTickerData(ticker);
    if (data) tickerData[ticker] = data;
    await wait(400);
  }

  const pillars = SECTOR_PILLARS.map(s => ({
    sector: s.sector,
    stocks: s.tickers
      .map(t => tickerData[t])
      .filter(Boolean)
      .sort((a, b) => {
        const order = { zone: 0, approaching: 1, extended: 2, unknown: 3 };
        return (order[a.grade] || 3) - (order[b.grade] || 3);
      })
  }));

  const onTheMove = ON_THE_MOVE.map(s => ({
    sector: s.sector,
    stocks: s.tickers
      .map(t => tickerData[t])
      .filter(Boolean)
      .sort((a, b) => {
        const order = { zone: 0, approaching: 1, extended: 2, unknown: 3 };
        return (order[a.grade] || 3) - (order[b.grade] || 3);
      })
  }));

  const zoneCount = Object.values(tickerData).filter(t => t.grade === "zone").length;
  console.log("Watchlist complete. " + Object.keys(tickerData).length + " tickers. " + zoneCount + " in zone.");

  return { pillars, onTheMove };
}

async function fetchQuotes() {
  const symbols = [
    { symbol: "SPY",  name: "S&P 500" },
    { symbol: "QQQ",  name: "NASDAQ" },
    { symbol: "DIA",  name: "DOW" },
    { symbol: "IWM",  name: "RUSSELL" },
    { symbol: "XLK",  name: "Tech" },
    { symbol: "XLV",  name: "Health" },
    { symbol: "XLF",  name: "Financials" },
    { symbol: "XLE",  name: "Energy" },
    { symbol: "XLY",  name: "Cons Disc" },
    { symbol: "XLI",  name: "Industrials" },
    { symbol: "XLB",  name: "Materials" },
    { symbol: "XLRE", name: "Real Estate" },
    { symbol: "XLU",  name: "Utilities" },
    { symbol: "XLP",  name: "Cons Staples" },
    { symbol: "XLC",  name: "Comm Svcs" }
  ];
  const results = {};
  for (let i = 0; i < symbols.length; i++) {
    const item = symbols[i];
    const q = await fh("/quote", { symbol: item.symbol });
    if (q) {
      results[item.symbol] = {
        name: item.name, symbol: item.symbol,
        current: q.c, open: q.o, high: q.h, low: q.l,
        prevClose: q.pc, change: q.d, changePct: q.dp
      };
    }
    await wait(200);
  }
  return results;
}

async function fetchVIX() {
  const q = await fh("/quote", { symbol: "VXX" });
  if (q) return { name: "VIX", symbol: "VXX", current: q.c, changePct: q.dp };
  return null;
}

async function fetchNews() {
  const news = await fh("/news", { category: "general", minId: 0 });
  if (!news || !Array.isArray(news)) return [];
  var out = [];
  for (var i = 0; i < Math.min(news.length, 12); i++) {
    var n = news[i];
    out.push({
      headline: n.headline, source: n.source,
      summary: n.summary ? n.summary.slice(0, 200) : "",
      url: n.url,
      datetime: new Date(n.datetime * 1000).toISOString(),
      category: n.category
    });
  }
  return out;
}

async function fetchEarnings() {
  const today = new Date().toISOString().split("T")[0];
  const earnings = await fh("/calendar/earnings", { from: today, to: today });
  if (!earnings || !earnings.earningsCalendar) return [];
  var out = [];
  var cal = earnings.earningsCalendar;
  for (var i = 0; i < Math.min(cal.length, 10); i++) {
    var e = cal[i];
    out.push({
      symbol: e.symbol,
      hour: e.hour === "bmo" ? "BMO" : e.hour === "amc" ? "AMC" : e.hour,
      epsEstimate: e.epsEstimate,
      revenueEstimate: e.revenueEstimate
    });
  }
  return out;
}

async function fetchEconCalendar() {
  const today = new Date().toISOString().split("T")[0];
  const cal = await fh("/calendar/economic", { from: today, to: today });
  if (!cal || !cal.economicCalendar) return [];
  var out = [];
  var items = cal.economicCalendar;
  for (var i = 0; i < items.length; i++) {
    var e = items[i];
    if (e.country === "US" && out.length < 8) {
      out.push({
        time: e.time || "TBD",
        event: e.event,
        impact: e.impact <= 1 ? "low" : e.impact === 2 ? "med" : "high",
        estimate: e.estimate,
        prev: e.prev
      });
    }
  }
  return out;
}

async function generateBrief(marketData) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const { quotes, vix, news, earnings, econ } = marketData;

  var indexLines = [];
  var indexSymbols = ["SPY", "QQQ", "DIA", "IWM"];
  for (var i = 0; i < indexSymbols.length; i++) {
    var s = indexSymbols[i];
    var q = quotes[s];
    if (q) {
      var sign = q.changePct >= 0 ? "+" : "";
      indexLines.push(q.name + " (" + s + "): $" + q.current + " (" + sign + (q.changePct ? q.changePct.toFixed(2) : "0") + "%)");
    }
  }

  var sectorLines = [];
  for (const sym of Object.keys(quotes)) {
    if (["SPY","QQQ","DIA","IWM","VXX"].indexOf(sym) === -1) {
      var q = quotes[sym];
      var sign = q.changePct >= 0 ? "+" : "";
      sectorLines.push(q.name + " (" + q.symbol + "): " + sign + (q.changePct ? q.changePct.toFixed(2) : "0") + "%");
    }
  }

  var newsLines = [];
  for (var i = 0; i < Math.min(news.length, 8); i++) newsLines.push("- " + news[i].headline + " (" + news[i].source + ")");

  var earnLines = [];
  for (var i = 0; i < earnings.length; i++) {
    var e = earnings[i];
    earnLines.push(e.symbol + " (" + e.hour + ") - EPS Est: " + (e.epsEstimate != null ? e.epsEstimate : "N/A"));
  }

  var econLines = [];
  for (var i = 0; i < econ.length; i++) {
    var e = econ[i];
    econLines.push(e.time + ": " + e.event + " (Impact: " + e.impact + ")");
  }

  var todayStr = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  var vixLine = "";
  if (vix) {
    var vSign = vix.changePct >= 0 ? "+" : "";
    vixLine = "VIX: " + vix.current + " (" + vSign + (vix.changePct ? vix.changePct.toFixed(2) : "0") + "%)";
  }

  var prompt = "You are a senior market analyst writing a concise morning brief for an active trader. Today is " + todayStr + ".\n\n";
  prompt += "Here is today's pre-market data:\n\n";
  prompt += "## INDEX QUOTES\n" + indexLines.join("\n") + "\n" + vixLine + "\n\n";
  prompt += "## SECTOR PERFORMANCE (Pre-Market)\n" + sectorLines.join("\n") + "\n\n";
  prompt += "## TODAY'S NEWS HEADLINES\n" + (newsLines.join("\n") || "No major headlines yet.") + "\n\n";
  prompt += "## EARNINGS TODAY\n" + (earnLines.join("\n") || "No major earnings today.") + "\n\n";
  prompt += "## ECONOMIC CALENDAR\n" + (econLines.join("\n") || "No major economic events today.") + "\n\n";
  prompt += 'Write a morning brief using this EXACT HTML structure. Keep it punchy, actionable, and under 600 words. No fluff. Write like a seasoned trader talks — direct, informed, no hedging.\n\n';
  prompt += 'Use these exact HTML elements:\n\n';
  prompt += '<h2><span class="sec-icon">◆</span> Market Overview</h2>\n';
  prompt += '- 2-3 sentences on the overall setup. Reference specific numbers.\n\n';
  prompt += '<h2><span class="sec-icon">◆</span> What to Watch</h2>\n';
  prompt += '- Use <ul><li> for 3-4 bullet points on key events/data/earnings today\n';
  prompt += '- Bold the event name with <strong>\n\n';
  prompt += '<h2><span class="sec-icon">◆</span> Sector Rotation</h2>\n';
  prompt += '- 2-3 sentences on which sectors are leading/lagging and why\n\n';
  prompt += 'Add 1-2 callout boxes using this format:\n';
  prompt += '<div class="callout callout-green"><div class="callout-label">✦ Bull Case</div>Text here</div>\n';
  prompt += '<div class="callout callout-red"><div class="callout-label">⚠ Bear Case</div>Text here</div>\n';
  prompt += '<div class="callout callout-amber"><div class="callout-label">⚡ Key Driver</div>Text here</div>\n\n';
  prompt += '<h2><span class="sec-icon">◆</span> Levels That Matter</h2>\n';
  prompt += '- Use <ul><li> for 3-4 key support/resistance/trigger levels\n\n';
  prompt += 'End with:\n<hr>\n<p><em>Not a prediction. A preparation. Make your plan before the bell.</em></p>\n\n';
  prompt += 'Output ONLY the HTML. No markdown. No code fences. No explanation.';

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }]
  });
  return response.content[0].text;
}

async function main() {
  console.log("=== Morning Brief Generator ===");
  console.log("Starting data fetch...");

  var results = await Promise.all([
    fetchQuotes(),
    fetchVIX(),
    fetchNews(),
    fetchEarnings(),
    fetchEconCalendar()
  ]);

  var quotes   = results[0];
  var vix      = results[1];
  var news     = results[2];
  var earnings = results[3];
  var econ     = results[4];

  console.log("Finnhub: " + Object.keys(quotes).length + " quotes, " + news.length + " news, " + earnings.length + " earnings, " + econ.length + " econ events");

  var watchlist = { pillars: [], onTheMove: [] };
  try {
    watchlist = await fetchWatchlist();
  } catch(err) {
    console.error("Watchlist fetch failed: " + err.message);
  }

  console.log("Generating brief via Claude...");
  var briefHtml;
  try {
    briefHtml = await generateBrief({ quotes, vix, news, earnings, econ });
    console.log("Brief generated.");
  } catch(err) {
    console.error("Claude API error: " + err.message);
    briefHtml = "<p>Brief generation failed. Market data is still current.</p>";
  }

  var indexData = [];
  for (const s of ["SPY","QQQ","DIA","IWM"]) {
    var q = quotes[s];
    indexData.push({
      name: q ? q.name : s,
      val:  q ? q.current.toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—",
      chg:  q ? q.changePct : 0,
      price: q ? q.current : 0
    });
  }
  indexData.push({ name: "VIX", val: vix ? vix.current.toFixed(2) : "—", chg: vix ? vix.changePct : 0, price: vix ? vix.current : 0 });
  indexData.push({ name: "10Y", val: "—", chg: 0, price: 0 });

  var sectorData = [];
  for (const sym of Object.keys(quotes)) {
    if (["SPY","QQQ","DIA","IWM","VXX"].indexOf(sym) === -1) {
      var q = quotes[sym];
      sectorData.push({ name: q.name, symbol: q.symbol, chg: q.changePct || 0 });
    }
  }

  var newsData = [];
  for (var i = 0; i < Math.min(news.length, 6); i++) {
    var n = news[i];
    var d = new Date(n.datetime);
    var timeStr = d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit", hour12:true, timeZone:"America/New_York" });
    newsData.push({ time: timeStr, text: n.headline, tag: n.source, url: n.url });
  }

  var earningsData = [];
  for (var i = 0; i < Math.min(earnings.length, 6); i++) {
    var e = earnings[i];
    earningsData.push({ ticker: e.symbol, info: "EPS Est: " + (e.epsEstimate != null ? e.epsEstimate : "N/A"), when: e.hour });
  }

  var econData = [];
  for (var i = 0; i < Math.min(econ.length, 6); i++) {
    var e = econ[i];
    econData.push({ time: e.time, name: e.event, impact: e.impact });
  }

  var fgScore = 50, fgLabel = "Neutral";
  if (vix && vix.current) {
    fgScore = Math.round(Math.max(0, Math.min(100, 100 - ((vix.current - 12) / 23) * 100)));
    if      (fgScore <= 20) fgLabel = "Extreme Fear";
    else if (fgScore <= 40) fgLabel = "Fear";
    else if (fgScore <= 60) fgLabel = "Neutral";
    else if (fgScore <= 80) fgLabel = "Greed";
    else                    fgLabel = "Extreme Greed";
  }

  var spy = quotes["SPY"], qqq = quotes["QQQ"];
  var keyLevelsData = [];
  if (spy) {
    keyLevelsData.push({ tag: "support", label: "SPY Support", val: (spy.low  || spy.current * 0.995).toFixed(2) });
    keyLevelsData.push({ tag: "resist",  label: "SPY Resist",  val: (spy.high || spy.current * 1.005).toFixed(2) });
  }
  if (qqq) {
    keyLevelsData.push({ tag: "pivot", label: "QQQ Pivot", val: ((qqq.high + qqq.low + qqq.current) / 3).toFixed(2) });
  }
  if (econ.length > 0) {
    var topEvent = econ.find(e => e.impact === "high") || econ[0];
    keyLevelsData.push({ tag: "event", label: topEvent.event ? topEvent.event.slice(0, 20) : "Econ Event", val: topEvent.time || "TBD" });
  }

  var output = {
    generated:  new Date().toISOString(),
    date:       new Date().toISOString().split("T")[0],
    indices:    indexData,
    sectors:    sectorData,
    keyLevels:  keyLevelsData,
    fearGreed:  { score: fgScore, label: fgLabel },
    earnings:   earningsData,
    econ:       econData,
    news:       newsData,
    brief:      briefHtml,
    watchlist:  watchlist
  };

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  var outPath = path.join(OUTPUT_DIR, "market-data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("Written to " + outPath);
  console.log("Done!");
}

main().catch(function(err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
