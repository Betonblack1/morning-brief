"""
earnings_agent.py
Fetches top 5 upcoming earnings plays using Polygon.io free tier.
Uses news endpoint to find earnings mentions + prior day price data for context.
"""

import os, json, time, requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("POLYGON_API_KEY")
BASE    = "https://api.polygon.io"
CACHE   = os.path.join(os.path.dirname(__file__), "../cache/earnings.json")
TTL     = 6  # hours

WATCHLIST = [
    "AAPL","MSFT","NVDA","GOOGL","META","AMZN","TSLA","JPM","BAC","GS",
    "MS","V","MA","UNH","LLY","JNJ","PFE","ABBV","MRK","XOM","CVX",
    "COP","HD","WMT","COST","TGT","NKE","SBUX","MCD","DIS","NFLX",
    "AMD","INTC","QCOM","AVGO","CRM","NOW","ORCL","IBM","CSCO","BA",
    "CAT","GE","HON","RTX","UPS","FDX","WFC","C","AXP","COIN","PLTR"
]

def _cache_valid():
    if not os.path.exists(CACHE): return False
    return datetime.now() - datetime.fromtimestamp(os.path.getmtime(CACHE)) < timedelta(hours=TTL)

def _get(path, params={}):
    params["apiKey"] = API_KEY
    r = requests.get(f"{BASE}{path}", params=params, timeout=10)
    r.raise_for_status()
    time.sleep(12)  # 5 req/min free tier
    return r.json()

def _prev_day():
    d = datetime.now().date() - timedelta(days=1)
    while d.weekday() >= 5: d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")

def run():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    if _cache_valid():
        print("[earnings] cache hit")
        return json.load(open(CACHE))

    print("[earnings] fetching news...")
    plays, seen = [], set()

    try:
        data = _get("/v2/reference/news", {
            "limit": 50, "order": "desc", "sort": "published_utc",
            "q": "earnings quarterly results beat miss guidance"
        })
        for item in data.get("results", []):
            title = item.get("title", "").lower()
            if not any(kw in title for kw in ["earnings","results","beat","miss","guidance","eps","revenue"]):
                continue
            for ticker in item.get("tickers", []):
                if ticker in seen or ticker not in WATCHLIST: continue
                seen.add(ticker)
                plays.append({
                    "ticker":    ticker,
                    "type":      "EARNINGS",
                    "headline":  item.get("title",""),
                    "source":    item.get("publisher",{}).get("name",""),
                    "published": item.get("published_utc",""),
                    "url":       item.get("article_url",""),
                })
    except Exception as e:
        print(f"[earnings] news fetch failed: {e}")
        return []

    # Enrich with price data and score
    enriched, prev = [], _prev_day()
    for play in plays[:10]:
        try:
            bars = _get(f"/v2/aggs/ticker/{play['ticker']}/range/1/day/{prev}/{prev}",
                        {"adjusted":"true","limit":1}).get("results", [])
            bar  = bars[0] if bars else {}
            close, vol, vwap = bar.get("c",0), bar.get("v",0), bar.get("vw",0)

            score = 50
            if vol > 5_000_000: score += 20
            elif vol > 1_000_000: score += 10
            if close > 50: score += 15
            elif close > 10: score += 8
            if vwap and close > vwap: score += 10

            enriched.append({**play,
                "prev_close": round(close, 2),
                "prev_vol":   int(vol),
                "score":      min(score, 100),
                "notes":      f"Prior close ${close:.2f} · Vol {int(vol):,}"
            })
        except Exception as e:
            print(f"[earnings] skip {play['ticker']}: {e}")

    result = sorted(enriched, key=lambda x: x["score"], reverse=True)[:5]
    json.dump(result, open(CACHE,"w"), indent=2)
    print(f"[earnings] {len(result)} plays")
    return result

if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
