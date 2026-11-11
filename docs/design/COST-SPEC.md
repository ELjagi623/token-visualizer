# 成本模块规格（两种口径）——口径、接口、界面

> 对应画板：`Cost.dc.html`（成本模块全貌与空状态）、`Main.dc.html`（成本口径切换、"等价 API 成本"指标卡、"订阅回本"卡）、`Settings.dc.html`（订阅方案区、价格表）。画板里的数字全是示例。
> 用户背景：订阅 Claude Pro/Max，月费固定。目的：看到"如果走 API 要花多少钱"，感受订阅的价值。

## 一、两种口径（结论）
套餐额度（"用了 Max 的百分之几"）**无法计算**：Anthropic 不公布 token 额度，限额是按 5 小时窗口 / 每周动态限制的，本机日志里也没有额度消耗信息。界面不得出现任何"额度使用百分比"。可计算的是下面两种：

**口径 ① 等价 API 成本（永远可算，只要有价格）**
- 成本 = Σ 记录（input×输入价 + output×输出价 + cacheWrite5m×5m写价 + cacheWrite1h×1h写价 + cacheRead×缓存读价）／1,000,000，单位 USD。输出已含思考，不重复计。缺 5m/1h 细分时 cacheWrite 总量按 5m 价，并在数据质量面板计数。
- 本地模型 = 0 且标记 `local`，不进入"未计价"。价格缺失的云端模型 → 该模型 token 记入 `unpricedTokens` / `unpricedModels`，其成本不计入且**绝不当 0 静默处理**（界面显示"部分模型未计价"提示）。
- `speed==='fast'` 的记录：仅当该价格规则填写了 `fastMultiplier` 才乘系数；未填则不计溢价，成本卡/表脚注"不含 fast 模式溢价（未配置）"。

**口径 ② 订阅摊销成本（需订阅月费，否则整块不显示）**
- 含义：把订阅费按天、按占比分摊到项目/会话/模型上，回答"这个项目大约占了我订阅费里的多少钱"。**不是额度消耗，不是实际扣费**，界面处处标注"估算 · 占比分摊"。
- 算法：对范围内每个本地日 d（不晚于今天）：`dailyFee(d) = monthlyFeeUsd ÷ 该日所在月份的天数`；若当天等价 API 成本 `C_d > 0`，则条目 i（项目/会话/模型/小时…）分得 `dailyFee(d) × C_{d,i} ÷ C_d`；若 `C_d = 0`（当天无用量或全部未计价），当天订阅费计入 `idleUsd`（闲置摊销），不分配给任何条目。范围内各条目分摊额之和 = `subUsd`，`subUsd + idleUsd` = 范围内日订阅费之和。
- 衍生：`订阅折算价 = subUsd ÷ (范围 token 总数 / 1e6)`（单位 USD / M tokens，口径随 Total/Fresh 切换）；`同量 API 价 = apiUsd ÷ (token/1e6)`；`回本倍数(范围) = apiUsd ÷ (subUsd + idleUsd)`。
- 订阅方案一个值套用所有月份（按自然月、按天摊销）；不做中途换档。

**订阅回本卡（总览页）**：`multipleMtd = 本月至今 apiUsd ÷ 完整月费`；`savingsUsd = max(0, apiMtd − 月费)`，未超过月费时显示"尚未回本"而不是负数；`整月预估 = (apiMtd ÷ 已过天数 × 当月天数) ÷ 月费`（线性外推，标"预估"）。另显示本月订阅摊销 `proratedFeeUsd = 月费 × 已过天数 ÷ 当月天数`。

## 二、数据与设置
- **价格表**：内置默认价格文件（如 `src/server/data/prices.default.json`）+ 用户规则（应用数据目录，可增删改、恢复默认）。规则字段：`id, pattern, match("exact"|"prefix"|"glob"), inputUsdPerM, outputUsdPerM, cacheWrite5mUsdPerM, cacheWrite1hUsdPerM, cacheReadUsdPerM, fastMultiplier?, sourceUrl?, checkedAt?`；任一价格为 null = 未配置。**内置文件里每个非空价格必须带 `sourceUrl` 与 `checkedAt`**（开发时联网查 Anthropic 官方 API 定价页核对；核对不到就留 null，不得凭记忆）；用脚本校验"无来源的非空内置价格 = 0 条"。匹配优先级：exact > 最长 prefix > glob；先用户规则后内置。**运行时绝不联网。**
- **订阅方案**（settings）：`subscription: { plan: "pro"|"max5x"|"max20x"|"custom"|null, monthlyFeeUsd: number|null }`。档位预置月费放内置文件 `plans.default.json`，同样每条带 `sourceUrl/checkedAt`（联网查 Claude 官方定价页），核对不到则 `monthlyFeeUsd: null`，界面要求用户手填。校验：有限数、0 ≤ 值 ≤ 100000。未填月费 ⇒ 口径②与回本卡不显示，仅提示"在设置里选择订阅方案"。

## 三、接口（在现有 API 约定上扩展；参数严格校验，未知参数 400）
所有金额字段单位 USD、number 或 null（null=无法计算）。

1. `GET /api/settings` / `PUT /api/settings`：新增 `subscription`（见上）。
2. `GET /api/prices` → `{ rules: [...], defaultsVersion, builtinCount }`；`PUT /api/prices`（整体替换用户规则，校验字段与数值范围）；`POST /api/prices/reset`（清空用户规则，恢复默认）。
3. **在已有聚合响应里附带 `cost` 对象**（不新增并行路径，避免口径分叉）：`/api/summary`、`/api/timeseries` 的每个点与每个系列、`/api/projects` 每项、`/api/sessions` 每行与 `/api/sessions/:id`、分析页的模型/项目条目。
   `cost: { apiUsd: number|null, subUsd: number|null, unpricedTokens: number, unpricedModels: string[] }`
   `apiUsd` 为 null 当且仅当该范围内没有任何已计价的云端模型；`subUsd` 为 null 当订阅方案未配置。两种口径一次都返回，由界面切换显示，不加 basis 参数。
4. `GET /api/cost/summary`（共用全局筛选参数：range / models / family / project）→
   `{ currency:"USD", api:{ totalUsd, byType:{ input, cacheWrite, cacheRead, output }, unpricedTokens, unpricedModels, fastPremiumApplied:boolean }, subscription:{ configured, plan, monthlyFeeUsd, totalUsd, idleUsd, perMillionTokensUsd, apiPerMillionTokensUsd, multiple }, daily:[{ date, apiUsd, feeUsd }], notes:string[] }`
5. `GET /api/subscription/payback`（无筛选，固定"本地时区当月"）→
   `{ configured, month:"YYYY-MM", elapsedDays, daysInMonth, apiUsdMtd, monthlyFeeUsd, proratedFeeUsd, multipleMtd, savingsUsd, paidBack, projected:{ apiUsd, multiple }, partial:boolean }`（`partial`=存在未计价模型，结果偏低）。
6. 导出（批次 C 的 CSV/JSON）：新增列 `cost_api_usd`、`cost_sub_usd`（null 导出为空），文件头说明"估算"。
7. 所有响应不得包含对话正文；金额计算在服务端完成，前端只格式化（`$` + 千分位 + 2 位小数；≥ $1,000 的大数卡片可省略小数）。

## 四、界面位置（对照画板）
- **总览页**：筛选条增加"成本口径"分段控件（等价 API / 订阅摊销，默认等价 API；未设置订阅方案时"订阅摊销"项可点但内容显示空状态）；指标网格第 8 张卡 = "等价 API 成本"（金额 + 环比 + 迷你曲线 + "估算"标注）；指标网格下方通栏"订阅回本"卡（三块：等价 API 成本、订阅摊销、回本倍数/省下金额；两根条：本月至今 / 整月预估；脚注说明局限）。
- **时间曲线**：右上增加"Token / 成本"单位切换，成本随成本口径切换。
- **成本模块**（`Cost.dc.html`，可作为总览页的"成本"区块或独立子视图，由开发者择一并写入 README）：两张口径卡并排、每日等价 API 成本柱 + 每日订阅费虚线、按项目两种成本表、三种空状态（价格未配置 / 未设置订阅方案 / 部分模型未计价）。
- **会话页**：表格"估算成本"列跟随成本口径；会话详情顶部同样。
- **设置页**：新增"订阅方案"区（档位分段 + 月费输入 + 未设置警示条）；价格表区去掉旧的"订阅用户可切换"开关，标题右侧固定标注"等价 API 成本 · 估算"。
- 所有金额旁必须带"估算"字样或 tooltip；口径②处处写明"占比分摊 · 非额度消耗"。

## 五、测试要点（统一测试时核对）
1. 测试用固定价格表（如 输入 1、输出 5、5m 写 2、1h 写 3、读 0.1，单位 USD/M）对 fixture 手算，API 与界面逐分一致；本地模型 0 且不入占比；未计价模型 `unpricedModels` 与 expected 一致，且界面出现提示、金额不为 0 的假象。
2. 订阅摊销：用固定月费（如 $30、30 天月份）手算：每个有用量的日子，各条目分摊额之和 = 当天日订阅费；`subUsd + idleUsd` = 范围内日订阅费之和；各项目 subUsd 之和 = 总 subUsd；闲置日（fixture 中无记录的日子）进入 idleUsd。
3. 回本：`multipleMtd`、`savingsUsd`、`projected` 与手算一致；未超过月费时 `paidBack=false` 且界面显示"尚未回本"；未设置订阅方案时回本卡与口径②显示空状态。
4. 价格来源校验脚本：内置价格每条非空价格带 `sourceUrl` 与 `checkedAt`（测试者抽查 ≥ 2 条与官方页面一致）；内置月费同理。
5. 运行期外部请求 = 0（价格只在开发时抓取）；设置/价格写入只落应用数据目录。
