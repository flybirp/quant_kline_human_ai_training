#!/usr/bin/env python3
"""L0.1b 补充对账：patterns_py.py vs patterns.ts（TS 真源）逐笔逐字比对。

抽样 N 笔有 barsCsv 的交易，从原始 CSV 重建「数据起点→buy_date（含）」全量历史，
分别跑 Python 移植版与 TS 原版（node type-stripping 直接执行 patterns.ts），
比对 pattern_summary_block 输出是否逐字一致。
"""
import csv
import json
import random
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from patterns_py import Bar, pattern_summary_block

DATA = Path('/Users/flybirp/Documents/mainland_data_2014')
N = int(sys.argv[1]) if len(sys.argv) > 1 else 40


def load_hist(code, buy_date):
    """从原始 CSV 重建数据起点→buy_date（含）的 Bar 列表（与 normalize 同口径）"""
    f = DATA / f'{code}.csv'
    if not f.exists():
        return None
    bars = []
    with open(f, encoding='utf-8') as fh:
        rows = list(csv.reader(fh))
    for r in rows[1:]:
        if not r or not r[0] or r[0] == 'date':
            continue
        if r[0] > buy_date:
            break
        bars.append(Bar(date=r[0], open=float(r[1]), close=float(r[2]),
                        high=float(r[3]), low=float(r[4]), volume=float(r[5])))
    return bars or None


def ts_lines(bars):
    """调 node 跑 patterns.ts 的 patternSummaryBlock"""
    payload = json.dumps([{'date': b.date, 'open': b.open, 'high': b.high,
                           'low': b.low, 'close': b.close, 'volume': b.volume} for b in bars])
    r = subprocess.run(['node', str(HERE / 'audit_ts.mjs')], input=payload,
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:300])
    return json.loads(r.stdout.strip())


def main():
    trades = []
    with open(HERE / 'trades-unified.jsonl', encoding='utf-8') as f:
        for line in f:
            t = json.loads(line)
            if (t.get('context') or {}).get('barsCsv'):
                trades.append(t)
    rng = random.Random(7)
    sample = rng.sample(trades, min(N, len(trades)))

    same = diff = skipped = 0
    diffs = []
    for t in sample:
        bars = load_hist(t['code'], t['date'])
        if not bars:
            skipped += 1
            continue
        py = pattern_summary_block(bars)
        ts = ts_lines(bars)
        if py == ts:
            same += 1
        else:
            diff += 1
            diffs.append((t['id'], t['code'], t['date'], py or [], ts or []))

    print(f'抽样 {len(sample)} 笔（跳过 {skipped}）：逐字一致 {same}，有差异 {diff}')
    for tid, code, date, py, ts in diffs[:5]:
        print(f'\n--- {tid} {code} {date} ---')
        print(f'Python({len(py)}行):')
        for x in py: print(f'  {x[:110]}')
        print(f'TS({len(ts)}行):')
        for x in ts: print(f'  {x[:110]}')
    print('\nRESULT:', 'CONSISTENT' if diff == 0 else f'{diff} DIFFS')


if __name__ == '__main__':
    main()
