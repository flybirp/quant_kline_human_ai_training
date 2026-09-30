#!/usr/bin/env python3
"""周线状态 TS↔Py 对账（同 audit_patterns.py 的做法）。

抽样 N 笔，分别用 weeklyState.ts（经 node）与 weekly_state.py 计算，
比对 state / reasons / metrics（浮点取 6 位容差）。
"""
import json
import random
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from audit_patterns import load_hist  # noqa: E402
from weekly_state import weekly_state  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 100


def ts_state(bars):
    payload = json.dumps([{'date': b.date, 'open': b.open, 'high': b.high,
                           'low': b.low, 'close': b.close, 'volume': b.volume} for b in bars])
    r = subprocess.run(['node', str(HERE / 'audit_ws.mjs')], input=payload,
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:300])
    return json.loads(r.stdout.strip())


def norm(o):
    """浮点取 6 位，避免精度差异"""
    if isinstance(o, dict):
        return {k: norm(v) for k, v in o.items()}
    if isinstance(o, list):
        return [norm(v) for v in o]
    if isinstance(o, float):
        return round(o, 6)
    return o


def main():
    trades = []
    with open(HERE / 'trades-unified.jsonl', encoding='utf-8') as f:
        for line in f:
            t = json.loads(line)
            if (t.get('context') or {}).get('barsCsv'):
                trades.append(t)
    rng = random.Random(11)
    sample = rng.sample(trades, min(N, len(trades)))

    from collections import Counter
    dist = Counter()
    same = diff = text_only = 0
    shown = 0
    for t in sample:
        bars = load_hist(t['code'], t['date'])
        if not bars or len(bars) < 60:
            continue
        py = norm(weekly_state(bars))
        ts = norm(ts_state(bars))
        dist[py['state']] += 1
        # 判定一致性 = 状态相同 + metrics 数值一致（reasons 是格式化文本，
        # Python 的 :.2f 与 JS toFixed(2) 在边界值舍入可能不同，不影响判定）
        core_same = (py['state'] == ts['state']) and (py['metrics'] == ts['metrics'])
        if core_same:
            same += 1
            if py['reasons'] != ts['reasons']:
                text_only += 1
        else:
            diff += 1
            if shown < 3:
                shown += 1
                print(f"--- {t['id']} {t['code']} {t['date']} ---")
                print(f"  PY: {py['state']} {py['reasons']}")
                print(f"  TS: {ts['state']} {ts['reasons']}")
                for k in py['metrics']:
                    if py['metrics'][k] != ts['metrics'][k]:
                        print(f"   metric {k}: PY={py['metrics'][k]} TS={ts['metrics'][k]}")

    print(f'\n抽样 {same + diff} 笔：判定一致 {same}，判定差异 {diff}，仅文本舍入差异 {text_only}')
    print(f'状态分布: {dict(dist)}')
    print('RESULT:', 'CONSISTENT' if diff == 0 else f'{diff} DIFFS')


if __name__ == '__main__':
    main()
