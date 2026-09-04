import type { Bar } from '../types';

// AI 上下文的 K 线呈现方式（用户可在训练设置里切换）
// csv:   数字表格（原始 OHLCV + 涨跌%/量比 + MA）
// chart: 字符形态图（价格纵向网格 + 阴阳块 + 量能条）
// image: 图表截图（多模态 LLM 直接看图，取当前周期视图）
export type KlineMode = 'csv' | 'chart' | 'image';

export const KLINE_MODE_KEY = 'kline-ai-kline-mode';

export function loadKlineMode(): KlineMode {
  const v = localStorage.getItem(KLINE_MODE_KEY);
  return v === 'chart' || v === 'image' ? v : 'csv';
}

export function saveKlineMode(m: KlineMode): void {
  localStorage.setItem(KLINE_MODE_KEY, m);
}

const PRICE_ROWS = 14; // 价格网格行数
const VOL_ROWS = 5; // 量能柱行数

// 跳空缺口阈值：|gap| >= 0.1% 才记录（过滤几分钱的微小跳空）
const GAP_THRESHOLD = 0.001;

// 计算相邻两根 bar 的跳空缺口：向上为正（cur.low > prev.high），向下为负（cur.high < prev.low）
export function gapBetween(cur: Bar, prev: Bar): number {
  if (cur.low > prev.high && prev.high > 0) {
    return (cur.low - prev.high) / prev.high;
  }
  if (cur.high < prev.low && prev.low > 0) {
    return (cur.high - prev.low) / prev.low;
  }
  return 0;
}

// 窗口内跳空缺口摘要（序号与 K 线行号一致，供 CSV 表格与字符形态图共用）
export function gapSummary(bars: Bar[]): string | null {
  const items: string[] = [];
  for (let i = 1; i < bars.length; i++) {
    const g = gapBetween(bars[i], bars[i - 1]);
    if (g >= GAP_THRESHOLD) {
      items.push(`第${i + 1}根向上跳空 +${(g * 100).toFixed(1)}%`);
    } else if (g <= -GAP_THRESHOLD) {
      items.push(`第${i + 1}根向下跳空 ${(g * 100).toFixed(1)}%`);
    }
  }
  if (items.length === 0) return null;
  return `跳空缺口（相对前一根高低点）：${items.join('；')}`;
}

// 字符形态图：纵向价格网格 + 量能柱状图，全图统一：█=阳线(红/涨，全实心) ░=阴线(绿/跌，稀疏点阵)
export function klineAsciiBlock(title: string, bars: Bar[], tailNote: string): string[] {
  if (bars.length === 0) return [`${title}（无数据）`];

  const pMax = Math.max(...bars.map((b) => b.high));
  const pMin = Math.min(...bars.map((b) => b.low));
  const span = pMax - pMin || pMax || 1;
  const rowOf = (p: number) =>
    Math.min(PRICE_ROWS - 1, Math.max(0, Math.round(((pMax - p) / span) * (PRICE_ROWS - 1))));

  const grid: string[][] = Array.from({ length: PRICE_ROWS }, () =>
    new Array(bars.length).fill(' '),
  );
  bars.forEach((b, i) => {
    const body = b.close >= b.open ? '█' : '░';
    const top = rowOf(b.high);
    const bot = rowOf(b.low);
    // 实体范围（开→收，rowOf 价格越高行号越小，薄实体至少占 1 行），其余为影线
    const bodyTop = rowOf(Math.max(b.open, b.close));
    const bodyBot = rowOf(Math.min(b.open, b.close));
    for (let y = top; y <= bot; y++) {
      grid[y][i] = y >= bodyTop && y <= bodyBot ? body : '│';
    }
  });

  // 量能柱：高度=成交量占比，格子颜色随 K 线阴阳（█/░ 与价格图同规则）
  const vmax = Math.max(...bars.map((b) => b.volume)) || 1;
  const volGrid: string[][] = Array.from({ length: VOL_ROWS }, () =>
    new Array(bars.length).fill(' '),
  );
  bars.forEach((b, i) => {
    const ch = b.close >= b.open ? '█' : '░';
    const h = Math.max(1, Math.min(VOL_ROWS, Math.ceil((b.volume / vmax) * VOL_ROWS)));
    for (let y = VOL_ROWS - h; y < VOL_ROWS; y++) volGrid[y][i] = ch;
  });

  const lines: string[] = [];
  lines.push(
    `${title}（${tailNote ? tailNote + '；' : ''}█=阳线实体(红/涨) ░=阴线实体(绿/跌) │=上下影线(最高~最低价)；纵向价格 ${pMin.toFixed(2)}~${pMax.toFixed(2)}，横向从早到晚每列1根共 ${bars.length} 根；量能柱高度=成交量占比，柱色随 K 线阴阳）`,
  );
  const axisW = 7;
  for (let y = 0; y < PRICE_ROWS; y++) {
    const p = pMax - (span * y) / (PRICE_ROWS - 1);
    const axis = y % 2 === 0 ? p.toFixed(2).padStart(axisW - 1) : ' '.repeat(axisW - 1);
    lines.push(`${axis}│${grid[y].join('')}`);
  }
  lines.push(`${' '.repeat(axisW - 1)}└${'─'.repeat(Math.min(bars.length, 78))}`);
  for (let y = 0; y < VOL_ROWS; y++) {
    // 中文占 2 显示列：'量能'=4 列，前补 2 空格凑齐 axisW-1=6 列，与价格轴对齐
    const label = y === 0 ? '  量能' : ' '.repeat(axisW - 1);
    lines.push(`${label}│${volGrid[y].join('')}`);
  }

  const gap = gapSummary(bars);
  if (gap) lines.push(gap);

  return lines;
}
