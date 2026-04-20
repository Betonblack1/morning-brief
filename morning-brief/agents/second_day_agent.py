"""
second_day_agent.py
Finds top 5 second-day continuation plays.
Logic: take yesterday's biggest % gainers with strong volume,
filter for clean setups (held gains, above VWAP), flag as day-2 candidates.
"""

import os, json, time, requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("POLYGON_API_KEY")
BASE    = "https://api.polygon.io"
CACHE   = os.path.join(os.path.dirname(__file__), "../cache/second_day.json")
TTL     = 8  # hours

# Filters
MIN_PRICE     = 5.0     # no penny stocks
MAX_PRICE     = 500.0   # no ultra-high-price names (hard to move %)
MIN_VOL       = 500_000 # minimum volume to be tradeable
MIN_PCT_GAIN  = 3.0     # must have moved 3%+ yesterday
MAX_PCT_GAIN  = 80.0    # ignore meme explosions (likely faded)

def _cache_valid():
    if not os.path.exists(CACHE): return False
    return datetime.now() - datetime.fromtimestamp(os.path.getmtime(CACHE)) < timedelta(hours=TTL)

def _get(path, params={}):
    params["apiKey"] = API_KEY
    r = requests.get(f"{BASE}{path}", params=params, timeout=15)
    r.raise_for_status()
    time.sleep(12)
    return r.json()

def _prev_day():
    d = datetime.now().date() - timedelta(days=1)
    while d.weekday() >= 5: d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")

def _day_before_prev():
    d = datetime.now().date() - timedelta(days=2)
    while d.weekday() >= 5: d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")

def run():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    if _cache_valid():
        print("[second_day] cache hit")
        return json.load(open(CACHE))

    print("[second_day] fetching grouped bars...")
    prev = _prev_day()
    d2   = _day_before_prev()
    candidates = []

    try:
        # Grouped daily bars for all US stocks yesterday
        data = _get(f"/v2/aggs/grouped/locale/us/market/stocks/{prev}", {
            "adjusted":    "true",
            "include_otc": "false"
        })
        bars = data.get("results", [])
        print(f"[second_day] {len(bars)} tickers in market on {prev}")

        for bar in bars:
            ticker = bar.get("T","")
            o, h, l, c = bar.get("o",0), bar.get("h",0), bar.get("l",0), bar.get("c",0)
            vol  = bar.get("v", 0)
            vwap = bar.get("vw", c)

            if not ticker or len(ticker) > 5: continue  # skip options/complex instruments
            if not (MIN_PRICE <= c <= MAX_PRICE):        continue
            if vol < MIN_VOL:                            continue
            if o <= 0:                                   continue

            pct_gain = ((c - o) / o) * 100

            if not (MIN_PCT_GAIN <= pct_gain <= MAX_PCT_GAIN): continue

            # Quality filters for a clean day-2 setup
            close_pct_of_high = (c / h) if h > 0 else 0  # closed near HOD = strength
            body_size = abs(c - o) / (h - l) if (h - l) > 0 else 0  # strong candle body

            score = 50
            # Big % move = interest
            score += min(pct_gain * 1.5, 25)
            # Closed near high of day = buyers in control
            if close_pct_of_high > 0.90: score += 20
            elif close_pct_of_high > 0.80: score += 12
            elif close_pct_of_high > 0.70: score += 6
            # Strong body (not a doji/reversal)
            if body_size > 0.7: score += 10
            # Volume
            if vol > 5_000_000: score += 10
            elif vol > 2_000_000: score += 6
            # Closed above VWAP = bullish
            if c > vwap: score += 8

            candidates.append({
                "ticker":         ticker,
                "type":           "2ND DAY",
                "prev_open":      round(o, 2),
                "prev_close":     round(c, 2),
                "prev_high":      round(h, 2),
                "prev_low":       round(l, 2),
                "prev_vwap":      round(vwap, 2),
                "prev_vol":       int(vol),
                "pct_gain":       round(pct_gain, 2),
                "close_vs_high":  round(close_pct_of_high * 100, 1),
                "score":          round(min(score, 100), 1),
            })

    except Exception as e:
        print(f"[second_day] grouped bars failed: {e}")
        return []

    # Sort by score, take top 20 to enrich
    candidates = sorted(candidates, key=lambda x: x["score"], reverse=True)[:20]

    # Enrich with news — any catalyst driving the move?
    print(f"[second_day] enriching top {len(candidates)} with news...")
    for c in candidates:
        try:
            news = _get(f"/v2/reference/news", {
                "ticker": c["ticker"], "limit": 3,
                "order": "desc", "sort": "published_utc"
            }).get("results", [])
            if news:
                c["headline"] = news[0].get("title", "")
                c["url"]      = news[0].get("article_url", "")
                c["source"]   = news[0].get("publisher", {}).get("name", "")
                # Boost score if there's a news catalyst
                c["score"] = min(c["score"] + 8, 100)
            else:
                c["headline"] = "No recent news — technical move"
                c["url"]      = ""
                c["source"]   = ""
            c["notes"] = (
                f"Day 1: +{c['pct_gain']}% · "
                f"Closed {c['close_vs_high']}% of HOD · "
                f"Vol {c['prev_vol']:,} · "
                f"Watch ${c['prev_high']:.2f} (HOD) as key level"
            )
        except Exception as e:
            print(f"[second_day] news skip {c['ticker']}: {e}")

    result = sorted(candidates, key=lambda x: x["score"], reverse=True)[:5]
    json.dump(result, open(CACHE,"w"), indent=2)
    print(f"[second_day] {len(result)} plays")
    return result

if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
