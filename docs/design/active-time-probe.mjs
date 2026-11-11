// 只读探针：估算 AI 运行时长。只读 type/timestamp/message.content[0].type/subtype/durationMs，不读对话正文。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = process.argv[2];
const CAP = Number(process.argv[3] || 15) * 60_000; // 相邻事件间隔超过 CAP 视为空闲/等待
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);

function union(iv) {
  iv.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of iv) {
    const l = out[out.length - 1];
    if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}
const total = (iv) => iv.reduce((a, [s, e]) => a + (e - s), 0);

let all = [], perFileSum = 0, filesWithTime = 0, nTD = 0;
const ratios = [];
const snapshot = new Map(files.map((f) => [f, fs.statSync(f).size])); // 快照大小，避免读到正在增长的部分

for (const f of files) {
  const limit = snapshot.get(f);
  const rl = readline.createInterface({ input: fs.createReadStream(f, { end: Math.max(0, limit - 1) }), crlfDelay: Infinity });
  let prev = null, iv = [];
  const tds = [];
  for await (const line of rl) {
    if (!line.includes('"timestamp"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (o.type === 'system' && o.subtype === 'turn_duration' && typeof o.durationMs === 'number') { tds.push([ts - o.durationMs, ts]); nTD++; continue; }
    let kind = null;
    if (o.type === 'assistant') kind = 'ai';
    else if (o.type === 'user') {
      const c = o.message && o.message.content;
      const first = Array.isArray(c) ? c[0] : null;
      kind = first && first.type === 'tool_result' ? 'ai' : 'human';
    }
    if (!kind) continue;
    if (kind === 'ai' && prev !== null) {
      const gap = ts - prev;
      if (gap >= 0 && gap <= CAP) iv.push([prev, ts]);
    }
    prev = ts;
  }
  iv = union(iv);
  if (iv.length) filesWithTime++;
  perFileSum += total(iv);
  all.push(...iv);
  for (const [s, e] of tds) { // 与 turn_duration 对账：该时间窗内我们估算的活跃时间占比
    let ov = 0; for (const [a, b] of iv) { const x = Math.max(a, s), y = Math.min(b, e); if (y > x) ov += y - x; }
    ratios.push(ov / Math.max(1, e - s));
  }
}
const wall = union(all);
const h = (ms) => (ms / 3600000).toFixed(1) + ' h';
ratios.sort((a, b) => a - b);
console.log(JSON.stringify({
  files: files.length, filesWithActivity: filesWithTime, capMin: CAP / 60000,
  wallClockUnion: h(total(wall)), perFileSum: h(perFileSum),
  turnDurationRecords: nTD,
  validation: ratios.length ? { n: ratios.length, medianCoverage: ratios[Math.floor(ratios.length / 2)].toFixed(2), p10: ratios[Math.floor(ratios.length * 0.1)].toFixed(2), p90: ratios[Math.floor(ratios.length * 0.9)].toFixed(2) } : null,
  distinctActiveDays: new Set(wall.map(([s]) => new Date(s).toISOString().slice(0, 10))).size
}, null, 1));
