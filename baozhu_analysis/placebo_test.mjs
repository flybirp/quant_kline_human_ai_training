// 安慰剂检验（placebo test）：quant_discover 的形态规律，是"对 A 股的理解"
// 还是"任何随机走势都会出现的几何必然"？
//
// 做法：把**不依赖 volume/pe/pb** 的纯价格规则，分别跑在
//   ① 真实 A 股   ~/Documents/mainland_data_2014（有 volume）
//   ② 纯随机假走势 ~/Documents/monkey_fake_data（无 volume，填常数使量比恒=1）
// 对比同一形态的前瞻收益与胜率：
//   真实 ≈ 假   → 该"规律"是随机序列的几何必然，无真实预测力
//   真实 >> 假  → 该形态确实捕捉到了 A 股特性
//
// 用法：node placebo_test.mjs [每数据集股票数] [采样步长]
import fs from 'node:fs';
import path from 'node:path';
import { detectPatterns } from '../web/src/lib/patterns.ts';
import { ENTRY_HALVED } from '../web/src/lib/quantRules/index.ts';

const REAL = '/Users/flybirp/Documents/mainland_data_2014';
const FAKE = '/Users/flybirp/Documents/monkey_fake_data';
const N = Number(process.argv[2] || 150);
const STEP_REAL = Number(process.argv[3] || 10);
const STEP_FAKE = Number(process.argv[4] || 3);   // 假数据仅 1000 天，步长取小以保证样本量可比

function loadBars(file, hasVolume) {
  const txt = fs.readFileSync(file, 'utf8');
  const lines = txt.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const r = l.split(',');
    if (r.length < 5 || !r[0] || r[0] === 'date') continue;
    out.push({
      date: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      // 假数据无 volume：填常数 → volRatio 恒为 1（平量），量能类规则自然不激活
      volume: hasVolume ? Number(r[5]) : 100000,
    });
  }
  return out.filter((b) => b.close > 0);
}

// 关注的纯价格形态（按 label 关键字匹配）
const TARGETS = [
  { key: '筑底跌破C组', name: '筑底跌破 C 组（深度 10~15%）', match: (l) => l.includes('筑底跌破C组') && !l.includes('缩量') },
  { key: '底分型', name: '底分型（含深档）', match: (l) => l.includes('底分型') },
  { key: 'spring', name: 'spring（含深档）', match: (l) => l.includes('spring') },
  // 回踩拆两档：d09 的价值在「第 1~2 次 + 回撤<5% + 不破线」的甜点条件，
  // 合并统计会稀释甜点档（旧版 match 只判 includes('趋势回踩')）
  { key: '回踩甜点', name: '趋势回踩·甜点✓（第1~2次/回撤<5%/不破线）', match: (l) => l.includes('趋势回踩·甜点') },
  { key: '回踩非甜点', name: '趋势回踩·非甜点', match: (l) => l.includes('趋势回踩') && !l.includes('甜点') },
  { key: '底背离', name: '底背离（T24 补测）', match: (l) => l.includes('底背离') },
  { key: '向上缺口·未回补', name: '向上缺口未回补', match: (l) => l.includes('向上缺口·未回补') },
  { key: '向上缺口·已回补', name: '向上缺口已回补', match: (l) => l.includes('向上缺口·已回补') },
  { key: '向下缺口·已回补', name: '向下缺口已回补', match: (l) => l.includes('向下缺口·已回补') },
  { key: '横盘区间', name: '横盘区间', match: (l) => l.includes('横盘区间') },
];

function scanDataset(dir, hasVolume, step, nStocks) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort().slice(0, nStocks);
  const acc = {};
  for (const t of TARGETS) acc[t.key] = { n: 0, e20: 0, e60: 0, win: 0 };
  acc.__halved = { n: 0, e20: 0, e60: 0, win: 0 };
  acc.__base = { n: 0, e20: 0, e60: 0, win: 0 }; // 基准：任意日买入

  let done = 0;
  for (const f of files) {
    let bars;
    try {
      bars = loadBars(path.join(dir, f), hasVolume);
    } catch {
      continue;
    }
    if (bars.length < 200) continue;
    for (let i = 80; i + 60 < bars.length; i += step) {
      const c0 = bars[i].close;
      const f20 = bars[i + 20] ? (bars[i + 20].close / c0 - 1) * 100 : null;
      const f60 = bars[i + 60] ? (bars[i + 60].close / c0 - 1) * 100 : null;
      if (f20 == null || f60 == null) continue;
      acc.__base.n++;
      acc.__base.e20 += f20;
      acc.__base.e60 += f60;
      if (f20 > 0) acc.__base.win++;

      const sub = bars.slice(0, i + 1);
      let labels;
      try {
        labels = detectPatterns(sub).map((h) => h.label);
      } catch {
        continue;
      }
      for (const t of TARGETS) {
        if (!labels.some(t.match)) continue;
        acc[t.key].n++;
        acc[t.key].e20 += f20;
        acc[t.key].e60 += f60;
        if (f20 > 0) acc[t.key].win++;
      }
      // 腰斩（quantRules 自实现，纯价格）
      try {
        if (ENTRY_HALVED.evaluate({ bars: sub })) {
          acc.__halved.n++;
          acc.__halved.e20 += f20;
          acc.__halved.e60 += f60;
          if (f20 > 0) acc.__halved.win++;
        }
      } catch {
        /* ignore */
      }
    }
    done++;
    if (done % 50 === 0) process.stderr.write(`  已扫描 ${done}/${files.length}\r`);
  }
  return acc;
}

function fmt(acc) {
  const out = {};
  for (const k of Object.keys(acc)) {
    const a = acc[k];
    out[k] = {
      n: a.n,
      e20: a.n ? a.e20 / a.n : null,
      e60: a.n ? a.e60 / a.n : null,
      win: a.n ? (a.win / a.n) * 100 : null,
    };
  }
  return out;
}

console.log(`扫描中：真实 ${N} 只（步长 ${STEP_REAL}）／假数据 ${N} 只（步长 ${STEP_FAKE}）`);
const real = fmt(scanDataset(REAL, true, STEP_REAL, N));
const fake = fmt(scanDataset(FAKE, false, STEP_FAKE, N));

const rows = [
  ['__base', '【基准】任意日买入'],
  ['__halved', '腰斩（翻倍后腰斩）'],
  ...TARGETS.map((t) => [t.key, t.name]),
];

console.log('\n===== 真实 A 股 vs 纯随机走势（前瞻 20 日）=====');
console.log('形态'.padEnd(24) + '真实 n/E20/胜率'.padEnd(30) + '随机 n/E20/胜率'.padEnd(30) + '超额差(真实−随机)');
console.log('-'.repeat(110));
for (const [k, name] of rows) {
  const r = real[k], f = fake[k];
  const cell = (x) => (x.n ? `${x.n}｜${x.e20 >= 0 ? '+' : ''}${x.e20.toFixed(2)}%｜${x.win.toFixed(1)}%` : '—');
  // 超额 = 形态 E − 该数据集基准 E
  const exR = r.n && real.__base.n ? r.e20 - real.__base.e20 : null;
  const exF = f.n && fake.__base.n ? f.e20 - fake.__base.e20 : null;
  const diff = exR != null && exF != null ? exR - exF : null;
  const verdict =
    diff == null ? '' : diff > 1.5 ? '  ← 真实显著更强 ✓' : diff < -1.5 ? '  ← 随机反而更强' : '  ← 两者相当（几何必然）';
  console.log(
    name.padEnd(24) + cell(r).padEnd(30) + cell(f).padEnd(30) +
      (diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%` : '—') + verdict,
  );
}

console.log('\n注：超额差 = (真实形态E − 真实基准E) − (随机形态E − 随机基准E)');
console.log('    差值接近 0 → 该形态的"规律"在随机走势中同样出现，属几何必然而非 A 股特性');

// ---- 前瞻 60 日：缺口类结论的原生口径（quant_discover 缺口分野按 60 日统计）----
console.log('\n===== 真实 A 股 vs 纯随机走势（前瞻 60 日）=====');
console.log('形态'.padEnd(24) + '真实 n/E60/胜率'.padEnd(30) + '随机 n/E60/胜率'.padEnd(30) + '超额差(真实−随机)');
console.log('-'.repeat(110));
for (const [k, name] of rows) {
  const r = real[k], f = fake[k];
  const cell = (x) => (x.n ? `${x.n}｜${x.e60 >= 0 ? '+' : ''}${x.e60.toFixed(2)}%｜${x.win.toFixed(1)}%` : '—');
  const exR = r.n && real.__base.n ? r.e60 - real.__base.e60 : null;
  const exF = f.n && fake.__base.n ? f.e60 - fake.__base.e60 : null;
  const diff = exR != null && exF != null ? exR - exF : null;
  const verdict =
    diff == null ? '' : diff > 1.5 ? '  ← 真实显著更强 ✓' : diff < -1.5 ? '  ← 随机反而更强' : '  ← 两者相当（几何必然）';
  console.log(
    name.padEnd(24) + cell(r).padEnd(30) + cell(f).padEnd(30) +
      (diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%` : '—') + verdict,
  );
}
