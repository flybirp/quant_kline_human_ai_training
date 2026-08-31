import type { Bar, Period } from './types';

export async function fetchStocks(): Promise<string[]> {
  const res = await fetch('/api/stocks');
  if (!res.ok) throw new Error('获取股票列表失败');
  const data = await res.json();
  return data.codes as string[];
}

export async function fetchKline(
  code: string,
  period: Period,
): Promise<Bar[]> {
  const res = await fetch(
    `/api/kline/${encodeURIComponent(code)}?period=${period}`,
  );
  if (!res.ok) throw new Error(`获取 ${code} K线失败`);
  const data = await res.json();
  return data.bars as Bar[];
}
