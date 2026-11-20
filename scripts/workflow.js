#!/usr/bin/env node

// ============================================================================
// Follow GitHub — Workflow Search
// ============================================================================
// Search GitHub by WORKFLOW, not by a single keyword. Reads a workflow
// definition (a list of stages, each with search keywords + a curated list of
// known-good repos), then for each stage:
//   1. emits the curated repos (hand-picked, already vetted)
//   2. runs a parallel keyword search to fill gaps
//   3. merges, de-duplicates, and reports per-stage
//
// This solves the "keyword search misses half the toolchain" problem: instead
// of betting on one word for a whole domain, you search each stage of the
// production pipeline with stage-appropriate keywords.
//
// Usage:
//   node workflow.js                          # list available workflows
//   node workflow.js motion-video-production   # search every stage
//   node workflow.js motion-video-production --stage motion,audio
//   node workflow.js motion-video-production --top 5
// ============================================================================

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');

const GITHUB_API = 'https://api.github.com/search/repositories';
const ACCEPT_HEADER = 'application/vnd.github+json';
const TRENDING_URL = 'https://cdn.jsdelivr.net/gh/Hyraze/trending-collection@main/api/daily/all.json';

const MAX_QUERIES_PER_STAGE = 4;

function parseArgs(argv) {
  const opts = { stage: null, top: 5, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage' && argv[i + 1]) opts.stage = argv[++i];
    else if (a === '--top' && argv[i + 1]) opts.top = parseInt(argv[++i], 10) || 5;
    else if (!a.startsWith('--')) opts.positionals.push(a);
  }
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
    archived: repo.archived || false,
    added_stars: null,
    trend_note: null
  };
}

async function searchOne(clauses, perPage) {
  const url = `${GITHUB_API}?q=${encodeURIComponent(clauses)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Accept: ACCEPT_HEADER } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  return { items: data.items || [] };
}

async function buildTrendingMap() {
  try {
    const res = await fetch(TRENDING_URL);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.items)) return null;
    const map = new Map();
    for (const item of data.items) {
      const fullName = (item.title || '').split('/').map((s) => s.trim()).join('/').toLowerCase();
      const added = (item.added_stars || '').replace(/,/g, '').match(/(\d+)/);
      map.set(fullName, added ? parseInt(added[1], 10) : 0);
    }
    return map;
  } catch (_) {
    return null;
  }
}

async function listWorkflows() {
  const files = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith('.json'));
  const workflows = [];
  for (const f of files) {
    try {
      const wf = JSON.parse(await readFile(join(WORKFLOWS_DIR, f), 'utf-8'));
      workflows.push({
        id: wf.id,
        name: wf.name,
        perspective: wf.perspective || null,
        scope: wf.scope || null,
        audience: wf.audience || null,
        origin: wf.origin || null,
        stageCount: (wf.stages || []).length
      });
    } catch (_) { /* skip malformed */ }
  }
  return workflows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const wfId = opts.positionals[0];

  if (!wfId) {
    // List available workflows — work as a "pick a search perspective" entry.
    const workflows = await listWorkflows();
    console.log(JSON.stringify({
      status: 'ok',
      action: 'list',
      message: 'Workflows are optional search perspectives. Pick one by id, or search directly with search.js.',
      workflows
    }, null, 2));
    return;
  }

  const wfPath = join(WORKFLOWS_DIR, `${wfId}.json`);
  if (!existsSync(wfPath)) {
    console.error(JSON.stringify({ status: 'error', message: `Workflow not found: ${wfId}` }));
    process.exit(1);
  }

  const wf = JSON.parse(await readFile(wfPath, 'utf-8'));
  let stages = wf.stages || [];
  if (opts.stage) {
    const wanted = opts.stage.split(',').map((s) => s.trim());
    stages = stages.filter((s) => wanted.includes(s.id));
  }

  const trendingMap = await buildTrendingMap();
  const stageResults = [];

  for (const stage of stages) {
    const keywords = (stage.search_keywords || []).slice(0, MAX_QUERIES_PER_STAGE);

    // Parallel keyword search for this stage.
    const searched = await Promise.all(
      keywords.map(async (kw) => {
        const out = await searchOne(kw, opts.top);
        return { query: kw, ...out };
      })
    );

    // Merge searched results, de-dup.
    const byName = new Map();
    for (const r of searched) {
      if (r.error) continue;
      for (const item of r.items || []) {
        const key = item.full_name.toLowerCase();
        if (!byName.has(key) || (item.stargazers_count || 0) > (byName.get(key).stars || 0)) {
          byName.set(key, slimRepo(item));
        }
      }
    }
    let found = [...byName.values()].sort((a, b) => b.stars - a.stars);

    // Enrich trend.
    for (const repo of found) {
      if (trendingMap && trendingMap.has(repo.name.toLowerCase())) {
        repo.added_stars = trendingMap.get(repo.name.toLowerCase());
        repo.trend_note = '今日上榜';
      } else if (trendingMap === null) {
        repo.trend_note = '查询不到 trend（数据源不可用）';
      } else {
        repo.trend_note = '查询不到 trend（不在今日榜单）';
      }
    }

    stageResults.push({
      id: stage.id,
      name: stage.name,
      name_en: stage.name_en,
      keywords,
      curated: stage.curated || [],
      found
    });
  }

  console.log(JSON.stringify({
    status: 'ok',
    workflow: wf.name,
    workflowId: wfId,
    stages: stageResults
  }, null, 2));
}

main();
