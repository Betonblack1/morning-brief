# Morning Brief

Automated pre-market morning brief powered by **Finnhub** (market data) and **Claude** (AI-written analysis). Runs on GitHub Actions, hosted free on GitHub Pages.

**Cost: ~$0.50/month**

---

## What It Does

Every weekday at **5:30 AM ET**, a GitHub Action:

1. Pulls live market data from Finnhub (indices, sectors, news, earnings, econ calendar)
2. Sends it to Claude API to generate a trader-style morning brief
3. Saves everything to `data/market-data.json`
4. Your dashboard (`index.html`) reads that file and renders it

---

## Setup (15 minutes)

### Step 1: Get Your API Keys

**Finnhub (free):**
1. Go to [finnhub.io](https://finnhub.io)
2. Click "Get Free API Key"
3. Sign up — copy your API key

**Anthropic:**
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account (separate from your Claude Pro chat subscription)
3. Add $5 in credits (Settings → Billing)
4. Go to API Keys → Create Key → copy it

### Step 2: Create Your GitHub Repo

1. Go to [github.com/new](https://github.com/new)
2. Name it `morning-brief` (or whatever you like)
3. Make it **public** (required for free GitHub Pages)
4. Push this entire folder to the repo:

```bash
cd morning-brief
git init
git add .
git commit -m "Initial setup"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/morning-brief.git
git push -u origin main
```

### Step 3: Add Your API Keys to GitHub

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add these two secrets:

| Name | Value |
|------|-------|
| `FINNHUB_API_KEY` | Your Finnhub key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### Step 4: Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Under "Source", select **Deploy from a branch**
3. Branch: `main`, folder: `/ (root)`
4. Click **Save**
5. Your site will be live at: `https://YOUR_USERNAME.github.io/morning-brief/`

### Step 5: Run It For the First Time

1. Go to your repo → **Actions** tab
2. Click **"Generate Morning Brief"** in the left sidebar
3. Click **"Run workflow"** → **"Run workflow"**
4. Wait ~30 seconds for it to complete
5. Refresh your GitHub Pages site — you should see live data!

---

## How It Works

```
GitHub Actions (cron: 5:30 AM ET, Mon-Fri)
    │
    ├── Finnhub API → Index quotes, sector ETFs, news, earnings, econ calendar
    │
    ├── Claude API → Generates the written morning brief from that data
    │
    └── Commits data/market-data.json → GitHub Pages serves index.html
```

---

## File Structure

```
morning-brief/
├── index.html                          # The dashboard (GitHub Pages serves this)
├── data/
│   └── market-data.json                # Generated data (auto-updated daily)
├── scripts/
│   └── generate-brief.js               # Fetches data + generates brief
├── .github/
│   └── workflows/
│       └── morning-brief.yml           # Cron job config
├── package.json
└── README.md
```

---

## Customization

**Change the schedule:** Edit `.github/workflows/morning-brief.yml` — the cron line. It's in UTC.
- `30 10 * * 1-5` = 5:30 AM ET (10:30 UTC) weekdays
- `0 11 * * 1-5` = 6:00 AM ET
- `0 13 * * 1-5` = 8:00 AM ET

**Change the brief style:** Edit the Claude prompt in `scripts/generate-brief.js` — look for the `prompt` variable. You can make it more concise, more detailed, add specific tickers you follow, etc.

**Add more tickers:** Edit the `indices` and `sectorETFs` arrays in `generate-brief.js`.

---

## Troubleshooting

**"No brief found" on the page:** Run the Action manually first (Step 5 above).

**Action fails:** Check the Actions tab for error logs. Usually it's a missing secret or API key issue.

**Data looks stale:** The page shows a yellow banner if data is older than 18 hours. Check that your Action ran successfully.

**Finnhub rate limits:** Free tier = 60 calls/min. The script uses ~15 calls with delays. You shouldn't hit limits.
