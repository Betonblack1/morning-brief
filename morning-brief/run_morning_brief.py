"""
run_morning_brief.py
Master runner. Execute this every morning at 6 AM.

Setup:
  1. pip install -r requirements.txt
  2. Copy .env.example to .env and fill in your keys
  3. Run: python run_morning_brief.py

Schedule on Windows (Task Scheduler):
  Action: python C:\path\to\morning-brief-agents\run_morning_brief.py
  Trigger: Daily at 6:00 AM

Schedule on Linux/Mac (cron):
  0 6 * * 1-5 cd /path/to/morning-brief-agents && python run_morning_brief.py
"""

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from orchestrator import run

if __name__ == "__main__":
    run()
