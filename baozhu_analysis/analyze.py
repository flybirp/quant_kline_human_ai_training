"""爆竹K线操作记录分析：单笔交易配对 + 行为画像 + 结论输出
规则：买入后未平仓即结束的训练，用「波段结束日」收盘价计算该笔盈亏（价格取自本地前复权 CSV）。
"""
import csv
import os
from datetime import datetime

import pandas as pd

FILE = 'data/训练数据报告_20260903_130650(1).xls'
DATA_DIR = '/Users/flybirp/Documents/mainland_data_2014'

# ---------- 解析 ----------

def parse_sheet(name):
    df = pd.read_excel(FILE, sheet_name=name, header=None)
    records, cur = [], None
    for _, row in df.iterrows():
        c0 = str(row[0]).strip() if pd.notna(row[0]) else ''
        if c0.startswith('训练记录'):
            cur = {
                'sheet': name, 'idx': c0,
                'code': str(row[1]).zfill(6), 'name': row[2],
                'start': str(row[4]), 'end': str(row[5]),
                'ret': row[7], 'range_ret': row[8],
                'observe_days': row[10], 'hold_days': row[11], 'heavy_days': row[12],
                'open_count': row[13], 'win_count': row[14],
                'ops': [],
            }
            records.append(cur)
        elif cur is not None and c0 == '' and pd.notna(row[1]):
            cur['ops'].append({
                'date': str(row[1])[:10],
                'side': str(row[2]).strip(),
                'pos': float(row[3]) if pd.notna(row[3]) else None,
                'buy_price': float(row[4]) if pd.notna(row[4]) and row[4] else None,
                'sell_price': float(row[5]) if pd.notna(row[5]) and row[5] else None,
            })
    return records

# ---------- 行情查询（前复权 CSV） ----------

_price_cache = {}

def load_daily(code):
    if code not in _price_cache:
        path = os.path.join(DATA_DIR, f'{code}.csv')
        rows = []
        if os.path.exists(path):
            with open(path, newline='') as f:
                for r in csv.reader(f):
                    if r and r[0][:2] in ('19', '20'):
                        rows.append((r[0], float(r[2])))  # date, close
        _price_cache[code] = rows
    return _price_cache[code]

def close_on_or_before(code, date):
    """date（YYYY-MM-DD）当日或之前最近交易日的收盘价"""
    daily = load_daily(code)
    best = None
    for d, c in daily:
        if d <= date:
            best = c
        else:
            break
    return best

def to_iso(s):
    return f'{s[:4]}-{s[4:6]}-{s[6:8]}'

# ---------- 交易配对（FIFO；未平仓用波段结束日收盘价） ----------

def pair_trades(rec):
    trades = []
    queue = []  # [ [buy_price, pos_remaining, buy_date, first_buy] ]
    for op in rec['ops']:
        if op['side'] == '买入' and op['buy_price']:
            queue.append([op['buy_price'], op['pos'], op['date'], True])
        elif op['side'] == '平仓' and op['sell_price']:
            remaining = op['pos'] or 1.0
            sell = op['sell_price']
            while remaining > 1e-9 and queue:
                head = queue[0]
                take = min(head[1], remaining)
                buy = head[0]
                trades.append({
                    'code': rec['code'], 'name': rec['name'],
                    'buy_date': head[2], 'sell_date': op['date'],
                    'buy': buy, 'sell': sell,
                    'pnl_pct': (sell - buy) / buy,
                    'weight': take, 'closed': True,
                    'sheet': rec['sheet'], 'idx': rec['idx'],
                })
                head[1] -= take
                remaining -= take
                if head[1] <= 1e-9:
                    queue.pop(0)
    # 未平仓：按波段结束日收盘价估值
    if queue:
        end_iso = to_iso(rec['end'])
        end_close = close_on_or_before(rec['code'], end_iso)
        if end_close is None:
            end_close = queue[-1][0]  # 行情缺失兜底：按成本价计（盈亏 0）
        for head in queue:
            buy = head[0]
            trades.append({
                'code': rec['code'], 'name': rec['name'],
                'buy_date': head[2], 'sell_date': end_iso,
                'buy': buy, 'sell': end_close,
                'pnl_pct': (end_close - buy) / buy,
                'weight': head[1], 'closed': False,
                'sheet': rec['sheet'], 'idx': rec['idx'],
            })
    for t in trades:
        d1 = datetime.strptime(t['buy_date'], '%Y-%m-%d')
        d2 = datetime.strptime(t['sell_date'], '%Y-%m-%d')
        t['hold_days'] = (d2 - d1).days
        t['year'] = t['buy_date'][:4]
    return trades

# ---------- 主流程 ----------

def main():
    sheets = pd.read_excel(FILE, sheet_name=None, header=None).keys()
    records = []
    for s in sheets:
        records.extend(parse_sheet(s))

    all_trades = []
    for rec in records:
        all_trades.extend(pair_trades(rec))

    tdf = pd.DataFrame(all_trades)
    sdf = pd.DataFrame(records)
    tdf.to_csv('trades.csv', index=False)
    sdf.drop(columns=['ops']).to_csv('sessions.csv', index=False)

    print(f'训练场次: {len(records)}  配对交易: {len(tdf)} 笔（其中持有到期 {sum(~tdf.closed)} 笔）')

    # ===== 1. 轮次总览 =====
    print('\n===== 轮次总览 =====')
    for sheet, g in sdf.groupby('sheet', sort=False):
        rets = g['ret'].dropna()
        print(f'{sheet:12s} {len(g):4d} 场 | 场均 {rets.mean():+.2%} | 胜率 {(rets>0).mean():.0%} | 累计复利 '
              f'{(1+rets).prod():.1f}x')

    # ===== 2. 单笔交易统计 =====
    print('\n===== 单笔交易统计（FIFO 配对，未平仓按波段结束日计） =====')
    win = tdf[tdf.pnl_pct > 0]
    loss = tdf[tdf.pnl_pct <= 0]
    print(f'总笔数 {len(tdf)} | 胜率 {len(win)/len(tdf):.1%}')
    print(f'平均盈利 {win.pnl_pct.mean():+.2%} / 平均亏损 {loss.pnl_pct.mean():+.2%} | 盈亏比 {abs(win.pnl_pct.mean()/loss.pnl_pct.mean()):.2f}')
    print(f'中位持仓 {tdf.hold_days.median():.0f} 天 | 平均持仓 {tdf.hold_days.mean():.0f} 天')

    # ===== 3. 持有到期 vs 正常平仓 =====
    print('\n===== 持有到期（未平仓结束）vs 正常平仓 =====')
    for label, g in [('正常平仓', tdf[tdf.closed]), ('持有到期', tdf[~tdf.closed])]:
        print(f'{label}: {len(g)} 笔 | 胜率 {(g.pnl_pct>0).mean():.1%} | 平均 {g.pnl_pct.mean():+.2%} | 中位 {g.pnl_pct.median():+.2%}')

    # ===== 4. 持仓天数 vs 收益 =====
    print('\n===== 持仓时长分层（按持有天数） =====')
    bins = [0, 5, 10, 20, 40, 80, 10000]
    labels = ['≤5天', '6-10天', '11-20天', '21-40天', '41-80天', '>80天']
    tdf['hold_bucket'] = pd.cut(tdf.hold_days, bins=bins, labels=labels)
    for b, g in tdf.groupby('hold_bucket', observed=True):
        print(f'{b:8s} {len(g):4d} 笔 | 胜率 {(g.pnl_pct>0).mean():.0%} | 平均 {g.pnl_pct.mean():+.2%} | 中位 {g.pnl_pct.median():+.2%}')

    # ===== 5. 仓位行为（1 仓一把梭 vs 0.5 分批） =====
    print('\n===== 单笔仓位（买入时仓位比例） =====')
    for pos, g in tdf.groupby('weight'):
        print(f'仓位 {pos}: {len(g)} 笔 | 胜率 {(g.pnl_pct>0).mean():.0%} | 平均 {g.pnl_pct.mean():+.2%}')

    # ===== 6. 加仓模式：同场多笔买入 =====
    print('\n===== 场内买入笔数 vs 场次收益 =====')
    sdf['buy_count'] = [sum(1 for o in r['ops'] if o['side'] == '买入') for r in records]
    for n, g in sdf.groupby('buy_count'):
        print(f'买入 {n} 笔: {len(g)} 场 | 场均收益 {g.ret.mean():+.2%} | 胜率 {(g.ret>0).mean():.0%}')

    # ===== 7. Top 盈亏 =====
    print('\n===== 单笔 Top5 盈利 / Top5 亏损 =====')
    cols = ['code', 'name', 'buy_date', 'sell_date', 'pnl_pct', 'hold_days', 'closed']
    print(tdf.nlargest(5, 'pnl_pct')[cols].to_string(index=False))
    print()
    print(tdf.nsmallest(5, 'pnl_pct')[cols].to_string(index=False))

    # ===== 8. 年度分布 =====
    print('\n===== 年度分布（按买入年） =====')
    for y, g in tdf.groupby('year'):
        print(f'{y}: {len(g):4d} 笔 | 胜率 {(g.pnl_pct>0).mean():.0%} | 平均 {g.pnl_pct.mean():+.2%}')

    # ===== 9. 跑赢区间 =====
    print('\n===== 跑赢区间率（场次级：训练收益 vs 区间收益） =====')
    valid = sdf.dropna(subset=['ret', 'range_ret'])
    print(f'{(valid.ret > valid.range_ret).mean():.1%} ({(valid.ret > valid.range_ret).sum()}/{len(valid)})')

    # ===== 10. 行为画像 =====
    print('\n===== 行为画像 =====')
    print(f'平均观望天数 {sdf.observe_days.mean():.0f} | 平均持仓天数 {sdf.hold_days.mean():.0f} | 平均重仓天数 {sdf.heavy_days.mean():.0f}')
    total_days = (sdf.observe_days + sdf.hold_days).replace(0, 1)
    print(f'平均持仓时间占比 {(sdf.hold_days / total_days).mean():.0%}')
    n_open = sdf.groupby('open_count')['ret'].agg(['count', 'mean'])
    print('\n开仓次数 vs 场均收益:')
    print(n_open.to_string())

if __name__ == '__main__':
    main()
