#!/usr/bin/env python3
"""L0.3a 批量验证：读 trades-unified.jsonl → 调 POST /api/ai/verify → trades_verified.csv

用法：
  python3 verify_trades.py --sample 100   # 按买入年份分层抽样 100 笔（默认）
  python3 verify_trades.py --all          # 全量（可验证池 656 笔）
  python3 verify_trades.py --ids h-第4轮-0302,h-第1轮-0075

- 断点续跑：trades_verified.csv 已有 id 自动跳过（服务端另有 verify-cache）
- 并发：--concurrency 策略笔数（默认 3；服务端每笔内部再并发 5 次调用）
- 失败重试：每笔最多 3 次（指数退避）
"""
import argparse
import csv
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

API = os.environ.get('VERIFY_API', 'http://localhost:8787/api/ai/verify')
HERE = os.path.dirname(os.path.abspath(__file__))
UNIFIED = os.path.join(HERE, 'trades-unified.jsonl')
OUT_CSV = os.path.join(HERE, 'trades_verified.csv')

FIELDS = [
    'id', 'round', 'code', 'stockName', 'date', 'price', 'weight',
    'pairedSellDate', 'pairedSellPrice', 'pnlPct', 'holdDays', 'estimated', 'sellDeferred',
    'postTrade10', 'postTrade20', 'postTrade60',
    'score', 'method', 'variance',
    'sub_signal', 'sub_timing', 'sub_sizing', 'sub_risk', 'sub_process',
    'sub_std_signal', 'sub_std_timing', 'sub_std_sizing', 'sub_std_risk', 'sub_std_process',
    'usage_total_tokens',
]


def load_unified():
    trades = []
    with open(UNIFIED, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            t = json.loads(line)
            trades.append(t)
    return trades


def verify_one(trade, retries=3):
    body = json.dumps({'tradeId': trade['id']}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                API, data=body, headers={'Content-Type': 'application/json'}, method='POST'
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:200]
            if e.code in (500, 502, 504) and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f'HTTP {e.code}: {detail}')
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(str(e))
    raise RuntimeError('unreachable')


def row_of(trade, v):
    o = trade.get('outcome') or {}
    sub = v.get('subScores') or {}
    row = {
        'id': trade['id'],
        'round': trade.get('round'),
        'code': trade.get('code'),
        'stockName': trade.get('stockName'),
        'date': trade.get('date'),
        'price': trade.get('price'),
        'weight': trade.get('weight'),
        'pairedSellDate': o.get('pairedSellDate'),
        'pairedSellPrice': o.get('pairedSellPrice'),
        'pnlPct': o.get('pnlPct'),
        'holdDays': o.get('holdDays'),
        'estimated': o.get('estimated'),
        'sellDeferred': o.get('sellDeferred'),
        'postTrade10': o.get('postTrade10'),
        'postTrade20': o.get('postTrade20'),
        'postTrade60': o.get('postTrade60'),
        'score': v.get('score'),
        'method': v.get('method'),
        'variance': v.get('variance'),
        'usage_total_tokens': (v.get('usage') or {}).get('total_tokens'),
    }
    for name in ('signal', 'timing', 'sizing', 'risk', 'process'):
        s = sub.get(name) or {}
        row[f'sub_{name}'] = s.get('mean')
        row[f'sub_std_{name}'] = s.get('std')
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sample', type=int, default=100)
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--ids', type=str, default='')
    ap.add_argument('--concurrency', type=int, default=3)
    args = ap.parse_args()

    trades = load_unified()
    pool = {t['id']: t for t in trades if (t.get('context') or {}).get('barsCsv')}
    print(f'可验证池（有 barsCsv）：{len(pool)} / {len(trades)}')

    # 断点续跑：已有结果跳过
    done = set()
    if os.path.exists(OUT_CSV):
        with open(OUT_CSV, encoding='utf-8') as f:
            for r in csv.DictReader(f):
                done.add(r['id'])
    if done:
        print(f'已有 {len(done)} 笔结果，跳过')

    # 目标集合
    if args.ids:
        targets = [pool[i] for i in args.ids.split(',') if i in pool]
        missing = [i for i in args.ids.split(',') if i not in pool]
        if missing:
            print(f'⚠ 不在可验证池: {missing}')
    elif args.all:
        targets = list(pool.values())
    else:
        # 按买入年份分层比例抽样（服务 L0.3c 分年稳定性）
        by_year = defaultdict(list)
        for t in pool.values():
            if t['id'] in done:
                continue
            by_year[t['date'][:4]].append(t)
        rng = random.Random(42)
        targets = []
        remaining = args.sample - len(done)
        total = sum(len(v) for v in by_year.values())
        if remaining <= 0:
            print('抽样目标已全部完成')
            return
        for year, group in sorted(by_year.items()):
            n = max(1, round(len(group) / total * remaining))
            take = min(n, len(group))
            picked = rng.sample(group, take)
            for t in picked:
                targets.append(t)
        targets = targets[:remaining]
        years = defaultdict(int)
        for t in targets:
            years[t['date'][:4]] += 1
        print(f'分层抽样 {len(targets)} 笔（{dict(sorted(years.items()))}）')

    targets = [t for t in targets if t['id'] not in done]
    if not targets:
        print('无待验证目标')
        return

    # CSV 追加写（不存在则带表头）
    write_header = not os.path.exists(OUT_CSV)
    out_f = open(OUT_CSV, 'a', encoding='utf-8', newline='')
    writer = csv.DictWriter(out_f, fieldnames=FIELDS)
    if write_header:
        writer.writeheader()

    t0 = time.time()
    ok = fail = 0
    try:
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = {ex.submit(verify_one, t): t for t in targets}
            for i, fut in enumerate(as_completed(futs), 1):
                t = futs[fut]
                try:
                    v = fut.result()
                    if v.get('cached'):
                        v = fut.result()  # 缓存命中同样计入
                    writer.writerow(row_of(t, v))
                    out_f.flush()
                    ok += 1
                    done_min = (time.time() - t0) / 60
                    print(f'[{i}/{len(targets)}] {t["id"]} {t["code"]} score={v.get("score")} '
                          f'({v.get("method")}) {done_min:.1f}min', flush=True)
                except Exception as e:
                    fail += 1
                    print(f'[{i}/{len(targets)}] {t["id"]} 失败: {e}', flush=True)
    finally:
        out_f.close()

    print(f'\n完成：成功 {ok} / 失败 {fail}，耗时 {(time.time() - t0) / 60:.1f} 分钟 → {OUT_CSV}')


if __name__ == '__main__':
    main()
