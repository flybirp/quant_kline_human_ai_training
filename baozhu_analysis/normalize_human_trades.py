#!/usr/bin/env python3
"""L0.1 数据层：人工交易统一 schema 落库 + 清洗对账报告

复用 analyze.py 的 FIFO 配对（843 笔），字段清洗（代码 6 位防丢零、日期统一、
weight 0~1、轮次规范），重建决策时上下文（barsCsv + 8 形态特征 + 持有段摘要），
计算后验结果（pnlPct / postTrade10/20/60 / estimated）。

输出：
- trades-unified.jsonl         统一交易（一行一交易，h- 前缀）
- trades-unified-report.md     清洗对账报告

口径说明（与训练页对齐）：
- 成交价 = 当日收盘价（对齐 Training.tsx / limit.ts「执行价即当日收盘」）；
  涨跌停判定复刻 limit.ts limitStateOf（涨停禁买 / 跌停禁卖）。
- barsCsv：该股「数据起点 → buy_date（含）」的全量历史算 MA5/20/60 与量比，
  再截最后 60 根（含 buy_date 当根）——对齐 Training.tsx buildAiRows(dailyBars).slice(-N)
  的「全量算指标再截窗口」口径；窗口大小 60 遵循 L0.1b/L0.1c。
- features：对「数据起点 → buy_date（含）」全量历史检测（对齐 patternSummaryBlock(allDaily)）。
- postTradeN：卖出成交日后第 N 根收盘价相对卖出价的涨跌幅（%）。
"""
import bisect
import csv
import json
import math
import os
import random
from collections import Counter, defaultdict
from datetime import datetime

import analyze  # 复用 parse_sheet + pair_trades（FIFO 配对 + 未平仓波段结束日估值）
from patterns_py import Bar, pattern_summary_block

os.chdir(os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = analyze.DATA_DIR
OUT_JSONL = 'trades-unified.jsonl'
OUT_REPORT = 'trades-unified-report.md'

SCHEMA_VERSION = 1
WINDOW = 60                # barsCsv 输出窗口根数（含 buy_date 当根）
POST_N = (10, 20, 60)      # postTrade 后续走势根数
GAP_THRESHOLD = 0.001      # 跳空缺口阈值（klineArt.ts 口径）

# 轮次排序（第3轮无配对交易，此处仅覆盖实际出现的轮次）
ROUND_ORDER = {'第1轮': 0, '第2轮': 1, '第3轮': 2, '第4轮': 3, '其他训练': 4}


# ---- 完整行情加载（OHLCV，缓存） ----

_full_cache = {}

def load_full_daily(code):
    if code not in _full_cache:
        path = os.path.join(DATA_DIR, f'{code}.csv')
        bars = []
        if os.path.exists(path):
            with open(path, newline='') as f:
                for r in csv.reader(f):
                    if not r or r[0][:2] not in ('19', '20'):
                        continue
                    try:
                        date = r[0]
                        o, c, h, l, v = (float(r[i]) for i in range(1, 6))
                    except (ValueError, IndexError):
                        continue
                    bars.append(Bar(date, o, h, l, c, v))
        dates = [b.date for b in bars]
        _full_cache[code] = (bars, dates)
    return _full_cache[code]


def idx_on_or_before(dates, date_str):
    """date_str 当日或之前最近交易日的下标；无则 None"""
    i = bisect.bisect_right(dates, date_str) - 1
    return i if i >= 0 else None


# ---- 训练页指标口径复刻 ----

def calc_ma(closes, period):
    """简单移动平均（含当日），与 Training.tsx calcMA 一致"""
    result = [None] * len(closes)
    s = 0.0
    for i, c in enumerate(closes):
        s += c
        if i >= period:
            s -= closes[i - period]
        if i >= period - 1:
            result[i] = s / period
    return result


def build_ai_rows(bars):
    """附加 MA5/20/60 + 阳阴涨跌% + 量比，与 Training.tsx buildAiRows 一致"""
    closes = [b.close for b in bars]
    ma5 = calc_ma(closes, 5)
    ma20 = calc_ma(closes, 20)
    ma60 = calc_ma(closes, 60)
    rows = []
    for i, b in enumerate(bars):
        pct = (b.close - b.open) / b.open if b.open > 0 else 0.0
        prev_vols = [bars[k].volume for k in range(max(0, i - 20), i)]
        avg_vol = sum(prev_vols) / len(prev_vols) if prev_vols else 0.0
        vol_ratio = b.volume / avg_vol if avg_vol > 0 else 1.0
        rows.append((b, ma5[i], ma20[i], ma60[i], pct, vol_ratio))
    return rows


def gap_between(cur, prev):
    if cur.low > prev.high and prev.high > 0:
        return (cur.low - prev.high) / prev.high
    if cur.high < prev.low and prev.low > 0:
        return (cur.high - prev.low) / prev.low
    return 0.0


def gap_summary(bars):
    items = []
    for i in range(1, len(bars)):
        g = gap_between(bars[i], bars[i - 1])
        if g >= GAP_THRESHOLD:
            items.append(f"第{i + 1}根向上跳空 +{g * 100:.1f}%")
        elif g <= -GAP_THRESHOLD:
            items.append(f"第{i + 1}根向下跳空 {g * 100:.1f}%")
    if not items:
        return None
    return f"跳空缺口（相对前一根高低点）：{'；'.join(items)}"


def build_bars_csv(bars):
    """bars = 全量历史（到 buy_date 含）；输出最后 WINDOW 根的 barsCsv 字符串"""
    rows = build_ai_rows(bars)
    if not rows:
        return None
    window = rows[-WINDOW:] if len(rows) >= WINDOW else rows
    n = len(window)
    lines = [
        f"【已揭示K线 · 日线】（最近 {n} 根，从早到晚；涨跌%=较开盘，正=红阳线 负=绿阴线，"
        f"绝对值≈K线实体长度；量比=当根量/前20根均量，>1.5放量 <0.7缩量；"
        f"列：序号,开,高,低,收,涨跌%,量,量比,MA5,MA20,MA60）",
    ]
    for i, (b, ma5, ma20, ma60, pct, vr) in enumerate(window):
        ma5_s = '—' if ma5 is None else f'{ma5:.2f}'
        ma20_s = '—' if ma20 is None else f'{ma20:.2f}'
        ma60_s = '—' if ma60 is None else f'{ma60:.2f}'
        lines.append(
            f"{i + 1},{b.open:.2f},{b.high:.2f},{b.low:.2f},{b.close:.2f},"
            f"{pct * 100:.1f},{int(b.volume + 0.5)},{vr:.2f},{ma5_s},{ma20_s},{ma60_s}"
        )
    gap = gap_summary([b for b, *_ in window])
    if gap:
        lines.append(gap)
    return "\n".join(lines)


# ---- 持有段走势摘要 + postTrade ----

def holding_summary(bars, dates, buy_date, sell_date, buy_price, sell_price):
    """持有段 [买入成交日, 卖出成交日] 走势摘要（full 模式用，非决策时可见）"""
    bi = idx_on_or_before(dates, buy_date)
    si = idx_on_or_before(dates, sell_date)
    if bi is None or si is None or si < bi:
        return None
    closes = [bars[k].close for k in range(bi, si + 1)]
    if not closes:
        return None
    mn = min(closes)
    mx = max(closes)
    # 最大回撤（峰→谷最大跌幅，正数%）
    max_dd = 0.0
    peak = closes[0]
    for c in closes:
        peak = max(peak, c)
        max_dd = max(max_dd, (peak - c) / peak * 100)
    # 最大涨幅（相对买入价）
    max_gain = (mx / buy_price - 1) * 100 if buy_price > 0 else None
    # 收盘价轨迹分位（卖出价在 [min,max] 的位置）
    q = (sell_price - mn) / (mx - mn) if mx > mn else 0.5
    return {
        "maxDrawdown": round(max_dd, 2),
        "maxGain": round(max_gain, 2) if max_gain is not None else None,
        "closeQuantile": round(max(0.0, min(1.0, q)), 4),
    }


def post_trade(bars, dates, sell_date, sell_price, n):
    """卖出成交日后第 N 根收盘价相对卖出价的涨跌幅（%）；数据不足返回 None"""
    si = idx_on_or_before(dates, sell_date)
    if si is None or sell_price <= 0:
        return None
    target = si + n
    if target < len(bars):
        return round((bars[target].close / sell_price - 1) * 100, 2)
    return None


# ---- 涨跌停约束（复刻 web/src/lib/limit.ts，与训练页完全一致） ----

def _round2(x):
    """模拟 JS Math.round(x*100)/100（四舍五入到分）"""
    return math.floor(x * 100 + 0.5) / 100


def limit_pct_of(code):
    """涨跌幅档位：创业板/科创板 20%，主板 10%（对齐 limit.ts limitPctOf）"""
    return 0.2 if code[:3] in ('300', '301', '688') else 0.1


def limit_state_of(bars, idx, code):
    """收盘涨跌停判定（对齐 limit.ts limitStateOf）。

    以收盘价为唯一口径：涨停价/跌停价 = round(前收×(1±幅度), 2)，容差 0.001。
    返回 'up'（收盘涨停，禁买）/ 'down'（收盘跌停，禁卖）/ None（正常或上市首日）。
    """
    if idx is None or idx <= 0 or idx >= len(bars):
        return None
    prev = bars[idx - 1].close
    cur = bars[idx].close
    if prev <= 0:
        return None
    pct = limit_pct_of(code)
    up_price = _round2(prev * (1 + pct))
    down_price = _round2(prev * (1 - pct))
    if cur >= up_price - 0.001:
        return 'up'
    if cur <= down_price + 0.001:
        return 'down'
    return None


# ---- 轮次规范化 ----

def round_of(sheet):
    """'第X轮-进行中' → '第X轮'；'其他训练' 保持原样"""
    if sheet.startswith('第') and '轮' in sheet:
        return sheet.split('轮')[0] + '轮'
    return sheet


def idx_num(idx):
    digits = ''.join(ch for ch in str(idx) if ch.isdigit())
    return int(digits) if digits else 0


def round_sort_key(rnd):
    return (ROUND_ORDER.get(rnd, 99), rnd)


# ---- 单笔 unified 构建 ----

def build_unified(t, rnd, seq):
    code = t['code']
    buy_date = t['buy_date']
    sell_date = t['sell_date']
    estimated = not t['closed']

    bars, dates = load_full_daily(code)
    bi = idx_on_or_before(dates, buy_date)
    si = idx_on_or_before(dates, sell_date)

    # 成交价口径 = 当日收盘价（与 Training.tsx / limit.ts「执行价即当日收盘」完全一致）
    buy_price = bars[bi].close if bi is not None else t['buy']

    # 涨跌停状态（复刻 limit.ts limitStateOf）：涨停禁买 / 跌停禁卖
    buy_limit = limit_state_of(bars, bi, code) if bi is not None else None
    sell_limit = limit_state_of(bars, si, code) if si is not None else None

    # 跌停日无法卖出 → 正常平仓若遇收盘跌停，顺延到下一交易日成交
    actual_sell_date = sell_date
    actual_si = si
    sell_deferred = False
    if (not estimated) and si is not None and sell_limit == 'down' and si + 1 < len(bars):
        actual_si = si + 1
        actual_sell_date = bars[actual_si].date
        sell_deferred = True
        sell_limit = limit_state_of(bars, actual_si, code)

    sell_price = bars[actual_si].close if actual_si is not None else t['sell']
    pnl_pct = (sell_price / buy_price - 1) if buy_price > 0 else 0.0

    if bi is not None:
        hist = bars[:bi + 1]  # 决策时可见历史 = 数据起点 → buy_date（含）
        bars_csv = build_bars_csv(hist)
        features = pattern_summary_block(hist) or []
        hs = holding_summary(bars, dates, buy_date, actual_sell_date, buy_price, sell_price)
    else:
        bars_csv = None
        features = []
        hs = None

    # 卖出时点形态（补 L0.1b 缺口：此前只有买入侧形态，timing/risk 评离场时无据可依，
    # 只能对着持有段摘要「算账」——新版本 d24~d29 的退出结论也需要卖出时点证据才能用上）
    sell_features = []
    if actual_si is not None and actual_si + 1 >= 40:
        sell_features = pattern_summary_block(bars[:actual_si + 1]) or []

    hold_days = t['hold_days']
    if sell_deferred:
        hold_days = (datetime.strptime(actual_sell_date, '%Y-%m-%d')
                     - datetime.strptime(buy_date, '%Y-%m-%d')).days

    outcome = {
        'pairedSellDate': actual_sell_date,
        'pairedSellPrice': round(sell_price, 2),
        'pnlPct': round(pnl_pct * 100, 2),
        'holdDays': hold_days,
        'estimated': estimated,
        'buyLimitState': buy_limit,
        'sellLimitState': sell_limit,
        'sellDeferred': sell_deferred,
    }
    for n in POST_N:
        outcome[f'postTrade{n}'] = post_trade(bars, dates, actual_sell_date, sell_price, n)

    return {
        'id': f"h-{rnd}-{seq:04d}",
        'source': 'human',
        'schemaVersion': SCHEMA_VERSION,
        'round': rnd,
        'sessionId': None,
        'code': code,
        'stockName': t['name'],
        'side': 'buy',
        'date': buy_date,
        'price': round(buy_price, 2),
        'weight': round(float(t['weight']), 4),
        'context': {
            'barsCsv': bars_csv,
            'features': features,
            'sellFeatures': sell_features,
            'holdingSummary': hs,
            'reconstructed': True,
            'aiReason': None,
            'aiPrompt': None,
        },
        'outcome': outcome,
    }


# ---- 抽查（L0.1c） ----

def spot_check(unified, k=10):
    """抽 k 笔可重建上下文的交易，核对 barsCsv 窗口/价格/postTrade"""
    rebuildable = [u for u in unified if u['context']['barsCsv']]
    random.seed(42)
    sample = random.sample(rebuildable, min(k, len(rebuildable)))
    sample.sort(key=lambda u: (u['round'], u['date']))
    lines = []
    for u in sample:
        bars, dates = load_full_daily(u['code'])
        bi = idx_on_or_before(dates, u['date'])
        si = idx_on_or_before(dates, u['outcome']['pairedSellDate'])
        # barsCsv 数据行数（跳过标题行 + 可能的 gap 行）
        csv_lines = u['context']['barsCsv'].split('\n')
        data_rows = [ln for ln in csv_lines[1:] if ln and not ln.startswith('跳空缺口')]
        last_cols = data_rows[-1].split(',')
        last_close = float(last_cols[4])
        # postTrade 校验用：卖出后第 N 根日期/收盘
        pt_detail = []
        for n in POST_N:
            val = u['outcome'][f'postTrade{n}']
            if val is not None and si is not None and si + n < len(bars):
                pt_detail.append(
                    f"postTrade{n}={val}%（第{n}根 {bars[si + n].date} 收 {bars[si + n].close:.2f}）"
                )
            else:
                pt_detail.append(f"postTrade{n}=None")
        lines.append(
            f"- {u['id']} | {u['code']} {u['stockName']} | 买 {u['date']} @{u['price']} | "
            f"卖 {u['outcome']['pairedSellDate']} @{u['outcome']['pairedSellPrice']} | pnl {u['outcome']['pnlPct']}%"
            f" | barsCsv {len(data_rows)} 行、末行收盘 {last_close:.2f}（应≈买入价 {u['price']}）"
        )
        lines.append(f"    - {'；'.join(pt_detail)}")
        lines.append(f"    - features({len(u['context']['features'])}): "
                     f"{' / '.join(u['context']['features'][:3]) or '无命中'}")
    return lines


# ---- 报告 ----

def build_report(unified, records, all_trades):
    L = []
    total = len(unified)

    # 轮次分布
    round_counter = Counter(u['round'] for u in unified)
    L.append('# 人工交易统一落库 · 清洗对账报告（L0.1）\n')
    L.append(f'- 总笔数：**{total}**（FIFO 配对，与 analyze.py 口径一致）')
    L.append(f'- schemaVersion：{SCHEMA_VERSION}')
    L.append(f'- 轮次分布：' + '，'.join(
        f"{r}={round_counter[r]}" for r in sorted(round_counter, key=round_sort_key)))
    L.append('')

    # 字段清洗对账
    L.append('## 字段清洗对账\n')
    # 脏代码（非有效 A 股代码）
    bad_codes = ['00SIMO', '00BAOS', '000nan', '399013']
    bad_n = sum(1 for u in unified if u['code'] in bad_codes)
    L.append(f'- 代码 6 位防丢零：已 `zfill(6)`。**脏代码 {bad_n} 笔**（无法映射行情）：'
             f"{', '.join(bad_codes)}（美股/指数/NaN，保留原值、上下文置 null）")
    no_data_codes = ['000822', '000858', '300742', '002740', '000828', '002308',
                     '600823', '000422', '000877', '603603', '600898', '000839', '600277']
    no_data_n = sum(1 for u in unified if u['code'] in no_data_codes)
    L.append(f'- 有效代码但本地无行情：**{no_data_n} 笔**（退市股/2014 前上市但目录缺失），'
             f'同样上下文置 null')
    # 日期
    years = Counter(u['date'][:4] for u in unified)
    pre2014 = sum(c for y, c in years.items() if int(y) < 2014)
    L.append(f'- 买入年份分布：' + '，'.join(f"{y}={years[y]}" for y in sorted(years)))
    L.append(f'- 其中 **{pre2014} 笔买入早于 2014**（数据目录起点 2014-01-02，无法重建）')
    # weight
    wc = Counter(u['weight'] for u in unified)
    L.append('- weight 分布（0~1）：' + '，'.join(f"{w}={wc[w]}" for w in sorted(wc)))
    L.append('')

    # 上下文重建对账
    L.append('## 上下文重建对账\n')
    with_csv = sum(1 for u in unified if u['context']['barsCsv'])
    with_feat = sum(1 for u in unified if u['context']['features'])
    with_hs = sum(1 for u in unified if u['context']['holdingSummary'])
    short_window = 0
    for u in unified:
        if u['context']['barsCsv']:
            rows = [ln for ln in u['context']['barsCsv'].split('\n')[1:]
                    if ln and not ln.startswith('跳空缺口')]
            if len(rows) < WINDOW:
                short_window += 1
    L.append(f'- barsCsv 可重建：**{with_csv}/{total}**；features 有命中：{with_feat}；'
             f'holdingSummary 可用：{with_hs}')
    L.append(f'- barsCsv 窗口 < {WINDOW} 根（数据起点附近）：{short_window} 笔')
    feat_counter = Counter()
    for u in unified:
        for f in u['context']['features']:
            # 形态名 = "N根前 底背离✓" 的第 2 个 token
            parts = f.split(' ', 1)
            feat_counter[parts[1].split('：')[0] if len(parts) > 1 else f] += 1
    L.append('- 形态特征命中分布（top）：' + '，'.join(
        f"{k}×{v}" for k, v in feat_counter.most_common(12)))
    L.append('')

    # postTrade 对账
    L.append('## postTrade 后续走势对账\n')
    for pn in POST_N:
        avail = sum(1 for u in unified if u['outcome'][f'postTrade{pn}'] is not None)
        L.append(f'- postTrade{pn} 可用：**{avail}/{total}**（其余为卖出日接近数据末端，第 {pn} 根不足）')
    L.append('')

    # 涨跌停约束对账（limit.ts limitStateOf 口径）
    L.append('## 涨跌停约束对账\n')
    up_buy = sum(1 for u in unified if u['outcome']['buyLimitState'] == 'up')
    down_sell = sum(1 for u in unified if u['outcome']['sellLimitState'] == 'down')
    deferred = sum(1 for u in unified if u['outcome']['sellDeferred'])
    L.append(f'- 涨停日买入（封板挂单无法成交，应被拒绝）：**{up_buy}** 笔')
    L.append(f'- 跌停日卖出（封板挂单无法成交，应被拒绝）：**{down_sell}** 笔')
    if deferred:
        L.append(f'- 跌停日卖出已顺延到下一交易日成交：**{deferred}** 笔'
                 f'（pairedSellDate / 卖出价 / pnl / holdDays / postTrade 均按顺延日重算）')
    L.append('- 口径：`limitStateOf`（涨停/跌停价 = round(前收×(1±幅度),2)、容差 0.001；'
             '创业板/科创板 20%、主板 10%；ST 无字段按非 ST 判定）')
    L.append('')

    # estimated（持有到期）
    L.append('## 持有到期估值对账\n')
    est = sum(1 for u in unified if u['outcome']['estimated'])
    L.append(f'- estimated=true（持有到期按波段结束日收盘估值）：**{est}** 笔；'
             f'正常平仓 {total - est} 笔')
    L.append('')

    # 抽查（L0.1c）
    L.append('## 抽查 10 笔（L0.1c）\n')
    L.append('（barsCsv 末行收盘应≈买入价；postTrade 给出第 N 根日期/收盘可手工复核）\n')
    L.extend(spot_check(unified, 10))
    L.append('')

    return '\n'.join(L)


def main():
    sheets = analyze.pd.read_excel(analyze.FILE, sheet_name=None, header=None).keys()
    records = []
    for s in sheets:
        records.extend(analyze.parse_sheet(s))

    all_trades = []
    for rec in records:
        all_trades.extend(analyze.pair_trades(rec))

    # sanity：与 analyze.py 输出对账
    assert len(all_trades) == 843, f"配对笔数异常: {len(all_trades)}"
    assert sum(1 for t in all_trades if not t['closed']) == 175, "持有到期笔数异常"

    # 轮次分组排序，生成 id 序号
    by_round = defaultdict(list)
    for t in all_trades:
        by_round[round_of(t['sheet'])].append(t)

    unified = []
    for rnd in sorted(by_round, key=round_sort_key):
        ts = sorted(by_round[rnd], key=lambda t: (t['buy_date'], idx_num(t['idx']), t['sell_date']))
        for seq, t in enumerate(ts, start=1):
            unified.append(build_unified(t, rnd, seq))

    # 写 jsonl（一行一交易）
    with open(OUT_JSONL, 'w', encoding='utf-8') as f:
        for u in unified:
            f.write(json.dumps(u, ensure_ascii=False) + '\n')

    # 写报告
    report = build_report(unified, records, all_trades)
    with open(OUT_REPORT, 'w', encoding='utf-8') as f:
        f.write(report + '\n')

    print(f"已写入 {OUT_JSONL}：{len(unified)} 笔")
    print(f"已写入 {OUT_REPORT}")
    print()
    print(report)


if __name__ == '__main__':
    main()
