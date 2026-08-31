import type { TrainingRecord, Period } from '../types';

const PERIOD_LABELS: Record<Period, string> = {
  day: '日线',
  week: '周线',
  month: '月线',
};

function holdingRateOf(r: TrainingRecord): number {
  const total = r.positionSeries.length;
  if (total === 0) return 0;
  return r.positionSeries.reduce((s, v) => s + v, 0) / total;
}

function heavyRateOf(r: TrainingRecord): number {
  const total = r.positionSeries.length;
  if (total === 0) return 0;
  return r.heavySeries.reduce((s, v) => s + v, 0) / total;
}

function escapeCell(cell: string): string {
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function buildTrainingCSV(records: TrainingRecord[]): string {
  const headers = [
    '记录ID', '股票代码', '股票名', '周期',
    '开始日期', '结束日期', '初始资金', '最终资金',
    '盈亏金额', '盈亏率%', '区间涨幅%',
    '开仓次数', '平仓胜次', '平仓负次',
    '持仓率%', '重仓率%', '持仓天数',
    '训练耗时ms', '创建时间',
  ];
  const rows: string[][] = [];
  rows.push(headers);
  for (const r of records) {
    rows.push([
      r.id, r.code, r.stockName, PERIOD_LABELS[r.period] || r.period,
      r.startDate, r.endDate,
      String(r.initialCapital), String(r.finalCapital),
      r.profit.toFixed(2),
      (r.profitRate * 100).toFixed(4),
      (r.rangeReturn * 100).toFixed(4),
      String(r.openCount),
      String(r.winTrades),
      String(r.lossTrades),
      (holdingRateOf(r) * 100).toFixed(2),
      (heavyRateOf(r) * 100).toFixed(2),
      String(r.positionSeries.length),
      String(r.durationMs),
      new Date(r.createdAt).toISOString(),
    ]);
  }
  rows.push([]);
  rows.push(['## 交易明细']);
  rows.push(['记录ID', '股票代码', '方向', '日期', '价格', '股数', 'K线索引']);
  for (const r of records) {
    for (const t of r.trades) {
      rows.push([
        r.id, r.code, t.side === 'buy' ? '买入' : '卖出',
        t.date, t.price.toFixed(3), String(t.shares), String(t.index),
      ]);
    }
  }
  return '\ufeff' + rows.map((r) => r.map(escapeCell).join(',')).join('\n');
}

export function downloadTrainingCSV(records: TrainingRecord[], filename?: string) {
  const csv = buildTrainingCSV(records);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const name =
    filename ||
    `爆竹K线训练记录_${new Date().toISOString().slice(0, 10)}.csv`;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
