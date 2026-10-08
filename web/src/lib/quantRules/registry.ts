import { weeklyState } from '../weeklyState.ts';
import { AVOID_RULES } from './avoidRules.ts';
import { ENTRY_RULES } from './entryRules.ts';
import { EXIT_RULES } from './exitRules.ts';
import { holdingAdvice, sizingAdvice } from './holdingRules.ts';
import type { Rule, RuleInput, RuleVerdict, Signal } from './types.ts';
import {
  enabledUnderProfile,
  rankSignals,
  weightOf,
  setWeightProfile,
  getWeightProfile,
  describeWeights,
  type WeightProfile,
} from './weights.ts';

// 权重配置再导出：调用方无需直接引 weights.ts
export { setWeightProfile, getWeightProfile, describeWeights, weightOf };
export type { WeightProfile };

// ============================================================
// 规则注册表 —— 统一评估入口 + 按规则开关（便于做 A/B）
// ============================================================

const ALL: Rule<RuleInput, Signal>[] = [...ENTRY_RULES, ...AVOID_RULES, ...EXIT_RULES];

const overrides = new Map<string, boolean>();

/** 开关单条规则（按 id），用于 A/B 或临时禁用某条规则 */
export function setRuleEnabled(id: string, enabled: boolean) {
  overrides.set(id, enabled);
}

/** 重置所有开关 */
export function resetRuleOverrides() {
  overrides.clear();
}

/** 列出全部规则（含启用状态、权重、证据等级） */
export function listRules(): {
  id: string;
  name: string;
  category: string;
  source: string;
  enabled: boolean;
  weight: number;
  evidence: string;
  note: string;
}[] {
  return ALL.map((r) => {
    const w = weightOf(r.id);
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      source: r.source,
      enabled: enabledOf(r),
      weight: w.weight,
      evidence: w.evidence,
      note: w.note,
    };
  });
}

/**
 * 启用判定 = 代码内默认/运行时开关 **且** 当前权重档位允许。
 * 档位为 conservative 时，未通过安慰剂检验的入场规则会被自动过滤。
 */
function enabledOf(r: Rule<RuleInput, Signal>): boolean {
  const base = overrides.has(r.id) ? !!overrides.get(r.id) : r.enabled;
  return base && enabledUnderProfile(r.id, r.category);
}

/** 多信号同时命中时的优先级排序（权重 × 强度） */
export function rankEntries(v: RuleVerdict): Signal[] {
  return rankSignals(v.entries);
}

/** 回避项排序（越靠前越该拦） */
export function rankAvoids(v: RuleVerdict): Signal[] {
  return rankSignals(v.avoids);
}

function run(rules: Rule<RuleInput, Signal>[], input: RuleInput): Signal[] {
  const out: Signal[] = [];
  for (const r of rules) {
    if (!enabledOf(r)) continue;
    try {
      const s = r.evaluate(input);
      if (s) out.push(s);
    } catch {
      // 单条规则异常不影响整体判定
    }
  }
  return out;
}

/** 主入口：对当前上下文做完整规则判定 */
export function evaluate(input: RuleInput): RuleVerdict {
  const ws = input.weeklyState ?? weeklyState(input.bars).state;
  const withWs: RuleInput = { ...input, weeklyState: ws };
  return {
    entries: run(ENTRY_RULES, withWs),
    avoids: run(AVOID_RULES, withWs),
    holding: holdingAdvice(withWs),
    exitSignals: run(EXIT_RULES, withWs),
    sizing: sizingAdvice(withWs),
    weeklyState: ws,
  };
}

/** 是否允许开仓（回避项非空且强度为 avoid 时建议不开） */
export function allowEntry(v: RuleVerdict): { allow: boolean; reasons: string[] } {
  const blocks = v.avoids.filter((a) => a.strength === 'avoid');
  return {
    allow: blocks.length === 0,
    reasons: blocks.map((b) => `${b.ruleName}：${b.detail}`),
  };
}
