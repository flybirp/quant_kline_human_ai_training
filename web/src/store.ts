import type { TrainingRecord } from './types';

// 旧版 localStorage key：仅用于一次性迁移到服务端
const LEGACY_KEY = 'kline-training-records';
const LEGACY_STAR_KEY = 'kline-starred-records';

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

export interface RecordsData {
  records: TrainingRecord[];
  starred: string[];
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`记录服务请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

export function fetchRecords(): Promise<RecordsData> {
  return request<RecordsData>('/api/records');
}

export async function saveRecord(record: TrainingRecord): Promise<void> {
  await request('/api/records', {
    method: 'POST',
    body: JSON.stringify({ record }),
  });
}

export async function clearRecords(): Promise<void> {
  await request('/api/records', { method: 'DELETE' });
}

export async function toggleStarred(id: string): Promise<string[]> {
  const data = await request<{ starred: string[] }>('/api/records/star', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  return data.starred;
}

// 一次性迁移：把旧版 localStorage 里的记录搬到服务端 JSON 文件后删除本地副本。
// server 侧已有数据时跳过（避免覆盖），仅清掉本地残留。
export async function migrateLocalRecords(): Promise<void> {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const local = JSON.parse(raw);
    if (!Array.isArray(local) || local.length === 0) {
      localStorage.removeItem(LEGACY_KEY);
      localStorage.removeItem(LEGACY_STAR_KEY);
      return;
    }
    const server = await fetchRecords();
    if (server.records.length === 0) {
      let starred: string[] = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(LEGACY_STAR_KEY) || '[]');
        if (Array.isArray(parsed)) starred = parsed.filter((x) => typeof x === 'string');
      } catch {
        starred = [];
      }
      await request('/api/records', {
        method: 'PUT',
        body: JSON.stringify({ records: local, starred }),
      });
    }
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(LEGACY_STAR_KEY);
  } catch {
    // 迁移失败不阻塞应用（下次启动可重试）
  }
}
