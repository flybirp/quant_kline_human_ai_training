import type { Bar } from '../../types';

// ============================================================
// quantRules · 类型定义
//
// 定位：把 quant_discover 的**买卖点与持有策略**写成可执行的规则代码，
// 独立于 UI / AI 决策 / verifier / 回测——以上四方都可以消费本模块。
//
// 设计原则：
// 1. 规则即数据：每条规则带来源篇目与统计先验（含打折标注），可遍历、可开关
// 2. 可判定：evaluate() 返回结构化结论，程序能直接用（不只是生成文本）
// 3. 单一真相：prompt 文本由规则数据自动生成（describe），避免手写文本与代码漂移
// ============================================================

/** 统计先验（一律标注报告值与打折值——报告值是幸存者偏差下的上界） */
export interface PriorStat {
  /** 指标名，如 "90日 E" */
  metric: string;
  /** 报告值（上界） */
  reported: string;
  /** 打折后的实操值（幸存者偏差 -16%~32%、去聚类后） */
  discounted?: string;
  /** 胜率（报告值） */
  winRate?: string;
  /** 胜率（打折后） */
  winRateDiscounted?: string;
  /** 样本量 */
  sample?: number;
  /** 分年稳定性，如 "11/13年为正 p=0.023 ✅" */
  yearly?: string;
  /** 聚类风险，如 "55%样本在2015" */
  clusterRisk?: string;
  /** quant_discover 篇目，如 "d06" */
  source: string;
}

export type RuleCategory = 'entry' | 'avoid' | 'holding' | 'exit' | 'sizing';

/** 规则定义 */
export interface Rule<Ctx = unknown, Out = unknown> {
  id: string;
  name: string;
  category: RuleCategory;
  /** quant_discover 篇目 */
  source: string;
  /** 统计先验（若有） */
  prior?: PriorStat;
  /** 是否启用（支持按规则做 A/B） */
  enabled: boolean;
  /** 补充说明 */
  note?: string;
  /** 判定函数 */
  evaluate: (ctx: Ctx) => Out | null;
}

/** 信号强度 */
export type SignalStrength = 'strong' | 'medium' | 'weak' | 'avoid';

/** 规则判定出的信号 */
export interface Signal {
  ruleId: string;
  ruleName: string;
  hit: boolean;
  /** 带数字的判定依据 */
  detail: string;
  strength: SignalStrength;
  source: string;
  prior?: PriorStat;
  /** 综合分 = 有效权重 × 强度系数（由 weights.rankSignals 填入，用于多信号排序） */
  weight?: number;
}

/** 持仓上下文 */
export interface PositionCtx {
  /** 建仓成本 */
  avgCost: number;
  /** 持仓期间最高价（trail 判定用） */
  peak: number;
  /** 已持有交易日数 */
  holdDays: number;
  /** 浮动盈亏率（0.05 = +5%） */
  floatPnlRate: number;
  /** 当前份数 */
  lots: number;
  /** 份数上限 */
  maxLots: number;
  /** 当初是按哪条入场规则建的仓（用于匹配持有期甜点） */
  entryRuleId?: string;
}

/** 评估输入 */
export interface RuleInput {
  /** 全量已揭示日线（因果，不含未来） */
  bars: Bar[];
  /** 最新一根（缺省取 bars 末根） */
  bar?: Bar;
  /** 周线状态（由 weeklyState 计算；不传则模块内部算） */
  weeklyState?: 'panic' | 'trend' | 'range' | 'unknown';
  /** 最新量比 */
  volRatio?: number | null;
  /** RPS 分位 0~99（横盘场景有效） */
  rps?: number | null;
  /** 当日涨跌停状态 */
  limitState?: 'up' | 'down' | null;
  /** 持仓（空仓则传 null） */
  position?: PositionCtx | null;
}

/** 持有建议 */
export interface HoldingAdvice {
  /** 该信号的持有期甜点（交易日） */
  targetDays: number | null;
  /** 坑位：勿在此附近离场 */
  pitfallDays?: number;
  /** 是否允许主动止盈 */
  allowTakeProfit: boolean;
  /** 推荐的移动止盈参数（激活浮盈% / 回落%） */
  trail?: { activate: number; drawdown: number };
  /** 已被统计证伪、禁止使用的做法 */
  forbidden: string[];
  /** 其他提示 */
  notes: string[];
  source: string;
}

/** 评估结论 */
export interface RuleVerdict {
  /** 命中的入场信号 */
  entries: Signal[];
  /** 命中的回避项 */
  avoids: Signal[];
  /** 持有建议（仅持仓时有） */
  holding: HoldingAdvice | null;
  /** 已满足的退出条件 */
  exitSignals: Signal[];
  /** 仓位建议 */
  sizing: { maxLots: number; note: string } | null;
  /** 周线状态（透传或内部计算） */
  weeklyState: 'panic' | 'trend' | 'range' | 'unknown';
}
