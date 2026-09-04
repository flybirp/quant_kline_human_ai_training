import type { Bar } from '../types';

// ============================================================
// 交易规则版本（用于 records.meta.ruleVersion 成绩归因断代）
// v1: 无涨跌停约束、无预热下限
// v2: 收盘涨跌停禁令（涨停禁买/跌停禁卖）+ 预热下限 WARMUP_MIN_BARS=30
//
// ⚠️ 代码规范：修改任何影响成交/推进/成本计算的规则后，必须更新此版本号
//    并在上方登记变更内容。不同版本下的训练成绩不可直接对比。
// ============================================================
export const RULE_VERSION = 2;

// 预热下限：决策段起点前至少保留的日线根数（观察窗口，保证 MA20/量比统计有效）
export const WARMUP_MIN_BARS = 30;

// 涨跌幅档位：创业板/科创板 20%，主板 10%（数据目录无北交所）
// ST 无状态字段无法识别，按非 ST 档判定（偏差方向偏宽松，已接受）
export function limitPctOf(code: string): number {
  return /^(300|301|688)/.test(code) ? 0.2 : 0.1;
}

// 涨跌停判定：以收盘价为唯一口径（执行价即当日收盘，不看盘中是否打开过）。
// 涨停价/跌停价 = round(前收 × (1±幅度), 2)（交易所规则精确到分），比较容差 0.001。
// 返回 'up'（收盘涨停，禁买）/ 'down'（收盘跌停，禁卖）/ null（正常）。
export function limitStateOf(bars: Bar[], idx: number, code: string): 'up' | 'down' | null {
  if (idx <= 0 || idx >= bars.length) return null; // 上市首日（无前收）不判定
  const prev = bars[idx - 1].close;
  const cur = bars[idx].close;
  if (prev <= 0) return null;
  const pct = limitPctOf(code);
  const upPrice = Math.round(prev * (1 + pct) * 100) / 100;
  const downPrice = Math.round(prev * (1 - pct) * 100) / 100;
  if (cur >= upPrice - 0.001) return 'up';
  if (cur <= downPrice + 0.001) return 'down';
  return null;
}
