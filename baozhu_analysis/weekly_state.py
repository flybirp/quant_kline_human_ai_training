"""weeklyState.ts 的 Python 等价实现（供后端回放 run_backtest.py 使用）。

口径与阈值同 `周线状态判定口径.md`：
  恐慌 A1 近4周平均周跌 > 前8周×1.5（d03）；A2 距26周高收盘回撤≥30%（d03/d08）
  趋势 B1 站上10周均线且均线向上（d07/d09）
  横盘 C1 近12周振幅≤20%（≈均价±10%，d05 consolidation）
判定优先级：恐慌 > 趋势 > 横盘。允许使用本周至今（未定型周）。

⚠️ 与 TS 版必须逐字同口径，改动任一侧都要重跑 audit_weekly.py 对账。
"""
from dataclasses import dataclass
from typing import Optional

# 复用 patterns_py 的 ISO 周键（与 patterns.ts 已 200/200 对账一致），避免两份实现漂移
from patterns_py import iso_week_key  # noqa: E402


@dataclass(slots=True)
class WeeklyBar:
    key: str
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


def to_weekly(bars: list) -> list[WeeklyBar]:
    out: list[WeeklyBar] = []
    for b in bars:
        key = iso_week_key(b.date)
        if not out or out[-1].key != key:
            out.append(WeeklyBar(key=key, date=b.date, open=b.open, high=b.high,
                                 low=b.low, close=b.close, volume=b.volume))
        else:
            w = out[-1]
            w.high = max(w.high, b.high)
            w.low = min(w.low, b.low)
            w.close = b.close
            w.date = b.date
            w.volume += b.volume
    return out


def _avg_weekly_drop(w: list[WeeklyBar], end: int, count: int) -> Optional[float]:
    if len(w) < 2 or count <= 0:
        return None
    end = min(len(w) - 1, end)
    start = max(1, end - count + 1)
    s, n = 0.0, 0
    for i in range(start, end + 1):
        prev = w[i - 1].close
        if prev <= 0:
            continue
        s += -((w[i].close - prev) / prev) * 100
        n += 1
    return s / n if n > 0 else None


def _sma(vals: list[float], end_idx: int, n: int) -> Optional[float]:
    if end_idx + 1 < n:
        return None
    return sum(vals[end_idx - n + 1:end_idx + 1]) / n


def weekly_state(bars: list) -> dict:
    w = to_weekly(bars)
    res = {
        'state': 'unknown',
        'reasons': [],
        'metrics': {'weeks': len(w), 'weeklyDrop4': None, 'weeklyDrop8': None,
                    'drawdownFrom26wHigh': None, 'ma10': None, 'ma10Slope': None,
                    'bandDrawdown': None, 'rangeWidthPct': None},
    }
    if len(w) < 8:
        res['reasons'] = ['周线样本不足 8 根']
        return res

    last = len(w) - 1
    closes = [x.close for x in w]
    m = res['metrics']

    d4 = _avg_weekly_drop(w, last, 4)
    d8 = _avg_weekly_drop(w, last - 4, 8)
    back26 = max(0, last - 25)
    high26 = max(w[i].close for i in range(back26, last + 1))
    dd26 = (high26 - w[last].close) / high26 * 100 if high26 > 0 else None

    ma10 = _sma(closes, last, 10)
    ma10_prev = _sma(closes, last - 2, 10)
    slope = (ma10 - ma10_prev) if (ma10 is not None and ma10_prev is not None) else None

    peak = w[last].close
    for i in range(last, -1, -1):
        peak = max(peak, w[i].close)
        if w[i].close < peak * 0.9:
            break
    band_dd = (peak - w[last].close) / peak * 100 if peak > 0 else None

    n12 = min(12, len(w))
    seg = w[len(w) - n12:]
    hi = max(x.high for x in seg)
    lo = min(x.low for x in seg)
    mid = sum(x.close for x in seg) / len(seg)
    width_pct = (hi - lo) / mid * 100 if mid > 0 else None

    m.update({'weeklyDrop4': d4, 'weeklyDrop8': d8, 'drawdownFrom26wHigh': dd26,
              'ma10': ma10, 'ma10Slope': slope, 'bandDrawdown': band_dd,
              'rangeWidthPct': width_pct})

    reasons = []
    if d4 is not None and d8 is not None and d8 > 0 and d4 >= d8 * 1.5:
        reasons.append(f'近4周平均周跌 {d4:.2f}% ≥ 前8周 {d8:.2f}% × 1.5（加速下跌/capitulation，d03）')
    if dd26 is not None and dd26 >= 30:
        reasons.append(f'距 26 周高收盘回撤 {dd26:.1f}% ≥ 30%（深跌位置，d03/d08）')
    if reasons:
        res['state'], res['reasons'] = 'panic', reasons
        return res

    if ma10 is not None and w[last].close > ma10 and (slope or 0) > 0:
        quality = ''
        if band_dd is not None:
            quality = ('优质（回撤<5%）' if band_dd < 5 else
                       '一般（回撤5~10%）' if band_dd < 10 else '走弱（回撤≥10%）')
        reasons.append(f'周收盘 {w[last].close:.2f} 站上 10 周均线 {ma10:.2f} 且均线向上（d07/d09）')
        if band_dd is not None:
            reasons.append(f'当前波段回撤 {band_dd:.1f}%——{quality}')
        res['state'], res['reasons'] = 'trend', reasons
        return res

    if width_pct is not None and n12 >= 6 and width_pct <= 20:
        reasons.append(f'近 {n12} 周区间振幅 {width_pct:.1f}%（约合均价 ±10% 内，d05 consolidation）')
        res['state'], res['reasons'] = 'range', reasons
        return res

    res['reasons'] = ['未落入恐慌/趋势/横盘任一明确状态']
    return res


# ---- 注入 AI 上下文的【周线状态】块（与 weeklyState.ts 的 weeklyStateBlock 对应）----
# 措辞原则：正向指令优先（LLM 对"不要做 X"的执行率低于"做 Y"）

STATE_LABEL = {
    'panic': '深跌恐慌态（出清买点窗口）',
    'trend': '趋势态',
    'range': '横盘态',
    'unknown': '无明确周线状态',
}

STATE_PLAY = {
    'panic': (
        '只找这三类出清买点——① 腰斩（翻倍后单边腰斩，按 90 日 +8~16%／胜率 57~66% 规划）；'
        '② C 组深跌破（跌破支撑 10~15% 且**跌破日量比 1.5~2.1 温和放量最优**，E+18.28%／胜率 88.5%）；'
        '③ 底背离（60 日 E+7.8%，全项目唯一年度稳定信号）；④ 深跌后反转需前 20 日跌幅 ≥30% 才可信',
        '禁止把"趋势走坏、跌破均线"当离场理由——持有期回撤 IC +0.49（12/12 年为正），浮亏越深越该拿',
    ),
    'trend': (
        '找波段内的**首次回踩**：波段回撤 <5% 为优质（创新高率 82%）、5~10% 打折、>10% 放弃；'
        '趋势完好时让利润奔跑',
        '禁止追第 4 次以后的回踩（创新高率断崖衰减）——多次回踩本身说明波段走弱',
    ),
    'range': (
        '区间下沿潜伏、上沿兑现；用 RPS 分位区分强弱——RPS≥80 是强势中继（优选）、'
        'RPS<20 是弱势停顿（回避）',
        '禁止在区间中段开仓（胜率仅 43~52%，均值微正全由右尾贡献）',
    ),
    'unknown': (
        '只做最高置信信号（深跌出清／腰斩级别），否则观望',
        '不要在无明确周线状态时按日线波动频繁操作',
    ),
}


def weekly_state_block(bars: list) -> Optional[str]:
    """生成注入上下文的【周线状态】块；样本不足返回 None"""
    if not bars or len(bars) < 60:
        return None
    s = weekly_state(bars)
    lines = [f"【周线状态】{STATE_LABEL[s['state']]}"]
    for r in s['reasons']:
        lines.append(f'- {r}')
    do, dont = STATE_PLAY[s['state']]
    lines.append(f'- 日线该做什么：{do}')
    lines.append(f'- 禁止：{dont}')
    return '\n'.join(lines)
