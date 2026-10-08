import { holdingAdvice } from './holdingRules.ts';
import type { Rule, RuleInput, Signal } from './types.ts';

// ============================================================
// 退出规则（d25 trail 是唯一有效的主动退出）
// 金叉对照：trail(10/5) E 5.41／胜率 78.2% vs 现行死叉 2.41／36.8%（d25）
// ============================================================

/** trail 移动止盈：浮盈达 activate% 后，自持仓最高价回落 drawdown% 即触发 */
export const EXIT_TRAIL: Rule<RuleInput, Signal> = {
  id: 'exit.trail',
  name: '移动止盈 trail（浮盈达 X% 后自最高回落 Y%）',
  category: 'exit',
  source: 'd25',
  enabled: true,
  evaluate: (input) => {
    const pos = input.position;
    if (!pos || pos.avgCost <= 0 || pos.peak <= 0) return null;
    const advice = holdingAdvice(input);
    const t = advice?.trail;
    if (!t) return null;
    const cur = input.bar?.close ?? input.bars[input.bars.length - 1]?.close ?? 0;
    if (cur <= 0) return null;
    const gain = (cur - pos.avgCost) / pos.avgCost;
    const dd = (pos.peak - cur) / pos.peak;
    if (gain < t.activate / 100) return null;
    if (dd < t.drawdown / 100) return null;
    return {
      ruleId: 'exit.trail',
      ruleName: `trail(${t.activate}/${t.drawdown})`,
      hit: true,
      detail: `浮盈 ${(gain * 100).toFixed(1)}% ≥ ${t.activate}%，且自持仓最高 ${pos.peak.toFixed(2)} 回落 ${(dd * 100).toFixed(1)}% ≥ ${t.drawdown}%——移动止盈触发`,
      strength: 'strong',
      source: 'd25',
    };
  },
};

/** 目标持有期到达（甜点期） */
export const EXIT_TARGET_DAYS: Rule<RuleInput, Signal> = {
  id: 'exit.target_days',
  name: '到达该信号的持有期甜点',
  category: 'exit',
  source: 'd24',
  enabled: true,
  evaluate: (input) => {
    const pos = input.position;
    if (!pos) return null;
    const advice = holdingAdvice(input);
    if (!advice?.targetDays) return null;
    if (pos.holdDays < advice.targetDays) return null;
    return {
      ruleId: 'exit.target_days',
      ruleName: '持有期甜点到达',
      hit: true,
      detail: `已持有 ${pos.holdDays} 个交易日，达到该信号的甜点期 ${advice.targetDays} 日`,
      strength: 'medium',
      source: 'd24',
    };
  },
};

export const EXIT_RULES: Rule<RuleInput, Signal>[] = [EXIT_TRAIL, EXIT_TARGET_DAYS];

// ---- 退出理由合规检查（供 verifier / UI 回灌使用）----
// ⚠️ 判定必须要求"动作 + 依据"共同出现，并显式排除 trail／止盈／持有到期等合规做法。
// 教训：早期仅用关键词"破位"判定，把一条合规的 trail 止盈误判成违规，得出完全相反的结论。

const VIOLATION_PATTERNS: { name: string; re: RegExp; source: string }[] = [
  { name: '固定百分比止损', re: /止损|割肉/, source: 'd24' },
  { name: '均线破位退出', re: /(跌破|下破|破)[^。；，]{0,8}(MA\s*\d+|均线)[^。；，]{0,12}(止损|离场|卖|清仓|出局)/, source: 'd27' },
  { name: '跌破支撑/前低就卖', re: /(跌破|下破)[^。；，]{0,8}(支撑|前低|平台)[^。；，]{0,12}(止损|离场|卖|清仓|出局)/, source: 'd25' },
  { name: '时间止损', re: /\d+\s*(天|日|根)[^。；，]{0,6}(不涨|没涨|未涨)|时间止损/, source: 'd25' },
  { name: 'K 线形态逃顶', re: /(吞没|顶分型|M头|黑三鸦)[^。；，]{0,10}(卖|离场|清仓|出局)/, source: 'd28' },
];

/** 合规做法（命中则不算违规） */
const OK_PATTERNS = /trail|移动止盈|追踪止盈|持有到期|甜点|止盈/;

export interface ExitCheck {
  violation: boolean;
  matched: string[];
  sources: string[];
}

/** 检查一条卖出理由是否使用了已被证伪的退出做法 */
export function checkExitReason(reason: string): ExitCheck {
  const r = reason || '';
  if (!r) return { violation: false, matched: [], sources: [] };
  if (OK_PATTERNS.test(r)) {
    // 合规表述优先；但仍要排除"名义止盈、实际止损"的混合表述
    if (!/止损|割肉/.test(r)) return { violation: false, matched: [], sources: [] };
  }
  const matched: string[] = [];
  const sources: string[] = [];
  for (const p of VIOLATION_PATTERNS) {
    if (p.re.test(r)) {
      matched.push(p.name);
      sources.push(p.source);
    }
  }
  return { violation: matched.length > 0, matched, sources };
}
