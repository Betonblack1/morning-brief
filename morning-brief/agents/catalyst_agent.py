"""
catalyst_agent.py
Fetches top 5 high-catalyst news plays from Polygon.io.
Looks for FDA, M&A, upgrades, guidance raises, macro surprises.
"""

import os, json, time, requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("POLYGON_API_KEY")
BASE    = "https://api.polygon.io"
CACHE   = os.path.join(os.path.dirname(__file__), "../cache/catalyst.json")
TTL     = 3  # hours — news refreshes faster

# Keywords that signal a real catalyst (not noise)
HIGH_SIGNAL = [
    "fda approved","fda approval","breakthrough therapy","phase 3","merger",
    "acquisition","acquired","buyout","takeover","going private",
    "raised guidance","raises guidance","revenue beat","earnings beat",
    "strategic review","partnership","contract awarded","exclusive agreement",
    "activist investor","short squeeze","analyst upgrade","price target raised",
    "special dividend","share buyback","stock split"
]

MEDIUM_SIGNAL = [
    "upgrade","outperform","overweight","buy rating","positive data",
    "trial results","fda filing","ipo","secondary offering","record revenue",
    "guidance","raised outlook","strong demand","market share"
]

def _cache_valid():
    if not os.path.exists(CACHE): return False
    return datetime.now() - datetime.fromtimestamp(os.path.getmtime(CACHE)) < timedelta(hours=TTL)

def _get(path, params={}):
    params["apiKey"] = API_KEY
    r = requests.get(f"{BASE}{path}", params=params, timeout=10)
    r.raise_for_status()
    time.sleep(12)
    return r.json()

def _prev_day():
    d = datetime.now().date() - timedelta(days=1)
    while d.weekday() >= 5: d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")

def _score_headline(title):
    t = title.lower()
    score = 0
    for kw in HIGH_SIGNAL:
        if kw in t: score += 30
    for kw in MEDIUM_SIGNAL:
        if kw in t: score += 15
    return min(score, 100)

def run():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    if _cache_valid():
        print("[catalyst] cache hit")
        return json.load(open(CACHE))

    print("[catalyst] fetching news...")
    scored, seen = [], set()

    try:
        # Two passes — broad market news + specific catalyst terms
        for query in ["merger acquisition FDA approval", "analyst upgrade guidance raised earnings beat"]:
            data = _get("/v2/reference/news", {
                "limit": 50, "order": "desc", "sort": "published_utc", "q": query
            })
            for item in data.get("results", []):
                title    = item.get("title", "")
                tickers  = item.get("tickers", [])
                url      = item.get("article_url", "")
                pub      = item.get("published_utc", "")
                source   = item.get("publisher", {}).get("name", "")

                if not tickers: continue
                ticker = tickers[0]
                if ticker in seen: continue
                seen.add(ticker)

                cat_score = _score_headline(title)
                if cat_score < 15: continue  # skip noise

                scored.append({
                    "ticker":    ticker,
                    "type":      "CATALYST",
                    "headline":  title,
                    "source":    source,
                    "published": pub,
                    "url":       url,
                    "score":     cat_score,
                    "notes":     ""
                })
    except Exception as e:
        print(f"[catalyst] news fetch failed: {e}")
        return []

    # Enrich top candidates with price data
    scored = sorted(scored, key=lambda x: x["score"], reverse=True)[:10]
    prev   = _prev_day()

    for play in scored:
        try:
            bars = _get(f"/v2/aggs/ticker/{play['ticker']}/range/1/day/{prev}/{prev}",
                        {"adjusted":"true","limit":1}).get("results",[])
            bar  = bars[0] if bars else {}
            close, vol = bar.get("c",0), bar.get("v",0)
            play["prev_close"] = round(close, 2)
            play["prev_vol"]   = int(vol)
            play["notes"]      = f"Prior close ${close:.2f} · Vol {int(vol):,}"
            # Boost score for liquid, higher-priced names
            if vol > 2_000_000: play["score"] = min(play["score"] + 10, 100)
            if close > 20:      play["score"] = min(play["score"] + 5,  100)
        except Exception as e:
            print(f"[catalyst] skip price {play['ticker']}: {e}")
            play.setdefault("prev_close", 0)
            play.setdefault("prev_vol",   0)

    result = sorted(scored, key=lambda x: x["score"], reverse=True)[:5]
    json.dump(result, open(CACHE,"w"), indent=2)
    print(f"[catalyst] {len(result)} plays")
    return result

if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
