import { zhB } from './zhB.ts';
import { zhC } from './zhC.ts';

/**
 * 中文字典（默认语言）。组件里不得硬编码中文字面量：一律 t('key')。
 * 占位符写法：{name}。
 */
export const zh = {
  ...zhB,
  ...zhC,
  'app.name': 'Token Visualizer',
  'app.skip': '跳到主内容',
  'app.loading': '加载中…',

  'nav.aria': '主导航',
  'nav.overview': '总览',
  'nav.analysis': '分析',
  'nav.sessions': '会话',
  'nav.settings': '设置',

  'theme.toLight': '切换浅色主题',
  'theme.toDark': '切换深色主题',
  'theme.menu': '主题设置',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.system': '跟随系统',

  'pill.live': 'Live',
  'pill.active': 'Active',
  'pill.idle': 'Idle',
  'pill.scanning': 'Scanning',
  'pill.error': 'Error',
  'pill.offline': 'Offline',
  'pill.today': '今日',
  'pill.tip.generating': '正在生成 · 最近一条记录 {ago}',
  'pill.tip.active': '近期活跃 · 最近一条记录 {ago}',
  'pill.tip.idle': '空闲 · 最近一条记录 {ago}',
  'pill.tip.idleNone': '空闲 · 还没有记录',
  'pill.tip.scanning': '首次建立索引：已处理 {done} / {total} 个文件',
  'pill.tip.error': '读取数据出错：{reason}',
  'pill.tip.errorUnknown': '读取数据出错',
  'pill.tip.offline': '与本地服务的连接已断开，正在重试',

  'unit.tokens': 'tokens',
  'unit.times': '次',

  'time.justNow': '刚刚',
  'time.minutesAgo': '{n} 分钟前',
  'time.hoursAgo': '{n} 小时前',
  'time.yesterday': '昨天',
  'time.daysAgo': '{n} 天前',
  'time.weeksAgo': '{n} 周前',
  'time.monthsAgo': '{n} 个月前',
  'time.never': '暂无记录',

  'sidebar.aria': '项目栏',
  'sidebar.searchPlaceholder': '搜索项目或路径',
  'sidebar.searchAria': '搜索项目',
  'sidebar.projects': '项目',
  'sidebar.sortAria': '项目排序方式',
  'sidebar.sort.total': '按总量排序',
  'sidebar.sort.recent': '按最近活跃排序',
  'sidebar.sort.name': '按名称排序',
  'sidebar.sort.today': '按今日用量排序',
  'sidebar.all': '全部项目',
  'sidebar.allSub': '{n} 个项目',
  'sidebar.scratch': '临时对话 Scratch',
  'sidebar.scratchSub': '{n} 个临时目录 · 已归并',
  'sidebar.scratchExpand': '展开临时目录',
  'sidebar.scratchCollapse': '收起临时目录',
  'sidebar.footer': '{n} 个项目 · 更新于 {time}',
  'sidebar.footerScanning': '{n} 个项目 · 正在扫描…',
  'sidebar.refresh': '手动刷新',
  'sidebar.noMatch': '没有匹配的项目',
  'sidebar.empty': '暂无项目',
  'sidebar.activeToday': '今日有活动',
  'sidebar.noPath': '路径未知（文件夹：{key}）',
  'sidebar.multiCwd': '{path}（另有 {n} 个工作目录）',
  'sidebar.open': '打开项目栏',
  'sidebar.close': '收起项目栏',
  'sidebar.parsing': '解析中…',

  'basis.aria': '统计口径',
  'basis.total': 'Total',
  'basis.fresh': 'Fresh',
  'basis.totalTip': '含缓存读',
  'basis.freshTip': '不含缓存读',

  'overview.subtitleAll': '汇总 {projects} 个项目 · {sessions} 个会话 · 活跃 {days} 天',
  'overview.subtitleOne': '{sessions} 个会话 · 活跃 {days} 天',
  'overview.subtitleScratch': '{projects} 个临时目录 · {sessions} 个会话 · 活跃 {days} 天',

  'tile.total': '总 Token（累计）',
  'tile.totalNote.total': '含缓存读 · 活跃 {days} 天',
  'tile.totalNote.fresh': '不含缓存读 · 活跃 {days} 天',
  'tile.today': '今日 Token',
  'tile.todayNote': '较昨日 · 按小时',
  'tile.requests': '请求数',
  'tile.requestsNote': '{sessions} 个会话 · 已去重的 API 调用',
  'tile.partial': '部分',
  'tile.copyHint': '{exact} · 点击复制精确值',
  'tile.copied': '已复制',

  'placeholder.chart': 'Token 时间曲线',
  'placeholder.heatmap': '日历热力图',
  'placeholder.today': '今日 vs 昨日',
  'placeholder.soon': '图表即将推出',

  'page.analysis': '分析',
  'page.sessions': '会话',
  'page.settings': '设置',
  'page.placeholder': '该页面正在建设中，敬请期待。',
  'page.placeholderCard': '内容建设中',

  'empty.title': '还没有记录，去用一用 Claude Code 吧',
  'empty.desc': '有了用量记录，这里会自动出现统计数据；新记录通常在几秒内出现。',

  'error.dataRoot.title': '数据目录不可用，请在设置中重新选择',
  'error.dataRoot.reason': '原因：{reason}',
  'error.dataRoot.goSettings': '前往设置',
  'error.api.title': '无法连接到本地服务',
  'error.api.desc': '请确认 Token Visualizer 的服务仍在运行（启动窗口没有被关闭），页面会自动重试。',
  'error.load': '数据加载失败：{reason}',
  'error.retry': '重试',

  'scan.title': '正在建立索引',
  'scan.desc': '首次启动需要完整读取一遍会话记录，之后只做增量更新，下次几秒内即可打开',
  'scan.progress': '解析进度',
  'scan.state': 'Scanning 正在扫描',
  'scan.files': '已处理文件',
  'scan.filesUnit': '个文件',
  'scan.bytes': '已读 {done} / {total}',
  'scan.readOnly': '只读，不会修改任何文件',
  'scan.progressAria': '首次解析进度',

  // 语言：选项文字固定（不随当前语言变化），分区标题中英并列，方便误切后找回
  'lang.en': 'English',
  'lang.zh': '中文',
  'settings.lang.title': 'Language · 语言',
  'settings.lang.label': '界面语言',
  'settings.lang.aria': '界面语言',

  'warn.title': '提示',
  'warn.dismiss': '关闭提示',
  'warn.more': '另有 {n} 条',
} as const;

export type DictKey = keyof typeof zh;
export type Dict = Record<DictKey, string>;
