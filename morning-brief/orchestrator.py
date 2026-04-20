"""
orchestrator.py
Runs all three agents, passes results to Claude API for scoring/ranking,
writes final market-data.json to the morning-brief repo.
"""

import os, json, sys
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY")
OUTPUT_PATH   = os.getenv("OUTPUT_PATH", "./data/market-data.json")

def run_agents():
    """Run all three agents and collect results."""
    sys.path.insert(0, os.path.dirname(__file__))

    results = {"earnings": [], "catalyst": [], "second_day": []}

    print("\n-- Running Earnings Agent ------------------")
    try:
        from agents.earnings_agent import run as run_earnings
        results["earnings"] = run_earnings()
    except Exception as e:
        print(f"  ERROR: {e}")

    print("\n-- Running Catalyst Agent ------------------")
    try:
        from agents.catalyst_agent import run as run_catalyst
        results["catalyst"] = run_catalyst()
    except Exception as e:
        print(f"  ERROR: {e}")

    print("\n-- Running Second Day Agent ----------------")
    try:
        from agents.second_day_agent import run as run_second_day
        results["second_day"] = run_second_day()
    except Exception as e:
        print(f"  ERROR: {e}")

    return results

def score_with_claude(results):
    """Use Claude API to generate a market brief and validate/rank the plays."""
    if not ANTHROPIC_KEY:
        print("[orchestrator] No Anthropic key — skipping Claude scoring")
        return results, "Claude scoring skipped — no API key set."

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

        payload = json.dumps({
            "earnings_plays":   results["earnings"],
            "catalyst_plays":   results["catalyst"],
            "second_day_plays": results["second_day"],
            "date":             datetime.now().strftime("%A %B %d, %Y")
        }, indent=2)

        prompt = f"""You are a professional day trader's morning brief assistant.
Below is raw market data pulled from Polygon.io for {datetime.now().strftime("%A %B %d, %Y")}.

{payload}

Your job:
1. Write a concise 3-sentence pre-market summary covering: overall market tone, the most important catalyst today, and a key risk to watch.
2. For each play list (earnings, catalyst, second_day), confirm the top pick makes sense and add a one-line "game plan" note (e.g. "Long over $X on volume, short under $Y MTF break").
3. Flag any plays that look like noise and should be skipped.

Respond ONLY with valid JSON in this exact format:
{{
  "summary": "3-sentence market summary here.",
  "earnings": [
    {{"ticker": "X", "game_plan": "Long over $X on catalyst confirm, stop under $X", "flag": null}}
  ],
  "catalyst": [
    {{"ticker": "X", "game_plan": "Watch for gap continuation above $X pre-mkt high", "flag": null}}
  ],
  "second_day": [
    {{"ticker": "X", "game_plan": "HOD break at $X with volume = entry, stop below $X", "flag": null}}
  ]
}}

Use null for flag if the play is valid. Use "skip" if it looks like noise."""

        resp = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}]
        )

        text = resp.content[0].text.strip()
        # Strip any markdown fences
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"): text = text[4:]
        claude_data = json.loads(text.strip())

        # Merge Claude's game plans into the results
        summary = claude_data.get("summary", "")
        for key in ["earnings", "catalyst", "second_day"]:
            claude_plays = {p["ticker"]: p for p in claude_data.get(key, [])}
            for play in results[key]:
                t = play.get("ticker","")
                if t in claude_plays:
                    play["game_plan"] = claude_plays[t].get("game_plan", "")
                    play["flag"]      = claude_plays[t].get("flag")
                else:
                    play.setdefault("game_plan", "")
                    play.setdefault("flag", None)
            # Remove flagged plays
            results[key] = [p for p in results[key] if p.get("flag") != "skip"]

        return results, summary

    except Exception as e:
        print(f"[orchestrator] Claude scoring failed: {e}")
        return results, "Market brief unavailable — Claude API error."

def write_output(results, summary):
    """Write final market-data.json."""
    output = {
        "generated_at": datetime.now().isoformat(),
        "date_label":   datetime.now().strftime("%A, %B %d, %Y"),
        "summary":      summary,
        "earnings":     results["earnings"],
        "catalyst":     results["catalyst"],
        "second_day":   results["second_day"],
    }

    # Ensure output directory exists
    out_dir = os.path.dirname(os.path.abspath(OUTPUT_PATH))
    os.makedirs(out_dir, exist_ok=True)

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n[orchestrator] Written to {OUTPUT_PATH}")
    print(f"  Earnings:   {len(results['earnings'])} plays")
    print(f"  Catalyst:   {len(results['catalyst'])} plays")
    print(f"  2nd Day:    {len(results['second_day'])} plays")
    return output

def run():
    print(f"\n{'='*50}")
    print(f"  MORNING BRIEF AGENT PIPELINE")
    print(f"  {datetime.now().strftime('%A %B %d, %Y — %I:%M %p')}")
    print(f"{'='*50}\n")

    results         = run_agents()
    results, summary = score_with_claude(results)
    output          = write_output(results, summary)

    print(f"\n  Summary: {summary[:120]}...")
    print(f"\n{'='*50}")
    print("  Pipeline complete.")
    print(f"{'='*50}\n")
    return output

if __name__ == "__main__":
    run()

