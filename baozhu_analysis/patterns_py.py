"""patterns.ts 的 Python 等价移植（L0.1b 上下文重建用）。

与 web/src/lib/patterns.ts 逐函数同口径对齐：
- 8 个检测器：底背离 / 深底分型 / 缩量反击 / spring / base_break 筑底跌破 /
  趋势回踩 / 横盘区间 / 缺口回补
- 全部检测只用 bar[i] 及之前的数据（因果）；局部极值点需 +1 根确认后才计为命中。
- 量比统一为「当根量 / 前 20 根均量（不含当日）」，与训练系统 CSV 的量比列一致。
- 先验字符串（prior）与 patterns.ts 逐字一致，供 verifier 参考。

移植自：/web/src/lib/patterns.ts（2026-09 版本）
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
import math


@dataclass(slots=True)
class Bar:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(slots=True)
class PatternHit:
    label: str
    barsAgo: int
    detail: str
    prior: str


# ---- 基础工具 ----

def vol_ratio(bars: list[Bar], i: int) -> float | None:
    """量比：当根量 / 前 20 根均量（不含当日）；i<20 时返回 None"""
    if i < 20:
        return None
    s = sum(bars[k].volume for k in range(i - 20, i))
    avg = s / 20
    return bars[i].volume / avg if avg > 0 else None


def sma_end(values: list[float], n: int, end_idx: int) -> float | None:
    """简单移动平均（含当日）；end_idx+1<n 时返回 None"""
    if end_idx + 1 < n:
        return None
    return sum(values[end_idx - n + 1 : end_idx + 1]) / n


def fmt_pct(v: float) -> str:
    return f"{'+' if v >= 0 else ''}{v * 100:.1f}%"


def iso_week_key(date_str: str) -> str:
    """ISO 自然周分桶键（周一为始），用于 base_break 的周线口径"""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    day = d.isoweekday()  # 1=周一 .. 7=周日
    d2 = d + timedelta(days=4 - day)  # 本周四 → 所属 ISO 周
    year_start = datetime(d2.year, 1, 1)
    week = math.ceil(((d2 - year_start).days + 1) / 7)
    return f"{d2.year}-W{week:02d}"


def atr_pct(bars: list[Bar], end_idx: int, n: int = 14) -> float | None:
    """ATR(14) 占价格百分比：个股波动特征归一化基准"""
    if end_idx < n:
        return None
    s = 0.0
    for k in range(end_idx - n + 1, end_idx + 1):
        b = bars[k]
        prev_close = bars[k - 1].close if k - 1 >= 0 else b.open
        tr = max(b.high - b.low, abs(b.high - prev_close), abs(b.low - prev_close))
        s += tr
    c = bars[end_idx].close
    return (s / n / c) * 100 if c > 0 else None


# ---- 1. 底背离（pv_divergence_bottom，discover_18）----

def detect_divergence_bottom(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 35:
        return None
    lows: list[int] = []
    for i in range(1, n - 1):
        if bars[i].close < bars[i - 1].close and bars[i].close <= bars[i + 1].close:
            lows.append(i)
    if len(lows) < 2:
        return None
    # 从晚到早找最近一对满足结构的 (L2 晚, L1 早)
    for a in range(len(lows) - 1, 0, -1):
        l2 = lows[a]
        if n - 1 - l2 > 30:
            break  # 只看最近 30 根内确认的
        for b in range(a - 1, -1, -1):
            l1 = lows[b]
            if l2 - l1 < 10:
                continue
            if bars[l2].close >= bars[l1].close:
                continue  # 须创新低
            if bars[l2].volume >= bars[l1].volume * 0.8:
                continue  # 量能须萎缩
            peak = -math.inf
            for k in range(l1, l2 + 1):
                peak = max(peak, bars[k].close)
            rebound = peak / bars[l1].close - 1
            vol_shrink = bars[l2].volume / bars[l1].volume
            full = 0.1 <= rebound <= 0.2
            return PatternHit(
                label="底背离✓",
                barsAgo=n - 1 - l2,
                detail=(
                    f"第二低点较前低创新低、量能仅为前低的{vol_shrink:.2f}倍，"
                    f"两点间隔{l2 - l1}根，中间反弹{fmt_pct(rebound)}"
                    f"{'（完整结构）' if full else ''}"
                ),
                prior=(
                    "历史净增+5pct、完整结构20日E+11.2%/胜率65%（全项目第二强买点，60日期望+7.8%；⚠ 报告值为上界，真实值约低16~32%）"
                    if full
                    else "历史净增+5pct、60日期望+7.8%、分年11/13为正（✅ 全项目唯一通过年度方向稳定性检验的信号 p=0.023，可直接使用；一路阴跌中的背离质量减半）"
                ),
            )
    return None


# ---- 2. 深跌底分型（fractal_bottom，discover_10/12）----

def detect_fractal_bottom(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 25:
        return None
    for i in range(n - 3, 0, -1):
        # 确认日 = 第 3 根（i+1）；只报最近 10 根内确认的
        if n - 1 - (i + 1) > 10:
            break
        m = bars[i]
        if not (m.high < bars[i - 1].high and m.high < bars[i + 1].high):
            continue
        if not (m.low < bars[i - 1].low and m.low < bars[i + 1].low):
            continue
        confirm_idx = i + 1
        if confirm_idx < 20:
            continue
        drop = bars[confirm_idx].close / bars[confirm_idx - 20].close - 1
        if drop > -0.1:
            continue  # 前 20 根跌幅须 ≥10%
        depth = min(
            (bars[i - 1].low - m.low) / m.low,
            (bars[i + 1].low - m.low) / m.low,
        ) * 100
        atr = atr_pct(bars, confirm_idx)
        depth_atr = depth / atr if (atr is not None and atr > 0) else None
        abs_pass = depth >= 3
        rel_pass = depth_atr is not None and depth_atr >= 1.5
        if not abs_pass and not rel_pass:
            continue  # 两个口径都不达标 = 浅分型无信息
        deep = depth >= 5 or (depth_atr is not None and depth_atr >= 2.5)
        drop20 = round(-drop * 100)
        atr_note = (
            f"，为日均波幅(ATR14≈{atr:.1f}%)的{depth_atr:.1f}倍"
            if depth_atr is not None
            else ""
        )
        return PatternHit(
            label="深底分型✓" if deep else "底分型✓",
            barsAgo=n - 1 - confirm_idx,
            detail=f"三K分型深度{depth:.1f}%{atr_note}，前20根跌幅{drop20}%",
            prior=(
                ("深分型档：20日胜率66.8%/E+7.8%（⚠ 上界；须有前20日深跌≥30%前置才可信，5-20日短持有）；" if deep else "中档分型：20日胜率62%左右（⚠ 上界）；")
                + (
                    "深跌背景（≥30%）下信号可信度显著更高（最强组合84%）"
                    if drop20 >= 30
                    else "跌幅10~20%背景信号质量中等，可轻仓试探"
                )
            ),
        )
    return None


# ---- 3. 缩量反击 / 努力比（effort_defeat，discover_10）----

def detect_effort_defeat(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 30:
        return None
    for j in range(n - 6, max(20, n - 15) - 1, -1):
        # 击败K最早在 j+1，最新在 j+5；只报最近 10 根内击败的
        vj = vol_ratio(bars, j)
        if vj is None or vj < 1.5:
            continue
        k1 = bars[j]
        rng = k1.high - k1.low
        body_ratio = abs(k1.close - k1.open) / rng if rng > 0 else 0
        bearish = k1.close < k1.open or body_ratio < 0.3
        if not bearish:
            continue
        for k in range(j + 1, min(j + 5, n - 1) + 1):
            if bars[k].close <= bars[j].high:
                continue
            if bars[k].close <= bars[k].open:
                continue  # 须阳线
            if n - 1 - k > 10:
                break
            vk = vol_ratio(bars, k)
            effort = vk / vj if vk is not None else None
            effort_str = f"，努力比{effort:.2f}" if effort is not None else ""
            good = effort is not None and effort < 0.6
            return PatternHit(
                label="缩量反击✓",
                barsAgo=n - 1 - k,
                detail=(
                    f"{'次日' if j + 1 == k else f'{k - j}根后'}"
                    f"阳线收复量比{vj:.1f}大阴线高点{effort_str}"
                ),
                prior=(
                    "努力比<0.6：5日胜率65%+（⚠ 短窗口，扣费与偏差后边际收窄）；空头发力被轻松击败，短期反攻信号可靠"
                    if good
                    else "缩量反击成立但击败量偏大（努力比≥0.6），信号强度一般（5日胜率56%左右）"
                ),
            )
    return None


# ---- 4. 威科夫 spring（wyckoff_spring，discover_21）----

def detect_spring(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 65:
        return None
    for r in range(n - 1, max(n - 30, 64) - 1, -1):
        # r = 收回日，只报最近 30 根内收回的
        if n - 1 - r > 30:
            break
        # 支撑：收回日前 60 根（不含最近 3 根可能的跌破段）的最低 low
        support = math.inf
        hi = -math.inf
        for k in range(r - 63, r - 3):
            support = min(support, bars[k].low)
            hi = max(hi, bars[k].high)
        if support == math.inf or support <= 0:
            continue
        if (hi - support) / support > 0.25:
            continue  # 非横盘语境
        if bars[r].close <= support:
            continue  # 收回日须站回支撑上方
        # 找跌破日 j∈[r-3, r-1]：收盘跌破支撑 ≥1%
        break_idx = -1
        for j in range(r - 3, r):
            if bars[j].close <= support * 0.99:
                break_idx = j
                break
        if break_idx < 0:
            continue
        spring_low = math.inf
        for k in range(break_idx, r + 1):
            spring_low = min(spring_low, bars[k].low)
        depth = (support - spring_low) / support * 100
        atr = atr_pct(bars, r)
        depth_atr = depth / atr if (atr is not None and atr > 0) else None
        deep = depth >= 5 or (depth_atr is not None and depth_atr >= 2.5)
        atr_note = f"（日均波幅的{depth_atr:.1f}倍）" if depth_atr is not None else ""
        return PatternHit(
            label="深spring✓" if deep else "spring✓",
            barsAgo=n - 1 - r,
            detail=(
                f"横盘支撑{support:.2f}被收盘跌破{depth:.1f}%后"
                f"{r - break_idx}根内收回，跌破深度{depth:.1f}%{atr_note}"
            ),
            prior=(
                "深spring（绝对≥5%或≥2.5倍日均波幅）：20日胜率60.8%/E+4.2%（⚠ 上界；年度摇摆剧烈 2014年99%→2017年29%）；持有期U型——20日可用、60日难受、180日+14.76%；禁止「跌破支撑就卖」（E 从 8.91 砍到 4.83，-46%）"
                if deep
                else "spring净增+5pct；浅spring（<2%且不足1.5倍日均波幅）质量一般（50%），深度越深越可靠（⚠ 年度摇摆剧烈，按分年中位打折）"
            ),
        )
    return None


def break_vol_note(vr: float | None) -> str:
    """跌破日量比档位（d32：1.5~2.1 温和放量是最优档，>2.1 巨量是最差档）

    量比口径：当根量 / 前 20 根均量（不含当日），与源仓 base_break 口径一致
    """
    if vr is None:
        return "量比?（不可用）"
    v = f"{vr:.2f}"
    if vr > 2.1:
        return f"量比{v}=巨量（>2.1 最差档，抛售未尽）"
    if vr >= 1.5:
        return f"量比{v}=温和放量（1.5~2.1 最优档）"
    if vr < 0.8:
        return f"量比{v}=缩量（<0.8 无人接盘，回避）"
    return f"量比{v}=平量（一般）"


# ---- 5. 筑底深跌破（base_break C/D 组，discover_04）----

def detect_base_break(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 80:
        return None
    # 周分桶
    weeks: list[dict] = []
    for i in range(n):
        key = iso_week_key(bars[i].date)
        if not weeks or weeks[-1]["key"] != key:
            weeks.append({"key": key, "low": bars[i].low, "high": bars[i].high, "firstIdx": i})
        else:
            w = weeks[-1]
            w["low"] = min(w["low"], bars[i].low)
            w["high"] = max(w["high"], bars[i].high)
    if len(weeks) < 15:
        return None
    # 找筑底段（贪心扩展：周 low 离散≤5%，≥2 周），从晚到早尝试，取最近一次跌破
    for start in range(len(weeks) - 3, 0, -1):
        lookback = weeks[max(0, start - 12) : start]
        if len(lookback) < 6:
            continue
        prior_high = max(w["high"] for w in lookback)
        base_low = math.inf
        for e in range(start, len(weeks)):
            base_low = min(base_low, weeks[e]["low"])
            if (prior_high - base_low) / prior_high < 0.2:
                break  # 不满足「下跌后首底」
            seg = weeks[start : e + 1]
            seg_low_max = max(w["low"] for w in seg)
            seg_low_min = min(w["low"] for w in seg)
            if (seg_low_max - seg_low_min) / seg_low_min > 0.05:
                break  # 周低点离散超 5%，段终止
            if len(seg) < 2:
                continue
            seg_end_idx = weeks[e]["firstIdx"]
            for i in range(seg_end_idx, n):
                if bars[i].low >= base_low:
                    continue
                if n - 1 - i > 20:
                    break  # 只报最近 20 根（4 周）内跌破的
                penetration = (base_low - bars[i].low) / base_low * 100
                if penetration < 10 or penetration > 30:
                    break  # 仅 C/D 组
                vr = vol_ratio(bars, i)
                shrink = vr is not None and vr < 0.8
                group = "C" if penetration <= 15 else "D"
                return PatternHit(
                    label=f"筑底跌破{group}组·缩量⚠" if shrink else f"筑底跌破{group}组✓",
                    barsAgo=n - 1 - i,
                    detail=(
                        f"周线筑底{len(seg)}周后跌破支撑{base_low:.2f}达{penetration:.1f}%，"
                        f"跌破日{break_vol_note(vr)}"
                    ),
                    prior=(
                        "⚠ C/D组×缩量跌破=无人接盘，历史4周收益为负、分年稳定为负——回避信号，勿抄底"
                        if shrink
                        else "C组×非缩量：20日E+14.84%/胜率79.6%（⚠ 上界，真实约低16~32%）；持有越长越好——180日+41.97%，4周窗口远未吃完，禁止止盈；跌破日量比1.5~2.1温和放量是最优档（E+18.28%/胜率88.5%，年度p=0.002 非聚类驱动），量比>2.1巨量是最差档（胜率68%，抛售未尽）"
                    ),
                )
            break  # 只看以 start 开头的最长合法段
    return None


# ---- 6. 跳空缺口 + 回补状态（gap_up/down，discover_17）----

def detect_gaps(bars: list[Bar]) -> list[PatternHit]:
    n = len(bars)
    hits: list[PatternHit] = []
    for i in range(n - 1, max(1, n - 60) - 1, -1):
        if bars[i].low > bars[i - 1].high * 1.02:
            g = 1
        elif bars[i].high < bars[i - 1].low * 0.98:
            g = -1
        else:
            g = 0
        if g == 0:
            continue
        gap_pct = (
            bars[i].low / bars[i - 1].high - 1
            if g > 0
            else bars[i].high / bars[i - 1].low - 1
        )
        filled = False
        fill_idx = -1
        for k in range(i + 1, n):
            if (bars[k].close <= bars[i - 1].high) if g > 0 else (bars[k].close >= bars[i - 1].low):
                filled = True
                fill_idx = k
                break
        if not filled and n - 1 - i > 40:
            continue  # 未回补的老缺口不报
        if filled and n - 1 - fill_idx > 10:
            continue  # 只报最近 10 根内刚回补的
        vr = vol_ratio(bars, i)
        vol_note = f"，缺口日量比{vr:.2f}（<1缩量/≥2放量）" if vr is not None else ""
        if g > 0:
            hits.append(PatternHit(
                label="向上缺口·已回补⚠" if filled else "向上缺口·未回补✓",
                barsAgo=(n - 1 - fill_idx) if filled else (n - 1 - i),
                detail=(
                    f"{gap_pct * 100:.1f}%向上跳空{vol_note}"
                    f"{'，收盘已跌回缺口下沿' if filled else f'，至今{n - 1 - i}根未回补'}"
                ),
                prior=(
                    "⚠ 缺口回补=离场信号：已回补组历史60日-9.5%/胜率24%（未回补组+18%/61%，分野28pct；负信号类：幸存者偏差下方向不变、真实更极端）"
                    if filled
                    else "未回补缺口=持有锚：历史60日E+18.4%/胜率61%（⚠ 上界）；收盘一旦回补立即离场"
                ),
            ))
        else:
            hits.append(PatternHit(
                label="向下缺口·已回补✓" if filled else "向下缺口·未回补⚠",
                barsAgo=(n - 1 - fill_idx) if filled else (n - 1 - i),
                detail=(
                    f"{gap_pct * 100:.1f}%向下跳空{vol_note}"
                    f"{'，收盘已收复缺口上沿' if filled else f'，至今{n - 1 - i}根未回补'}"
                ),
                prior=(
                    "向下缺口被回补=利空出尽，历史60日+18%/胜率68%（较强买点之一；⚠ 上界，按8折规划）"
                    if filled
                    else "未回补向下缺口=趋势下跌；若前期大涨后出现，是最强减仓信号（历史仅32%胜收）"
                ),
            ))
        if len(hits) >= 2:
            break
    return hits


# ---- 7. 趋势内回踩 MA5 带（pullback，discover_09，状态报法）----

def detect_pullback(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 60:
        return None
    closes = [b.close for b in bars]
    ma5 = [sma_end(closes, 5, i) for i in range(n)]
    ma20 = [sma_end(closes, 20, i) for i in range(n)]
    # 最近一次金叉
    cross = -1
    for i in range(n - 1, 20, -1):
        if ma5[i] is None or ma20[i] is None or ma5[i - 1] is None or ma20[i - 1] is None:
            continue
        if ma5[i - 1] <= ma20[i - 1] and ma5[i] > ma20[i]:
            cross = i
            break
    if cross < 0 or n - 1 - cross < 3:
        return None
    cur = n - 1
    if ma5[cur] is None:
        return None
    # 趋势确立过滤：金叉后波段须有可观涨幅（≥5%）
    peak_for_trend = -math.inf
    for i in range(cross, cur + 1):
        peak_for_trend = max(peak_for_trend, closes[i])
    if peak_for_trend / closes[cross] - 1 < 0.05:
        return None
    dist = (bars[cur].low - ma5[cur]) / ma5[cur]
    if dist > 0.03:
        return None  # 当前不在回踩带内
    # 统计波段内回踩次数
    count = 0
    in_band = None
    peak = -math.inf
    for i in range(cross, cur + 1):
        peak = max(peak, closes[i])
        ma = ma5[i]
        if ma is None:
            continue
        d = (bars[i].low - ma) / ma
        if d <= 0.03:
            if in_band is False:
                count += 1
            in_band = True
        else:
            in_band = False
    wave_dd = (peak - closes[cur]) / peak * 100
    broke = closes[cur] < ma5[cur]
    if count == 0 or (wave_dd < 1 and not broke):
        return None
    sweet = count <= 2 and wave_dd < 5 and not broke
    return PatternHit(
        label="趋势回踩·甜点✓" if sweet else "趋势回踩",
        barsAgo=0,
        detail=(
            f"MA5金叉MA20后波段内第{count}次回踩MA5带（当前距MA5 {fmt_pct(dist)}，"
            f"{'已收破MA5' if broke else '未收破'}），波段内回撤{wave_dd:.1f}%"
        ),
        prior=(
            "第1~2次+不破线+回撤<5%：历史20日创新高率83%；回撤5~10%质量减半，>10%放弃"
            if sweet
            else "回踩质量不佳：多次回踩=波段走弱（第4次后创新高率断崖），或回撤过深/已破线——考虑放弃或减仓"
        ),
    )


# ---- 8. 横盘区间状态（consolidation 简化版，discover_05）----

def detect_range(bars: list[Bar]) -> PatternHit | None:
    n = len(bars)
    if n < 30:
        return None
    hi = bars[n - 1].high
    lo = bars[n - 1].low
    length = 1
    for i in range(n - 2, -1, -1):
        nhi = max(hi, bars[i].high)
        nlo = min(lo, bars[i].low)
        if nlo <= 0 or (nhi / nlo - 1) > 0.15:
            break  # 扩展违反 15% 带即终止
        hi = nhi
        lo = nlo
        length += 1
        if length >= 60:
            break  # 最多回看 60 根
    if length < 15:
        return None
    cur = bars[n - 1].close
    pos = (cur - lo) / (hi - lo)
    pos_label = "下沿附近" if pos <= 0.33 else ("上沿附近" if pos >= 0.67 else "中段")
    return PatternHit(
        label="横盘区间",
        barsAgo=0,
        detail=(
            f"近{length}根价格运行于 {lo:.2f}~{hi:.2f}（宽{(hi / lo - 1) * 100:.0f}%），"
            f"当前{pos_label}（位置{pos * 100:.0f}%）"
        ),
        prior=(
            "横盘本身不是买点（胜率43~52%），价值在右尾：下沿附近才可轻仓潜伏、上沿附近兑现、"
            "中段不开新仓；区间边界是离场决策的参考锚而非机械止损位（统计上固定百分比止损各档ΔE全负；"
            "MA20 在震荡中是噪音线）；收盘跌破下沿非机会，除非演变为深跌出清"
            "（跌10~15%+量能不缩）"
        ),
    )


# ---- 汇总：形态特征块 ----

def detect_patterns(bars: list[Bar]) -> list[PatternHit]:
    """检测全部形态，返回按距今排序的命中列表（全部因果，只用已揭示数据）"""
    hits: list[PatternHit] = [
        detect_divergence_bottom(bars),
        detect_fractal_bottom(bars),
        detect_effort_defeat(bars),
        detect_spring(bars),
        detect_base_break(bars),
        detect_pullback(bars),
        detect_range(bars),
        *detect_gaps(bars),
    ]
    hits = [h for h in hits if h is not None]
    return sorted(hits, key=lambda h: h.barsAgo)


def pattern_summary_block(bars: list[Bar]) -> list[str] | None:
    """AI 上下文的【形态特征】块；无命中返回 None（不注入）。

    返回每个命中的一行描述（不含 markdown 列表符号），格式：
        "{ago} {label}：{detail} —— {prior}"
    """
    if len(bars) < 40:
        return None
    hits = detect_patterns(bars)
    if not hits:
        return None
    lines: list[str] = []
    for h in hits:
        ago = "最新一根" if h.barsAgo == 0 else f"{h.barsAgo}根前"
        lines.append(f"{ago} {h.label}：{h.detail} —— {h.prior}")
    return lines
