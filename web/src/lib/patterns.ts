import type { Bar } from '../types';

// quant_discover 形态特征库（出口②：AI 上下文的【形态特征】块）
// 来源：/Users/flybirp/Documents/quant_discover —— 12 年全市场（5062 只，2014~2026）统计先验，
//       判定口径对齐源仓 appendix.md，先验数字见 docs/discover_XX 各篇。
//
// 移植口径说明（与源仓的差异，均已注明）：
// - 量比统一为「当根量 / 前 20 根均量（不含当日）」，与训练系统 CSV 的量比列一致；
//   源仓默认口径含当日（仅 base_break 不含），阈值沿用原值，差异极小。
// - 全部检测只用 bar[i] 及之前的数据（因果）；局部极值点需 +1 根确认后才计为命中。
// - 腰斩（spike_top）未移植：需要「低点→翻倍→顶→单边腰斩」完整结构，训练窗口
//   （warmup 30 + decision 101 根日线）常容不下完整前期；判读要点已写入 AI 策略
//   指令预设「出清买点」。
// - 过拟合防线：仅报分年稳健的形态（n≥3,000 且分年方向稳定），证伪类（双底/杯柄/
//   吞没/K线组合）不报，回避类只作为缺口/量能语义的一部分呈现。

export interface PatternHit {
  label: string; // 形态名
  barsAgo: number; // 命中确认日距今根数（0 = 最新一根）
  detail: string; // 结构细节（关键数值）
  prior: string; // 历史统计先验（供 AI 参考）
}

// ---- 基础工具 ----

// 量比：当根量 / 前 20 根均量（不含当日）；i<20 时返回 null
function volRatio(bars: Bar[], i: number): number | null {
  if (i < 20) return null;
  let sum = 0;
  for (let k = i - 20; k < i; k++) sum += bars[k].volume;
  const avg = sum / 20;
  return avg > 0 ? bars[i].volume / avg : null;
}

// 简单移动平均（含当日）；i<n-1 时返回 null（未来确认用）
function smaEnd(values: number[], n: number, endIdx: number): number | null {
  if (endIdx + 1 < n) return null;
  let sum = 0;
  for (let k = endIdx - n + 1; k <= endIdx; k++) sum += values[k];
  return sum / n;
}

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

// ISO 自然周分桶键（周一为始），用于 base_break 的周线口径
function isoWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // 本周四 → 所属 ISO 周
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---- 1. 底背离（pv_divergence_bottom，discover_18）----
// 口径：两个局部低点，间隔≥10 根、后者收盘创新低（低于前者）且量能 < 前者 0.8 倍；
//       两点之间有过 10~20% 反弹的「完整结构」质量最高。
function detectDivergenceBottom(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 35) return null;
  // 局部低点：收盘低于两侧（右侧等低取先者，与源仓「相等平台取首个」一致）
  const lows: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (bars[i].close < bars[i - 1].close && bars[i].close <= bars[i + 1].close) lows.push(i);
  }
  if (lows.length < 2) return null;
  // 从晚到早找最近一对满足结构的 (L2 晚, L1 早)
  for (let a = lows.length - 1; a > 0; a--) {
    const l2 = lows[a];
    if (n - 1 - l2 > 30) break; // 只看最近 30 根内确认的
    for (let b = a - 1; b >= 0; b--) {
      const l1 = lows[b];
      if (l2 - l1 < 10) continue;
      if (bars[l2].close >= bars[l1].close) continue; // 须创新低
      if (bars[l2].volume >= bars[l1].volume * 0.8) continue; // 量能须萎缩
      // 两点间最大反弹幅度（完整结构 10~20% 最佳）
      let peak = -Infinity;
      for (let k = l1; k <= l2; k++) peak = Math.max(peak, bars[k].close);
      const rebound = peak / bars[l1].close - 1;
      const volShrink = bars[l2].volume / bars[l1].volume;
      const full = rebound >= 0.1 && rebound <= 0.2;
      return {
        label: '底背离✓',
        barsAgo: n - 1 - l2,
        detail: `第二低点较前低创新低、量能仅为前低的${volShrink.toFixed(2)}倍，两点间隔${l2 - l1}根，中间反弹${fmtPct(rebound)}${full ? '（完整结构）' : ''}`,
        prior: full
          ? '历史净增+5pct、完整结构20日E+11.2%/胜率65%（全项目第二强买点，60日期望+7.8%）'
          : '历史净增+5pct、60日期望+7.8%、分年11/13为正（一路阴跌中的背离质量减半）',
      };
    }
  }
  return null;
}

// ATR(14) 占价格百分比：个股波动特征归一化基准（银行股与科技股的振幅不可同日而语，
// 绝对百分比门槛对低波动股过严、对高波动股过松；相对口径 = depth / ATR 得到「分型深度是日均波幅的几倍」）
// 导出供 AI 上下文【市场统计】使用：日波动率基准（判断当日走势是正常波动还是异常）
export function atrPct(bars: Bar[], endIdx: number, n = 14): number | null {
  if (endIdx < n) return null;
  let sum = 0;
  for (let k = endIdx - n + 1; k <= endIdx; k++) {
    const b = bars[k];
    const prevClose = bars[k - 1]?.close ?? b.open;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    sum += tr;
  }
  const c = bars[endIdx].close;
  return c > 0 ? (sum / n / c) * 100 : null;
}

// ---- 2. 深跌底分型（fractal_bottom，discover_10/12）----
// 口径：三K底分型（中间K高低点均低于两侧）；depth=中间低点超出两侧低点的较小幅度（分母为中间K low）；
//       仅统计确认日前 20 根跌幅≥10% 的样本。
//       报告线（双口径）：绝对 depth≥3%（源统计全市场口径）或 相对 depth≥1.5×ATR14（个股归一化：
//       分型凹陷超过日均波幅 1.5 倍即结构性显著——低波动股 1.5% 的凹陷可能已极显著）。
//       深档：depth≥5% 或 ≥2.5×ATR。
function detectFractalBottom(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 25) return null;
  for (let i = n - 3; i >= 1; i--) {
    // 确认日 = 第 3 根（i+1）；只报最近 10 根内确认的
    if (n - 1 - (i + 1) > 10) break;
    const m = bars[i];
    if (!(m.high < bars[i - 1].high && m.high < bars[i + 1].high)) continue;
    if (!(m.low < bars[i - 1].low && m.low < bars[i + 1].low)) continue;
    const confirmIdx = i + 1;
    if (confirmIdx < 20) continue;
    const drop = bars[confirmIdx].close / bars[confirmIdx - 20].close - 1;
    if (drop > -0.1) continue; // 前 20 根跌幅须 ≥10%
    const depth =
      Math.min(
        (bars[i - 1].low - m.low) / m.low,
        (bars[i + 1].low - m.low) / m.low,
      ) * 100;
    const atr = atrPct(bars, confirmIdx);
    const depthAtr = atr != null && atr > 0 ? depth / atr : null; // 分型深度 / 日均波幅
    const absPass = depth >= 3; // 源统计口径（全市场混合样本）
    const relPass = depthAtr != null && depthAtr >= 1.5; // 个股归一化口径
    if (!absPass && !relPass) continue; // 两个口径都不达标 = 浅分型无信息
    const deep = depth >= 5 || (depthAtr != null && depthAtr >= 2.5);
    const drop20 = Math.round(-drop * 100);
    const atrNote =
      depthAtr != null ? `，为日均波幅(ATR14≈${atr!.toFixed(1)}%)的${depthAtr.toFixed(1)}倍` : '';
    return {
      label: deep ? '深底分型✓' : '底分型✓',
      barsAgo: n - 1 - confirmIdx,
      detail: `三K分型深度${depth.toFixed(1)}%${atrNote}，前20根跌幅${drop20}%`,
      prior:
        (deep ? '深分型档：20日胜率66.8%/E+7.8%；' : '中档分型：20日胜率62%左右；') +
        (drop20 >= 30
          ? '深跌背景（≥30%）下信号可信度显著更高（最强组合84%）'
          : '跌幅10~20%背景信号质量中等，可轻仓试探'),
    };
  }
  return null;
}

// ---- 3. 缩量反击 / 努力比（effort_defeat，discover_10）----
// 口径：关键K=量比≥1.5 的阴线/十字；其后 1~5 根内出现阳线收盘收复关键K最高价=击败；
//       努力比=击败K量比/关键K量比，越小说明空头越无力。
function detectEffortDefeat(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 30) return null;
  for (let j = n - 6; j >= Math.max(20, n - 15); j--) {
    // 击败K最早在 j+1，最新在 j+5；只报最近 10 根内击败的
    const vj = volRatio(bars, j);
    if (vj == null || vj < 1.5) continue;
    const k1 = bars[j];
    const range = k1.high - k1.low;
    const bodyRatio = range > 0 ? Math.abs(k1.close - k1.open) / range : 0;
    const bearish = k1.close < k1.open || bodyRatio < 0.3;
    if (!bearish) continue;
    for (let k = j + 1; k <= Math.min(j + 5, n - 1); k++) {
      if (bars[k].close <= bars[j].high) continue;
      if (bars[k].close <= bars[k].open) continue; // 须阳线
      if (n - 1 - k > 10) break;
      const vk = volRatio(bars, k);
      const effort = vk != null ? vk / vj : null;
      const effortStr = effort != null ? `，努力比${effort.toFixed(2)}` : '';
      const good = effort != null && effort < 0.6;
      return {
        label: '缩量反击✓',
        barsAgo: n - 1 - k,
        detail: `${j + 1 === k ? '次日' : `${k - j}根后`}阳线收复量比${vj.toFixed(1)}大阴线高点${effortStr}`,
        prior: good
          ? '努力比<0.6：5日胜率65%+；空头发力被轻松击败，短期反攻信号可靠'
          : '缩量反击成立但击败量偏大（努力比≥0.6），信号强度一般（5日胜率56%左右）',
      };
    }
  }
  return null;
}

// ---- 4. 威科夫 spring（wyckoff_spring，discover_21）----
// 口径：横盘语境（60 根振幅≤25%）下，支撑（区间最低 low）被收盘跌破≥1% 后 ≤3 根内收盘收回上方；
//       跌破深度≥5% 为深 spring。止损应设在 spring 最低价而非支撑位。
function detectSpring(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 65) return null;
  for (let r = n - 1; r >= n - 30 && r >= 64; r--) {
    // r = 收回日，只报最近 30 根内收回的
    if (n - 1 - r > 30) break;
    // 支撑：收回日前 60 根（不含最近 3 根可能的跌破段）的最低 low
    let support = Infinity;
    let hi = -Infinity;
    for (let k = r - 63; k <= r - 4; k++) {
      support = Math.min(support, bars[k].low);
      hi = Math.max(hi, bars[k].high);
    }
    if (support === Infinity || support <= 0) continue;
    if ((hi - support) / support > 0.25) continue; // 非横盘语境
    if (bars[r].close <= support) continue; // 收回日须站回支撑上方
    // 找跌破日 j∈[r-3, r-1]：收盘跌破支撑 ≥1%
    let breakIdx = -1;
    for (let j = r - 3; j <= r - 1; j++) {
      if (bars[j].close <= support * 0.99) {
        breakIdx = j;
        break;
      }
    }
    if (breakIdx < 0) continue;
    let springLow = Infinity;
    for (let k = breakIdx; k <= r; k++) springLow = Math.min(springLow, bars[k].low);
    const depth = (support - springLow) / support * 100;
    // 深档双口径（个股波动归一化）：绝对 ≥5% 或 ≥2.5×ATR14（低波动股的相对显著跌破）
    const atr = atrPct(bars, r);
    const depthAtr = atr != null && atr > 0 ? depth / atr : null;
    const deep = depth >= 5 || (depthAtr != null && depthAtr >= 2.5);
    const atrNote = depthAtr != null ? `（日均波幅的${depthAtr.toFixed(1)}倍）` : '';
    return {
      label: deep ? '深spring✓' : 'spring✓',
      barsAgo: n - 1 - r,
      detail: `横盘支撑${support.toFixed(2)}被收盘跌破${depth >= 1 ? depth.toFixed(1) : '≥1'}%后${r - breakIdx}根内收回，跌破深度${depth.toFixed(1)}%${atrNote}`,
      prior: deep
        ? '深spring（绝对≥5%或≥2.5倍日均波幅）：20日胜率60.8%/E+4.2%；止损设在spring最低价，勿设在支撑位'
        : 'spring净增+5pct；浅spring（<2%且不足1.5倍日均波幅）质量一般（50%），深度越深越可靠',
    };
  }
  return null;
}

// ---- 5. 筑底深跌破（base_break C/D 组，discover_04）----
// 周线口径（ISO 自然周）：≥2 周低点贴同一支撑（离散≤5%）→ 前 12 周跌≥20%（下跌后首底）
// → 首个跌破支撑的日线 → 深度 C(10~15%)/D(15~30%) × 跌破日量比（<0.8 缩量=回避）。
function detectBaseBreak(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 80) return null;
  // 周分桶
  const weeks: { key: string; low: number; high: number; firstIdx: number }[] = [];
  for (let i = 0; i < n; i++) {
    const key = isoWeekKey(bars[i].date);
    const w = weeks[weeks.length - 1];
    if (!w || w.key !== key) {
      weeks.push({ key, low: bars[i].low, high: bars[i].high, firstIdx: i });
    } else {
      w.low = Math.min(w.low, bars[i].low);
      w.high = Math.max(w.high, bars[i].high);
    }
  }
  if (weeks.length < 15) return null;
  // 找筑底段（贪心扩展：周 low 离散≤5%，≥2 周），从晚到早尝试，取最近一次跌破
  for (let start = weeks.length - 3; start >= 1; start--) {
    // 位置：筑底段前 12 周自最高收盘跌≥20%（简化：用 high 口径近似）
    const lookback = weeks.slice(Math.max(0, start - 12), start);
    if (lookback.length < 6) continue;
    const priorHigh = Math.max(...lookback.map((w) => w.high));
    let baseLow = Infinity;
    for (let e = start; e < weeks.length; e++) {
      baseLow = Math.min(baseLow, weeks[e].low);
      if ((priorHigh - baseLow) / priorHigh < 0.2) break; // 不满足「下跌后首底」
      const seg = weeks.slice(start, e + 1);
      const segLowMax = Math.max(...seg.map((w) => w.low));
      const segLowMin = Math.min(...seg.map((w) => w.low));
      if ((segLowMax - segLowMin) / segLowMin > 0.05) break; // 周低点离散超 5%，段终止
      if (seg.length < 2) continue;
      // 段末位置：找段结束后首个 low < baseLow 的日线
      const segEndIdx = weeks[e].firstIdx; // 近似：段最后一周的起始日
      for (let i = segEndIdx; i < n; i++) {
        if (bars[i].low >= baseLow) continue;
        if (n - 1 - i > 20) break; // 只报最近 20 根（4 周）内跌破的
        const penetration = (baseLow - bars[i].low) / baseLow * 100;
        if (penetration < 10 || penetration > 30) break; // 仅 C/D 组
        const vr = volRatio(bars, i);
        const shrink = vr != null && vr < 0.8;
        const group = penetration <= 15 ? 'C' : 'D';
        return {
          label: shrink ? `筑底跌破${group}组·缩量⚠` : `筑底跌破${group}组✓`,
          barsAgo: n - 1 - i,
          detail: `周线筑底${seg.length}周后跌破支撑${baseLow.toFixed(2)}达${penetration.toFixed(1)}%，跌破日量比${vr != null ? vr.toFixed(2) : '?'}（<0.8为缩量）`,
          prior: shrink
            ? '⚠ C/D组×缩量跌破=无人接盘，历史4周收益为负、分年稳定为负——回避信号，勿抄底'
            : 'C组×非缩量：历史4周胜率78~81%/E+13~16%，分年最稳健的甜点（恐慌释放+有承接）',
        };
      }
      break; // 只看以 start 开头的最长合法段
    }
  }
  return null;
}

// ---- 6. 跳空缺口 + 回补状态（gap_up/down，discover_17）----
// 口径：向上缺口=当根 low > 前根 high×1.02；回补=此后收盘 ≤ 前根 high。
//       未回补=持有锚；已回补=离场信号。向下缺口对称（强势背景下的向下缺口是最强减仓信号）。
function detectGaps(bars: Bar[]): PatternHit[] {
  const n = bars.length;
  const hits: PatternHit[] = [];
  for (let i = n - 1; i >= Math.max(1, n - 60); i--) {
    const g = bars[i].low > bars[i - 1].high * 1.02 ? 1 : bars[i].high < bars[i - 1].low * 0.98 ? -1 : 0;
    if (g === 0) continue;
    const gapPct = g > 0 ? bars[i].low / bars[i - 1].high - 1 : bars[i].high / bars[i - 1].low - 1;
    let filled = false;
    let fillIdx = -1;
    for (let k = i + 1; k < n; k++) {
      if (g > 0 ? bars[k].close <= bars[i - 1].high : bars[k].close >= bars[i - 1].low) {
        filled = true;
        fillIdx = k;
        break;
      }
    }
    if (!filled && n - 1 - i > 40) continue; // 未回补的老缺口不报
    if (filled && n - 1 - fillIdx > 10) continue; // 只报最近 10 根内刚回补的
    const vr = volRatio(bars, i);
    const volNote = vr != null ? `，缺口日量比${vr.toFixed(2)}（<1缩量/≥2放量）` : '';
    if (g > 0) {
      hits.push({
        label: filled ? '向上缺口·已回补⚠' : '向上缺口·未回补✓',
        barsAgo: filled ? n - 1 - fillIdx : n - 1 - i,
        detail: `${(gapPct * 100).toFixed(1)}%向上跳空${volNote}${filled ? '，收盘已跌回缺口下沿' : `，至今${n - 1 - i}根未回补`}`,
        prior: filled
          ? '⚠ 缺口回补=离场信号：已回补组历史60日-9.5%/胜率24%（未回补组+18%/61%，分野28pct）'
          : '未回补缺口=持有锚：历史60日E+18.4%/胜率61%；收盘一旦回补立即离场',
      });
    } else {
      hits.push({
        label: filled ? '向下缺口·已回补✓' : '向下缺口·未回补⚠',
        barsAgo: filled ? n - 1 - fillIdx : n - 1 - i,
        detail: `${(gapPct * 100).toFixed(1)}%向下跳空${volNote}${filled ? '，收盘已收复缺口上沿' : `，至今${n - 1 - i}根未回补`}`,
        prior: filled
          ? '向下缺口被回补=利空出尽，历史60日+18%/胜率68%（较强买点之一）'
          : '未回补向下缺口=趋势下跌；若前期大涨后出现，是最强减仓信号（历史仅32%胜收）',
      });
    }
    if (hits.length >= 2) break;
  }
  return hits;
}

// ---- 7. 趋势内回踩 MA5 带（pullback，discover_09，状态报法）----
// 口径：MA5 金叉 MA20 后的波段内，low 自上方进入 MA5 ±3% 带为一次回踩（离开带后重计）；
//       波段回撤=波段高点到当前的收盘回撤。第 1~2 次 + 回撤<5% + 不收破 MA5 = 甜点。
function detectPullback(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 60) return null;
  const closes = bars.map((b) => b.close);
  const ma5: (number | null)[] = [];
  const ma20: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    ma5.push(smaEnd(closes, 5, i));
    ma20.push(smaEnd(closes, 20, i));
  }
  // 最近一次金叉
  let cross = -1;
  for (let i = n - 1; i >= 21; i--) {
    if (ma5[i] == null || ma20[i] == null || ma5[i - 1] == null || ma20[i - 1] == null) continue;
    if (ma5[i - 1]! <= ma20[i - 1]! && ma5[i]! > ma20[i]!) {
      cross = i;
      break;
    }
  }
  if (cross < 0 || n - 1 - cross < 3) return null;
  const cur = n - 1;
  if (ma5[cur] == null) return null;
  // 趋势确立过滤：金叉后波段须有可观涨幅（≥5%），否则金叉只是横盘缠绕，非趋势
  let peakForTrend = -Infinity;
  for (let i = cross; i <= cur; i++) peakForTrend = Math.max(peakForTrend, closes[i]);
  if (peakForTrend / closes[cross] - 1 < 0.05) return null;
  const dist = (bars[cur].low - ma5[cur]!) / ma5[cur]!;
  if (dist > 0.03) return null; // 当前不在回踩带内
  // 统计波段内回踩次数（进入带的事件数，离开带 >3% 后重计；初始在带内不计数——须「从带外进入」）
  let count = 0;
  let inBand: boolean | null = null;
  let peak = -Infinity;
  for (let i = cross; i <= cur; i++) {
    peak = Math.max(peak, closes[i]);
    const ma = ma5[i];
    if (ma == null) continue;
    const d = (bars[i].low - ma) / ma;
    if (d <= 0.03) {
      if (inBand === false) count++;
      inBand = true;
    } else {
      inBand = false;
    }
  }
  const waveDd = (peak - closes[cur]) / peak * 100;
  const broke = closes[cur] < ma5[cur]!;
  // count=0 表示金叉后从未发生「离带→进带」的回踩事件（价格始终贴线，多为强势上涨），
  // 不构成回踩信号；waveDd<1 且未破线说明收盘仍贴波段高点，同样不是回落动作
  if (count === 0 || (waveDd < 1 && !broke)) return null;
  const sweet = count <= 2 && waveDd < 5 && !broke;
  return {
    label: sweet ? '趋势回踩·甜点✓' : '趋势回踩',
    barsAgo: 0,
    detail: `MA5金叉MA20后波段内第${count}次回踩MA5带（当前距MA5 ${fmtPct(dist)}，${broke ? '已收破MA5' : '未收破'}），波段内回撤${waveDd.toFixed(1)}%`,
    prior: sweet
      ? '第1~2次+不破线+回撤<5%：历史20日创新高率83%；回撤5~10%质量减半，>10%放弃'
      : '回踩质量不佳：多次回踩=波段走弱（第4次后创新高率断崖），或回撤过深/已破线——考虑放弃或减仓',
  };
}

// ---- 8. 横盘区间状态（consolidation 简化版，discover_05）----
// 口径：自最新根向前贪婪扩展，窗口高低差 ≤15% 为界；持续 ≥15 根即成立。
//       状态报法：区间存在期间每次决策都报，给 AI 区间上下沿锚。
//       价值：横盘本身不是买点（胜率43~52%），区间锚用于「下沿潜伏/上沿兑现/中段不动/止损设区间外」。
function detectRange(bars: Bar[]): PatternHit | null {
  const n = bars.length;
  if (n < 30) return null;
  let hi = bars[n - 1].high;
  let lo = bars[n - 1].low;
  let len = 1;
  for (let i = n - 2; i >= 0; i--) {
    const nhi = Math.max(hi, bars[i].high);
    const nlo = Math.min(lo, bars[i].low);
    if (nlo <= 0 || (nhi / nlo - 1) > 0.15) break; // 扩展违反 15% 带即终止
    hi = nhi;
    lo = nlo;
    len++;
    if (len >= 60) break; // 最多回看 60 根
  }
  if (len < 15) return null;
  const cur = bars[n - 1].close;
  const pos = (cur - lo) / (hi - lo); // 0=下沿 1=上沿
  const posLabel = pos <= 0.33 ? '下沿附近' : pos >= 0.67 ? '上沿附近' : '中段';
  return {
    label: '横盘区间',
    barsAgo: 0,
    detail: `近${len}根价格运行于 ${lo.toFixed(2)}~${hi.toFixed(2)}（宽${((hi / lo - 1) * 100).toFixed(0)}%），当前${posLabel}（位置${(pos * 100).toFixed(0)}%）`,
    prior:
      '横盘本身不是买点（胜率43~52%），价值在右尾：下沿附近才可轻仓潜伏、上沿附近兑现、中段不开新仓（持仓者的离场依据是跌破区间下沿，而非处于中段）；止损必须设在区间边界外（勿设在MA20——震荡中它是噪音线）；收盘跌破下沿非机会，除非演变为深跌出清（跌10~15%+量能不缩）',
  };
}

// ---- 汇总：形态特征块 ----

// 检测全部形态，返回按距今排序的命中列表（全部因果，只用已揭示数据）
export function detectPatterns(bars: Bar[]): PatternHit[] {
  const hits: PatternHit[] = [
    detectDivergenceBottom(bars),
    detectFractalBottom(bars),
    detectEffortDefeat(bars),
    detectSpring(bars),
    detectBaseBreak(bars),
    detectPullback(bars),
    detectRange(bars),
    ...detectGaps(bars),
  ].filter((h): h is PatternHit => h != null);
  return hits.sort((a, b) => a.barsAgo - b.barsAgo);
}

// AI 上下文的【形态特征】块；无命中返回 null（不注入）
export function patternSummaryBlock(bars: Bar[]): string[] | null {
  if (bars.length < 40) return null;
  const hits = detectPatterns(bars);
  if (hits.length === 0) return null;
  const lines = [
    '【形态特征】（程序按 12 年全市场统计口径逐根判定，仅用已揭示数据；先验为历史统计均值，非承诺，供决策参考）',
  ];
  for (const h of hits) {
    const ago = h.barsAgo === 0 ? '最新一根' : `${h.barsAgo}根前`;
    lines.push(`- ${ago} ${h.label}：${h.detail} —— ${h.prior}`);
  }
  return lines;
}
