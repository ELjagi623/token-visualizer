<p align="center">
  <img src="docs/assets/icon.svg" alt="Token Visualizer" width="96" height="96">
</p>

<h1 align="center">Token Visualizer</h1>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

纯本地运行的 Claude Code token 用量可视化：读取 `~/.claude/projects` 下的会话记录（JSONL），按项目统计 token，展示总量、时间曲线、模型 / 工具 / 缓存 / 会话分析，并按官方 API 单价折算"等价 API 成本"、对比订阅费算回本。

- **只读**：不会修改 `~/.claude` 里的任何文件；自己的缓存和设置只写应用数据目录。
- **不读对话正文**：只提取用量与元数据字段；会话标题只在本机显示、不进导出。
- **零外网**：运行时不发任何外部请求（字体、图标全部本地打包），价格表是开发时联网核对后随应用保存的。
- 需求见 `PRD.md`；设计稿与成本规格在 `docs/design/`；自动验收报告在 `docs/ACCEPTANCE.md`。

## 下载安装（Windows，推荐）

不需要安装 Node.js，也不需要浏览器：到 [Releases](../../releases) 页面下载

- `Token-Visualizer-Setup-<版本>.exe`：安装版（可选安装目录，创建桌面 / 开始菜单快捷方式）；
- `Token-Visualizer-<版本>-portable.exe`：免安装版（双击即用）。

双击后会打开一个独立窗口（不是浏览器标签页），关闭窗口即退出。与命令行版共用同一份设置与缓存（`%APPDATA%\TokenVisualizer`），卸载不会删除它们。

> 安装包目前**没有代码签名**，Windows SmartScreen 首次运行时可能提示"未知发布者"：点"更多信息 → 仍要运行"即可。Release 说明里附有 SHA-256 校验值；介意的话可以从源码自己构建（见下）。
> 目前只在 Windows 11 上验证过；macOS / Linux 暂未验证。

自己构建桌面 APP：

```
npm install
npm run app            # 构建并以独立窗口运行（开发调试）
npm run dist           # 打包 Windows 安装包与免安装版，产物在 release/
npm run smoke:desktop  # 冒烟测试：启动真实窗口，检查渲染、沙箱、单实例、退出释放端口
```

（桌面外壳在 `desktop/`：Electron 主进程在进程内直接启动本项目的本地服务，再用一个窗口加载 `http://127.0.0.1:47821`；服务端代码与数据 json 由 esbuild 打成单个 `dist-desktop/main.cjs`。窗口开启了沙箱与上下文隔离，只允许在本服务来源内导航，其它链接交给系统浏览器。更换图标：替换 `desktop/icon.png`，或 `npm run icon` 重新生成占位图标。）

## 快速开始（命令行 / 浏览器方式）

环境：Windows 11，Node.js >= 22.18（本机用 v26）。服务端运行时**零第三方依赖**，TypeScript 由 Node 原生 type-stripping 直接运行。

```
npm install            # 安装开发依赖（改前端 / 跑测试才需要；web/dist 已随项目提供，只想使用可跳过）
npm run build          # 构建前端到 web/dist（改了前端才需要重新构建）
npm start              # 启动并自动打开浏览器 http://127.0.0.1:47821/（端口被占用则向后顺延）
```

- 不想自动打开浏览器：`npm start -- --no-open`（注意中间的 `--`，否则 npm 会把 `--no-open` 当成自己的参数吞掉）或设环境变量 `TV_NO_OPEN=1`。
- **双击 `start.cmd`**（或 `start.ps1`）：检测 Node 版本（缺失 / 过旧时给出中文引导）→ 启动服务 → 打开默认浏览器；窗口里显示地址，关闭窗口即退出。
- 首次启动会全量解析所有会话文件（本机约 700 MB / 12 万行约 2 秒），期间页面显示扫描进度，已解析部分可先查看；之后读缓存，从 start.cmd 到总览可交互约 1.5 秒。
- 数据目录默认 `%USERPROFILE%\.claude\projects`，应用数据目录默认 `%APPDATA%\TokenVisualizer`。可在设置页改数据目录，或用环境变量（见下）。

环境变量：

| 变量 | 作用 |
|---|---|
| `TV_DATA_ROOT` | 数据根目录，默认 `%USERPROFILE%\.claude\projects`（设置页里保存的目录优先） |
| `TV_APPDATA_DIR` | 应用数据目录（缓存 / 设置 / 价格 / 项目覆盖），默认 `%APPDATA%\TokenVisualizer` |
| `TV_PORT` | 起始端口，默认 47821，被占用则向后顺延；`0` = 系统分配 |
| `TV_NOW` | 固定"当前时间"（ISO 或毫秒，仅测试用，用来复现"今日 / 本月"边界） |
| `TV_NO_OPEN=1` | 不自动打开浏览器 |

## 命令表

| 命令 | 作用 |
|---|---|
| `npm start` | 启动本地服务（仅绑定 127.0.0.1）；`-- --no-open` 不开浏览器，`-- --port <n>` 指定起始端口 |
| `npm run build` | 构建前端到 `web/dist`（服务端托管它；产物要保留在项目里） |
| `npm run app` | 构建后以独立桌面窗口运行（Electron） |
| `npm run dist` | 打包 Windows 安装包 + 免安装版到 `release/` |
| `npm run smoke:desktop` | 桌面 APP 冒烟测试（真实窗口：渲染 / 沙箱 / 单实例 / 退出释放端口） |
| `npm run dev:web` | 前端开发服务器（Vite，<http://127.0.0.1:5173>，`/api` 代理到 `TV_PORT`（默认 47821）；需另开终端 `npm start -- --no-open`） |
| `npm test` | Vitest 单测（约 30 秒） |
| `npm run test:e2e` | Playwright E2E（用系统 Edge；先 `npm run build`；自带临时数据根与服务进程；截图写到 `test/screenshots/`；约 6 分钟，运行期间不要并发其它浏览器进程） |
| `npm run typecheck` | `tsc --noEmit` 类型检查（服务端 + 前端 + E2E 三个 tsconfig） |
| `npm run acceptance` | **自动验收**：对 fixture 逐条核对 PRD 第 10 节可自动化的验收（去重、项目识别、总量 = 曲线之和、日界、模型占比、口径、增量刷新 ≤ 10 s、容错、导出）+ 成本守恒 + AI 运行时长手算 + 隐藏项目 + 只读 / 零外网审计，结果写 `docs/ACCEPTANCE.md`，任何失败退出码非 0（约 1 分钟）。`-- --real` 追加真实数据（只读）快照核对；`-- --e2e` 另跑 E2E；`-- --skip-unit` 跳过 vitest / typecheck |
| `npm run fixture` | 重新生成合成 fixture（`test/fixtures/projects/` 与 `expected.json`），输出逐字节可重复 |
| `npm run check:prices` | 打印内置模型价格 / 订阅档位月费，并校验每个非空值都带 https 来源与核对日期 |
| `npm run parse -- --root "<目录>" [--json]` | 对任意数据根做解析 + 去重，打印统计、token 总和、耗时与峰值内存 |
| `npm run verify -- --root "<目录>" [--tz Asia/Shanghai]` | 独立核对：用与主实现不共享代码的朴素实现和主实现各算一遍（都只读到启动时快照的文件大小），比较总量 / 唯一消息数 / 项目 / 模型 / 本地日 / 会话；零差异退出码 0 |
| `npm run bench -- [--root "<目录>"]` | 扫描基准：首次全量 / 无变化增量 / 冷启动读缓存的耗时、进度回调次数、缓存大小、峰值内存（缓存写临时目录） |
| `npm run bench:api -- [--root "<目录>"]` | API 基准：各端点 50 次请求的 p50 / p95 |

## 页面

顶栏分段导航：**总览 / 分析 / 会话 / 设置**，右侧是状态胶囊（Scanning / Live / Active / Idle / Error / Offline）和主题切换（月亮 / 太阳一键切换，旁边小箭头可选"跟随系统"）。左侧项目栏：搜索、排序、"全部项目"合计、每项 30 天迷你曲线、Scratch（Claude 桌面版临时对话）默认归并为一组、悬浮显示完整路径、底部"已隐藏 N 个"可恢复；窄于 900 px 折叠为抽屉（页头按钮打开），宽屏也可手动收起。路由是 hash 路由，`#/overview?project=<id>&range=…`，筛选状态都在 URL 里，刷新 / 后退可还原。

- **总览**：筛选条（时间范围 今天 / 近 7 天 / 近 30 天 / 本月 / 近 90 天 / 全部、模型多选、Total ⇄ Fresh、模型家族合并、成本口径 等价 API ⇄ 订阅摊销、导出）；使用状态卡（今日用量 + 进度条，进度按每日预算 > 每月预算 > 近 30 天日均）；9 张指标卡（累计总 Token、今日、本周、本月、请求数、缓存命中率、输出 ÷ 新输入、等价 API 成本、AI 运行时长）；订阅回本卡；Token 时间曲线（面积 / 柱状、小时 / 日 / 周 / 月、拆分 总量 / 类型 / 模型 / 项目、Token ⇄ 成本、峰值标注、图例点击显隐）；26 周日历热力图（点某天看当天按小时曲线和会话列表）；今日 vs 昨日。
- **分析**：Token 类型构成（含思考占输出）、模型排行（环形 + 条形 + 明细，可按家族合并，本地模型带标记）、缓存效率（命中率趋势 + 写读比）、活跃时段（星期 × 小时热力图）、工具排行（仅工具名与次数）、项目对比、主线 vs 子代理、本地 vs 云端、会话 Top 10、数据质量面板。
- **会话**：表格（标题、项目、开始时间、时长、请求、总 Token、估算成本、主要模型）、排序 / 搜索 / 项目筛选 / 分页；详情（逐次请求柱状图、类型构成、工具使用、上下文增长曲线与"压缩"点），可直达 `#/sessions/<id>`。
- **设置**：见下节。
- **成本模块 `#/cost`**（总览的子视图，顶栏仍高亮"总览"；总览的"订阅回本"卡与成本卡有入口）：两张口径卡、每日成本柱 + 每日订阅费虚线、按项目两种成本表、三种空状态。**成本页有自带的范围选择（近 7 / 30 / 90 天、本月、全部），没有联动全局筛选条**（项目仍沿用页面顶部所选项目），这是有意的取舍。

所有页面都有加载骨架、空状态（数据根为空 / 范围内无记录）与错误状态（数据根不可读时每个页面顶部都给出原因和"前往设置"）。

## 设置说明

设置页（`#/settings`）除价格表需点"保存价格表"外，其余修改即时保存；全部只写应用数据目录（`settings.json` / `prices.json` / `project-overrides.json`）。

| 分区 | 说明 |
|---|---|
| 数据源 | 数据根目录：输入路径 → "检测"（只读统计项目文件夹 / 会话文件数）→ "应用"才生效；非法路径给中文原因且不改当前数据；"恢复自动"回到默认目录 |
| 显示 | 默认统计口径（Total / Fresh）、主题（浅 / 深 / 跟随系统）、时区（IANA 列表或跟随系统；决定"今天"和每日统计的日界）、一周起始日（周一 / 周日） |
| 数据刷新 | 自动刷新开关与间隔（5 / 10 / 30 / 60 秒，增量轮询）；"立即全量重建"丢弃缓存重新解析（正常不需要） |
| 模型价格表 | 见"成本口径"；可编辑 / 新增 / 还原 / 恢复默认，匹配支持精确 / 前缀 / 通配 |
| 订阅方案 | Pro / Max 5x / Max 20x / 自定义月费（USD）；预置档位月费来自官方定价页（带来源与核对日期），核对不到的档位需要手填 |
| 月费币种 / 汇率 | 月费框前可在 USD / CNY 间切换，已有数字按汇率自动换算；汇率（1 USD = ? CNY，默认 7.2）在设置里手填，软件不联网。内部仍统一以美元存储和计算，人民币只是输入 / 显示层 |
| 续费日 | 每月几号续费（1–31，默认不设置）。设置后"本月"= 当前订阅周期（续费日 → 下个续费日前一天），影响本月 Token、本月 vs 上月环比、筛选栏"本月"、月预算进度条、订阅回本与日订阅费；该月没有此日（如 31 号遇 2 月）按当月最后一天算。不设置则按自然月。与月费无关 |
| 预算 | 每日 / 每月预算（M tokens），总览使用状态卡进度条按它计算，超过 100% 变色 |
| 项目管理 | 归并 Scratch 开关；逐项重命名 / 置顶 / 隐藏（隐藏项目的记录整体不计入"全部项目"合计、曲线、成本、运行时长、导出，所以分组之和始终等于合计；不改任何源数据） |

## 成本口径

> 所有成本都是**估算**，以官方账单为准。界面上每个金额旁都带"估算"。运行时应用不联网，价格变动后请在设置页手动更新。

**口径 ① 等价 API 成本**（永远可算，只要有价格）：本机记录的 token 按各模型官方 API 单价折算——"如果这些用量走 API 要花多少钱"。

```
成本 = Σ 记录（input × 输入价 + output × 输出价 + cacheWrite5m × 5m 写价 + cacheWrite1h × 1h 写价 + cacheRead × 缓存读价）/ 1,000,000
```

输出已含思考，不重复计；缺 5m / 1h 细分的缓存写按 5m 价并在数据质量面板计数；**模型分类规则**：以 `claude-` 开头的是 Anthropic 云端模型；其余一切模型名（路径 / gguf、`org/name`、无路径的 `qwen3-coder-next-uncensored-heretic.i1`、`grok-4.7`、`gpt-4o`、别名 `sonnet` 等；`<synthetic>` 与 `unknown` 除外）都视为本地 / 非 Anthropic 模型——成本不适用、显示"本地"、不进入成本占比，也不算"未计价"（无路径的非 claude- 名字若想按云端价计费，可在价格表为它新增一条规则，用户规则优先）；**以 `claude-` 开头但价格缺失的云端模型显示"—"并提示"未计价"，绝不当 0**；`speed=fast` 的记录只有该价格规则填了 `fastMultiplier`（内置里官方公布了 fast 价的模型为 ×2）才计溢价。

**口径 ② 订阅摊销成本**（需要订阅月费）：把订阅费按天、按占比分摊到项目 / 会话 / 模型上，回答"这个项目大约占了我订阅费里的多少钱"。算法：每个本地日 d（不晚于今天）日订阅费 = 月费 ÷ 当月天数（设置了续费日则 ÷ 所在订阅周期的天数）；当天等价 API 成本 `C_d > 0` 时，条目 i 分得 `日费 × C_{d,i} ÷ C_d`；`C_d = 0`（无用量或全部未计价）的日子，日订阅费计入 `idleUsd`（闲置摊销）。因此 Σ 分摊 + idle = 范围内日订阅费之和。**这不是额度消耗，不是实际扣费**。

**订阅回本卡**（总览）：本月（设置了续费日则为当前订阅周期）至今等价 API 成本、订阅月费、倍数（成本 ÷ 月费）、"相当于省下 $X"（未超过月费显示"尚未回本"，不会出现负数省钱）、按近期日均线性外推的整月预估倍数（标"预估"）。局限：只统计**本机记录**，网页版 / 其它设备的用量不在内；订阅方案按你当前的选择套用到整月。

**"用了套餐额度的百分之几"无法计算**：Anthropic 不公布 token 额度，限额按 5 小时窗口 / 每周动态限制，本机日志里也没有额度消耗信息，所以界面不会出现任何额度百分比。

**价格来源**：`src/server/data/prices.default.json`（Anthropic 官方 API 定价页 https://platform.claude.com/docs/en/about-claude/pricing）与 `plans.default.json`（官方订阅定价页 https://claude.com/pricing），每个非空值都带 `sourceUrl` 与 `checkedAt`（2026-11-10 核对），`npm run check:prices` 校验"无来源的非空价格 = 0 条"。内置不含 Haiku 5.5（官方按提示长度分档）与受限的 Mythos，请在设置页自行添加；非 `claude-` 前缀的模型（如 `qwen3-coder-next-uncensored-heretic.i1`）按"本地 / 非 Anthropic"处理，不计成本。官方页当前把 $200 档称 Ultra（链接参数 `plan=max_20x`），内置按 Max 20x 对应，档位说明里已提示请自行确认。

## AI 运行时长（估算）

含义：本机上 AI 实际"工作"了多久。日志里每条记录都有 `timestamp`，据此估算（官方 `system/turn_duration` 只在少数新版本会话里有，只用于对账）：

1. 每个会话文件（含子代理文件）内按时间顺序遍历 `assistant` 与 `user` 记录；`user` 记录只看 `message.content[0].type`：`tool_result` 算"AI 事件"，其余算"真人输入"，**不读正文**；
2. 对每个 AI 事件，若它与上一个事件（任意 AI / 真人事件）的间隔 ≤ **15 分钟**，把该间隔计为 AI 工作时间；间隔更长视为空闲 / 等待，不计；以真人输入结尾的间隔（人在想 / 打字）不计；
3. 各文件得到的区间做并集：**主数字「AI 运行时长」= 所有会话 / 子代理区间的并集**（挂钟时间，并行的多个会话 / 子代理只算一次）；次要数字 = 各文件区间之和（"累计 agent 时长"，并行重复计入，见 `activeMsSum`）；
4. 聚合时按所选时区把区间按日 / 小时切分（跨午夜正确），所以曲线各桶之和 = 范围内的并集。

在本机真实数据上：并集约 49 小时、各文件之和约 64 小时；阈值取 5 / 15 / 30 分钟结果相近（对阈值不敏感）；与官方 `turn_duration` 的 27 条对账，估算区间覆盖其时间窗的中位数 100%。界面一律标注"估算"。

## 目录结构

```
src/server/                    服务端（Node 内置模块，零第三方依赖）
  index.ts                     入口：解析参数 → 启动 → 打开浏览器
  app.ts                       HTTP 应用：路由、聚合响应缓存（LRU）、SSE、端口探测
  api/                         errors / params（统一查询参数校验）/ security（Host + Origin）/ static / sse / lru / viewRoutes / routes-cost / routes-settings
  core/                        safeFs（唯一的文件系统入口）/ parser / dedupe / loadRoot / projects / models / time / aggregate / activity（AI 运行时长）/ title
  store/                       数据仓库：文件状态、全局去重视图、增量刷新、缓存（gzip NDJSON）、轮询 / fs.watch
  cost/                        价格表匹配 / 成本引擎 / 订阅摊销 / 回本
  data/                        内置默认价格与订阅档位（带来源与日期）
  settings.ts · overrides.ts · projectContext.ts · export.ts
src/shared/                    前后端共用类型与指标口径
web/                           前端（Vite + React 18 + TypeScript + Zustand + ECharts；CSS 变量 + CSS Modules）
  src/design/                  设计系统（令牌、卡片、胶囊、分段控件、迷你曲线、状态面板…）
  src/layout/                  顶栏、状态胶囊、项目栏、页头、筛选条、提示条
  src/pages/ · src/features/   总览 / 分析 / 会话 / 设置 / 成本 / 导出
  src/charts/                  ECharts 封装与选项构造
  dist/                        构建产物（随项目保留，服务端托管）
scripts/                       fixture 生成、解析 / 核对 / 基准 / 价格校验 / 自动验收（acceptance.ts）与审计钩子（audit-hook.mjs）
test/                          Vitest 单测；test/fixtures 为合成数据；test/e2e 为 Playwright 规格；test/screenshots 为截图归档
desktop/                       桌面 APP 外壳（Electron 主进程 main.ts、esbuild 打包脚本、图标）；electron-builder.yml 为打包配置
docs/                          验收报告（ACCEPTANCE.md，npm run acceptance 生成）、设计稿与成本规格（design/）、截图素材
start.cmd · start.ps1          双击启动脚本（start.cmd 为纯 ASCII，中文提示在 scripts/messages/*.txt）
```

## HTTP API

所有响应为 UTF-8 JSON；错误统一为 `{ "error": { "code", "message" } }`；查询参数用同一套解析，未知 / 重复 / 非法参数一律 400。只绑定 127.0.0.1；Host 必须是 `127.0.0.1:<port>` / `localhost:<port>`，带 Origin 时必须同源，否则 403；从不发 CORS 头；响应带 nosniff / CSP / no-store；API 不返回任何对话正文。

| 端点 | 说明 |
|---|---|
| `GET /api/status` | 扫描进度、`dataVersion`、`usageState` / `activity`（generating ≤ 60 s / active ≤ 10 min / idle）、今日总量、`dataRoot`、`warnings` |
| `GET /api/events` | SSE：`status` / `dataVersion` / `settings`；连接时先推快照；15 s 心跳 |
| `GET /api/projects` | 项目列表（含 `scratch` 组及 `children`）、`all` 合计、30 天 `sparkline`、`cost`、`hidden` / `hiddenCount`；`sort=total\|recent\|name\|today`、`q=` |
| `GET /api/summary` | 汇总 + `periods`（今日 / 昨日 / 本周 / 上周 / 本月 / 上月及环比）+ `activeMs` / `activeMsSum` + `cost` |
| `GET /api/timeseries` | 时间序列 `points`（空桶补零，每点含 `activeMs`、`cost`）+ `series`（按 split 拆分，含 `costValues`） |
| `GET /api/heatmap` · `GET /api/day-detail?date=` | 日历热力图（近 `weeks` 周，默认 26）· 某本地日按小时序列 + 当天会话 |
| `GET /api/analysis/{models,composition,projects,sessions-top,cache-efficiency,activity-grid,tools,sidechain,local-vs-cloud,quality}` | 分析页各卡片 |
| `GET /api/sessions` · `GET /api/sessions/:id` | 会话列表（`q` / `sort` / `dir` / `page` / `pageSize`）· 会话详情（404 = 没有该会话） |
| `GET /api/cost/summary` | 两种口径成本汇总（`api` / `subscription` / `daily` / `byProject` / `byModel` / `notes`） |
| `GET /api/subscription/payback` · `GET /api/subscription/plans` | 订阅回本（固定本地时区当月）· 内置订阅档位 |
| `GET /api/prices` · `PUT /api/prices` · `POST /api/prices/reset` | 价格表（用户规则整体替换）/ 恢复默认 |
| `GET /api/export?kind=daily\|model\|session&format=csv\|json` | 导出（遵从筛选 / 口径 / 时区） |
| `GET/PUT /api/settings` · `POST /api/settings/validate-root` · `GET /api/timezones` | 设置 / 检测数据根 / 时区列表 |
| `GET/PUT /api/project-overrides` · `POST /api/project-overrides/unhide-all` | 项目重命名 / 隐藏 / 置顶 |
| `POST /api/refresh` · `POST /api/rebuild` | 立即增量刷新 · 丢弃缓存重建（202） |

聚合参数：`project`（`all` 或项目 id，可逗号分隔）、`range`（today / 7d / 30d / thisMonth / 90d / all / custom）、`from` / `to`（custom，本地日期含两端）、`granularity`（hour / day / week / month）、`basis`（total / fresh）、`split`（none / tokenType / model / project）、`models`、`mergeFamilies`、`tz`、`weekStart`、`includeSidechain`；缺省取自设置。

## 数据口径

- 只有 `type == "assistant"` 的行携带用量。同一条消息会被写成多行（流式 block），会话恢复 / 分叉还会把历史拷进新文件，所以**去重是全局的**：键为 `message.id`（缺失则退回 `requestId`）。合并规则：各 usage 数值字段取最大值；时间取最早；工具按 `tool_use` block id 取并集。重复消息归属"首条带时间戳的记录最早"的文件。`<synthetic>` 完全排除。子代理文件（`<项目>/<会话>/subagents/agent-*.jsonl`）纳入并并入父会话。
- `Total = input + cacheWrite + cacheRead + output`；`Fresh = input + cacheWrite + output`；二者之差恒等于缓存读。`thinking` 包含在 output 内。`cacheHitRate = cacheRead / (input + cacheWrite + cacheRead)`；总览"输出 ÷ 输入"= output ÷ 新输入（`input_tokens`）。
- 项目 = 数据根下一级文件夹；显示名取"记录数最多的 cwd"的末级目录名（所以含中文用户名的路径显示正确）；Scratch 默认归并为虚拟项目。
- 时间：按 IANA 时区切日（DST 日有 23 / 25 小时，Asia/Kolkata 等非整小时偏移正确）；周起始日可选；`7d / 30d / 90d` 含今天共 N 个本地日；"今日 / 本周 / 本月"区间终点是下一期起点；环比为"本期（至今）对上一整期"，上期为 0 显示"—"，超过 999% 封顶显示 `999%+`。
- 总览"总 Token"卡跟随所选时间范围；今日 / 本周 / 本月卡是周期卡，不受时间范围影响，只受项目 / 模型 / 口径影响。热力图固定近 26 周。

## 缓存与增量刷新

- 缓存在应用数据目录 `cache/usage-cache.json.gz`：只存用量与元数据（含 ≤ 40 字的会话标题与活跃区间），不存对话正文；原子写；带 `schemaVersion`，版本不符 / 损坏 / 数据根不同自动丢弃重建。改解析规则必须把 `CACHE_SCHEMA_VERSION` +1。
- 增量：大小与 mtime 没变 → 不读；变大 → 校验已消费区域头 / 尾 4 KB 哈希，没变只读新增字节（半行留待下次），变了整文件重解析；变小 / 重写 → 整文件重解析；文件消失 → 撤销其贡献。默认每 5 秒轮询一次，新记录通常 ≤ 10 秒内出现在界面。

## 隐私与只读保证

- 对数据根和 `~/.claude` **只读**：所有读取经 `safeFs`，只允许打开 `*.jsonl` 与 `custom-title.json`；写操作只允许写到应用数据目录，写入前断言目标不在数据根 / `~/.claude` 之内（含符号链接 / junction 解析）。
- **只提取用量与元数据字段**：`tool_use` 只取 `name` 与 block `id`，不读 `input`；用户消息只看 `content[0].type`；不读 `.credentials.json` 等任何其它文件。会话标题（`custom-title.json`，否则首条真人消息前 ≤ 40 字）只在本机界面显示，**不进导出**。
- **不发任何外部网络请求**：只监听 127.0.0.1；字体 / 图标本地打包；构建产物里无外链（有单测扫描）。
- 验证：`npm run acceptance` 用审计钩子（`scripts/audit-hook.mjs`）起真实服务进程，记录全部文件写 / 出站连接 / DNS / 子进程，断言"数据根逐字节无变化、写入只在应用数据目录、非回环连接 = 0"，并有一只"金丝雀"证明钩子确实能抓到违规。

## 导出

`GET /api/export?kind=daily|model|session&format=csv|json` + 聚合筛选参数；界面里在总览 / 会话页头的"导出"菜单。CSV 为 UTF-8 带 BOM，**第一行是以 `# ` 开头的"估算"说明（读取时请跳过 # 行），第二行是列名**；包含 `cost_api_usd` / `cost_sub_usd`（无法计算为空）；不含对话正文，也不含由首条用户消息派生的标题；文本列有 CSV 公式注入防护（以 `= + - @` 开头加前缀 `'`）。

## 已知限制

- 只统计**本机**记录：网页版 Claude、其它设备、已被清理的会话文件的用量不在内。
- 成本是估算：价格取自开发时核对的官方页（2026-11-10），之后官方调价需在设置页手动更新；`Max 20x` 档对应官方现称 Ultra 的 $200 档，请自行确认；Haiku 5.5 / Mythos 未内置价格（显示"未计价"）。
- 订阅摊销的每日占比分母是"当天全部可见记录"的成本，与筛选无关，所以带项目 / 模型筛选时 `subUsd + idleUsd` 不等于范围内日订阅费之和（不筛选时守恒；各项目 subUsd 之和始终 = 总 subUsd）。
- 成本页的范围选择不与全局筛选条联动；`/api/projects` 各项的 `cost` 是全部时间。
- AI 运行时长按日志时间戳估算（15 分钟阈值），只覆盖本机记录。
- 增量只校验已消费区域的头 / 尾 4 KB；若有人在文件**中段**原地改写且大小、头尾都不变（Claude Code 只追加，实际不会发生），要靠设置页的"立即全量重建"发现。
- 超大会话（上万次请求）的详情一次返回全部请求（约 1 MB 级），柱状图点很密；真实数据里最大会话约 850 次，无问题。
- 聚合每次查询线性扫描全部记录（真实数据约 1 万条，单次约 5–40 ms，带 LRU 缓存）；视图重算是对全部行的一次线性去重（约 30 ms，10 倍数据量约数百毫秒）。
- 只有中文界面（文案走 `t()`，保留了加英文的结构）；项目"合并到另一项目"、PNG 导出、桌面壳 / 托盘均未做。
- 前端字体为本地 woff2（Outfit 拉丁 400–700、Noto Sans SC 400 / 500 / 600，按 unicode-range 分片），`web/dist` 约 9 MB。

## 常见问题

- **页面空白 / 提示"数据目录不可用"**：数据根目录不存在或不可读。到设置页"数据源"输入正确目录（默认 `%USERPROFILE%\.claude\projects`）→ 检测 → 应用；或确认 Claude Code 已产生过会话。
- **提示"还没有记录"**：目录可读但没有 `*.jsonl`；用一次 Claude Code 后几秒内会自动出现。
- **端口被占用**：自动向后顺延，实际地址以启动输出为准；也可 `npm start -- --port 50000`。
- **`npm start --no-open` 还是打开了浏览器**：必须写成 `npm start -- --no-open`（或 `TV_NO_OPEN=1`）。
- **`cmd /c start.cmd` 找不到文件**：设置了 `NoDefaultCurrentDirectoryInExePath` 的环境里需要写 `.\start.cmd` 或完整路径；双击不受影响。
- **成本显示"—"或"部分模型未计价"**：某个 `claude-` 开头的模型没有价格（新发布的模型）。到设置页价格表为它新增规则。非 `claude-` 前缀的模型（本地模型、其它厂商）不计成本，不会出现这个提示。
- **成本卡 / 回本卡提示"在设置里选择订阅方案"**：订阅方案未设置；选一个档位或填自定义月费。
- **总览数字比 Claude Code 自己显示的大**：默认口径 Total 含缓存读（通常占绝对大头）；切到 Fresh 可看不含缓存读的用量。
- **今天 / 本月的边界不对**：检查设置里的时区与一周起始日；日界按所选时区的本地 0 点。
- **想重新统计**：设置页"立即全量重建"，或删除应用数据目录下的 `cache/`（不会影响设置）。
- **改了前端代码没生效**：`npm run build`（服务端托管的是 `web/dist`）。
