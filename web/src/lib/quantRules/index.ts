// ============================================================
// quantRules —— quant_discover 买卖点与持有策略的规则代码（独立模块）
//
// 定位：把散落在 patterns.ts / weeklyState.ts / exitGuide.ts / Settings 预设 /
// verifier 判据 里的 quant_discover 知识，收拢为**可执行的规则**。
// 独立于 UI / AI 决策 / verifier / 回测——以上四方都可以消费本模块。
//
// 用法：
//   import { evaluate, allowEntry, describeContext } from '@/lib/quantRules';
//   const v = evaluate({ bars, position, rps });
//   if (!allowEntry(v).allow) { /* 拦截开仓 */ }
//   const lines = describeContext({ bars, position });   // 注入 AI 上下文
//
// 规则开关（A/B 用）：setRuleEnabled('entry.spring', false)
// ============================================================

export type {
  PriorStat,
  Rule,
  RuleCategory,
  RuleInput,
  RuleVerdict,
  PositionCtx,
  HoldingAdvice,
  Signal,
  SignalStrength,
} from './types.ts';

// 规则集合
export { ENTRY_RULES, ENTRY_HALVED, ENTRY_BASE_BREAK_C, ENTRY_DIVERGENCE, ENTRY_DEEP_REVERSAL, ENTRY_PULLBACK, ENTRY_SPRING } from './entryRules.ts';
export { AVOID_RULES, REFUTED_PATTERNS } from './avoidRules.ts';
export { EXIT_RULES, EXIT_TRAIL, EXIT_TARGET_DAYS, checkExitReason } from './exitRules.ts';
export { holdingAdvice, sizingAdvice, FORBIDDEN_EXITS, STATE_SEMANTICS } from './holdingRules.ts';

// 注册表与评估
export {
  evaluate,
  allowEntry,
  listRules,
  setRuleEnabled,
  resetRuleOverrides,
  rankEntries,
  rankAvoids,
  setWeightProfile,
  getWeightProfile,
  describeWeights,
  weightOf,
} from './registry.ts';

// 权重配置（证据等级与权重的单一真相源）
export {
  RULE_WEIGHTS,
  DEFAULT_DISCOUNT,
  effectiveWeight,
  rankSignals,
  type RuleWeight,
  type EvidenceLevel,
  type WeightProfile,
} from './weights.ts';

// 文本生成
export { describeEntries, describeAvoids, describeHolding, describeVerdict, describeContext } from './describe.ts';
