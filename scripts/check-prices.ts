/**
 * 价格来源校验：内置默认价格 / 订阅档位月费里，每个非空值都必须带 https 的 sourceUrl 与 YYYY-MM-DD 的 checkedAt。
 * 违规数 = 0 → 退出码 0；否则逐条打印并退出 1。同时打印全部内置价格，便于对照官方页面抽查。
 *
 *   npm run check:prices
 */
import { builtinPlans } from '../src/server/cost/plans.ts';
import { builtinDefaults, PRICE_FIELDS } from '../src/server/cost/prices.ts';

const bad: string[] = [];
const { rules, defaultsVersion } = builtinDefaults();
console.log(`内置价格（USD / 百万 token）defaultsVersion=${defaultsVersion}，共 ${rules.length} 条`);
console.log(['模型', '输入', '输出', '5m 写', '1h 写', '读', 'fast×', '核对日期', '来源'].join('\t'));
for (const r of rules) {
  const nonNull = PRICE_FIELDS.filter((f) => r[f] !== null);
  console.log([r.pattern, ...PRICE_FIELDS.map((f) => r[f] ?? '—'), r.fastMultiplier ?? '—', r.checkedAt ?? '—', r.sourceUrl ?? '—'].join('\t'));
  if (nonNull.length > 0) {
    if (!r.sourceUrl || !/^https:\/\//.test(r.sourceUrl)) bad.push(`${r.id}: 非空价格缺 https sourceUrl`);
    if (!r.checkedAt || !/^\d{4}-\d{2}-\d{2}$/.test(r.checkedAt)) bad.push(`${r.id}: 非空价格缺 checkedAt`);
  }
  if (r.fastMultiplier !== null && (!r.sourceUrl || !r.checkedAt)) bad.push(`${r.id}: fastMultiplier 缺来源`);
}
const plans = builtinPlans();
console.log(`\n订阅档位 defaultsVersion=${plans.defaultsVersion}`);
for (const p of plans.plans) {
  console.log([p.id, p.label, p.monthlyFeeUsd ?? '—', p.checkedAt ?? '—', p.sourceUrl ?? '—'].join('\t'));
  if (p.monthlyFeeUsd !== null) {
    if (!p.sourceUrl || !/^https:\/\//.test(p.sourceUrl)) bad.push(`plan ${p.id}: 非空月费缺 https sourceUrl`);
    if (!p.checkedAt || !/^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt)) bad.push(`plan ${p.id}: 非空月费缺 checkedAt`);
  }
}
console.log(`\n无来源的非空内置价格 / 月费：${bad.length} 条`);
for (const b of bad) console.log(`  - ${b}`);
process.exit(bad.length === 0 ? 0 : 1);
