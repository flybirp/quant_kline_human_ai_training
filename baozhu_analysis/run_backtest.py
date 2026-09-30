#!/usr/bin/env python3
"""纯后端 pred_and_wait 训练回放（A/B 双盲对照用）。

为什么需要：A 组历史记录是 pred_wait + image（图表截图）模式，截图由前端渲染，脚本
无法复现。解法是**两组都用同一套后端回放重跑**，唯一变量是风控指引——内部可比、
可做配对检验（同股票同时段）、可批量可重复。

与前端对齐的部分：
- ai_mode = pred_and_wait（预测 → 触发器 → 唤醒 → 对账 → 修订/重预测），移植自 predWait.ts
- 上下文：60 根日线 CSV + 市场统计 + 形态特征（patterns_py，与 patterns.ts 200/200 对账一致）
  + RPS 分位 + 持仓时的【持有与卖出】块（移植自 exitGuide.ts）
- 交易：份数仓位、手续费/滑点/印花税、收盘价成交、涨跌停约束

与前端的差异（为可复现而简化）：
- kline_mode 固定为 csv（image 需前端渲染，无法复现）
- 不含周线/月线块与交易纪律记忆（discipline），其余口径一致

用法：
  python3 run_backtest.py --codes 603075,600926 --arm both
  python3 run_backtest.py --sample 8 --arm both
  python3 run_backtest.py --codes 603075 --arm B
结果追加写入 baozhu_analysis/backtest_records.jsonl（不污染 server/data/records.json）
"""
import argparse
import csv
import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from patterns_py import Bar, pattern_summary_block, atr_pct  # noqa: E402
from weekly_state import weekly_state_block  # noqa: E402

DATA = Path('/Users/flybirp/Documents/mainland_data_2014')
RPS_DIR = ROOT / 'server' / 'data' / 'rps'
API = 'http://localhost:8787/api/ai/decide'
OUT = HERE / 'backtest_records.jsonl'

EXP_TAG = 'bars101'   # 实验标记（--tag 覆盖），写入 meta

# 是否注入【周线状态】块（「周线定方向 + 日线找入场点」实验的自变量，--weekly 开启）
# 对照：同 arm 不开；实验：同 arm 开启 → 唯一变量即该状态块
WITH_WEEKLY = False

WARMUP = 30
DECISION_BARS = 101   # 默认与训练系统一致；--bars 可覆盖（长窗口实验用 200+）
WINDOW = 60
INITIAL_CAPITAL = 1_000_000
POSITIONS = 2
FEE_RATE = 0.0003
SLIPPAGE = 0.0001
STAMP_TAX = 0.001
HORIZON_MIN, HORIZON_MAX = 3, 15   # 对齐 aiSettings.loadAiHorizon 默认值
SIDEWAYS_THRESHOLD = 0.005

# ==================== A/B 唯一变量：风控指引 ====================
RISK_GUIDE_A = """以下持仓纪律基于 A 股 12 年全市场统计先验，与任何建仓风格兼容，应严格执行：
- 突破/买入后10日确认期：回撤<3%=强势，坚定持有；回撤≥8%=隐性失败，减仓处理；跌回启动平台=确认失败，清仓。不能只看"是否跌破平台"二分。
- 向上跳空缺口是持有锚：收盘回补缺口立即离场（历史未回补组+18%/已回补组-10%，分野28pct）。
- 止损位设定：跌破型买点设在跌破日最低价；支撑假跌破收回（spring）设在 spring 最低价而非支撑位。
- 盈利时不急于兑现：统计上21~80天是波段甜蜜区，趋势完好时让利润奔跑，用回撤深度而非涨幅决定减仓。
- 开仓熔断（硬规则）：本局内同方向止损≥3次即停止入场，直到出现区间突破或深跌出清确认信号；震荡市中MA20是噪音线，把止损设在区间边界或结构位，不要设在MA20。"""

RISK_GUIDE_B = """[EXIT:v2] 以下持仓纪律基于 A 股 12 年全市场统计先验（quant_discover d24~d29 持有与卖出研究），与任何建仓风格兼容，应严格执行：
【风控在仓位，不在止损价】固定百分比止损是负期望的：-5%~-15% 是噪音区，各档 ΔE 全负（腰斩信号 -15% 档仍 -19pct），-5% 档触发率 66~89%，被止损的赢家后续平均还赚 +13~30%；持有期回撤 IC +0.49（12/12 年为正）——浮亏越深越该拿。风险控制请落在单票仓位上限（份数），不要靠价格止损位。
【已被证伪的退出做法，不要使用】固定百分比止损／时间止损（N 天不涨就出，六信号全败）／均线破位退出（卖飞 70%、卖对仅 8%、期望磨掉 87%）／跌破支撑或前低就卖（spring 案例 E 从 8.91 砍到 4.83）／K 线形态逃顶（AUC≈0.5）。退出规则不要叠加（OR 组合是负改进）。
【唯一有效的主动退出】移动止盈 trail：浮盈达 X% 后自最高回落 Y% 卖出，参考档位 腰斩类(30/10)、底背离(20/8)、spring(20/10)、绝望组(20/8)；或干脆持有到期。
【持有期甜点】腰斩/绝望组 90 日（40 日处是坑，勿在此离场）；筑底跌破、底背离 越长越好（180 日仍未吃完，禁止止盈）；spring U 型（20 日可用 → 60 日难受 → 180 日再起）。
【状态语义】浮盈是最强的反向信号（IC -0.44，其中约 3/4 是大盘 beta）——浮盈大时用 trail 锁定、勿因浮盈加仓；回撤越深越该拿（回撤 IC +0.49）。
- 突破/买入后10日确认期：回撤<3%=强势，坚定持有；回撤≥8%=隐性失败，减仓处理；跌回启动平台=确认失败，清仓。
- 向上跳空缺口是持有锚：收盘回补缺口立即离场（历史未回补组+18%/已回补组-10%，分野28pct）。
- 盈利时不急于兑现：趋势完好时让利润奔跑，用回撤深度而非涨幅决定减仓；慢修复型（C组/底背离）禁止止盈。
- 开仓熔断（硬规则）：本局内同方向被迫离场≥3次即停止入场，直到出现区间突破或深跌出清确认信号。"""

STRATEGY = """你采用「出清买点」体系（基于 A 股 12 年全市场统计先验，核心规律：底部质量看出清程度，不看守住没有）：
【优先建仓形态】
1. 腰斩：翻倍后单边腰斩，出清最彻底（⚠ 实操按 90 日 +8~16%/胜率 57~66% 规划，是危机 alpha）。持有按 90 天设计，须承受 -20% 级浮亏，宜分批。
2. 深跌破且量能不缩：跌破支撑 10~15%、跌破日量能不萎缩——20 日 E+14.84%/胜率 79.6%（上界）；最优档是跌破日量比 1.5~2.1 温和放量（E+18.28%/胜率 88.5%），量比>2.1 巨量是最差档（胜率 68%）。持有越长越好，禁止止盈。缩量跌破=无人接盘，回避。
3. 底背离：收盘创新低但量能萎缩于前一低点——60 日 E+7.8%（✅ 全项目唯一年度稳定信号）。持有越长越好，禁止止盈。
4. 深跌后反转：前 20 日跌幅≥30% 时反转信号才可信。
【回避清单】双底颈线突破（46%/39%破底率）、杯柄突破（37.6%）、量比>2.1 巨量、回调段极度缩量（<0.7倍）、前高/颈线假突破带。
【元认知】背景重于形态；量能萎缩=衰竭、放量=消耗；看空天花板远低于做多；等回踩会系统性只等到失败者（回撤<3% 直接上才是强势确认、≥8% 即隐性失败）。"""

SYSTEM_PREDICT = """你是 A 股训练系统里的 AI 交易员，采用「预测等待」模式：先做一次结构化预测，挂好可被程序自动判定的触发条件，然后让市场自己走，直到触发或到期才被唤醒。
{strategy}

【风控指引】（必须遵守）
{risk_guide}

「预测」输出严格 JSON：
{{"horizon":整数({hmin}~{hmax}个交易日),"initial_action":"buy|hold","initial_lots":整数(buy时必填),"bias":"up|down|sideways","expected_range":{{"low":数字,"high":数字}},"triggers":[{{"id":"t1","kind":"break_up|break_down|volume_ratio_gt|volume_ratio_lt|trail","value":数字,"value2":数字(仅trail需要，回落%),"desc":"触发说明"}}],"summary":"50字以内的预测概述"}}
触发器说明：break_up(high>=value)、break_down(low<=value)、volume_ratio_gt/lt(当日量/预测日前20日均量)、trail(浮盈达 value% 后自持仓最高价回落 value2%)。只输出 JSON。"""

SYSTEM_WAKE = """你是 A 股训练系统里的 AI 交易员，处于「预测等待」模式。你刚被触发器或到期唤醒。
{strategy}

【风控指引】（必须遵守）
{risk_guide}

「唤醒」输出严格 JSON：
{{"action":"buy|sell|hold","lots":整数,"reason":"50字以内的决策理由","revised":{{可选，同预测格式，不填则沿用原预测}}}}
只输出 JSON。"""


# ==================== 数据 ====================

def load_bars(code):
    f = DATA / f'{code}.csv'
    if not f.exists():
        return []
    out = []
    with open(f, encoding='utf-8') as fh:
        for i, r in enumerate(csv.reader(fh)):
            if i == 0 or not r or r[0] == 'date':
                continue
            out.append(Bar(date=r[0], open=float(r[1]), close=float(r[2]),
                           high=float(r[3]), low=float(r[4]), volume=float(r[5])))
    return out


def load_rps(code):
    f = RPS_DIR / f'{code}.csv'
    if not f.exists():
        return {}
    with open(f, encoding='utf-8') as fh:
        return {r[0]: int(r[1]) for r in csv.reader(fh) if len(r) >= 2 and r[0]}


def ma(bars, i, n):
    if i + 1 < n:
        return None
    return sum(b.close for b in bars[i - n + 1:i + 1]) / n


def vol_ratio(bars, i):
    if i < 20:
        return None
    avg = sum(b.volume for b in bars[i - 20:i]) / 20
    return bars[i].volume / avg if avg > 0 else None


def limit_state(bars, i):
    if i <= 0 or i >= len(bars):
        return None
    prev, cur = bars[i - 1].close, bars[i].close
    if prev <= 0:
        return None
    up, dn = round(prev * 1.1, 2), round(prev * 0.9, 2)
    if cur >= up - 0.001:
        return 'up'
    if cur <= dn + 0.001:
        return 'down'
    return None


# ==================== 上下文（对齐前端 CSV 模式） ====================

def kline_block(bars, end_idx):
    lines = ['【已揭示K线 · 日线】（最近 60 根，从早到晚；涨跌%=较开盘，正=红阳线 负=绿阴线；'
             '量比=当根量/前20根均量，>1.5放量 <0.7缩量；列：序号,开,高,低,收,涨跌%,量,量比,MA5,MA20,MA60）']
    seg = bars[max(0, end_idx - WINDOW + 1):end_idx + 1]
    start = end_idx - len(seg) + 1
    fmt = lambda v: '—' if v is None else f'{v:.2f}'
    for k, b in enumerate(seg):
        idx = start + k
        chg = (b.close - b.open) / b.open * 100 if b.open else 0
        vr = vol_ratio(bars, idx)
        lines.append(f'{k + 1},{b.open:.2f},{b.high:.2f},{b.low:.2f},{b.close:.2f},{chg:.1f},'
                     f'{int(b.volume)},{fmt(vr)},{fmt(ma(bars, idx, 5))},{fmt(ma(bars, idx, 20))},'
                     f'{fmt(ma(bars, idx, 60))}')
    return '\n'.join(lines)


def exit_guide_block(float_pnl_rate):
    """移植自 web/src/lib/exitGuide.ts（持仓时注入）"""
    lines = ['【持有与卖出】（quant_discover d24~d29，12 年全市场统计；仅在持仓时给出）']
    pnl = float_pnl_rate
    if pnl > 0.2:
        lines.append(f'当前浮盈 +{pnl * 100:.1f}%：浮盈是最强的**反向**状态（IC -0.44，其中约 3/4 是大盘 beta，'
                     f'剔除后 -0.125）；大幅浮盈时应考虑移动止盈而非继续加仓')
    elif pnl > 0:
        lines.append(f'当前浮盈 +{pnl * 100:.1f}%：浮盈为弱反向信号（IC -0.44），可用 trail 锁定，勿因浮盈加仓')
    elif pnl > -0.15:
        lines.append(f'当前浮亏 {pnl * 100:.1f}%：**回撤越深越该拿**（回撤 IC +0.49，12/12 年为正；'
                     f'回撤深组后续 E60 +41.9% vs 浅组 -2.4%），此区间属噪音区，止损是逆向操作')
    else:
        lines.append(f'当前浮亏 {pnl * 100:.1f}%：已超出噪音区（-5%~-15%），若当初是深档信号，统计上仍建议持有'
                     f'（回撤 IC +0.49）；若要安全网，只可设深档灾难保险（-30%~-45%）')
    lines += [
        '',
        '已被统计证伪的退出做法——**不要使用**：',
        '- 固定百分比止损：-5%~-15% 是噪音区，各档 ΔE 全负（腰斩信号 -15% 档仍 -19pct），-5% 档触发率 66~89%，'
        '被止损的赢家后续平均还赚 +13~30%',
        '- 时间止损（N 天不涨就出）：六信号全败，且坑位之后往往正是甜点期',
        '- 均线破位退出（MA20/MA60 跌破卖出）：卖飞率 70%、卖对率仅 8%、20 日内再入场 78%，期望磨掉 87%',
        '- 跌破支撑/前低就卖：失败判定信号 ≠ 退出规则（spring 案例 E 从 8.91 砍到 4.83）',
        '- K 线形态逃顶：形态类特征 AUC 全部 ≈0.5 且年度方向翻转，事前不可识别',
        '',
        '唯一有效的主动退出：**移动止盈 trail**（浮盈达 X% 后自最高点回落 Y% 卖出），参考档位：'
        '腰斩类 trail(30/10)、底背离 trail(20/8)、spring trail(20/10)、绝望组 trail(20/8)；或干脆持有到期。',
        '持有期甜点：腰斩/绝望组 90 日（**40 日是坑，勿在此离场**）；筑底跌破、底背离 越长越好'
        '（180 日仍未吃完，禁止止盈）；spring U 型（20 日可用 → 60 日难受 → 180 日再起）。',
        '风险控制请落在**仓位规模**（单票上限），不要靠价格止损位；退出规则不要叠加（OR 组合是负改进）。',
    ]
    return '\n'.join(lines)


def build_context(bars, idx, rps_map, holding, avg_cost, peak):
    parts = [kline_block(bars, idx)]
    # 市场统计
    b = bars[idx]
    vr = vol_ratio(bars, idx)
    seg = bars[max(0, idx - 19):idx + 1]
    chg20 = (b.close - seg[0].close) / seg[0].close * 100 if seg[0].close else 0
    hi = max(x.high for x in seg)
    dd20 = (hi - min(x.low for x in seg)) / hi * 100 if hi > 0 else 0
    atr = atr_pct(bars, idx)
    lines = ['【市场统计】（基于日线）',
             f'近20根涨跌 {chg20:.1f}%，区间最大回撤 {dd20:.1f}%；量比 '
             f'{vr:.2f}' if vr else '量比 —']
    if atr is not None:
        lines.append(f'日均真实波幅 ATR14 = {atr:.2f}%——这是该股的正常波动基准')
    rps = rps_map.get(b.date)
    if rps is not None:
        note = ('当前属强势组（横盘场景优选）' if rps >= 80 else
                '当前属弱势组（横盘场景应回避）' if rps < 20 else '当前属中间组')
        lines.append(f'相对强度 RPS 分位 {rps}（0~99，高=强）——{note}；⚠️ 只在横盘形态下有效')
    parts.append('\n'.join(lines))
    # 形态特征
    feats = pattern_summary_block(bars[:idx + 1])
    if feats:
        parts.append('【形态特征】（程序按 12 年全市场统计口径逐根判定，仅用已揭示数据；'
                     '先验为历史统计均值，非承诺，供决策参考）\n' + '\n'.join(f'- {f}' for f in feats))
    # 周线状态（实验自变量，--weekly 开启；位置与 TS 侧一致：形态特征之后）
    if WITH_WEEKLY:
        ws = weekly_state_block(bars[:idx + 1])
        if ws:
            parts.append(ws)
    # 持有与卖出（仅持仓）
    if holding and avg_cost > 0:
        parts.append(exit_guide_block((b.close - avg_cost) / avg_cost))
    return '\n\n'.join(parts) + '\n\n'


# ==================== 协议归一化（移植 normalizePrediction） ====================

TRIGGER_KINDS = {'break_up', 'break_down', 'volume_ratio_gt', 'volume_ratio_lt', 'trail'}


def normalize_triggers(raw):
    out = []
    if not isinstance(raw, list):
        return out
    for t in raw:
        if not isinstance(t, dict):
            continue
        kind, value = t.get('kind'), t.get('value')
        if kind not in TRIGGER_KINDS:
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            continue
        trig = {'id': str(t.get('id') or f't{len(out) + 1}'), 'kind': kind, 'value': value,
                'desc': t.get('desc') if isinstance(t.get('desc'), str) else None}
        if kind == 'trail':
            try:
                v2 = float(t.get('value2'))
                trig['value2'] = v2 if v2 > 0 else max(1.0, value / 2)
            except (TypeError, ValueError):
                trig['value2'] = max(1.0, value / 2)
        out.append(trig)
    return out


def normalize_prediction(raw):
    if not isinstance(raw, dict):
        return None
    try:
        horizon = int(round(float(raw.get('horizon', HORIZON_MIN))))
    except (TypeError, ValueError):
        horizon = HORIZON_MIN
    horizon = max(HORIZON_MIN, min(HORIZON_MAX, horizon))
    bias = raw.get('bias') if raw.get('bias') in ('up', 'down', 'sideways') else 'sideways'
    try:
        lots = max(1, int(round(float(raw.get('initial_lots', 1)))))
    except (TypeError, ValueError):
        lots = 1
    er = raw.get('expected_range')
    expected_range = None
    if isinstance(er, dict):
        try:
            expected_range = {'low': float(er['low']), 'high': float(er['high'])}
        except (KeyError, TypeError, ValueError):
            expected_range = None
    return {
        'horizon': horizon,
        'initial_action': 'buy' if raw.get('initial_action') == 'buy' else 'hold',
        'initial_lots': lots,
        'bias': bias,
        'expected_range': expected_range,
        'triggers': normalize_triggers(raw.get('triggers')),
        'summary': str(raw.get('summary') or '')[:80],
    }


# ==================== 触发判定（移植 checkTriggers） ====================

def check_triggers(prediction, bar, base_avg_volume, time_reached, pos):
    hits = []
    for t in prediction.get('triggers', []):
        k, v = t['kind'], t['value']
        if k == 'break_up' and bar.high >= v:
            hits.append((t, f"{t.get('desc') or '上破'}（触及 {v:.2f}）"))
        elif k == 'break_down' and bar.low <= v:
            hits.append((t, f"{t.get('desc') or '下破'}（触及 {v:.2f}）"))
        elif k == 'volume_ratio_gt' and base_avg_volume > 0 and bar.volume / base_avg_volume >= v:
            hits.append((t, f"{t.get('desc') or '放量'}（量比 {bar.volume / base_avg_volume:.2f}）"))
        elif k == 'volume_ratio_lt' and base_avg_volume > 0 and bar.volume / base_avg_volume <= v:
            hits.append((t, f"{t.get('desc') or '缩量'}（量比 {bar.volume / base_avg_volume:.2f}）"))
        elif k == 'trail' and pos and pos.get('avg_cost', 0) > 0 and pos.get('peak', 0) > 0:
            gain = (bar.close - pos['avg_cost']) / pos['avg_cost']
            dd = (pos['peak'] - bar.close) / pos['peak']
            d = t.get('value2') or v / 2
            if gain >= v / 100 and dd >= d / 100:
                hits.append((t, f"移动止盈（浮盈 {gain * 100:.1f}% ≥ {v}%，自最高 {pos['peak']:.2f} 回落 {dd * 100:.1f}%）"))
    if not hits and time_reached:
        hits.append((None, f"预测 {prediction.get('horizon')} 个交易日到期"))
    return hits


def build_pred_review(prediction, bars, pred_start, cur_idx, trigger_reason):
    if pred_start < 0 or cur_idx <= pred_start or cur_idx >= len(bars):
        return None, None, False
    base = bars[pred_start]
    future = bars[pred_start + 1:cur_idx + 1]
    if not future or base.close <= 0:
        return None, None, False
    last = future[-1].close
    chg = (last - base.close) / base.close
    actual_bias = 'up' if chg > SIDEWAYS_THRESHOLD else ('down' if chg < -SIDEWAYS_THRESHOLD else 'sideways')
    lo, hi = min(x.low for x in future), max(x.high for x in future)
    correct = actual_bias == prediction['bias']
    parts = [f"你上轮预测 bias={prediction['bias']}" +
             (f"、区间[{prediction['expected_range']['low']}~{prediction['expected_range']['high']}]"
              if prediction.get('expected_range') else '') +
             f"、有效期{prediction['horizon']}根",
             f"实际走出 bias={actual_bias}（{chg * 100:+.1f}%）、区间[{lo:.2f}~{hi:.2f}]",
             '方向判断正确' if correct else f"方向判断错误（预测{prediction['bias']}实走{actual_bias}），请重新校准趋势判断"]
    if prediction.get('expected_range'):
        if hi > prediction['expected_range']['high']:
            parts.append('实际高点超出预测区间上限')
        if lo < prediction['expected_range']['low']:
            parts.append('实际低点跌破预测区间下限')
    parts.append(f'本轮唤醒方式：{trigger_reason}')
    return f"【上轮预测对账】{'；'.join(parts)}。请据此校准本轮修订，不要重复犯同类错误。", actual_bias, correct


def render_pred_stats(s):
    if s['total'] < 2:
        return None
    miss = s['total'] - s['hit']
    lines = [f"【近期预测战绩】已对账 {s['total']} 轮：方向对 {s['hit']} 次、错 {miss} 次"
             f"（看多变空 {s['bullishMiss']}、看空变多 {s['bearishMiss']}）"]
    if s['total'] >= 3 and miss / s['total'] >= 0.7:
        tend = ('且错误集中在看多落空——你可能在系统性高估多头机会' if s['bullishMiss'] > s['bearishMiss']
                else '且错误集中在看空踏空——你可能在系统性低估多头力量' if s['bearishMiss'] > s['bullishMiss']
                else '多空双向都在失准')
        lines.append(f"⚠ 战绩警示：错误率 {miss / s['total'] * 100:.0f}%，{tend}。请自省：你的人设与策略是否适配"
                     "当前个股、当前时段的行情结构？若不适配，应主动调整战术（缩短有效期、降低仓位、减少操作）。")
    return '\n'.join(lines)


# ==================== LLM 调用 ====================

def call_decide(system, user, session_id, kind):
    body = json.dumps({'system': system, 'user': user, 'mode': 'pred_and_wait',
                       'kind': kind, 'sessionId': session_id}).encode()
    req = urllib.request.Request(API, data=body, headers={'Content-Type': 'application/json'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:200]
            if e.code in (500, 502, 504) and attempt < 2:
                continue
            raise RuntimeError(f'HTTP {e.code}: {detail}')
        except Exception:
            if attempt < 2:
                continue
            raise
    raise RuntimeError('unreachable')


# ==================== 交易执行 ====================

class Book:
    def __init__(self):
        self.cash = INITIAL_CAPITAL
        self.shares = 0
        self.avg_cost = 0.0
        self.peak = 0.0
        self.trades = []
        self.closed_pairs = []  # 每笔卖出的盈亏（用于胜率）

    def buy(self, price, lots, date, idx, max_lots=POSITIONS):
        lots = max(1, min(lots, max_lots))
        per = self.cash / max(1, (max_lots - self.lots_used()))
        amount = min(per * lots, self.cash)
        px = price * (1 + SLIPPAGE)
        sh = int(amount / px / 100) * 100
        if sh <= 0:
            return False
        cost = sh * px
        fee = max(5, cost * FEE_RATE)
        if cost + fee > self.cash:
            sh = int((self.cash - fee) / px / 100) * 100
            if sh <= 0:
                return False
            cost = sh * px
            fee = max(5, cost * FEE_RATE)
        self.cash -= cost + fee
        self.avg_cost = (self.avg_cost * self.shares + cost) / (self.shares + sh) if self.shares else cost / sh
        self.shares += sh
        self.peak = max(self.peak, price)
        self.trades.append({'side': 'buy', 'price': round(px, 3), 'shares': sh, 'date': date, 'index': idx, 'actor': 'ai'})
        return True

    def sell(self, price, lots, date, idx):
        if self.shares <= 0:
            return False
        sh = self.shares if lots is None or lots <= 0 else min(self.shares, int(self.shares * lots / max(1, POSITIONS)))
        sh = max(100, int(sh / 100) * 100)
        sh = min(sh, self.shares)
        px = price * (1 - SLIPPAGE)
        net = sh * px
        fee = max(5, net * FEE_RATE)
        tax = net * STAMP_TAX
        self.cash += net - fee - tax
        pnl = (px - self.avg_cost) * sh - fee - tax
        self.closed_pairs.append(pnl)
        self.shares -= sh
        self.trades.append({'side': 'sell', 'price': round(px, 3), 'shares': sh, 'date': date, 'index': idx, 'actor': 'ai'})
        if self.shares <= 0:
            self.avg_cost = 0.0
            self.peak = 0.0
        return True

    def lots_used(self):
        return 0 if self.shares <= 0 else max(1, POSITIONS)

    def equity(self, price):
        return self.cash + self.shares * price


# ==================== 一局回放 ====================

def run_one(code, arm, decision_bars=DECISION_BARS, seed_offset=0):
    bars = load_bars(code)
    total = WARMUP + decision_bars
    if len(bars) < total:
        return None
    # 确定性起点：用 code 数值（不用 hash(str)，其跨进程随机会导致不可复现）
    # 同一 code 在任何一次运行中都落在同一段行情上，保证 A/B 与长短窗口可比
    rng = random.Random(int(code) + seed_offset)
    start = rng.randint(WARMUP, max(WARMUP, len(bars) - decision_bars - 1))
    seg = bars[start - WARMUP:start + decision_bars]
    rps_map = load_rps(code)
    risk_guide = RISK_GUIDE_A if arm == 'A' else RISK_GUIDE_B
    sys_predict = SYSTEM_PREDICT.format(strategy=STRATEGY, risk_guide=risk_guide,
                                        hmin=HORIZON_MIN, hmax=HORIZON_MAX)
    sys_wake = SYSTEM_WAKE.format(strategy=STRATEGY, risk_guide=risk_guide)

    book = Book()
    session_id = f'bt-{code}-{arm}-{start}'
    pred_stats = {'total': 0, 'hit': 0, 'bullishMiss': 0, 'bearishMiss': 0}
    prediction = None
    pred_start = None
    base_avg_vol = 0.0
    decisions = 0

    for i in range(WARMUP, len(seg)):
        bar = seg[i]
        ls = limit_state(seg, i)
        if prediction is None:
            # 新一轮预测
            user = build_context(seg, i, rps_map, book.shares > 0, book.avg_cost, book.peak)
            user += ('你现在处于「预测等待」模式，请基于以上走势对未来做一次结构化预测。\n'
                     f'要求：horizon 为 {HORIZON_MIN}~{HORIZON_MAX} 之间由你判断（超界会被截断）；'
                     '先给出是否现在建仓的初始动作，再给出可被程序自动判定的触发条件。只输出 JSON。')
            data = call_decide(sys_predict, user, session_id, 'predict')
            decisions += 1
            prediction = normalize_prediction(data)
            if not prediction:
                prediction = None
                continue
            pred_start = i
            prev = seg[max(0, i - 20):i]
            base_avg_vol = sum(b.volume for b in prev) / len(prev) if prev else 0
            if prediction['initial_action'] == 'buy' and ls != 'up':
                book.buy(bar.close, prediction.get('initial_lots', 1), bar.date, i)
            continue

        # 已有预测：检查触发
        if book.shares > 0:
            book.peak = max(book.peak, bar.high)
        pos = {'avg_cost': book.avg_cost, 'peak': book.peak} if book.shares > 0 else None
        time_reached = i >= pred_start + prediction['horizon']
        hits = check_triggers(prediction, bar, base_avg_vol, time_reached, pos)
        if not hits:
            continue

        # 唤醒
        trigger_reason = hits[0][1]
        review_text, actual_bias, correct = build_pred_review(prediction, seg, pred_start, i, trigger_reason)
        if actual_bias:
            pred_stats['total'] += 1
            if correct:
                pred_stats['hit'] += 1
            elif prediction['bias'] == 'up':
                pred_stats['bullishMiss'] += 1
            elif prediction['bias'] == 'down':
                pred_stats['bearishMiss'] += 1
        user = build_context(seg, i, rps_map, book.shares > 0, book.avg_cost, book.peak)
        if review_text:
            user += review_text + '\n'
        stats_text = render_pred_stats(pred_stats)
        if stats_text:
            user += stats_text + '\n'
        user += ('请基于「上轮对账 + 之前的预测 + 唤醒原因 + 当前最新走势」给出当下一根的动作，'
                 '可附修订预测（revised）。只输出 JSON。')
        data = call_decide(sys_wake, user, session_id, 'wake')
        decisions += 1
        action = data.get('action')
        lots = max(1, int(data.get('lots') or 1))
        reason = str(data.get('reason') or '')
        if action == 'buy' and ls != 'up':
            book.buy(bar.close, lots, bar.date, i)
        elif action == 'sell' and ls != 'down' and book.shares > 0:
            book.sell(bar.close, lots, bar.date, i)
        # 修订预测则继续本轮，否则清空 → 下根重新预测
        revised = data.get('revised')
        new_pred = normalize_prediction(revised) if isinstance(revised, dict) else None
        if new_pred:
            prediction, pred_start = new_pred, i
            prev = seg[max(0, i - 20):i]
            base_avg_vol = sum(b.volume for b in prev) / len(prev) if prev else 0
        else:
            prediction, pred_start = None, None
        _ = reason

    # 收尾：按最后收盘平仓计入权益
    last = seg[-1]
    final = book.equity(last.close)
    wins = sum(1 for p in book.closed_pairs if p > 0)
    losses = sum(1 for p in book.closed_pairs if p <= 0)
    return {
        'code': code,
        'startDate': seg[WARMUP].date,
        'endDate': last.close and seg[-1].date,
        'initialCapital': INITIAL_CAPITAL,
        'finalCapital': round(final, 2),
        'profit': round(final - INITIAL_CAPITAL, 2),
        'profitRate': (final - INITIAL_CAPITAL) / INITIAL_CAPITAL,
        'rangeReturn': (last.close - seg[WARMUP].close) / seg[WARMUP].close,
        'trades': book.trades,
        'winTrades': wins,
        'lossTrades': losses,
        'openCount': sum(1 for t in book.trades if t['side'] == 'buy'),
        'meta': {
            'aiMode': 'pred_wait',
            'klineMode': 'csv',
            'ruleVersion': 2,
            'decisionBars': decision_bars,
            'experiment': EXP_TAG,
            'weeklyState': WITH_WEEKLY,
            'positions': POSITIONS,
            'riskGuide': risk_guide,
            'aiPrompt': STRATEGY,
            'backtest': True,
            'arm': arm,
            'decisions': decisions,
            'sessionId': session_id,
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--codes', default='')
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--arm', default='both', choices=['A', 'B', 'both'])
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--bars', type=int, default=DECISION_BARS, help='决策窗口根数（长窗口实验用 200+）')
    ap.add_argument('--tag', default='', help='实验标记，写入 meta.experiment')
    ap.add_argument('--weekly', action='store_true', help='注入【周线状态】块（实验组）')
    args = ap.parse_args()
    global EXP_TAG, WITH_WEEKLY
    EXP_TAG = args.tag or f'bars{args.bars}'
    WITH_WEEKLY = args.weekly

    if args.codes:
        codes = [c.strip() for c in args.codes.split(',') if c.strip()]
    elif args.sample:
        all_codes = sorted(p.stem for p in DATA.glob('*.csv'))
        codes = random.Random(42 + args.offset).sample(all_codes, min(args.sample, len(all_codes)))
    else:
        print('需要 --codes 或 --sample')
        return

    arms = ['A', 'B'] if args.arm == 'both' else [args.arm]
    with open(OUT, 'a', encoding='utf-8') as f:
        for code in codes:
            for arm in arms:
                try:
                    r = run_one(code, arm, args.bars, args.offset)
                    if not r:
                        print(f'{code} {arm}: 数据不足，跳过')
                        continue
                    f.write(json.dumps(r, ensure_ascii=False) + '\n')
                    f.flush()
                    print(f'{code} {arm}: 收益 {r["profitRate"] * 100:+.2f}%  '
                          f'区间 {r["rangeReturn"] * 100:+.2f}%  '
                          f'交易 {len(r["trades"])} 笔  调用 {r["meta"]["decisions"]} 次', flush=True)
                except Exception as e:
                    print(f'{code} {arm} 失败: {str(e)[:200]}', flush=True)


if __name__ == '__main__':
    main()
