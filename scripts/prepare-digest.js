#!/usr/bin/env node

// ============================================================================
// Follow GitHub — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a GitHub trending digest.
//
// Data source (dual engine, no API key required):
//  - PRIMARY: trending-collection static JSON via jsDelivr CDN. This is real
//    GitHub Trending data (with "stars today" per repo) served over a CDN, so
//    it never hits the GitHub API and is immune to the shared-IP rate limit.
//  - FALLBACK: official GitHub Search API (sort=stars). Used only if the CDN
//    feed is unreachable, since the unauthenticated API is rate-limited.
//
// Outputs a single JSON blob to stdout. The LLM's ONLY job is to read this
// JSON, remix the content, and output the digest text.
//
// Usage: node prepare-digest.js [daily|weekly|monthly]
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-github');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Hyraze/trending-collection@main/api';
const GITHUB_API = 'https://api.github.com/search/repositories';
const ACCEPT_HEADER = 'application/vnd.github+json';

const PROMPT_FILES = [
  'summarize-repos.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function searchUrl(query, perPage) {
  return `${GITHUB_API}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
}

function slimSearchRepo(repo) {
  return {
    name: repo.full_name,
    url: repo.html_url,
    description: repo.description || '',
    language: repo.language || null,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    topics: repo.topics || [],
    added_stars: null,
    created_at: repo.created_at,
    pushed_at: repo.pushed_at,
    homepage: repo.homepage || null,
    license: repo.license ? repo.license.spdx_id : null,
    archived: repo.archived || false
  };
}

// Normalize a trending-collection item (title is "owner / repo", plus
// added_stars like "314 stars today") into the standard repo shape.
function slimTrendingItem(item) {
  const fullName = (item.title || '')
    .split('/')
    .map((s) => s.trim())
    .join('/');
  const added = item.added_stars || '';
  // Format is always a plain integer + unit text, e.g.
  // "314 stars today", "1,059 stars today", "7,257 stars this week".
  // Strip commas and grab the first number. No "k" suffix exists in this feed.
  const numMatch = added.replace(/,/g, '').match(/(\d+)/);
  const addedNum = numMatch ? parseInt(numMatch[1], 10) : null;
  return {
    name: fullName,
    url: item.url,
    description: item.description || '',
    language: item.language || null,
    stars: item.stars || 0,
    forks: item.forks || 0,
    topics: [],
    added_stars: addedNum,
    created_at: null,
    pushed_at: null,
    homepage: null,
    license: null,
    archived: false
  };
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];
  const periodArg = (process.argv[2] || 'daily').toLowerCase();
  const period = ['daily', 'weekly', 'monthly'].includes(periodArg) ? periodArg : 'daily';

  // 1. Read user config
  let config = {
    language: 'bilingual',
    frequency: 'daily',
    delivery: { method: 'stdout' },
    trendingSize: 15,
    trendingWindowDays: 7
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  const size = config.trendingSize || 15;
  const windowDays = config.trendingWindowDays || 7;

  // 2. PRIMARY: fetch trending-collection via CDN.
  const feed = await fetchJSON(`${CDN_BASE}/${period}/all.json`);
  let trending = [];
  let source = 'trending-collection (jsDelivr CDN)';

  if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
    trending = feed.items
      .slice(0, size)
      .map(slimTrendingItem)
      .filter((r) => r.name && r.url);
  } else {
    errors.push('Could not fetch trending-collection feed from CDN');
  }

  // 3. FALLBACK: official GitHub Search API, only if the CDN feed is empty.
  let fallbackNew = [];
  let fallbackAll = [];
  if (trending.length === 0) {
    const since = daysAgo(windowDays);
    const headers = { Accept: ACCEPT_HEADER };
    const [newRes, allRes] = await Promise.all([
      fetchJSON(searchUrl(`created:>${since}`, size), headers),
      fetchJSON(searchUrl(`pushed:>${since} stars:>1000`, size), headers)
    ]);
    fallbackNew = (newRes?.items || []).map(slimSearchRepo);
    fallbackAll = (allRes?.items || []).map(slimSearchRepo);
    if (fallbackNew.length === 0 && fallbackAll.length === 0) {
      errors.push('Fallback GitHub Search API also returned no results');
    } else {
      source = 'GitHub Search API (fallback)';
    }
  }

  // 4. Load prompts: user custom > local default
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 5. Build output.
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    source,
    period,

    config: {
      language: config.language || 'bilingual',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' },
      trendingSize: size,
      trendingWindowDays: windowDays
    },

    content: {
      trending,
      fallbackNew,
      fallbackAll
    },

    stats: {
      trendingCount: trending.length,
      fallbackNewCount: fallbackNew.length,
      fallbackAllCount: fallbackAll.length
    },

    prompts,

    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
