#!/usr/bin/env node

// ============================================================================
// Follow GitHub — Search Repos
// ============================================================================
// Search GitHub repositories by keyword/topic, sorted by stars. Used when the
// user asks "what's the best project for X?" (e.g. motion, animation, product
// videos). Outputs a JSON blob to stdout for the LLM to remix.
//
// Supports MULTI-KEYWORD search: pass several independent queries (positional
// args, or repeated --q flags). Each query is searched separately, then the
// results are merged and de-duplicated by repo name, sorted by stars. This
// mitigates the "wrong keyword -> missed results" problem, since GitHub Search
// is literal, not semantic.
//
// Usage:
//   node search.js "motion design animation"              # single query
//   node search.js animation "motion graphics" tween      # multi-keyword
//   node search.js --q animation --q "motion graphics"    # explicit --q flags
//   node search.js --topic animation                      # search a topic
//   node search.js --language python "data viz"           # filter by language
//   node search.js --top 5 "product video"
//
// Options:
//   --q <text>        an independent search query (repeatable; positional
//                     args are also treated as queries)
//   --topic <t>       add a topic: clause to EVERY query (repeatable)
//   --language <l>    add a language: clause to EVERY query
//   --top <n>         number of results PER QUERY (default 10)
// ============================================================================

import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const GITHUB_API = 'https://api.github.com/search/repositories';
const ACCEPT_HEADER = 'application/vnd.github+json';
// Real GitHub Trending data (with per-repo "stars today") served over CDN,
// immune to the GitHub API rate limit. Used only to enrich search results
// with a "trend" field.
const TRENDING_URL = 'https://cdn.jsdelivr.net/gh/Hyraze/trending-collection@main/api/daily/all.json';

// Unauthenticated GitHub Search API allows ~10 requests/min on a shared IP.
// Cap the number of parallel queries to stay safe.
const MAX_QUERIES = 8;

function parseArgs(argv) {
  const opts = { topics: [], language: null, top: 10, queries: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--q' && argv[i + 1]) {
      opts.queries.push(argv[++i]);
    } else if (a === '--topic' && argv[i + 1]) {
      opts.topics.push(argv[++i]);
    } else if (a === '--language' && argv[i + 1]) {
      opts.language = argv[++i];
    } else if (a === '--top' && argv[i + 1]) {
      opts.top = parseInt(argv[++i], 10) || 10;
    } else if (a.startsWith('--')) {
      // unknown flag: skip it and its value if present
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else {
      opts.queries.push(a);
    }
  }
  opts.queries = opts.queries.map((q) => q.trim()).filter(Boolean);
  return opts;
}

function slimRepo(repo) {
  return {
    name: repo.full_name,
    url: repo.html_url,
    description: repo.description || '',
    language: repo.language || null,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    topics: repo.topics || [],
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    homepage: repo.homepage || null,
    license: repo.license ? repo.license.spdx_id : null,
    archived: repo.archived || false,
    // trend is enriched later from the daily trending feed; null means
    // "not on today's trending list" (query failed / not found).
    added_stars: null,
    trend_note: null,
    // which of the searched keywords hit this repo (a repo matched by
    // several keywords is more likely relevant)
    matched_queries: []
  };
}

// Build the q= fragment for one search query (query words + shared clauses).
function buildClauses(queryText, topics, language) {
  const clauses = [];
  if (queryText) clauses.push(queryText);
  for (const t of topics) clauses.push(`topic:${t}`);
  if (language) clauses.push(`language:${language}`);
  return clauses.join(' ');
}

async function searchOne(clauses, perPage) {
  const url = `${GITHUB_API}?q=${encodeURIComponent(clauses)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Accept: ACCEPT_HEADER } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `GitHub API returned ${res.status}: ${body.slice(0, 120)}` };
  }
  const data = await res.json();
  return { items: data.items || [], total: data.total_count || 0 };
}

// Fetch today's trending list and build a lowercase name -> added_stars map.
// Returns null on any failure (network / parse), so the caller can mark
// "查询不到" instead of guessing.
async function buildTrendingMap() {
  try {
    const res = await fetch(TRENDING_URL);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.items)) return null;
    const map = new Map();
    for (const item of data.items) {
      const fullName = (item.title || '')
        .split('/')
        .map((s) => s.trim())
        .join('/')
        .toLowerCase();
      const added = (item.added_stars || '').replace(/,/g, '').match(/(\d+)/);
      map.set(fullName, added ? parseInt(added[1], 10) : 0);
    }
    return map;
  } catch (_) {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.queries.length === 0) {
    console.error(JSON.stringify({
      status: 'error',
      message: 'No query provided. Usage: node search.js "your query" or node search.js --q <query> --q <query>'
    }));
    process.exit(1);
  }

  if (opts.queries.length > MAX_QUERIES) {
    console.error(JSON.stringify({
      status: 'error',
      message: `Too many queries (${opts.queries.length}); max ${MAX_QUERIES} per run to stay within GitHub rate limits.`
    }));
    process.exit(1);
  }

  // Search each query independently, in parallel.
  const results = await Promise.all(
    opts.queries.map(async (q) => {
      const clauses = buildClauses(q, opts.topics, opts.language);
      const out = await searchOne(clauses, opts.top);
      return { query: q, clauses, ...out };
    })
  );

  const errors = results.filter((r) => r.error).map((r) => ({ query: r.query, error: r.error }));
  const queryTotals = results.map((r) => ({ query: r.query, total: r.total ?? 0 }));

  // Merge & de-duplicate by repo full name (case-insensitive). Keep the
  // highest-starred instance; accumulate the list of matched queries.
  const byName = new Map();
  for (const r of results) {
    for (const item of r.items || []) {
      const key = item.full_name.toLowerCase();
      const existing = byName.get(key);
      if (!existing) {
        const slim = slimRepo(item);
        slim.matched_queries = [r.query];
        byName.set(key, slim);
      } else {
        if (!existing.matched_queries.includes(r.query)) {
          existing.matched_queries.push(r.query);
        }
        if ((item.stargazers_count || 0) > (existing.stars || 0)) {
          const better = slimRepo(item);
          better.matched_queries = existing.matched_queries;
          byName.set(key, better);
        }
      }
    }
  }

  // Sort merged results by stars descending.
  const repos = [...byName.values()].sort((a, b) => b.stars - a.stars);

  // Enrich with trend: look each result up in today's trending list.
  const trendingMap = await buildTrendingMap();
  for (const repo of repos) {
    if (trendingMap && trendingMap.has(repo.name.toLowerCase())) {
      repo.added_stars = trendingMap.get(repo.name.toLowerCase());
      repo.trend_note = '今日上榜';
    } else if (trendingMap === null) {
      repo.trend_note = '查询不到 trend（trending 数据源不可用）';
    } else {
      repo.trend_note = '查询不到 trend（不在今日榜单）';
    }
  }

  // Read language preference for the remix hints.
  const USER_DIR = join(homedir(), '.follow-github');
  const CONFIG_PATH = join(USER_DIR, 'config.json');
  let language = 'bilingual';
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
      language = cfg.language || 'bilingual';
    } catch (_) { /* ignore */ }
  }

  console.log(JSON.stringify({
    status: 'ok',
    queries: opts.queries,
    queryTotals,
    language,
    totalCount: repos.length,
    repos,
    errors: errors.length > 0 ? errors : undefined
  }, null, 2));
}

main();
