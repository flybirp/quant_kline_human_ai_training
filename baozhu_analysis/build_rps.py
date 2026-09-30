#!/usr/bin/env python3
"""预计算全市场 RPS 分位（对齐 quant_discover d15 口径）。

口径（docs/discover_15_RPS相对强度.md）：
  rel_ret_120d = 个股 120 日收益 − 中证1000 同期收益（指数按日期 reindex + ffill 对齐）
  RPS 分位     = 按 base_date 当日**全市场**对 rel_ret_120d 排名的百分位（0~99，高=强）

唯一稳定结论（d15）：横盘（consolidation）场景分组单调递增且分年 10/10 稳定——
  RPS<20 最弱（胜率 44.9%）→ 50-80（50.8%）→ RPS≥80 最优（约 +11.3pct）。
  买点选 RPS 高的（强势中继），回避 RPS 低的（弱势停顿）。
  ⚠️ 对超跌类（base_break/zfzs/spike）无增强作用，不要跨形态复用。

输出：server/data/rps/{code}.csv —— 每行 `date,rps`（rps 为 0~99 整数分位）

用法：
  python3 build_rps.py --limit 200     # 小样本验证
  python3 build_rps.py                 # 全市场（5062 只）
"""
import argparse
import csv
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path('/Users/flybirp/Documents/mainland_data_2014')
INDEX_DIR = Path('/Users/flybirp/Documents/mainland_index_data_2014')
INDEX_FILE = INDEX_DIR / 'zz1000.csv'  # 中证1000（d15 口径）
PERIOD = 120
OUT_DIR = Path(__file__).parent.parent / 'server' / 'data' / 'rps'


def load_prices(path: Path) -> pd.Series:
    """读日线 CSV，返回以 date 为索引的 close 序列（升序）"""
    df = pd.read_csv(path, usecols=['date', 'close'])
    df['date'] = df['date'].astype(str)
    df = df.drop_duplicates('date').sort_values('date')
    return df.set_index('date')['close'].astype(float)


def index_ret_120() -> pd.Series:
    """中证1000 的 120 日收益（按日期 ffill 对齐后供个股 reindex）"""
    idx = load_prices(INDEX_FILE)
    return (idx / idx.shift(PERIOD) - 1.0) * 100.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 只股票（小样本验证）')
    ap.add_argument('--period', type=int, default=PERIOD)
    args = ap.parse_args()

    codes = sorted(p.stem for p in DATA.glob('*.csv'))
    if args.limit:
        codes = codes[: args.limit]
    print(f'股票数: {len(codes)}（period={args.period}d，基准=中证1000）')

    t0 = time.time()
    idx_ret = index_ret_120()

    # 收集 (code_idx, date, rel_ret)，最后统一按 date 算截面分位
    parts = []
    meta = []  # (code, DataFrame index=date)
    for ci, code in enumerate(codes):
        try:
            px = load_prices(DATA / f'{code}.csv')
        except Exception:
            continue
        if len(px) <= args.period:
            continue
        stock_ret = (px / px.shift(args.period) - 1.0) * 100.0
        rel = stock_ret - idx_ret.reindex(stock_ret.index).ffill()
        rel = rel.dropna()
        if rel.empty:
            continue
        meta.append((code, rel))
    print(f'有效股票: {len(meta)}，耗时 {time.time() - t0:.0f}s')

    if not meta:
        print('无有效数据')
        return

    # 拼成大表：date × code 的 rel_ret
    t1 = time.time()
    # sort_index：concat(axis=1) 默认不排序，末行未必是最新交易日
    df = pd.concat([r.rename(code) for code, r in meta], axis=1).sort_index()
    print(f'截面表: {df.shape[0]} 个交易日 × {df.shape[1]} 只股票，耗时 {time.time() - t1:.0f}s')

    # 逐日截面百分位（0~99，高=强；NaN 不计入排名）
    t2 = time.time()
    rps = df.rank(axis=1, pct=True, na_option='keep') * 99.0
    rps = rps.round().astype('Int64')  # 可空整数，保留 NaN
    print(f'分位计算完成，耗时 {time.time() - t2:.0f}s')

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for code in df.columns:
        col = rps[code].dropna()
        if col.empty:
            continue
        with open(OUT_DIR / f'{code}.csv', 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            for d, v in col.items():
                w.writerow([d, int(v)])
        written += 1
    print(f'写出 {written} 只股票的 RPS 序列 → {OUT_DIR}，总耗时 {(time.time() - t0) / 60:.1f} 分钟')

    # 自检：抽一只打印最近 5 行 + 全市场分位分布
    sample = df.columns[0]
    col = rps[sample].dropna()
    print(f'\n自检 {sample} 最近 5 个交易日 RPS:')
    print(col.tail(5).to_string())
    today = df.index[-1]
    print(f'\n全市场 {today} 的 RPS 分布（应为近似均匀 0~99）:')
    print(rps.loc[today].dropna().describe()[['mean', '25%', '50%', '75%']].to_string())


if __name__ == '__main__':
    main()
