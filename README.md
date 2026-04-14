# Daily Digest for Data Center, Geopolitics and AI

Every morning, three curated briefings land in your Telegram — data center
industry updates, global geopolitical risk assessment, and what top AI builders
are saying. Zero maintenance, fully automated via GitHub Actions.

**Philosophy:** Follow builders who ship products and have original opinions,
not influencers who regurgitate information. Track geopolitical risk and
industry trends through quality journalism, not social media noise.

## What You Get

### 1. Data Center Briefing (7am Sydney / 21:00 UTC)

A structured industry briefing with regional breakdown:

- **Top 3 APAC events** — Japan, Southeast Asia, Australia, India, China, etc.
- **Top 3 ROW events** — North America, Europe, Middle East, Africa, Latin America
- **Bytedance / TikTok tracker** — dedicated section for ByteDance DC activity
- **Industry trend summary** — key trends with 3 event-linked observations

Sources: DCD, Data Center Knowledge, TechDay Asia, DC Post

### 2. Geopolitical Briefing (8am Sydney / 22:00 UTC)

A structured risk assessment with 6 event cards and a market outlook:

- **Top 3 China-adjacent events** — Taiwan Strait, South China Sea, Korean Peninsula, etc.
- **Top 3 global events** — Middle East, Europe, Africa, Americas
- **Gold market impact** — bullish/bearish rating with 3 event-linked reasons

Sources: Reuters, BBC, Al Jazeera, Financial Times, SCMP, WSJ, Bloomberg, Nikkei Asia

### 3. AI Builders Digest (9am Sydney / 23:00 UTC)

8-10 curated cards summarizing the past 24 hours from top AI builders:

- New podcast episodes from Latent Space, No Priors, Training Data, and more
- Key posts from 25 curated AI builders on X/Twitter (Karpathy, Swyx, Sam Altman, etc.)
- Full articles from Anthropic Engineering and Claude Blog
- Every card links to the original source — no hallucinated URLs

All digests are written in Traditional Chinese with a cold, factual
[LatePost](https://www.latepost.com/)-style tone — no hype, no exclamation marks.

## Quick Start

Fork this repo and add your secrets. That's it — your first digest arrives on
the next scheduled run, or trigger it manually from the Actions tab.

### 1. Fork This Repo

```bash
# Or just click "Fork" on GitHub
git clone https://github.com/lch99310/Daily_Digest_for_geopolitics_and_AI.git
cd Daily_Digest_for_geopolitics_and_AI
```

### 2. Add GitHub Secrets

Go to your repo **Settings → Secrets and variables → Actions** and add:

| Secret | Required | Used By |
|--------|----------|---------|
| `OPENROUTER_FREE_API_KEY` | Yes | All digests — get one free at [openrouter.ai](https://openrouter.ai/) |
| `DC_TELEGRAM_BOT_TOKEN` | Yes (DC) | Create via [@BotFather](https://t.me/BotFather) |
| `DC_TELEGRAM_CHAT_ID` | Yes (DC) | Get via [@userinfobot](https://t.me/userinfobot) |
| `GEOPO_TELEGRAM_BOT_TOKEN` | Yes (Geopolitics) | Can reuse the same bot, or create a separate one |
| `GEOPO_TELEGRAM_CHAT_ID` | Yes (Geopolitics) | The chat/channel ID for geopolitical briefings |
| `TELEGRAM_BOT_TOKEN` | Yes (AI digest) | Bot token for AI builders digest |
| `TELEGRAM_CHAT_ID` | Yes (AI digest) | Chat ID for AI builders digest |
| `RESEND_API_KEY` | Optional | For email delivery ([resend.com](https://resend.com/)) |
| `EMAIL_TO` | Optional | Recipient email address |

Or you can directly follow following Telegram bots for latest daily digest updates.

- **Daily Digest for Data Center:** @daily_datacenter_digest_bot
- **Daily Digest for geopolitics:** @Daily_geopo_briefing_CH_bot
- **Daily Digest for AI from X(Twotter):** @myaisailydigest_bot

### 3. Run It

- **Automatic:** Digests run daily on schedule (see table below)
- **Manual:** Go to **Actions → Choose workflow → Run workflow**

| Workflow | Schedule | Trigger |
|----------|----------|---------|
| Data Center Briefing | Daily 21:00 UTC | `dc.yml` |
| Geopolitical Briefing | Daily 22:00 UTC | `geopo.yml` |
| AI Builders Digest | Daily 23:00 UTC | `digest.yml` |

## How It Works

```
Data Center Briefing:
  4 RSS feeds (DCD, DCK, TechDay Asia, DC Post)
    → dc-digest.mjs (fetch + LLM + Telegram delivery, all-in-one)

Geopolitical Briefing:
  8 RSS feeds (Reuters, BBC, FT, SCMP, WSJ, Bloomberg, Nikkei, Al Jazeera)
    → geopo-digest.mjs (fetch + LLM + Telegram delivery, all-in-one)

AI Builders Digest:
  Central feed (zarazhangrui/follow-builders)
    → prepare-digest.js (fetch + filter 24h)
    → generate-digest.mjs (OpenRouter LLM → markdown)
    → deliver-telegram.js + deliver-email.js
```

All workflows use OpenRouter's free-tier models with streaming + idle detection:
if a model is actively generating, it gets up to 3 minutes; if unresponsive for
30 seconds, it's skipped immediately. No paid API keys required.

## Customization

### Change the Schedule

Edit the `cron` field in the workflow files under `.github/workflows/`:

```yaml
schedule:
  - cron: '0 21 * * *'  # Change this to your preferred UTC time
```

### Change AI Digest Language/Delivery

Override via environment variables in `digest.yml`:

```yaml
env:
  CONFIG_LANGUAGE: bilingual   # bilingual | en | zh-CN
  CONFIG_DELIVERY_METHOD: both # telegram | email | both | stdout
```

Or copy `config.example.json` to `config.json` for local development.

### Add or Remove News Sources

Edit the `NEWS_FEEDS` array in the respective script:

```javascript
const NEWS_FEEDS = [
  { name: 'Your Source', url: 'https://example.com/rss' },
];
```

For paywalled sources, use the Google News RSS proxy pattern:
```
https://news.google.com/rss/search?q=when:24h+allinurl:example.com&hl=en-US&gl=US&ceid=US:en
```

### Modify the Digest Style

The LLM prompts are defined directly in the scripts:
- `scripts/dc-digest.mjs` — Data center briefing format, APAC/ROW/Bytedance sections
- `scripts/geopo-digest.mjs` — Geopolitical briefing format, sections, and gold analysis
- `scripts/generate-digest.mjs` — AI builders digest format and tone

## Default Sources

### Data Center News (4 feeds)
[DCD](https://www.datacenterdynamics.com/) |
[Data Center Knowledge](https://www.datacenterknowledge.com/) |
[TechDay Asia](https://datacenternews.asia/) |
[DC Post](https://datacenterpost.com/)

### Geopolitical News (8 feeds)
Reuters World, BBC World, Al Jazeera, Financial Times, SCMP, WSJ, Bloomberg, Nikkei Asia

### AI Podcasts (6)
[Latent Space](https://www.youtube.com/@LatentSpacePod) |
[Training Data](https://www.youtube.com/playlist?list=PLOhHNjZItNnMm5tdW61JpnyxeYH5NDDx8) |
[No Priors](https://www.youtube.com/@NoPriorsPodcast) |
[Unsupervised Learning](https://www.youtube.com/@RedpointAI) |
[MAD Podcast](https://www.youtube.com/@DataDrivenNYC) |
[AI & I](https://www.youtube.com/playlist?list=PLuMcoKK9mKgHtW_o9h5sGO2vXrffKHwJL)

### AI Builders on X (25)
[Andrej Karpathy](https://x.com/karpathy), [Swyx](https://x.com/swyx), [Josh Woodward](https://x.com/joshwoodward), [Kevin Weil](https://x.com/kevinweil), [Peter Yang](https://x.com/petergyang), [Nan Yu](https://x.com/thenanyu), [Amanda Askell](https://x.com/AmandaAskell), [Cat Wu](https://x.com/_catwu), [Google Labs](https://x.com/GoogleLabs), [Amjad Masad](https://x.com/amasad), [Guillermo Rauch](https://x.com/rauchg), [Alex Albert](https://x.com/alexalbert__), [Aaron Levie](https://x.com/levie), [Ryo Lu](https://x.com/ryolu_), [Garry Tan](https://x.com/garrytan), [Matt Turck](https://x.com/mattturck), [Zara Zhang](https://x.com/zarazhangrui), [Sam Altman](https://x.com/sama), [Claude](https://x.com/claudeai)

### Official Blogs (2)
[Anthropic Engineering](https://www.anthropic.com/engineering) |
[Claude Blog](https://claude.com/blog)

## Architecture

```
.
├── .github/workflows/
│   ├── dc.yml                  # Data Center briefing workflow (21:00 UTC)
│   ├── geopo.yml               # Geopolitical briefing workflow (22:00 UTC)
│   └── digest.yml              # AI Builders workflow (23:00 UTC)
├── scripts/
│   ├── dc-digest.mjs           # Fetch DC RSS + LLM generates DC briefing
│   ├── geopo-digest.mjs        # Fetch news RSS + LLM generates geopolitical briefing
│   ├── prepare-digest.js       # Fetch and aggregate AI builder feeds
│   ├── generate-digest.mjs     # LLM generates AI builders digest
│   ├── deliver-telegram.js     # Telegram delivery (chunked, Markdown with fallback)
│   └── deliver-email.js        # Email delivery via Resend
└── config.example.json         # Configuration template
```

**Zero npm dependencies** — all scripts use only Node.js built-in APIs.

## Requirements

- A GitHub account (for Actions — free tier is sufficient)
- An OpenRouter account ([openrouter.ai](https://openrouter.ai/) — free, no credit card needed)
- A Telegram bot (for delivery — free via [@BotFather](https://t.me/BotFather))

That's it. No paid APIs. No servers. No maintenance.

## Privacy

- OpenRouter free API key is stored as a GitHub Secret — never exposed in logs
- Telegram bot tokens are stored as GitHub Secrets
- All digests read only public content (public RSS feeds, public posts, public podcasts)
- No user data is collected or transmitted anywhere

## License

MIT
