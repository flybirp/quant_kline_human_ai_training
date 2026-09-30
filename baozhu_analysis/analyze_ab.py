#!/usr/bin/env python3
"""A/B 配对分析（读 backtest_records.jsonl）。

按 meta.experiment 分组（如 long200 / base101），每组内按股票 code 配对 A/B
（同股票同时段，唯一变量=风控指引），输出均值、超额、胜率、配对差与符号检验。

胜率口径：从 trades 重放，期末未平仓按最后收盘估值计入（否则盈利仓位往往
持有到结束未卖出，会系统性低估胜率）。

用法：
  python3 analyze_ab.py                 # 全部实验
  python3 analyze_ab.py --exp long200   # 只看长窗口
"""
import argparse
import csv
import json
import statistics
from math import comb
from pathlib import Path

HERE = Path(__file__).parent
DATA = Path('/Users/flybirp/Documents/mainland_data_2014')
SRC = HERE / 'backtest_records.jsonl'

ARM_FILTER = 'B'   # --arm 覆盖


def last_close(code, date):
    f = DATA / f'{code}.csv'
    if not f.exists():
        return None
    prev = None
    with open(f, encoding='utf-8') as fh:
        for i, r in enumerate(csv.reader(fh)):
            if i == 0 or not r or r[0] == 'date':
                continue
            if r[0] > date:
                break
            prev = float(r[2])
    return prev


def replay_pnls(r):
    """重放 trades：返回每笔平仓盈亏（含期末未平仓按收盘估值）"""
    sh, avg, pnls = 0, 0.0, []
    for t in r['trades']:
        px, q = t['price'], t['shares']
        if t['side'] == 'buy':
            avg = (avg * sh + px * q) / (sh + q) if sh else px
            sh += q
        else:
            fee = max(5, px * q * 0.0003)
            tax = px * q * 0.001
            pnls.append((px - avg) * q - fee - tax)
            sh -= q
            if sh <= 0:
                sh, avg = 0, 0.0
    lc = last_close(r['code'], r['endDate'])
    if sh > 0 and lc:
        pnls.append((lc - avg) * sh)
    return pnls


def sign_test_p(pos, n):
    if n == 0:
        return 1.0
    return min(1.0, sum(comb(n, k) for k in range(pos, n + 1)) / 2 ** n * 2)


def analyze(exp):
    rows = [json.loads(l) for l in open(SRC, encoding='utf-8') if l.strip()]
    rows = [r for r in rows if not exp or r['meta'].get('experiment') == exp]
    A = {r['code']: r for r in rows if r['meta']['arm'] == 'A'}
    B = {r['code']: r for r in rows if r['meta']['arm'] == 'B'}
    codes = sorted(c for c in A if c in B)
    if not codes:
        print(f'[{exp or "全部"}] 无配对数据')
        return

    def side(d, name):
        pr = [d[c]['profitRate'] * 100 for c in codes]
        ex = [(d[c]['profitRate'] - d[c]['rangeReturn']) * 100 for c in codes]
        pnls = [p for c in codes for p in replay_pnls(d[c])]
        wins = sum(1 for p in pnls if p > 0)
        tr = sum(len(d[c]['trades']) for c in codes)
        print(f'  {name}: 收益 {statistics.mean(pr):+.2f}%（中位 {statistics.median(pr):+.2f}%）  '
              f'超额 {statistics.mean(ex):+.2f}%  '
              f'胜率 {wins / len(pnls) * 100 if pnls else 0:.1f}%（{len(pnls)}笔）  '
              f'交易 {tr / len(codes):.1f} 笔/局')
        return statistics.mean(pr), statistics.mean(ex)

    print(f'\n===== {exp or "全部"}：{len(codes)} 对 =====')
    ma_, ea = side(A, 'A组(旧风控)     ')
    mb_, eb = side(B, 'B组(新[EXIT:v2])')

    diffs = [(B[c]['profitRate'] - A[c]['profitRate']) * 100 for c in codes]
    pos = sum(1 for d in diffs if d > 0)
    n = len(diffs)
    p = sign_test_p(pos, n)
    print(f'  配对差 B−A: 平均 {statistics.mean(diffs):+.2f}%  中位 {statistics.median(diffs):+.2f}%  '
          f'标准差 {statistics.pstdev(diffs):.2f}')
    print(f'  B 优于 A: {pos}/{n} 局   符号检验 p≈{p:.3f}  '
          f'{"→ 差异显著" if p < 0.05 else "→ 无统计差异"}')
    # 需要多少对才能检测当前效应（粗略：效应/标准差 → n ≈ (1.96·sd/effect)²）
    eff, sd = abs(statistics.mean(diffs)), statistics.pstdev(diffs)
    if eff > 0 and sd > 0:
        need = (1.96 * sd / eff) ** 2
        print(f'  按当前效应 {eff:.2f}% 与波动 {sd:.2f}%，检测显著差异约需 {need:.0f} 对')


def state_of_buy(r):
    """对每笔买入，按成交日重算当时的周线状态（状态可从历史数据复现，不必事先落盘）"""
    from weekly_state import weekly_state
    import csv as _csv
    f = DATA / f"{r['code']}.csv"
    if not f.exists():
        return None
    bars = []
    with open(f, encoding='utf-8') as fh:
        for i, row in enumerate(_csv.reader(fh)):
            if i == 0 or not row or row[0] == 'date':
                continue
            if row[0] > r['endDate']:
                break
            bars.append(type('B', (), {'date': row[0], 'open': float(row[1]), 'close': float(row[2]),
                                        'high': float(row[3]), 'low': float(row[4]),
                                        'volume': float(row[5])})())
    out = {}
    for t in r['trades']:
        if t['side'] != 'buy':
            continue
        sub = [b for b in bars if b.date <= t['date']]
        if len(sub) < 60:
            continue
        out[t['date']] = weekly_state(sub)['state']
    return out


def buy_state_stats(rows):
    """按周线状态统计开仓分布：看 AI 在各状态下敢不敢买"""
    from collections import Counter
    c = Counter()
    for r in rows:
        m = state_of_buy(r) or {}
        for st in m.values():
            c[st] += 1
    return c


def compare(e_ctrl, e_test):
    """跨实验配对比较（同 code），唯一变量即实验自变量"""
    rows = [json.loads(l) for l in open(SRC, encoding='utf-8') if l.strip()]
    arm = ARM_FILTER
    C = {r['code']: r for r in rows if r['meta'].get('experiment') == e_ctrl
         and (not arm or r['meta'].get('arm') == arm)}
    T = {r['code']: r for r in rows if r['meta'].get('experiment') == e_test
         and (not arm or r['meta'].get('arm') == arm)}
    codes = sorted(set(C) & set(T))
    if not codes:
        print(f'无配对：{e_ctrl} vs {e_test}')
        return
    from math import comb as _comb
    print(f'\n===== 配对比较：{e_test}（实验） vs {e_ctrl}（对照）｜{len(codes)} 对 =====')

    def side(d, name):
        pr = [d[c]['profitRate'] * 100 for c in codes]
        ex = [(d[c]['profitRate'] - d[c]['rangeReturn']) * 100 for c in codes]
        pnls = [p for c in codes for p in replay_pnls(d[c])]
        wins = sum(1 for p in pnls if p > 0)
        tr = sum(len(d[c]['trades']) for c in codes)
        print(f'  {name}: 收益 {statistics.mean(pr):+.2f}%  超额 {statistics.mean(ex):+.2f}%  '
              f'胜率 {wins / len(pnls) * 100 if pnls else 0:.1f}%  交易 {tr / len(codes):.1f}/局')
        return statistics.mean(pr)

    mc = side(C, '对照组  ')
    mt = side(T, '实验组  ')
    diffs = [(T[c]['profitRate'] - C[c]['profitRate']) * 100 for c in codes]
    pos = sum(1 for d in diffs if d > 0)
    n = len(diffs)
    p = min(1.0, sum(_comb(n, k) for k in range(pos, n + 1)) / 2 ** n * 2)
    print(f'  配对差（实验−对照）: {statistics.mean(diffs):+.2f}%  中位 {statistics.median(diffs):+.2f}%  '
          f'标准差 {statistics.pstdev(diffs):.2f}')
    print(f'  实验优于对照: {pos}/{n} 局  符号检验 p≈{p:.3f}  '
          f'{"→ 显著" if p < 0.05 else "→ 不显著"}')
    eff, sd = abs(statistics.mean(diffs)), statistics.pstdev(diffs)
    if eff > 0 and sd > 0:
        print(f'  检测该效应约需 {((1.96 * sd / eff) ** 2):.0f} 对')
    print('  开仓的周线状态分布  对照:', dict(buy_state_stats([C[c] for c in codes])))
    print('  开仓的周线状态分布  实验:', dict(buy_state_stats([T[c] for c in codes])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exp', default='')
    ap.add_argument('--compare', nargs=2, metavar=('CTRL', 'TEST'), default=None,
                    help='跨实验配对比较，如 --compare long200 long200w')
    ap.add_argument('--arm', default='B', help='比较时只看该 arm（默认 B，即新风控指引组）')
    args = ap.parse_args()
    global ARM_FILTER
    ARM_FILTER = args.arm
    if args.compare:
        compare(args.compare[0], args.compare[1])
        return
    rows = [json.loads(l) for l in open(SRC, encoding='utf-8') if l.strip()]
    exps = [args.exp] if args.exp else sorted({r['meta'].get('experiment', '?') for r in rows})
    for e in exps:
        if e in ('verify',):
            continue
        analyze(e)


if __name__ == '__main__':
    main()
