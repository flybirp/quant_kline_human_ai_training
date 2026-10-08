import { detectPatterns } from '../patterns.ts';
import type { PriorStat, Rule, RuleInput, Signal } from './types.ts';

// ============================================================
// 入场规则（买点）——全部引自 quant_discover，每条带来源与统计先验
//
// 复用 patterns.ts 的 8 个形态检测器（已与 Python 版 200/200 对账），
// 本层负责：按 label 匹配 + 叠加量比/周线等附加条件 + 给出强度与先验。
// 例外：腰斩（spike_top）patterns.ts 未移植，在本模块内实现。
// ============================================================

const hitsOf = (bars: RuleInput['bars']) => detectPatterns(bars ?? []);
const has = (labels: string[], kw: string) => labels.some((l) => l.includes(kw));

/** 量比：当根量 / 前 20 根均量（不含当日）——与 patterns.ts 同口径 */
function volRatio(bars: RuleInput['bars']): number | null {
  const i = bars.length - 1;
  if (i < 20) return null;
  const avg = bars.slice(i - 20, i).reduce((s, b) => s + b.volume, 0) / 20;
  return avg > 0 ? bars[i].volume / avg : null;
}

// ---- A1 腰斩（d06）：翻倍后单边腰斩，出清最彻底 ----
const PRIOR_HALVED: PriorStat = {
  metric: '90日 E',
  reported: '+19.93%',
  discounted: '+8~16%（剔除 2015 后）',
  winRate: '74.1%',
  winRateDiscounted: '57~66%',
  sample: 1876,
  yearly: '9/13 年为正 p=0.267（未通过稳定性检验）',
  clusterRisk: '55% 样本集中在 2015 年——属危机 alpha，平时平庸、极端恐慌年爆发',
  source: 'd06',
};

export const ENTRY_HALVED: Rule<RuleInput, Signal> = {
  id: 'entry.halved',
  name: '腰斩（翻倍后单边腰斩）',
  category: 'entry',
  source: 'd06',
  prior: PRIOR_HALVED,
  enabled: true,
  note: '维持"跌 50%"定义：d30/d31 证明"跌 60%/70%"与"跌得更快更单边"全被 2015 绑架',
  evaluate: (input) => {
    const bars = input.bars;
    if (bars.length < 120) return null;
    // 近 250 根内：先有翻倍（低→高 ≥100%），随后自高点腰斩（≥50%）
    const seg = bars.slice(Math.max(0, bars.length - 250));
    let hiIdx = 0;
    for (let i = 1; i < seg.length; i++) if (seg[i].close > seg[hiIdx].close) hiIdx = i;
    if (hiIdx < 20) return null;
    const hi = seg[hiIdx].close;
    let lo = Infinity;
    for (let i = 0; i < hiIdx; i++) lo = Math.min(lo, seg[i].close);
    if (lo <= 0 || hi / lo - 1 < 1.0) return null; // 未翻倍
    const cur = seg[seg.length - 1].close;
    const drop = 1 - cur / hi;
    if (drop < 0.5) return null;
    return {
      ruleId: 'entry.halved',
      ruleName: '腰斩（翻倍后单边腰斩）',
      hit: true,
      detail: `自 ${lo.toFixed(2)} 涨至 ${hi.toFixed(2)}（${((hi / lo - 1) * 100).toFixed(0)}% 翻倍），随后自高点回落 ${(drop * 100).toFixed(1)}%（≥50% 腰斩）`,
      strength: 'strong',
      source: 'd06',
      prior: PRIOR_HALVED,
    };
  },
};

// ---- A2 筑底深跌破 C 组（d04 + d32 量比档位）----
const PRIOR_BASE_BREAK: PriorStat = {
  metric: '20日 E',
  reported: '+14.84%',
  discounted: '真实约低 16~32%',
  winRate: '79.6%',
  sample: 1626,
  yearly: '8/12 年为正（未通过稳定性检验）',
  source: 'd04',
};
const PRIOR_BASE_BREAK_SWEET: PriorStat = {
  metric: '温和放量档 E',
  reported: '+18.28%',
  winRate: '88.5%',
  yearly: '年度 p=0.002，非聚类驱动 ✅',
  source: 'd32',
};

export const ENTRY_BASE_BREAK_C: Rule<RuleInput, Signal> = {
  id: 'entry.base_break_c',
  name: '筑底深跌破 C 组（跌破 10~15%，量能不缩）',
  category: 'entry',
  source: 'd04 / d32',
  prior: PRIOR_BASE_BREAK,
  enabled: true,
  note: '最优档是跌破日量比 1.5~2.1 温和放量；量比 >2.1 巨量是最差档（抛售未尽）',
  evaluate: (input) => {
    const hits = hitsOf(input.bars);
    const shrink = hits.find((h) => h.label.includes('筑底跌破') && h.label.includes('缩量'));
    if (shrink) {
      return {
        ruleId: 'entry.base_break_c',
        ruleName: '筑底深跌破（缩量档）',
        hit: true,
        detail: `${shrink.detail}——缩量跌破=无人接盘，属回避信号`,
        strength: 'avoid',
        source: 'd04',
      };
    }
    const hit = hits.find((h) => h.label.includes('筑底跌破C组'));
    if (!hit) return null;
    const vr = input.volRatio ?? volRatio(input.bars);
    let strength: Signal['strength'] = 'medium';
    let prior = PRIOR_BASE_BREAK;
    let extra = '';
    if (vr != null) {
      if (vr >= 1.5 && vr <= 2.1) {
        strength = 'strong';
        prior = PRIOR_BASE_BREAK_SWEET;
        extra = `；跌破日量比 ${vr.toFixed(2)} 落在 1.5~2.1 温和放量最优档`;
      } else if (vr > 2.1) {
        strength = 'avoid';
        extra = `；⚠️ 跌破日量比 ${vr.toFixed(2)} >2.1 巨量（最差档，抛售未尽，胜率仅 68%）`;
      } else {
        extra = `；跌破日量比 ${vr.toFixed(2)}（未达温和放量档）`;
      }
    }
    return {
      ruleId: 'entry.base_break_c',
      ruleName: '筑底深跌破 C 组',
      hit: true,
      detail: `${hit.detail}${extra}`,
      strength,
      source: 'd04 / d32',
      prior,
    };
  },
};

// ---- A3 底背离（d18）——唯一通过年度稳定性检验的信号 ----
const PRIOR_DIVERGENCE: PriorStat = {
  metric: '60日 E',
  reported: '+7.78%',
  discounted: '+7.8%（唯一年度稳定信号，可放心直接使用）',
  winRate: '57.0%',
  sample: 71119,
  yearly: '11/13 年为正 p=0.023 ✅',
  source: 'd18',
};

export const ENTRY_DIVERGENCE: Rule<RuleInput, Signal> = {
  id: 'entry.divergence',
  name: '底背离（缩量创新低=卖压衰竭）',
  category: 'entry',
  source: 'd18',
  prior: PRIOR_DIVERGENCE,
  enabled: true,
  evaluate: (input) => {
    const hit = hitsOf(input.bars).find((h) => h.label.includes('底背离'));
    if (!hit) return null;
    return {
      ruleId: 'entry.divergence',
      ruleName: '底背离',
      hit: true,
      detail: hit.detail,
      strength: 'strong',
      source: 'd18',
      prior: PRIOR_DIVERGENCE,
    };
  },
};

// ---- A4 深跌后反转（d10 / d12）：底分型 / 缩量反击，须有深跌前置 ----
const PRIOR_DEEP_REVERSAL: PriorStat = {
  metric: '20日胜率',
  reported: '深分型 66.8%／缩量反击（努力比<0.6）65%+',
  discounted: '真实约低 16~32%',
  source: 'd10 / d12',
};

export const ENTRY_DEEP_REVERSAL: Rule<RuleInput, Signal> = {
  id: 'entry.deep_reversal',
  name: '深跌后反转（前 20 日跌幅 ≥30% 才可信）',
  category: 'entry',
  source: 'd10 / d12',
  prior: PRIOR_DEEP_REVERSAL,
  enabled: true,
  note: '浅跌中的任何"底部信号"都是噪音；深跌是最强前置',
  evaluate: (input) => {
    const bars = input.bars;
    if (bars.length < 60) return null;
    const labels = hitsOf(bars).map((h) => h.label);
    const fractal = has(labels, '底分型');
    const defeat = has(labels, '缩量反击');
    if (!fractal && !defeat) return null;
    const i = bars.length - 1;
    const ref = bars[i - 20]?.close ?? bars[0].close;
    const drop20 = ref > 0 ? 1 - bars[i].close / ref : 0;
    if (drop20 < 0.3) {
      return {
        ruleId: 'entry.deep_reversal',
        ruleName: '底分型/缩量反击（浅跌档）',
        hit: true,
        detail: `命中 ${fractal ? '底分型' : '缩量反击'}，但前 20 日跌幅仅 ${(drop20 * 100).toFixed(1)}%（<30%）——浅跌中的底部信号是噪音`,
        strength: 'weak',
        source: 'd10 / d12',
      };
    }
    return {
      ruleId: 'entry.deep_reversal',
      ruleName: '深跌后反转',
      hit: true,
      detail: `命中 ${fractal ? '底分型' : '缩量反击'}，前 20 日跌幅 ${(drop20 * 100).toFixed(1)}%（≥30% 深跌前置成立）`,
      strength: 'medium',
      source: 'd10 / d12',
      prior: PRIOR_DEEP_REVERSAL,
    };
  },
};

// ---- A5 趋势内回踩（d09）----
const PRIOR_PULLBACK: PriorStat = {
  metric: '创新高率（20日）',
  reported: '82%（首次回踩 + 波段回撤<5%）',
  discounted: '第 4 次后回踩断崖衰减',
  source: 'd09',
};

export const ENTRY_PULLBACK: Rule<RuleInput, Signal> = {
  id: 'entry.pullback',
  name: '趋势内首次回踩（回撤 <5% 才优质）',
  category: 'entry',
  source: 'd09',
  prior: PRIOR_PULLBACK,
  enabled: true,
  evaluate: (input) => {
    const hits = hitsOf(input.bars);
    const sweet = hits.find((h) => h.label.includes('甜点'));
    const plain = hits.find((h) => h.label.includes('趋势回踩'));
    const hit = sweet || plain;
    if (!hit) return null;
    return {
      ruleId: 'entry.pullback',
      ruleName: '趋势内回踩',
      hit: true,
      detail: hit.detail,
      strength: sweet ? 'medium' : 'weak',
      source: 'd09',
      prior: sweet ? PRIOR_PULLBACK : undefined,
    };
  },
};

// ---- A6 spring（d21）----
const PRIOR_SPRING: PriorStat = {
  metric: '20日胜率',
  reported: '深 spring 60.8%',
  discounted: '年度摇摆剧烈（2014 年 99% → 2017 年 29%）',
  yearly: '未通过稳定性检验',
  source: 'd21',
};

export const ENTRY_SPRING: Rule<RuleInput, Signal> = {
  id: 'entry.spring',
  name: 'spring（横盘支撑假跌破收回，深度 ≥5% 更可靠）',
  category: 'entry',
  source: 'd21',
  prior: PRIOR_SPRING,
  enabled: true,
  evaluate: (input) => {
    const hits = hitsOf(input.bars);
    const deep = hits.find((h) => h.label.includes('深spring'));
    const plain = hits.find((h) => h.label.includes('spring'));
    const hit = deep || plain;
    if (!hit) return null;
    return {
      ruleId: 'entry.spring',
      ruleName: 'spring',
      hit: true,
      detail: hit.detail,
      strength: deep ? 'medium' : 'weak',
      source: 'd21',
      prior: deep ? PRIOR_SPRING : undefined,
    };
  },
};

/** 全部入场规则（顺序即强度优先级） */
export const ENTRY_RULES: Rule<RuleInput, Signal>[] = [
  ENTRY_HALVED,
  ENTRY_BASE_BREAK_C,
  ENTRY_DIVERGENCE,
  ENTRY_DEEP_REVERSAL,
  ENTRY_PULLBACK,
  ENTRY_SPRING,
];
