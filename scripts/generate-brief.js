import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "data");

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!FINNHUB_KEY) throw new Error("Missing FINNHUB_API_KEY");
if (!ANTHROPIC_KEY) throw new Error("Missing ANTHROPIC_API_KEY");

const FH_BASE = "https://finnhub.io/api/v1";

async function fh(endpoint, params = {}) {
  const url = new URL(`${FH_BASE}${endpoint}`);
  url.searchParams.set("token", FINNHUB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString());
  if (!resp.ok) { console.error(`Finnhub error ${resp.status} on ${endpoint}`); return null; }
  return resp.json();
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchQuotes() {
  const symbols = [
    { symbol: "SPY", name: "S&P 500" },
    { symbol: "QQQ", name: "NASDAQ" },
    { symbol: "DIA", name: "DOW" },
    { symbol: "IWM", name: "RUSSELL" },
    { symbol: "XLK", name: "Tech" },
    { symbol: "XLV", name: "Health" },
    { symbol: "XLF", name: "Financials" },
    { symbol: "XLE", name: "Energy" },
    { symbol: "XLY", name: "Cons Disc" },
    { symbol: "XLI", name: "Industrials" },
    { symbol: "XLB", name: "Materials" },
    { symbol: "XLRE", name: "Real Estate" },
    { symbol: "XLU", name: "Utilities" },
    { symbol: "XLP", name: "Cons Staples" },
    { symbol: "XLC", name: "Comm Svcs" },
  ];
  const results = {};
  for (const item of symbols) {
    const q = await fh("/quote", { symbol: item.symbol });
    if (q) {
      results[item.symbol] = {
        name: item.name, symbol: item.symbol,
        current: q.c, open: q.o, high: q.h, low: q.l,
        prevClose: q.pc, change: q.d, changePct: q.dp,
      };
    }
    await delay(200);
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
  return news.slice(0, 12).map((n) => ({
    headline: n.headline, source: n.source,
    summary: n.summary?.slice(0, 200), url: n.url,
    datetime: new Date(n.datetime * 1000).toISOString(), category: n.category,
  }));
}

async function fetchEarnings() {
  const today = new Date().toISOString().split("T")[0];
  const earnings = await fh("/calendar/earnings", { from: today, to: today });
  if (!earnings?.earningsCalendar) return [];
  return earnings.earningsCalendar.slice(0, 10).map((e) => ({
    symbol: e.symbol,
    hour: e.hour === "bmo" ? "BMO" : e.hour === "amc" ? "AMC" : e.hour,
    epsEstimate: e.epsEstimate, revenueEstimate: e.revenueEstimate,
  }));
}

async function fetchEconCalendar() {
  const today = new Date().toISOString().split("T")[0];
  const cal = await fh("/calendar/economic", { from: today, to: today });
  if (!cal?.economicCalendar) return [];
  return cal.economicCalendar
    .filter((e) => e.country === "US").slice(0, 8)
    .map((e) => ({
      time: e.time || "TBD", event: e.event,
      impact: e.impact <= 1 ? "low" : e.impact === 2 ? "med" : "high",
      estimate: e.estimate, prev: e.prev,
    }));
}

async function generateBrief(marketData) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const { quotes, vix, news, earnings, econ } = marketData;

  const indexSummary = ["SPY", "QQQ", "DIA", "IWM"]
    .map((s) => { const q = quotes[s]; if (!q) return ""; return `${q.name} (${s}): $${q.current} (${q.changePct >= 0 ? "+" : ""}${q.changePct?.toFixed(2)}%)`; })
    .filter(Boolean).join("\n");

  const sectorSummary = Object.values(quotes)
    .filter((q) => !["SPY", "QQQ", "DIA", "IWM", "VXX"].includes(q.symbol))
    .map((q) => `${q.name} (${q.symbol}): ${q.changePct >= 0 ? "+" : ""}${q.changePct?.toFixed(2)}%`)
    .join("\n");

  const newsSummary = news.slice(0, 8).map((n) => `- ${n.headline} (${n.source})`).join("\n");
  const earningsSummary = earnings.map((e) => `${e.symbol} (${e.hour}) - EPS Est: ${e.epsEstimate ?? "N/A"}`).join("\n");
  const econSummary = econ.map((e) => `${e.time}: ${e.event} (Impact: ${e.impact})`).join("\n");

  const prompt = `You are a senior market analyst writing a concise morning brief for an active trader. Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

Here is today's pre-market data:

## INDEX QUOTES
${indexSummary}
${vix ? `VIX: ${vix.current} (${vix.changePct >= 0 ? "+" : ""}${vix.changePct?.toFixed(2)}%)` : ""}

## SECTOR PERFORMANCE (Pre-Market)
${sectorSummary}

## TODAY'S NEWS HEADLINES
${newsSummary || "No major headlines yet."}

## EARNINGS TODAY
${earningsSummary || "No major earnings today."}

## ECONOMIC CALENDAR
${econSummary || "No major economic events today."}

Write a morning brief using this EXACT HTML structure. Keep it punchy, actionable, and under 600 words. No fluff. Write like a seasoned trader talks — direct, informed, no hedging.

Use these exact HTML elements:

<h2><span class="sec-icon">◆</span> Market Overview</h2>
- 2-3 sentences on the overall setup. Reference specific numbers.

<h2><span class="sec-icon">◆</span> What to Watch</h2>
- Use <ul><li> for 3-4 bullet points on key events/data/earnings today
- Bold the event name with <strong>

<h2><span class="sec-icon">◆</span> Sector Rotation</h2>
- 2-3 sentences on which sectors are leading/lagging and why

Add 1-2 callout boxes using this format:
<div class="callout callout-green"><div class="callout-label">✦ Bull Case</div>Text here</div>
<div class="callout callout-red"><div class="callout-label">⚠ Bear Case</div>Text here</div>
<div class="callout callout-amber"><div class="callout-label">⚡ Key Driver</div>Text here</div>

<h2><span class="sec-icon">◆</span> Levels That Matter</h2>
- Use <ul><li> for 3-4 key support/resistance/trigger levels

End with:
<hr>
<p><em>Not a prediction. A preparation. Make your plan before the bell.</em></p>

Output ONLY the HTML. No markdown. No code fences. No explanation.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].text;
}

async function main() {
  console.log("Fetching market data from Finnhub...");
  const [quotes, vix, news, earnings, econ] = await Promise.all([
    fetchQuotes(), fetchVIX(), fetchNews(), fetchEarnings(), fetchEconCalendar(),
  ]);
  console.log(`Got ${Object.keys(quotes).length} quotes, ${news.length} news, ${earnings.length} earnings, ${econ.length} econ events`);

  console.log("Generating brief via Claude...");
  let briefHtml;
  try {
    briefHtml = await generateBrief({ quotes, vix, news, earnings, econ });
    console.log("Brief generated");
  } catch (err) {
    console.error("Claude API error:", err.message);
    briefHtml = `<p>Brief generation failed. Market data is still current.</p>`;
  }

  const indexData = ["SPY", "QQQ", "DIA", "IWM"].map((s) => {
    const q = quotes[s];
    return { name: q?.name ?? s, val: q?.current?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "—", chg: q?.changePct ?? 0, price: q?.current ?? 0 };
  });
  indexData.push({ name: "VIX", val: vix?.current?.toFixed(2) ?? "—", chg: vix?.changePct ?? 0, price: vix?.current ?? 0 });
  indexData.push({ name: "10Y", val: "—", chg: 0, price: 0 });

  const sectorData = Object.values(quotes)
    .filter((q) => !["SPY", "QQQ", "DIA", "IWM", "VXX"].includes(q.symbol))
    .map((q) => ({ name: q.name, symbol: q.symbol, chg: q.changePct ?? 0 }));

  const newsData = news.slice(0, 6).map((n) => {
    const d = new Date(n.datetime);
    const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
    return { time: timeStr, text: n.headline, tag: n.source, url: n.url };
  });

  const earningsData = earnings.slice(0, 6).map((e) => ({ ticker: e.symbol, info: `EPS Est: ${e.epsEstimate ?? "N/A"}`, when: e.hour }));
  const econData = econ.slice(0, 6).map((e) => ({ time: e.time, name: e.event, impact: e.impact }));

  let fgScore = 50, fgLabel = "Neutral";
  if (vix?.current) {
    fgScore = Math.round(Math.max(0, Math.min(100, 100 - ((vix.current - 12) / 23) * 100)));
    if (fgScore <= 20) fgLabel = "Extreme Fear";
    else if (fgScore <= 40) fgLabel = "Fear";
    else if (fgScore <= 60) fgLabel = "Neutral";
    else if (fgScore <= 80) fgLabel = "Greed";
    else fgLabel = "Extreme Greed";
  }

  const spy = quotes["SPY"], qqq = quotes["QQQ"];
  const keyLevelsData = [];
  if (spy) {
    keyLevelsData.push({ tag: "support", label: "SPY Support", val: (spy.low || spy.current * 0.995).toFixed(2) });
    keyLevelsData.push({ tag: "resist", label: "SPY Resist", val: (spy.high || spy.current * 1.005).toFixed(2) });
  }
  if (qqq) keyLevelsData.push({ tag: "pivot", label: "QQQ Pivot", val: ((qqq.high + qqq.low + qqq.current) / 3).toFixed(2) });
  if (econ.length > 0) {
    const topEvent = econ.find((e) => e.impact === "high") || econ[0];
    keyLevelsData.push({ tag: "event", label: topEvent.event?.slice(0, 20) ?? "Econ Event", val: topEvent.time || "TBD" });
  }

  const output = {
    generated: new Date().toISOString(), date: new Date().toISOString().split("T")[0],
    indices
