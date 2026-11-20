#!/usr/bin/env node

// ============================================================================
// Follow GitHub — Find Projects (the core method)
// ============================================================================
// "把需求变成最合适的一组项目" — 工作流是动态发现、实时更新的。
//
// 给定一个领域/需求（"开发", "产品宣传动画", "数据可视化", ...），它做两件事：
//
//   1. 先搜这个领域有没有「工作流项目」（roadmap / awesome-xxx / build-your-own /
//      system-design / skills 这类方法论/流水线仓库）。如果有，就把它们作为
//      工作流返回，并解析每个流程节点（stages），再为每个节点搜具体项目。
//      返回：工作流项目 + 每个节点的具体项目。
//
//   2. 同时多关键词直接搜项目。
//
// 两者共同构成输出。工作流是「实时搜出来的」，不是手写的静态清单，所以不会落后。
//
// Usage:
//   node find.js "产品宣传动画"        # 领域工作流 + 直接搜索
//   node find.js "开发" --top 5
//   node find.js "data visualization" --top 5 --no-workflow   # 只直接搜
//   node find.js --list                 # 列出本地已沉淀的工作流（可选增强）
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

// Workflow-hunting keywords appended to the user's need. These surface
// "methodology / pipeline / roadmap / skills" repos — the workflow layer.
const WORKFLOW_HINTS = ['roadmap', 'awesome', 'build your own', 'system design', 'skill', 'guide', 'best practices', 'toolbox', 'curated list'];

function parseArgs(argv) {
  const opts = { top: 5, noWorkflow: false, list: false, need: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top' && argv[i + 1]) opts.top = parseInt(argv[++i], 10) || 5;
    else if (a === '--no-workflow') opts.noWorkflow = true;
    else if (a === '--list') opts.list = true;
    else if (!a.startsWith('--')) opts.need.push(a);
  }
  opts.need = opts.need.join(' ').trim();
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

// Search one query. `andMode=true` joins words with `+` (GitHub's AND operator)
// so a multi-word need matches repos containing ALL words, not ANY.
async function searchOne(clauses, perPage, andMode = false) {
  const q = andMode ? clauses.trim().split(/\s+/).join('+') : clauses;
  const url = `${GITHUB_API}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Accept: ACCEPT_HEADER } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  return { items: data.items || [], total: data.total_count || 0 };
}

async function buildTrendingMap() {
  try {
    const res = await fetch(TRENDING_URL);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.items)) return null;
    const map = new Map();
    for (const item of data.items) {
      const fn = (item.title || '').split('/').map((s) => s.trim()).join('/').toLowerCase();
      const added = (item.added_stars || '').replace(/,/g, '').match(/(\d+)/);
      map.set(fn, added ? parseInt(added[1], 10) : 0);
    }
    return map;
  } catch (_) {
    return null;
  }
}

function enrichTrend(repo, trendingMap) {
  if (trendingMap && trendingMap.has(repo.name.toLowerCase())) {
    repo.added_stars = trendingMap.get(repo.name.toLowerCase());
    repo.trend_note = '今日上榜';
  } else if (trendingMap === null) {
    repo.trend_note = '查询不到 trend（数据源不可用）';
  } else {
    repo.trend_note = '查询不到 trend（不在今日榜单）';
  }
  return repo;
}

function mergeDedup(repos) {
  const byName = new Map();
  for (const r of repos) {
    const key = r.name.toLowerCase();
    if (!byName.has(key) || (r.stars || 0) > (byName.get(key).stars || 0)) {
      byName.set(key, r);
    }
  }
  return [...byName.values()].sort((a, b) => b.stars - a.stars);
}

// Search workflow-layer repos for a domain. GitHub's convention is `awesome-<topic>`,
// so the awesome query puts "awesome" first. Roadmap / guide / skill hints are
// appended after the domain.
//
// Returns two separate groups:
//   - workflowRepos: methodology/lists (awesome-xxx, roadmap, guide), kept
//     separate so their lower star count is NOT drowned by high-star tools
//   - (the caller still runs direct search for concrete tools)
async function findWorkflowRepos(need, top) {
  const queries = [
    `awesome ${need}`,
    `${need} roadmap`,
    `${need} guide`,
    `${need} curated list`,
    `${need} skill`
  ];
  const results = await Promise.all(queries.map((q) => searchOne(q, top)));
  const found = [];
  for (const r of results) {
    if (r.error) continue;
    for (const item of r.items || []) found.push(slimRepo(item));
  }
  return mergeDedup(found);
}

// Parse a workflow repo's README into stages (## headings + bullet items).
// Tries common branch and filename variants (README.md / readme.md), so
// lowercase filenames don't get missed.
async function parseWorkflowStages(repoName) {
  const branches = ['main', 'master'];
  const filenames = ['README.md', 'readme.md'];
  for (const b of branches) {
    for (const f of filenames) {
      const url = `https://raw.githubusercontent.com/${repoName}/${b}/${f}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'follow-github' } });
        if (!res.ok) continue;
        const md = await res.text();
        const stages = extractStages(md);
        if (stages && stages.length > 0) return stages;
      } catch (_) {
        continue;
      }
    }
  }
  return null;
}

function extractStages(md) {
  const lines = md.split('\n');
  const stages = [];
  let current = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      current = { name: h[1].trim(), items: [] };
      stages.push(current);
      continue;
    }
    if (current) {
      // "- [name](url) - desc" or "- [name](url): desc"
      const link = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:-\s*|:\s*)?(.*)$/);
      if (link) {
        current.items.push({ name: link[1], url: link[2], desc: link[3].trim() });
      }
    }
  }
  return stages.filter((s) => s.items.length > 0);
}

// For each stage of a workflow, search concrete repos for that stage's name.
async function searchStageRepos(stageName, top) {
  const out = await searchOne(stageName, top);
  if (out.error) return [];
  return out.items.map(slimRepo);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const trendingMap = await buildTrendingMap();

  if (opts.list) {
    const domains = [];
    const entries = await readdir(WORKFLOWS_DIR, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const files = (await readdir(join(WORKFLOWS_DIR, e.name))).filter((f) => f.endsWith('.json'));
      domains.push({ domain: e.name, workflows: files.map((f) => f.replace('.json', '')) });
    }
    console.log(JSON.stringify({ status: 'ok', action: 'list', domains }, null, 2));
    return;
  }

  const need = opts.need;
  if (!need) {
    console.error(JSON.stringify({ status: 'error', message: 'No need provided. Usage: node find.js "你的需求"' }));
    process.exit(1);
  }

  // Two INDEPENDENT parallel tracks, started together:
  //   A. direct multi-keyword search
  //   B. workflow discovery (find workflow repos -> parse stages -> search per stage)
  // They run concurrently and merge into one output at the end.

  // A. Direct multi-keyword search (always runs).
  // The whole need is searched AS ONE query first (GitHub treats multi-word
  // queries as AND), so "game development" matches game-dev repos, not the
  // generic "development" mega-lists. Individual words are added only as
  // supplementary variants, and their results are ranked below the whole-need
  // match (lower weight), so they can't drown the relevant results.
  const needTokens = need.split(/\s+/).filter(Boolean);
  const directTask = (async () => {
    // Whole-need with forced AND (all words must match), so "game development"
    // matches game-dev repos instead of generic "development" mega-lists.
    const whole = await searchOne(need, opts.top, true);
    const wholeRepos = whole.error ? [] : whole.items.map(slimRepo);

    // Supplementary variants: only add single-word variants when the need is
    // a SINGLE word (to broaden coverage via synonyms). For multi-word needs,
    // the AND search is already precise — splitting into single words would
    // inject noise (e.g. "development" alone matches generic mega-repos).
    let extra = [];
    if (needTokens.length === 1) {
      const variants = await Promise.all(needTokens.map((kw) => searchOne(kw, 3)));
      const variantRepos = mergeDedup(
        variants.flatMap((r) => (r.error ? [] : r.items.map(slimRepo)))
      );
      const wholeNames = new Set(wholeRepos.map((r) => r.name.toLowerCase()));
      extra = variantRepos.filter((r) => !wholeNames.has(r.name.toLowerCase()));
    }

    const repos = [...mergeDedup(wholeRepos), ...extra].slice(0, opts.top * 2);
    return repos.map((r) => enrichTrend(r, trendingMap));
  })();

  // B. Workflow discovery (unless disabled).
  const workflowTask = (async () => {
    if (opts.noWorkflow) return { repos: [], stages: [] };
    const workflowRepos = (await findWorkflowRepos(need, opts.top)).slice(0, opts.top);

    // Parse the README of the most relevant workflow repo. Relevance scoring:
    // 1. name contains the need's key token(s) AND is a list/roadmap/map
    // 2. name contains the need's key token(s)
    // 3. any list/roadmap/map/awesome
    // 4. first repo
    // This avoids picking a generic "awesome-*" that happens to rank high but
    // is unrelated to the need (e.g. awesome-youtubers for "game development").
    const needTokens = need.toLowerCase().split(/\s+/).filter(Boolean);
    const isList = (r) => /awesome|list|roadmap|curated|map|mind/i.test(r.name);
    const nameHits = (r) => {
      const n = r.name.toLowerCase();
      return needTokens.some((t) => t.length > 2 && n.includes(t));
    };
    const parseTarget =
      workflowRepos.find((r) => nameHits(r) && isList(r)) ||
      workflowRepos.find((r) => nameHits(r)) ||
      workflowRepos.find((r) => isList(r)) ||
      workflowRepos[0];

    let workflowStages = [];
    if (parseTarget) {
      const stages = await parseWorkflowStages(parseTarget.name);
      if (stages && stages.length > 0) {
        const meaningful = stages.filter((s) => !/^[^a-z]*(contents?|table of contents)\b/i.test(s.name.trim()));
        workflowStages = await Promise.all(
          meaningful.slice(0, 8).map(async (s) => ({
            stage: s.name,
            sourceRepo: parseTarget.name,
            items: s.items.slice(0, 5),
            found: (await searchStageRepos(s.name, 3)).map((r) => enrichTrend(r, trendingMap))
          }))
        );
      }
    }
    return {
      repos: workflowRepos.map((r) => enrichTrend(r, trendingMap)),
      stages: workflowStages
    };
  })();

  // Run both tracks in parallel, then merge.
  const [directResult, workflowResult] = await Promise.all([directTask, workflowTask]);

  console.log(JSON.stringify({
    status: 'ok',
    need,
    mode: {
      workflow: !opts.noWorkflow,
      direct: true
    },
    workflowRepos: workflowResult.repos,
    workflowStages: workflowResult.stages,
    directRepos: directResult
  }, null, 2));
}

main();
