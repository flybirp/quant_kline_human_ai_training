import type { Bar, Period } from './types';

// RPS 相对强度分位序列（quant_discover d15 口径：个股120日收益 − 中证1000同期收益的全市场截面百分位）
// 返回 date -> 分位(0~99，高=强)；服务不可用时返回空 Map，前端降级为不注入
export async function fetchRps(code: string): Promise<Map<string, number>> {
  try {
    const res = await fetch(`/api/rps?code=${encodeURIComponent(code)}`);
    if (!res.ok) return new Map();
    const data = await res.json();
    const arr = Array.isArray(data.series) ? data.series : [];
    return new Map(arr.map((p: [string, number]) => [String(p[0]), Number(p[1])]));
  } catch {
    return new Map();
  }
}

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
