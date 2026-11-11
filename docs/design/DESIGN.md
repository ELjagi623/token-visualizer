# UI 设计稿说明（由 Claude Design 制作）

- 在线画布（私有）：https://claude.ai/artifact/BRhyMkiMitajhwF6QQyxPY
- 本地源文件：`docs/design/*.dc.html`（画板源码，内含精确的内联样式、尺寸、间距、SVG 图表写法，实现前端时**直接对照**）。
- 所有数字、项目名、会话标题都是**示例数据**，只用于版式；真实界面一律来自 API。

## 画板清单
| 文件 | 内容 | 对应阶段 |
|---|---|---|
| Main.dc.html | 总览（浅色，默认）：顶栏、项目栏、使用状态卡、9 张指标卡、Token 时间曲线（含峰值标注与 tooltip）、日历热力图、今日 vs 昨日累计对比 | 5、6 |
| Overview-Dark.dc.html | 同一页的深色主题（仅 theme 参数不同） | 5 |
| Analysis.dc.html | 分析：类型构成环形图、模型排行、缓存效率、星期×小时热力图、工具排行、项目对比、主线/子代理、本地/云端、数据质量面板 | 7 |
| Sessions.dc.html | 会话：排序表格 + 会话详情（逐次请求柱状、上下文增长曲线含"压缩"标记、类型构成、工具使用） | 8 |
| Settings.dc.html | 设置：数据源、显示、刷新、价格表（默认未配置 + 警示条）、预算、项目管理 | 9、10 |
| FirstRun.dc.html | 首次扫描加载态：进度、已解析部分先展示、骨架屏 shimmer | 5、11 |

## 设计令牌（CSS 变量，浅色 / 深色）
| 变量 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| --bg | #F6F6F3 | #0E1210 | 页面背景 |
| --card | #FFFFFF | #171C19 | 卡片 |
| --line | rgba(17,22,19,.07) | rgba(255,255,255,.08) | 1px 描边 |
| --text / --text2 / --muted | #111613 / #555C56 / #6B726C | #ECF1ED / #B2BAB4 / #9AA39C | 主/次/弱文字（均满足 WCAG AA） |
| --track | #ECEEEA | #252C28 | 进度条轨道、热力图空格 |
| --seg / --segOn | #EDEEEA / #FFFFFF | #1F2522 / #2C3430 | 分段控件底 / 选中项 |
| --accent / --accentText | #10B981 / #047857 | #34D399 / #6EE7B7 | 强调绿（填充 / 文字用） |
| --blue --amber --pink --violet | #3B82F6 #F59E0B #EC4899 #8B5CF6 | #60A5FA #FBBF24 #F472B6 #A78BFA | 多系列色板 |
| --grid | rgba(17,22,19,.09) | rgba(255,255,255,.09) | 图表参考线 |
| --shadow | 0 1px 2px rgba(17,22,19,.04), 0 14px 36px rgba(17,22,19,.05) | 0 1px 2px rgba(0,0,0,.3), 0 14px 36px rgba(0,0,0,.28) | 卡片阴影 |
| 状态胶囊 pillIdle/Blue/Green/Amber/Pink 的 Bg/Fg | 见源码 THEMES 对象 | 见源码 THEMES 对象 | Idle 灰 / Active 蓝 / Live·Generating 绿 / 警告琥珀 / 错误粉 |
| 热力图 h1–h4 | accent 透明度 .24/.45/.72/1 | accent(深) 透明度 .25/.45/.72/1 | 日历与星期×小时热力图 |

Token 类型固定配色（全站一致）：输入=blue，缓存写=amber，缓存读=accent 绿，输出=violet。

## 字体与排版
- 字体栈：`'Outfit','Noto Sans SC','HarmonyOS Sans SC','Microsoft YaHei',system-ui,sans-serif`。**实现时必须用 @fontsource 本地打包，不得使用设计稿里的 Google Fonts `<link>`（运行时零外网请求）。**
- 数字一律 `font-variant-numeric: tabular-nums`，字重 600，字距 -0.02em。
- 大指标数字 44px（状态卡 42px）+ 单位 16px 浅色（--muted，字重 500，左间距 6px 基线对齐）；页面标题 28px/600；卡片标题 21px/600；卡片小标题 15px/500；说明 13px --muted；顶栏 Logo 23px/700。

## 组件规范
- 卡片：圆角 24px，背景 --card，1px --line 描边，--shadow；内边距 28px（指标卡 22×24）；卡片间距 20–24px。
- 分段控件 `.seg`：胶囊，底 --seg，内边距 4px；项高 40px（小号 34px），选中项 --segOn + 轻阴影。
- 状态胶囊：高 34px，圆点 8px；非当前态整体 opacity .5；Live/Generating/Scanning 圆点呼吸动画（`prefers-reduced-motion` 下关闭）。
- 进度条：高 8px，圆角 999，轨道 --track，填充 --accent。
- 指标卡：左上线性图标 18px(stroke 1.8) + 标题；右上可选环比小胶囊（▲/▼ + 百分比）；底部通栏迷你面积曲线（无坐标轴，渐变 accent 26%→0，线宽 2，`vector-effect: non-scaling-stroke`）。
- 图表：无粗网格，仅淡虚线水平参考线（3 5）；线用平滑曲线（Catmull-Rom 张力 .17 ≈ monotone），线宽 2–2.4，下方渐变面积；峰值点实心 + 文字标注；tooltip 为白卡 + 圆角 16 + 阴影，内含各类型分解与请求数；环形图 r=70、描边 22、段间留 3px 间隙、中心显示总数。
- 布局：页面 padding 20/32px；顶栏（Logo / 胶囊导航 / 状态胶囊 + 主题按钮）；项目栏固定 288px，窄窗口下折行到主内容上方；主区 flex 999 1 560px；指标卡网格 3 列 → 2 列(≤1180px) → 1 列(≤760px)。
- 项目栏：搜索框 46px、排序 chip、"全部项目"选中项为白卡 + 阴影、其余透明；每项 = 名称 + 今日活跃绿点 + 最近活跃时间 + 总量 + 84×22 迷你曲线；底部"Scratch 临时对话"折叠组、项目总数与更新时间、手动刷新按钮。
- 无障碍：导航为 `<a aria-current>`；分段控件为 `<button aria-pressed>` 组；图表 `role="img"` + 文字描述；表单控件带 aria-label；触控目标 ≥ 40px。

## 实现时的取舍说明
1. 设计稿用 SVG 手绘图表仅为呈现版式；实际实现按 PLAN 使用 ECharts，但需**还原上述视觉**（平滑线、渐变面积、淡虚线、圆角柱、tooltip 样式、峰值标注）。
2. 设计稿里的成本一律显示"—"（价格表待核对），实现须保持：未配置价格 → 显示"—"并提示，不得当 0。
3. 设计稿没有覆盖的状态（空状态、Error 胶囊、骨架屏细节）按同一令牌体系自行补齐：空状态用卡片内居中插画感文案；Error 用 pillPink；骨架屏沿用 FirstRun 的 shimmer。
4. 设计稿的深色画板只切换 theme；实现用 `[data-theme]` 切换同名 CSS 变量即可，并记住用户选择。

## 补充（成本模块，2026-11-10）
新增画板 `Cost.dc.html`，并更新了 `Main.dc.html`（成本口径切换、"等价 API 成本"卡、"订阅回本"卡）与 `Settings.dc.html`（订阅方案区、去掉订阅用户开关）。成本的口径定义、算法、接口与界面位置见 **`COST-SPEC.md`**（开发批次 C 必读）。
