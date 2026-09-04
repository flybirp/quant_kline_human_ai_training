"""第4轮：训练收益 vs 区间收益 的累计复利曲线（按场次顺序）"""
import numpy as np
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt

# macOS 中文字体
for f in ['PingFang SC', 'Hiragino Sans GB', 'Arial Unicode MS', 'Heiti SC']:
    if f in {x.name for x in matplotlib.font_manager.fontManager.ttflist}:
        plt.rcParams['font.family'] = f
        break
plt.rcParams['axes.unicode_minus'] = False

sdf = pd.read_csv('sessions.csv', dtype={'code': str})
r4 = sdf[sdf['sheet'] == '第4轮-进行中'].dropna(subset=['ret', 'range_ret']).reset_index(drop=True)

# 按记录序号排序（导出顺序即第一场到最后一场）
r4['seq'] = range(1, len(r4) + 1)
train_curve = 10000 * np.cumprod(1 + r4['ret'].values)          # 实际训练复利
market_curve = 10000 * np.cumprod(1 + r4['range_ret'].values)   # 满仓躺平吃区间复利

fig, ax = plt.subplots(figsize=(14, 7), dpi=150)
ax.plot(r4['seq'], train_curve, color='#e63946', lw=2.2, label=f'训练收益（实际交易）→ 终值 {train_curve[-1]:,.0f}')
ax.plot(r4['seq'], market_curve, color='#457b9d', lw=1.8, alpha=0.9,
        label=f'区间收益（满仓躺平）→ 终值 {market_curve[-1]:,.0f}')
ax.axhline(10000, color='#888', lw=0.8, ls='--', alpha=0.6)

ax.set_yscale('log')
ax.set_yticks([1e4, 1e5, 1e6, 1e7, 1e8, 1e9])
ax.get_yaxis().set_major_formatter(matplotlib.ticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))

ax.set_xlabel('训练场次（第 1 → 123 场）')
ax.set_ylabel('累计资金（起始 10,000，对数轴）')
ax.set_title('第4轮 · 训练收益 vs 区间收益 累计复利曲线（n=123）')
ax.legend(loc='upper left', fontsize=11, framealpha=0.9)
ax.grid(alpha=0.25, which='both')

# 标注终值
ax.annotate(f'{train_curve[-1]:,.0f}', xy=(r4['seq'].iloc[-1], train_curve[-1]),
            xytext=(-90, 10), textcoords='offset points', color='#e63946', fontsize=12, fontweight='bold')
ax.annotate(f'{market_curve[-1]:,.0f}', xy=(r4['seq'].iloc[-1], market_curve[-1]),
            xytext=(-100, 8), textcoords='offset points', color='#457b9d', fontsize=12, fontweight='bold')

plt.tight_layout()
plt.savefig('第4轮_收益曲线.png', dpi=150, bbox_inches='tight')
print(f'已保存 第4轮_收益曲线.png | 训练终值 {train_curve[-1]:,.0f} | 躺平终值 {market_curve[-1]:,.0f}')

# 附：线性轴版本（前段细节更清楚）
fig2, ax2 = plt.subplots(figsize=(14, 7), dpi=150)
ax2.plot(r4['seq'], train_curve, color='#e63946', lw=2.2, label=f'训练收益（实际交易）→ {train_curve[-1]:,.0f}')
ax2.plot(r4['seq'], market_curve, color='#457b9d', lw=1.8, alpha=0.9, label=f'区间收益（满仓躺平）→ {market_curve[-1]:,.0f}')
ax2.axhline(10000, color='#888', lw=0.8, ls='--', alpha=0.6)
ax2.set_xlabel('训练场次（第 1 → 123 场）')
ax2.set_ylabel('累计资金（起始 10,000，线性轴）')
ax2.set_title('第4轮 · 训练收益 vs 区间收益（线性轴）')
ax2.legend(loc='upper left', fontsize=11, framealpha=0.9)
ax2.grid(alpha=0.25)
ax2.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
plt.tight_layout()
plt.savefig('第4轮_收益曲线_线性.png', dpi=150, bbox_inches='tight')
print('已保存 第4轮_收益曲线_线性.png')
