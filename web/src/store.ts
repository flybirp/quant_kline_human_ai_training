import type { TrainingRecord } from './types';

const KEY = 'kline-training-records';
const STAR_KEY = 'kline-starred-records';

// 主页「总资金」别名：爆竹coins，起始 10000。它是独立于训练买卖资金的虚拟概念。
export const INITIAL_COINS = 10000;

// 总资金 = 起始资金按每场训练收益率（profitRate）复利累计。
// 由历史记录推导，保证主页与历史统计口径完全一致。
export function computeCoins(records: TrainingRecord[]): number {
  let coins = INITIAL_COINS;
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of sorted) {
    coins = coins * (1 + r.profitRate);
  }
  return Math.round(coins * 100) / 100;
}

export function loadRecords(): TrainingRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecord(record: TrainingRecord): TrainingRecord[] {
  const records = [record, ...loadRecords()];
  localStorage.setItem(KEY, JSON.stringify(records));
  return records;
}

export function clearRecords(): void {
  localStorage.removeItem(KEY);
}

export function loadStarred(): string[] {
  try {
    const raw = localStorage.getItem(STAR_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toggleStarred(id: string): string[] {
  const list = loadStarred();
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  localStorage.setItem(STAR_KEY, JSON.stringify(next));
  return next;
}
