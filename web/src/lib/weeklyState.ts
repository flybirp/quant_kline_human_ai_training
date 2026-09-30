import type { Bar } from '../types';

// ISO 自然周分桶键（周一为始）——与 patterns.ts 的 isoWeekKey 同源同逻辑。
// 此处内联而非 import，是为了让本模块可被 node 直接执行（对账脚本 audit_ws.mjs 用），
// 无需打包器解析无扩展名导入；两处逻辑一致，由 audit_weekly.py 对账兜底。
function isoWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // 本周四 → 所属 ISO 周
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// 周线状态判定（「周线定方向 + 日线找入场点」的状态层）
//
// 口径与阈值出处见 `周线状态判定口径.md`（全部引自 quant_discover，禁止拍脑袋）：
//   深跌恐慌态 A1 跌速×1.5（d03）、A2 距 26 周高点回撤≥30%（d03/d08）
//   趋势态     B1 站上 10 周均线且均线向上（d07/d09 体系）、B2 波段回撤<10%（d07/d09）
//   横盘态     C1 12 周均价±10%（d05 consolidation）、C2 下跌后≥3 周波幅≤5%（d05 flat_zone）
//
// 判定优先级：恐慌 > 趋势 > 横盘（恐慌态是买点窗口，不可被覆盖）。
// 说明：按约定**允许使用本周至今（未定型周）**，故状态会随日线推进在周内更新。

export type WeeklyStateKind = 'panic' | 'trend' | 'range' | 'unknown';

export interface WeeklyBar {
  key: string; // ISO 周键
  date: string; // 该周最后一根日线日期
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WeeklyState {
  state: WeeklyStateKind;
  reasons: string[]; // 带数字的判定依据
  metrics: {
    weeks: number;
    weeklyDrop4: number | null; // 近 4 周平均周跌幅（%）
    weeklyDrop8: number | null; // 前 8 周平均周跌幅（%）
    drawdownFrom26wHigh: number | null; // 距 26 周高收盘回撤（%）
    ma10: number | null; // 10 周均线
    ma10Slope: number | null; // 10 周均线方向（相对 2 周前）
    bandDrawdown: number | null; // 当前波段自最高周收盘回撤（%）
    rangeWidthPct: number | null; // 近 12 周振幅相对均价（%）
  };
}

/** 日线聚合为真自然周（ISO，周一起）；未完成的本周同样计入 */
export function toWeekly(bars: Bar[]): WeeklyBar[] {
  const out: WeeklyBar[] = [];
  for (const b of bars) {
    const key = isoWeekKey(b.date);
    const w = out[out.length - 1];
    if (!w || w.key !== key) {
      out.push({ key, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    } else {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.date = b.date;
      w.volume += b.volume;
    }
  }
  return out;
}

function avgWeeklyDrop(w: WeeklyBar[], from: number, count: number): number | null {
  // 平均周跌幅（正值=跌）：区间内相邻周收盘的变化取负后平均
  if (w.length < 2 || count <= 0) return null;
  const end = Math.min(w.length - 1, from);
  const start = Math.max(1, end - count + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end; i++) {
    const prev = w[i - 1].close;
    if (prev <= 0) continue;
    sum += -((w[i].close - prev) / prev) * 100;
    n++;
  }
  return n > 0 ? sum / n : null;
}

function sma(vals: number[], endIdx: number, n: number): number | null {
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let k = endIdx - n + 1; k <= endIdx; k++) s += vals[k];
  return s / n;
}

export function weeklyState(bars: Bar[]): WeeklyState {
  const w = toWeekly(bars);
  const empty: WeeklyState = {
    state: 'unknown',
    reasons: [],
    metrics: { weeks: w.length, weeklyDrop4: null, weeklyDrop8: null, drawdownFrom26wHigh: null,
               ma10: null, ma10Slope: null, bandDrawdown: null, rangeWidthPct: null },
  };
  if (w.length < 8) return { ...empty, reasons: ['周线样本不足 8 根'] };

  const last = w.length - 1;
  const closes = w.map((x) => x.close);

  // --- A1 加速下跌：近 4 周平均周跌幅 > 前 8 周 × 1.5（d03 capitulation）---
  const d4 = avgWeeklyDrop(w, last, 4);
  const d8 = avgWeeklyDrop(w, last - 4, 8);
  const m = { ...empty.metrics };

  // --- A2 距 26 周最高周收盘的回撤 ---
  const back26 = Math.max(0, last - 25);
  let high26 = -Infinity;
  for (let i = back26; i <= last; i++) high26 = Math.max(high26, w[i].close);
  const dd26 = high26 > 0 ? (high26 - w[last].close) / high26 * 100 : null;

  m.weeklyDrop4 = d4;
  m.weeklyDrop8 = d8;
  m.drawdownFrom26wHigh = dd26;

  // --- B1 10 周均线 + 方向 ---
  const ma10 = sma(closes, last, 10);
  const ma10Prev = sma(closes, last - 2, 10);
  m.ma10 = ma10;
  m.ma10Slope = ma10 != null && ma10Prev != null ? ma10 - ma10Prev : null;

  // --- B2 当前波段自最高周收盘回撤（从最近一次周线收盘新高算起）---
  let peak = w[last].close;
  for (let i = last; i >= 0; i--) {
    peak = Math.max(peak, w[i].close);
    // 向前回溯找到本波段起点：遇到周收盘 < 当前 peak 的 0.9 视为波段已结束
    if (w[i].close < peak * 0.9) break;
  }
  const bandDd = peak > 0 ? (peak - w[last].close) / peak * 100 : null;
  m.bandDrawdown = bandDd;

  // --- C1 近 12 周区间宽度（相对均价）---
  const n12 = Math.min(12, w.length);
  const seg = w.slice(w.length - n12);
  const hi = Math.max(...seg.map((x) => x.high));
  const lo = Math.min(...seg.map((x) => x.low));
  const mid = seg.reduce((s, x) => s + x.close, 0) / seg.length;
  const widthPct = mid > 0 ? (hi - lo) / mid * 100 : null;
  m.rangeWidthPct = widthPct;

  const reasons: string[] = [];

  // 判定：恐慌优先
  if (d4 != null && d8 != null && d8 > 0 && d4 >= d8 * 1.5) {
    reasons.push(`近4周平均周跌 ${d4.toFixed(2)}% ≥ 前8周 ${d8.toFixed(2)}% × 1.5（加速下跌/capitulation，d03）`);
  }
  if (dd26 != null && dd26 >= 30) {
    reasons.push(`距 26 周高收盘回撤 ${dd26.toFixed(1)}% ≥ 30%（深跌位置，d03/d08）`);
  }
  if (reasons.length > 0) return { state: 'panic', reasons, metrics: m };

  if (ma10 != null && w[last].close > ma10 && (m.ma10Slope ?? 0) > 0) {
    const quality = bandDd != null ? (bandDd < 5 ? '优质（回撤<5%）' : bandDd < 10 ? '一般（回撤5~10%）' : '走弱（回撤≥10%）') : '';
    reasons.push(`周收盘 ${w[last].close.toFixed(2)} 站上 10 周均线 ${ma10.toFixed(2)} 且均线向上（d07/d09）`);
    if (bandDd != null) reasons.push(`当前波段回撤 ${bandDd.toFixed(1)}%——${quality}`);
    return { state: 'trend', reasons, metrics: m };
  }

  if (widthPct != null && n12 >= 6 && widthPct <= 20) {
    // ±10% 区间 ≈ 振幅 20%
    reasons.push(`近 ${n12} 周区间振幅 ${widthPct.toFixed(1)}%（约合均价 ±10% 内，d05 consolidation）`);
    return { state: 'range', reasons, metrics: m };
  }

  reasons.push('未落入恐慌/趋势/横盘任一明确状态');
  return { state: 'unknown', reasons, metrics: m };
}

// ---- 注入 AI 上下文的【周线状态】块 ----
// 措辞原则：**正向指令优先**（"只找这三类买点"），少用否定式
// （LLM 对"不要做 X"的执行率明显低于"做 Y"——上一轮 A/B 实测：A 组破位止损 50%，
//  禁用后 B 组降到 10%，靠的是正向给出替代动作而不只是禁令）

const STATE_LABEL: Record<WeeklyStateKind, string> = {
  panic: '深跌恐慌态（出清买点窗口）',
  trend: '趋势态',
  range: '横盘态',
  unknown: '无明确周线状态',
};

const STATE_PLAY: Record<WeeklyStateKind, { do: string; dont: string }> = {
  panic: {
    do: '只找这三类出清买点——① 腰斩（翻倍后单边腰斩，按 90 日 +8~16%／胜率 57~66% 规划）；② C 组深跌破（跌破支撑 10~15% 且**跌破日量比 1.5~2.1 温和放量最优**，E+18.28%／胜率 88.5%）；③ 底背离（60 日 E+7.8%，全项目唯一年度稳定信号）；④ 深跌后反转需前 20 日跌幅 ≥30% 才可信',
    dont: '禁止把"趋势走坏、跌破均线"当离场理由——持有期回撤 IC +0.49（12/12 年为正），浮亏越深越该拿',
  },
  trend: {
    do: '找波段内的**首次回踩**：波段回撤 <5% 为优质（创新高率 82%）、5~10% 打折、>10% 放弃；趋势完好时让利润奔跑',
    dont: '禁止追第 4 次以后的回踩（创新高率断崖衰减）——多次回踩本身说明波段走弱',
  },
  range: {
    do: '区间下沿潜伏、上沿兑现；用 RPS 分位区分强弱——RPS≥80 是强势中继（优选）、RPS<20 是弱势停顿（回避）',
    dont: '禁止在区间中段开仓（胜率仅 43~52%，均值微正全由右尾贡献）',
  },
  unknown: {
    do: '只做最高置信信号（深跌出清／腰斩级别），否则观望',
    dont: '不要在无明确周线状态时按日线波动频繁操作',
  },
};

/** 生成注入上下文的【周线状态】块（无足够周线样本时返回 null） */
export function weeklyStateBlock(bars: Bar[]): string[] | null {
  if (!bars || bars.length < 60) return null;
  const s = weeklyState(bars);
  const lines: string[] = [`【周线状态】${STATE_LABEL[s.state]}`];
  for (const r of s.reasons) lines.push(`- ${r}`);
  const play = STATE_PLAY[s.state];
  lines.push(`- 日线该做什么：${play.do}`);
  lines.push(`- 禁止：${play.dont}`);
  return lines;
}
