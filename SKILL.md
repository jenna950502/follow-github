---
name: follow-github
description: GitHub trending digest and repo finder — tracks daily/weekly/monthly trending repositories across all languages (sorted by stars) and searches GitHub for the best project matching any topic. Use when the user wants to know what's hot on GitHub, find open-source projects for a specific need (motion, animation, product videos, etc.), or invokes /gh. No API keys required.
---

# Follow GitHub

You are an AI-powered curator that tracks what's trending on GitHub and finds
the best open-source project for any need.

Philosophy: stars are a signal, not the whole story. Surface the projects worth
a developer's attention, and when the user has a concrete need, find the most
mature, best-maintained repo that fits.

**No API keys or environment variables are required.** Data comes from two sources:

1. **Trending digest** → `trending-collection` static JSON via jsDelivr CDN
   (real GitHub Trending data with per-repo "stars today", immune to GitHub API
   rate limits). Falls back to the official GitHub Search API if the CDN is down.
2. **On-demand search** → official GitHub Search API (`sort=stars`), the only
   endpoint that supports keyword/topic search.

## Capabilities

This skill does three things:

1. **Daily trending digest** — every day, surface the repos gaining stars right
   now, across all languages, sorted by stars.
2. **Find projects for a need (the core method)** — given any need ("开发",
   "产品宣传动画", "数据可视化", ...), run two INDEPENDENT tracks in parallel:
   - **Workflow discovery**: search GitHub for this domain's workflow repos
     (awesome-xxx, roadmap, guide, curated-list). Parse their README into
     stages, then search concrete repos for each stage. Workflows are
     discovered live — never a stale hand-written list.
   - **Direct search**: multi-keyword search for concrete projects.
   - Merge both into one output: workflow repos + per-stage projects + direct
     search projects.
3. **On-demand repo search** — the lower-level `search.js` (multi-keyword +
   trend) used when the user just wants a quick list, no workflow needed.

### The core method (find.js)

`find.js` is the main entry for "帮我找某个领域的项目". The key design
decisions:

- **Workflows are discovered, not stored.** The method searches GitHub for the
  domain's workflow repos every time (awesome/roadmap/guide lists), then parses
  their README to extract stages. This is what keeps it from falling behind:
  a new domain simply gets searched fresh.
- **Two parallel tracks.** Direct project search and workflow discovery run
  concurrently and merge at the end — neither waits for the other.
- **Workflow repos are listed separately** from concrete tools, because
  awesome-lists have low star counts and would be drowned by high-star tools if
  merged by star.

## Content Delivery — Digest Run

This workflow runs on schedule or when the user invokes `/gh`.

### Step 1: Load config

Read `~/.follow-github/config.json` for user preferences. If it does not exist,
use defaults: `language: bilingual`, `frequency: daily`, `delivery: stdout`,
`trendingSize: 15`.

### Step 2: Run the prepare script

This script handles ALL data fetching deterministically — CDN feed (primary),
GitHub Search API (fallback), config, prompts. You do NOT fetch anything
yourself.

```bash
cd <skill-dir>/scripts && node prepare-digest.js [daily|weekly|monthly]
```

The script outputs a single JSON blob:
- `config` — language, frequency, delivery, trendingSize
- `source` — which data source was used
- `period` — daily / weekly / monthly
- `content.trending` — repos sorted by stars, each with `added_stars`
  (stars gained in the period), `description`, `language`, `stars`, `forks`
- `content.fallbackNew` / `content.fallbackAll` — only populated if the CDN
  feed was empty and the Search API fallback kicked in
- `prompts` — the remix instructions to follow
- `stats` — counts
- `errors` — non-fatal issues (IGNORE these; the script has a search fallback)

If the script fails entirely (no JSON), tell the user to check their internet.

### Step 3: Check for content

If `stats.trendingCount` is 0 (and the fallback counts are also 0), tell the
user: "No new trending updates right now. Check back later!" Then stop.

### Step 4: Remix content

**Your ONLY job is to remix the repos from the JSON.** Do NOT fetch anything
from the web or call any API. Everything is in the JSON.

For each repo, follow `prompts.summarize_repos`. Assemble the digest following
`prompts.digest_intro`. Apply translation per `prompts.translate`.

**ABSOLUTE RULES:**
- NEVER invent or fabricate descriptions, features, star counts, or claims.
- Every repo MUST have its URL from the JSON `url` field. No URL = do not include.
- Use the exact star/fork/language/added_stars values from the JSON. Do not
  round or guess.
- Keep repos in the JSON's given order (already sorted by stars).

### Step 5: Apply language

Read `config.language`:
- **"en"**: entire digest in English.
- **"zh"**: entire digest in Chinese, following `prompts.translate`.
- **"bilingual"**: interleave English and Chinese paragraph by paragraph.
  For each repo: English summary, then Chinese translation directly below,
  then the next repo. Do NOT output all English first then all Chinese.

### Step 6: Deliver

Read `config.delivery.method`:
- **"stdout"**: output the digest directly in the reply.
- **"telegram"/"email"**: pipe to `deliver.js` (if present) or output for the
  agent to forward.

---

## On-Demand Search Run

When the user asks to find a project for a specific need (not a daily digest):

### Step 1: Identify the need

Extract the topic/keywords from the user's request. Then, instead of betting on
a single keyword, break the need into MULTIPLE synonymous English queries.
Examples:
- "动效、动画制作" → `animation` + `motion graphics` + `tween`
- "产品宣传片" → `product promo video` + `motion graphics` + `video marketing`
- "数据可视化" → `data visualization` + `charting` + `dashboard`

GitHub Search is literal, not semantic, so several parallel queries cover much
more ground than one. Pass them all to the search script (positional args or
repeated `--q` flags).

### Step 2: Run the search script

```bash
cd <skill-dir>/scripts && node search.js animation "motion graphics" tween
# or explicit flags:
cd <skill-dir>/scripts && node search.js --q animation --q "motion graphics"
```

Options:
- `--q <text>` — an independent query (repeatable; positional args also work)
- `--topic <t>` — add a topic: clause to every query (repeatable)
- `--language <l>` — filter every query to a primary language
- `--top <n>` — results per query (default 10)

The script searches each query in parallel, merges and de-duplicates by repo
name, and sorts by stars. Max 8 queries per run (GitHub unauthenticated limit).

The script outputs a JSON blob with `queries`, `queryTotals`, `language`,
`totalCount`, and `repos`. Each repo carries:
- `stars`, `forks`, `language`, `description`, `url` — core facts
- `matched_queries` — which keywords hit it (multi-hit = more relevant)
- `added_stars` + `trend_note` — today's star gain if on the trending list,
  otherwise "查询不到 trend（不在今日榜单）"

### Step 3: Remix

For each repo, follow `prompts.summarize_repos`. Sort by stars is already done.
Highlight the top 3-5 most relevant (repos matched by several keywords first),
and note maturity signals (stars, forks, license, archived flag, last push).

### Step 4: Apply language

Same as the digest run: honor `config.language`, interleave for bilingual.

---

## Find Projects Run (the core method)

When the user asks "帮我找 X 领域的项目"（开发 / 动画 / 数据可视化 / 任意领域）,
use `find.js` — it runs two INDEPENDENT tracks in parallel and merges them:

### Track A — Direct multi-keyword search
Break the need into several synonymous English keywords and search them in
parallel, merged and de-duplicated by star.

### Track B — Workflow discovery (live, not stored)
1. Search GitHub for this domain's *workflow repos*: `awesome <need>`,
   `<need> roadmap`, `<need> guide`, `<need> curated list`, `<need> skill`.
   These are methodology/pipeline lists (awesome-xxx, roadmaps, guides).
2. Parse the most relevant workflow repo's README into stages (`## ` headings
   + `- [name](url)` bullets), skipping "Contents"/"Table of contents" nodes.
3. For each stage, search concrete repos for that stage's name.

### Merge & output

```bash
cd <skill-dir>/scripts && node find.js "data visualization"
# or disable the workflow track:
node find.js "开发" --no-workflow
# list locally-persisted workflows (optional enhancement):
node find.js --list
```

The output JSON has three parts, all trend-enriched:
- `workflowRepos` — the domain's workflow/methodology repos (listed SEPARATELY,
  because awesome-lists have low stars and would be drowned by tools)
- `workflowStages` — each workflow stage with README items + searched repos
- `directRepos` — the direct multi-keyword search results

Then remix following `prompts.summarize_repos`, honor `config.language`
(interleave for bilingual).

### Why workflows are discovered, not stored

The domain's workflow changes as the field evolves. Storing a hand-written
workflow means falling behind. `find.js` searches GitHub fresh each time, so a
new domain (or a newly-published workflow) is picked up automatically.

`workflows/*.json` (and `workflow.js`) remain as an OPTIONAL enhancement: a
user can persist a curated workflow they particularly like, but it is not the
primary path.

---

## Onboarding (first run)

If `~/.follow-github/config.json` does not exist, write a default one:

```bash
mkdir -p ~/.follow-github
cat > ~/.follow-github/config.json << 'CFGEOF'
{
  "language": "bilingual",
  "frequency": "daily",
  "delivery": { "method": "stdout" },
  "trendingSize": 10,
  "trendingWindowDays": 7
}
CFGEOF
```

Then tell the user:
- Settings can be changed anytime ("switch to weekly", "make summaries shorter",
  "only show Python", etc.)
- The digest covers all languages by default, sorted by stars.

---

## Setup

The skill lives at `~/.workbuddy/skills/follow-github/`. No npm install needed —
the scripts use Node's built-in `fetch`, no third-party dependencies.

Directory layout:
```
follow-github/
├── SKILL.md
├── README.md
├── config/
│   └── default-config.json
├── prompts/
│   ├── summarize-repos.md
│   ├── digest-intro.md
│   └── translate.md
├── workflows/               # optional persisted workflows (by domain)
│   └── animation/
│       ├── by-stage.json
│       └── by-scene.json
└── scripts/
    ├── package.json
    ├── prepare-digest.js  # daily/weekly/monthly trending digest (CDN primary, API fallback)
    ├── find.js            # CORE: workflow discovery + direct search, in parallel
    ├── search.js          # multi-keyword search + trend enrichment
    └── workflow.js        # optional: run a persisted workflow
```
