# Daily Digest for Geopolitics and AI

Every morning, two curated briefings land in your Telegram — one tracking what
top AI builders are saying, the other assessing global geopolitical risk with a
gold market outlook. Zero maintenance, fully automated via GitHub Actions.

**Philosophy:** Follow builders who ship products and have original opinions,
not influencers who regurgitate information. Track geopolitical risk through
quality journalism, not social media noise.

## What You Get

### 1. AI Builders Digest (7am Sydney / 21:00 UTC)

8-10 curated cards summarizing the past 24 hours from top AI builders:

- New podcast episodes from Latent Space, No Priors, Training Data, and more
- Key posts from 25 curated AI builders on X/Twitter (Karpathy, Swyx, Sam Altman, etc.)
- Full articles from Anthropic Engineering and Claude Blog
- Every card links to the original source — no hallucinated URLs

### 2. Daily Geopolitical Briefing (8am Sydney / 22:00 UTC)

A structured risk assessment with 6 event cards and a market outlook:

- **Top 3 China-adjacent events** — Taiwan Strait, South China Sea, Korean Peninsula, etc.
- **Top 3 global events** — Middle East, Europe, Africa, Americas
- **Gold market impact** — bullish/bearish rating with 3 event-linked reasons

Sources: Reuters, BBC, Al Jazeera, Financial Times, SCMP, WSJ, Bloomberg, Nikkei Asia

Both digests are written in Traditional Chinese with a cold, factual
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
| `OPENROUTER_FREE_API_KEY` | Yes | Both digests — get one free at [openrouter.ai](https://openrouter.ai/) |
| `TELEGRAM_BOT_TOKEN` | Yes (AI digest) | Create via [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Yes (AI digest) | Get via [@userinfobot](https://t.me/userinfobot) |
| `GEOPO_TELEGRAM_BOT_TOKEN` | Yes (Geopolitics) | Can reuse the same bot, or create a separate one |
| `GEOPO_TELEGRAM_CHAT_ID` | Yes (Geopolitics) | The chat/channel ID for geopolitical briefings |
| `RESEND_API_KEY` | Optional | For email delivery ([resend.com](https://resend.com/)) |
| `EMAIL_TO` | Optional | Recipient email address |

### 3. Run It

- **Automatic:** Digests run daily on schedule (see table below)
- **Manual:** Go to **Actions → Choose workflow → Run workflow**

| Workflow | Schedule | Trigger |
|----------|----------|---------|
| AI Builders Digest | Daily 21:00 UTC | `digest.yml` |
| Geopolitical Briefing | Daily 22:00 UTC | `geopo.yml` |

## How It Works

```
AI Builders Digest:
  Central feed (zarazhangrui/follow-builders)
    → prepare-digest.js (fetch + filter 24h)
    → generate-digest.mjs (OpenRouter LLM → markdown)
    → deliver-telegram.js + deliver-email.js

Geopolitical Briefing:
  8 RSS feeds (Reuters, BBC, FT, SCMP, WSJ, Bloomberg, Nikkei, Al Jazeera)
    → geopo-digest.mjs (fetch + LLM + Telegram delivery, all-in-one)
```

Both workflows use OpenRouter's free-tier models with sequential fallback —
if the first model fails (rate-limited or timeout), it tries the next one
automatically. No paid API keys required.

## Customization

### Change the Schedule

Edit the `cron` field in `.github/workflows/digest.yml` or `geopo.yml`:

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

### Add or Remove Geopolitical News Sources

Edit the `NEWS_FEEDS` array in `scripts/geopo-digest.mjs`:

```javascript
const NEWS_FEEDS = [
  { name: 'Reuters World', url: 'https://feeds.reuters.com/reuters/worldNews' },
  // Add your own RSS feed here:
  { name: 'Your Source', url: 'https://example.com/rss' },
];
```

For paywalled sources, use the Google News RSS proxy pattern:
```
https://news.google.com/rss/search?q=when:24h+allinurl:example.com&hl=en-US&gl=US&ceid=US:en
```

### Modify the Digest Style

The LLM prompts are defined directly in the scripts:
- `scripts/generate-digest.mjs` — AI builders digest format and tone
- `scripts/geopo-digest.mjs` — Geopolitical briefing format, sections, and gold analysis

## Default Sources

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
│   ├── digest.yml              # AI Builders workflow (21:00 UTC)
│   └── geopo.yml               # Geopolitical briefing workflow (22:00 UTC)
├── scripts/
│   ├── prepare-digest.js       # Fetch and aggregate AI builder feeds
│   ├── generate-digest.mjs     # LLM generates AI builders digest
│   ├── geopo-digest.mjs        # Fetch RSS + LLM generates geopolitical briefing
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
- The AI digest reads only public content (public posts, public podcasts, public blogs)
- The geopolitical digest reads only public RSS feeds
- No user data is collected or transmitted anywhere

## License

MIT
