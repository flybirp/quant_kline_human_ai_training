"""第1轮 vs 第4轮对比：区间收益（抽段运气）与超额收益（主动能力）的分解
命题1：按区间收益算是否没做出超额收益
命题2：两轮抽到的区间收益是否有明显差异
"""
import numpy as np
import pandas as pd

sdf = pd.read_csv('sessions.csv', dtype={'code': str})

def stats(x):
    x = x.dropna()
    return f'均值 {x.mean():+.2%} | 中位 {x.median():+.2%} | 上涨占比 {(x>0).mean():.0%} | n={len(x)}'

def mann_whitney_u(a, b):
    """手写 Mann-Whitney U 检验（正态近似，双尾）"""
    from scipy.stats import norm
    na, nb = len(a), len(b)
    allv = np.concatenate([a, b])
    ranks = pd.Series(allv).rank().values
    ra = ranks[:na].sum()
    ua = ra - na * (na + 1) / 2
    mu = na * nb / 2
    sigma = np.sqrt(na * nb * (na + nb + 1) / 12)
    z = (ua - mu) / sigma
    p = 2 * (1 - norm.cdf(abs(z)))
    return ua, z, p

r1 = sdf[sdf['sheet'] == '第1轮-进行中'].copy()
r4 = sdf[sdf['sheet'] == '第4轮-进行中'].copy()

print('===== 命题2：两轮抽到的区间收益分布 =====\n')
print(f'第1轮 区间收益: {stats(r1.range_ret)}')
print(f'第4轮 区间收益: {stats(r4.range_ret)}')
a = r1.range_ret.dropna().values
b = r4.range_ret.dropna().values
ua, z, p = mann_whitney_u(a, b)
print(f'\nMann-Whitney U 检验: U={ua:.0f}  z={z:.3f}  p={p:.4f}')
welch_t = (a.mean() - b.mean()) / np.sqrt(a.var(ddof=1)/len(a) + b.var(ddof=1)/len(b))
print(f'Welch t ≈ {welch_t:.3f}（负值=第4轮区间更高）')
print('→ ' + ('两轮抽到的区间行情有显著差异' if p < 0.05 else '两轮抽到的区间行情无统计显著差异'))

print('\n===== 命题1：训练收益 vs 区间收益（超额分解） =====\n')
for name, g in [('第1轮', r1), ('第4轮', r4)]:
    v = g.dropna(subset=['ret', 'range_ret'])
    ex = v.ret - v.range_ret
    print(f'{name}:')
    print(f'  训练收益:  {stats(v.ret)}')
    print(f'  区间收益:  {stats(v.range_ret)}')
    print(f'  超额收益:  {stats(ex)}')
    print(f'  复利对比:  实际交易 {np.prod(1+v.ret):.1f}x  vs  满仓躺平吃区间 {np.prod(1+v.range_ret):.1f}x')
    print()

print('===== 相关性：训练收益有多大程度由区间行情决定 =====\n')
for name, g in [('第1轮', r1), ('第4轮', r4)]:
    v = g.dropna(subset=['ret', 'range_ret'])
    corr_p = np.corrcoef(v.ret, v.range_ret)[0, 1]
    corr_s = v.ret.corr(v.range_ret, method='spearman')
    print(f'{name}: 皮尔逊 r={corr_p:.3f} | 斯皮尔曼 ρ={corr_s:.3f}')

print('\n===== 分档细看：区间好坏 × 超额表现 =====\n')
for name, g in [('第1轮', r1), ('第4轮', r4)]:
    v = g.dropna(subset=['ret', 'range_ret']).copy()
    v['ex'] = v.ret - v.range_ret
    v['bucket'] = pd.cut(v.range_ret, [-2, -0.2, 0, 0.2, 0.5, 10],
                         labels=['大跌<-20%', '小跌', '小涨', '大涨20-50%', '暴涨>50%'])
    print(f'--- {name} ---')
    for b, gg in v.groupby('bucket', observed=True):
        print(f'  {str(b):12s} {len(gg):3d} 场 | 区间均值 {gg.range_ret.mean():+.1%} | '
              f'训练收益均值 {gg.ret.mean():+.1%} | 超额均值 {gg.ex.mean():+.1%} | 超额胜率 {(gg.ex>0).mean():.0%}')
    print()
