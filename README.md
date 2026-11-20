# Follow GitHub

GitHub 趋势追踪 + 项目检索 skill。每天汇总 GitHub 上正在涨星的仓库（全语言、按 star 排序），也能在你提出具体需求时（如"开发""产品宣传动画""数据可视化"）自动找工作流、逐环节搜出最合适的开源项目。

## 核心方法（find.js）

你提任意需求，`find.js` 用**两条独立并行的线**同时搜，最后合并输出：

1. **工作流发现**：先在 GitHub 搜这个领域有没有「工作流项目」（`awesome <领域>`、`<领域> roadmap`、guide、curated list），找到后解析它的 README，拆出每个流程节点，再为每个节点搜具体项目。**工作流是实时搜出来的，不是手写静态清单，所以不会落后。**
2. **直接搜索**：同时用多关键词直接搜项目。

```bash
node scripts/find.js "data visualization"   # 工作流发现 + 直接搜索（并行）
node scripts/find.js "开发" --no-workflow    # 只要直接搜索
node scripts/find.js --list                  # 列出本地已沉淀的工作流
```

## 能力

1. **每日趋势摘要**：抓取 GitHub 真实 Trending 数据（全语言、按 star 降序），含「今日涨星」。
2. **找项目（核心方法）**：`find.js` 工作流发现 + 直接搜索并行。
3. **多关键词搜索**：`search.js` 按关键词/topic/language 搜，支持多词并行 + 合并去重，带 trend。

## 特性

- **零 API key**：趋势走 trending-collection CDN，搜索走官方 GitHub Search API 公开端点。
- **零依赖**：脚本只用 Node 内置 `fetch`，无需 `npm install`。
- **双语摘要**：默认中英逐段交错（`config.language` 可切换 en/zh/bilingual）。
- **严格不编造**：描述、star 数、fork 数均来自 API 原始数据，每条带原文链接；查不到 trend 就明说。

## 用法

```bash
# 每日趋势摘要（默认 daily，也可 weekly / monthly）
node scripts/prepare-digest.js
node scripts/prepare-digest.js weekly
node scripts/prepare-digest.js monthly

# 找项目（核心）：工作流发现 + 直接搜索并行
node scripts/find.js "数据可视化"
node scripts/find.js "产品宣传动画"
node scripts/find.js "开发一个博客" --top 5

# 多关键词搜索（底层）
node scripts/search.js animation "motion graphics" tween
node scripts/search.js --q animation --q "motion graphics"
node scripts/search.js --language python "data visualization"

# 本地已沉淀的工作流（可选增强）
node scripts/workflow.js
node scripts/workflow.js motion-by-scene --stage data-animation
```

> 多关键词搜索：GitHub Search 是字面匹配、不是语义搜索，所以把需求拆成多个近义英文词并行搜、再合并去重，能显著降低"关键词没选对导致漏掉好项目"的概率。

> 工作流发现：像"开发""做动画"这种需求，GitHub 上早有人维护好了方法论清单（awesome-xxx / roadmap / guide）。`find.js` 每次都实时搜这些清单、解析它们的 README、逐环节找项目——比维护一份手写清单更能跟上领域演进。

## 配置

`~/.follow-github/config.json`：

```json
{
  "language": "bilingual",
  "frequency": "daily",
  "delivery": { "method": "stdout" },
  "trendingSize": 10,
  "trendingWindowDays": 7
}
```

- `language`: en / zh / bilingual
- `trendingSize`: 每类榜单抓多少条（默认 10）
- `trendingWindowDays`: "新建"窗口天数（默认 7）

## 数据源说明

GitHub 官方 REST API **不提供 Trending 榜单**（Trending 页面是纯 HTML）。本 skill 采用**双引擎**：

1. **每日趋势（主）**：`trending-collection` 项目提供的静态 JSON（经 jsDelivr CDN），这是真正的 GitHub Trending 数据，含每条项目的「当期涨星数」（`stars today` / `stars this week`）。走 CDN、零限速风险。
2. **GitHub Search API（检索）**：按需检索（关键词/topic/language + `sort=stars`），也是工作流发现的来源。

未认证的 GitHub Search API 限速 10 次/分钟，且共享 IP 的 core 限额经常打满，所以每日趋势**优先走 CDN**，只有检索时才碰 Search API。

## 目录结构

## 安装（换电脑 / 换 agent 后继续用）

```bash
# 1. clone 到 skills 目录
mkdir -p ~/.workbuddy/skills
git clone https://github.com/jenna950502/follow-github.git ~/.workbuddy/skills/follow-github

# 2. 首次运行前，生成默认配置（可选，脚本无配置也能跑）
mkdir -p ~/.follow-github
cat > ~/.follow-github/config.json << 'CFG'
{
  "language": "bilingual",
  "frequency": "daily",
  "delivery": { "method": "stdout" },
  "trendingSize": 10,
  "trendingWindowDays": 7
}
CFG

# 3. 直接使用（无需 npm install，脚本只用 Node 内置 fetch）
node ~/.workbuddy/skills/follow-github/scripts/find.js "游戏开发"
```

> 零依赖：脚本只用 Node 内置 `fetch`，无需 `npm install`。只要新机器装了 Node（≥18），clone 即可用。

## 目录结构

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
├── workflows/               # 可选：本地沉淀的工作流（按领域）
│   └── animation/
│       ├── by-stage.json
│       └── by-scene.json
└── scripts/
    ├── package.json
    ├── prepare-digest.js    # 每日趋势
    ├── find.js              # 核心：工作流发现 + 直接搜索并行
    ├── search.js            # 多关键词搜索 + trend
    └── workflow.js          # 可选：跑本地沉淀的工作流
```
