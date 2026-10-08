import { detectPatterns } from '../patterns.ts';
import type { Rule, RuleInput, Signal } from './types.ts';

// ============================================================
// 回避规则（负面清单）——历史胜率低于随机基准或已被证伪，宁可错过
// 说明：本层不重复实现形态检测，只对 patterns.ts 的命中结果做"回避判定"
// ============================================================

/** 量比：当根量 / 前 20 根均量（不含当日） */
function volRatio(bars: RuleInput['bars']): number | null {
  const i = bars.length - 1;
  if (i < 20) return null;
  const avg = bars.slice(i - 20, i).reduce((s, b) => s + b.volume, 0) / 20;
  return avg > 0 ? bars[i].volume / avg : null;
}

/** 区间位置：当前收盘在近 60 根高低区间的分位（0=下沿，1=上沿） */
function rangePos(bars: RuleInput['bars']): number | null {
  const seg = bars.slice(Math.max(0, bars.length - 60));
  if (seg.length < 20) return null;
  const hi = Math.max(...seg.map((b) => b.high));
  const lo = Math.min(...seg.map((b) => b.low));
  if (hi <= lo) return null;
  return (bars[bars.length - 1].close - lo) / (hi - lo);
}

export const AVOID_SHRINK_BREAK: Rule<RuleInput, Signal> = {
  id: 'avoid.shrink_break',
  name: '缩量跌破（无人接盘）',
  category: 'avoid',
  source: 'd04',
  enabled: true,
  evaluate: (input) => {
    const hit = detectPatterns(input.bars ?? []).find(
      (h) => h.label.includes('筑底跌破') && h.label.includes('缩量'),
    );
    if (!hit) return null;
    return {
      ruleId: 'avoid.shrink_break',
      ruleName: '缩量跌破',
      hit: true,
      detail: `${hit.detail}——历史 4 周收益为负、分年稳定为负，回避`,
      strength: 'avoid',
      source: 'd04',
    };
  },
};

export const AVOID_HUGE_VOLUME: Rule<RuleInput, Signal> = {
  id: 'avoid.huge_volume',
  name: '巨量（量比 >2.1，抛售未尽）',
  category: 'avoid',
  source: 'd32',
  enabled: true,
  note: 'd32：量比>2.1 是最差档（胜率仅 68%）；量比≥5 极端放量疑似出货',
  evaluate: (input) => {
    const vr = input.volRatio ?? volRatio(input.bars);
    if (vr == null) return null;
    if (vr <= 2.1) return null;
    return {
      ruleId: 'avoid.huge_volume',
      ruleName: '巨量',
      hit: true,
      detail: `最新量比 ${vr.toFixed(2)} >2.1${vr >= 5 ? '（≥5 极端放量，疑似出货）' : '（抛售未尽，最差档）'}`,
      strength: 'avoid',
      source: 'd32',
    };
  },
};

export const AVOID_SHRINK_PULLBACK: Rule<RuleInput, Signal> = {
  id: 'avoid.shrink_pullback',
  name: '回调段极度缩量（量能 < 均量 0.7 倍，崩塌前兆）',
  category: 'avoid',
  source: 'd14',
  enabled: true,
  note: '历史胜率 31.5%——买盘消失',
  evaluate: (input) => {
    const bars = input.bars;
    if (bars.length < 25) return null;
    const i = bars.length - 1;
    const avg = bars.slice(i - 20, i).reduce((s, b) => s + b.volume, 0) / 20;
    if (avg <= 0) return null;
    const vr = bars[i].volume / avg;
    const decline = bars[i].close < (bars[i - 5]?.close ?? Infinity);
    if (!(vr < 0.7)) return null;
    return {
      ruleId: 'avoid.shrink_pullback',
      ruleName: '回调段极度缩量',
      hit: true,
      detail: `最新量比 ${vr.toFixed(2)} <0.7${decline ? '，且处于回调段——买盘消失，崩塌前兆（胜率 31.5%）' : ''}`,
      strength: 'avoid',
      source: 'd14',
    };
  },
};

export const AVOID_RANGE_MIDDLE: Rule<RuleInput, Signal> = {
  id: 'avoid.range_middle',
  name: '横盘区间中段开仓',
  category: 'avoid',
  source: 'd05',
  enabled: true,
  note: '横盘本身不是买点（胜率 43~52%），价值在右尾：下沿潜伏、上沿兑现，中段不动',
  evaluate: (input) => {
    const isRange =
      input.weeklyState === 'range' ||
      detectPatterns(input.bars ?? []).some((h) => h.label.includes('横盘区间'));
    if (!isRange) return null;
    const pos = rangePos(input.bars);
    if (pos == null || pos < 0.35 || pos > 0.65) return null;
    return {
      ruleId: 'avoid.range_middle',
      ruleName: '横盘区间中段',
      hit: true,
      detail: `当前处于近 60 根区间的 ${(pos * 100).toFixed(0)}% 位置（中段）——横盘中段不开仓`,
      strength: 'avoid',
      source: 'd05',
    };
  },
};

export const AVOID_WEAK_RANGE: Rule<RuleInput, Signal> = {
  id: 'avoid.weak_range',
  name: '弱势横盘（RPS <20，弱势停顿）',
  category: 'avoid',
  source: 'd15',
  enabled: true,
  note: 'RPS 唯一有效用法是横盘场景：≥80 强势中继优选，<20 弱势停顿回避（分年 10/10）',
  evaluate: (input) => {
    if (input.rps == null) return null;
    if (input.weeklyState !== 'range' && !detectPatterns(input.bars ?? []).some((h) => h.label.includes('横盘区间'))) {
      return null;
    }
    if (input.rps >= 20) return null;
    return {
      ruleId: 'avoid.weak_range',
      ruleName: '弱势横盘',
      hit: true,
      detail: `横盘且 RPS 分位 ${input.rps} <20——弱势停顿，应回避（d15：分组单调、分年 10/10）`,
      strength: 'avoid',
      source: 'd15',
    };
  },
};

export const AVOID_GAP_FILLED: Rule<RuleInput, Signal> = {
  id: 'avoid.gap_filled',
  name: '向上缺口已回补（持有锚失效）',
  category: 'avoid',
  source: 'd17',
  enabled: true,
  note: '未回补组 +18%/61%，已回补组 -10%/24%，分野 28pct——收盘回补立即离场',
  evaluate: (input) => {
    const hit = detectPatterns(input.bars ?? []).find((h) => h.label.includes('向上缺口·已回补'));
    if (!hit) return null;
    return {
      ruleId: 'avoid.gap_filled',
      ruleName: '向上缺口已回补',
      hit: true,
      detail: `${hit.detail}——持有锚失效，历史已回补组 60 日 -9.5%／胜率 24%`,
      strength: 'avoid',
      source: 'd17',
    };
  },
};

/** 全部回避规则 */
export const AVOID_RULES: Rule<RuleInput, Signal>[] = [
  AVOID_SHRINK_BREAK,
  AVOID_HUGE_VOLUME,
  AVOID_SHRINK_PULLBACK,
  AVOID_RANGE_MIDDLE,
  AVOID_WEAK_RANGE,
  AVOID_GAP_FILLED,
];

/** 已被证伪的"形态"（不检测，仅记录，供 describe 生成文本） */
export const REFUTED_PATTERNS = [
  { name: '双底颈线突破', stat: '胜率 46%，39% 最终破底', source: 'd16' },
  { name: '杯柄突破', stat: '胜率 37.6%（前高=派发区）', source: 'd19' },
  { name: 'K 线组合（十字星/孕线/红三兵/黑三鸦）', stat: '全部无独立预测力，同背景形状间收益差 <0.5pct', source: 'd20' },
  { name: '顶分型/吞没/M 头/黑三鸦（做空方向）', stat: '四连证伪；做空天花板（65%）远低于做多（84%）', source: 'd13/d16/d20' },
  { name: '大顶的 K 线/量能形态', stat: 'AUC ≈0.5 且年度方向翻转，事前不可识别', source: 'd28' },
  { name: '腰斩"跌更深/更快/更单边"的精选', stat: '全部被 2015 样本绑架，剔除后单调性消失甚至反转', source: 'd30/d31' },
];
