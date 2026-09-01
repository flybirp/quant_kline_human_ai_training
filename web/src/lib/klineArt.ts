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
const VOL_BLOCKS = ' ▁▂▃▄▅▆▇█'; // 量能条 8 档块字符

// 字符形态图：纵向价格网格，█=阳线(涨) ▒=阴线(跌)，下方量能条
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
    const ch = b.close >= b.open ? '█' : '▒';
    const top = rowOf(b.high);
    const bot = rowOf(b.low);
    for (let y = top; y <= bot; y++) grid[y][i] = ch;
  });

  const lines: string[] = [];
  lines.push(
    `${title}（${tailNote ? tailNote + '；' : ''}█=阳线(涨) ▒=阴线(跌)，纵向价格 ${pMin.toFixed(2)}~${pMax.toFixed(2)}，横向从早到晚每列1根共 ${bars.length} 根，下方量能条高度=成交量占比）`,
  );
  const axisW = 7;
  for (let y = 0; y < PRICE_ROWS; y++) {
    const p = pMax - (span * y) / (PRICE_ROWS - 1);
    const axis = y % 2 === 0 ? p.toFixed(2).padStart(axisW - 1) : ' '.repeat(axisW - 1);
    lines.push(`${axis}│${grid[y].join('')}`);
  }
  lines.push(`${' '.repeat(axisW - 1)}└${'─'.repeat(Math.min(bars.length, 78))}`);

  const vmax = Math.max(...bars.map((b) => b.volume)) || 1;
  const volLine = bars
    .map((b) => {
      const idx = Math.max(1, Math.min(VOL_BLOCKS.length - 1, Math.ceil((b.volume / vmax) * 8)));
      return VOL_BLOCKS[idx];
    })
    .join('');
  lines.push(`${'量能'.padStart(axisW - 1)}│${volLine}`);

  return lines;
}
