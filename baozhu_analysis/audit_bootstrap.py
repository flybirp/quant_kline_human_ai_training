# 安慰剂对照组合法性自检：block-bootstrap 合成数据是否"像 A 股"
#
# 对照组的价值前提是：它保留了真实走势的低阶统计特征（跳空、日内振幅、
# 波动率、收益分布尾部），只破坏了时间上的可预测结构。
# 若这些统计量对不上，任何"形态在两组表现相当"的结论都不可信。
#
# 用法：python3 audit_bootstrap.py [抽样股票数]
import os
import sys
import glob
import random
import statistics as st

REAL = '/Users/flybirp/Documents/mainland_data_2014'
FAKE = '/Users/flybirp/Documents/monkey_fake_data'
N = int(sys.argv[1]) if len(sys.argv) > 1 else 150


def load(path):
    bars = []
    with open(path, encoding='utf-8', errors='ignore') as f:
        lines = f.read().split('\n')
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        r = line.split(',')
        if len(r) < 5 or r[0] in ('date', ''):
            continue
        try:
            bars.append((r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4])))
        except ValueError:
            continue
    return [b for b in bars if b[2] > 0]


def sample_files(d, n):
    fs = sorted(glob.glob(os.path.join(d, '*.csv')))
    random.seed(42)
    return random.sample(fs, min(n, len(fs)))


def stats(bars):
    """返回单只股票的低阶统计特征"""
    n = len(bars)
    if n < 100:
        return None
    gaps, amps, rets = [], [], []
    hi_all, lo_all = -1e18, 1e18
    for i in range(1, n):
        _, o, c, h, l = bars[i]
        pc = bars[i - 1][2]
        if pc <= 0:
            continue
        gaps.append(abs(o / pc - 1) * 100)
        amps.append((h - l) / pc * 100)
        rets.append((c / pc - 1) * 100)
        hi_all = max(hi_all, h)
        lo_all = min(lo_all, l)
    if not rets:
        return None
    return {
        'gap1': sum(1 for g in gaps if g >= 1.0) / len(gaps) * 100,   # 跳空≥1% 占比
        'gap2': sum(1 for g in gaps if g >= 2.0) / len(gaps) * 100,   # 跳空≥2% 占比
        'amp': sum(amps) / len(amps),                                  # 日均振幅
        'ret_std': st.pstdev(rets),                                    # 日收益标准差
        'ret_kurt': st.pstdev(rets) and sum((x - sum(rets) / len(rets)) ** 4 for x in rets) / len(rets) / (st.pstdev(rets) ** 4),
        'range': (hi_all / lo_all - 1) * 100,                          # 全程高低幅度
        'n': n,
    }


def agg(d, n):
    acc = {}
    for f in sample_files(d, n):
        s = stats(load(f))
        if not s:
            continue
        for k, v in s.items():
            acc.setdefault(k, []).append(v)
    return {k: sum(v) / len(v) for k, v in acc.items()}


r, f = agg(REAL, N), agg(FAKE, N)

print(f'抽样：真实 {N} 只 / 合成 {N} 只\n')
print('指标'.ljust(16) + '真实 A 股'.rjust(14) + '合成(bootstrap)'.rjust(16) + '比值'.rjust(10) + '  判定')
print('-' * 74)
rows = [
    ('跳空≥1% 占比%', 'gap1', 0.6, 1.6),
    ('跳空≥2% 占比%', 'gap2', 0.4, 2.0),
    ('日均振幅%', 'amp', 0.7, 1.4),
    ('日收益标准差%', 'ret_std', 0.7, 1.4),
    ('收益峰度', 'ret_kurt', 0.5, 2.0),
    ('全程高低幅度%', 'range', 0.5, 2.0),
]
ok = True
for label, k, lo, hi in rows:
    rv, fv = r[k], f[k]
    ratio = fv / rv if rv else 0
    good = lo <= ratio <= hi
    ok = ok and good
    print(f'{label.ljust(16)}{rv:>13.2f}{fv:>15.2f}{ratio:>9.2f}x  {"✓" if good else "✗ 偏离"}')
print('-' * 74)
print('结论：', '对照组统计特征与真实同量级 → 可用于安慰剂检验' if ok else '⚠ 对照组与真实分布差异过大，结论不可信')
