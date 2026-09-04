"""探查爆竹K线导出数据的结构与数据质量"""
import pandas as pd

FILE = 'data/训练数据报告_20260903_130650(1).xls'

def parse_sheet(name):
    """解析一个 sheet：返回训练记录列表（汇总头 + 操作明细）"""
    df = pd.read_excel(FILE, sheet_name=name, header=None)
    records = []
    cur = None
    for _, row in df.iterrows():
        c0 = str(row[0]).strip() if pd.notna(row[0]) else ''
        if c0.startswith('训练记录'):
            cur = {
                'sheet': name,
                'idx': c0,
                'code': str(row[1]),
                'name': row[2],
                'start': str(row[4]),
                'end': str(row[5]),
                'start_coins': row[6],
                'ret': row[7],
                'range_ret': row[8],
                'observe_days': row[10],
                'hold_days': row[11],
                'heavy_days': row[12],
                'open_count': row[13],
                'win_count': row[14],
                'ops': [],
            }
            records.append(cur)
        elif cur is not None and c0 == '' and pd.notna(row[1]):
            cur['ops'].append({
                'date': str(row[1]),
                'side': str(row[2]).strip(),
                'pos': row[3],
                'buy_price': row[4],
                'sell_price': row[5],
            })
    return records

all_records = []
sheets = pd.read_excel(FILE, sheet_name=None, header=None).keys()
for s in sheets:
    rs = parse_sheet(s)
    print(f'sheet [{s}]: {len(rs)} 场训练')
    all_records.extend(rs)

print(f'\n总计: {len(all_records)} 场训练')

# 数据质量探查
op_sides = {}
unfinished = []
for r in all_records:
    for op in r['ops']:
        op_sides[op['side']] = op_sides.get(op['side'], 0) + 1
    if r['ops'] and r['ops'][-1]['side'] == '买入':
        unfinished.append(r)
print(f'\n操作类型分布: {op_sides}')
print(f'\n最后一笔为买入（未平仓结束）的训练: {len(unfinished)} 场')
for r in unfinished[:10]:
    last = r['ops'][-1]
    print(f"  {r['sheet']} {r['idx']} {r['code']} {r['name']} {r['start']}~{r['end']} 最后买入 {last['date'][:10]} @{last['buy_price']} 仓{last['pos']}")

# 仓位值分布
pos_vals = {}
for r in all_records:
    for op in r['ops']:
        pos_vals[op['pos']] = pos_vals.get(op['pos'], 0) + 1
print(f'\n仓位值分布: {pos_vals}')

# 收益分布速览
rets = [r['ret'] for r in all_records if pd.notna(r['ret'])]
print(f'\n训练收益: 均值 {sum(rets)/len(rets):.4f} 中位 {sorted(rets)[len(rets)//2]:.4f} 最大 {max(rets):.4f} 最小 {min(rets):.4f}')
wins = sum(1 for x in rets if x > 0)
print(f'胜率: {wins}/{len(rets)} = {wins/len(rets):.1%}')

# 训练心得有内容吗
notes = [r for r in all_records if r.get('note')]
tips = [(r['sheet'], r['idx'], r.get('note')) for r in all_records if pd.notna(r.get('note'))] if False else None
