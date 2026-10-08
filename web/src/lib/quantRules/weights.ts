import type { Signal, SignalStrength } from './types.ts';

// ============================================================
// 规则权重配置 —— quant_discover 统计结论的「单一真相源」
//
// 为什么要有这个文件：
//   统计结论原先散落在四处，改一处要同步四处，且无处表达"证据强弱"——
//     ① patterns.ts / patterns_py.py 的 prior 字符串（8 个检测器）
//     ② 本模块各规则的 prior 字段
//     ③ Settings.tsx 的 AI 指令预设与持仓铁律
//     ④ server/lib/verifier.js 的五子标准权重
//   2026-09-30 安慰剂检验（block bootstrap 对照组）后，终于有了**独立于
//   quant_discover 自身的证据**：哪些形态是真特性、哪些只是随机序列的几何必然。
//   这些结论必须有地方落地，否则下一轮统计更新仍会四处漂移。
//
// 设计原则：
//   1. 权重与规则代码分离——改权重/开关不动 evaluate()
//   2. 每个数字都标注证据来源与实测值，不写"感觉上应该"
//   3. 证据等级先于权重：evidence 决定要不要用，weight 决定多信号冲突时谁优先
//   4. 打折系数集中管理（幸存者偏差 -16%~32%，见 T2/T19）
// ============================================================

/** 证据等级：决定"这条规则值不值得用" */
export type EvidenceLevel =
  | 'verified' // 通过安慰剂检验：真实显著强于对照组 → 真特性
  | 'geometric' // 安慰剂检验显示对照同样出现 → 几何必然，不是 A 股特性
  | 'negative' // 真实反而弱于对照 → 负向特征
  | 'disputed' // 与统计报告矛盾，或样本不足，待核对
  | 'untested'; // 尚未做安慰剂检验（多为量能类，因对照无 volume 无法测）

/** 单条规则的权重配置 */
export interface RuleWeight {
  /** 相对权重 0~1：多信号同时命中时的优先级；也是生成 prompt 时的排序依据 */
  weight: number;
  /** 证据等级 */
  evidence: EvidenceLevel;
  /** 安慰剂检验实测（真实超额 − 对照超额，百分点） */
  placebo?: { d20: number; d60: number; nReal: number };
  /** 依据说明（改动前请先读） */
  note: string;
}

/**
 * 全局打折系数：正期望类统计值的经验折扣。
 * quant_discover 自身审计：退市股 0/11 覆盖 → 正期望类真实值低 16%~32%（T2）。
 * 取中位 ≈ 0.75；仅底背离（全项目唯一通过年度稳定性检验）可按 0.9 计。
 */
export const DEFAULT_DISCOUNT = 0.75;

// ---- 权重表 ----
// 安慰剂检验条件：真实 600 只 / block bootstrap 对照 600 只（L=20），
// 采样点 146,109 vs 172,200，判据 = (形态E−基准E) − (对照形态E−对照基准E)。
// 完整报告见项目根 `形态安慰剂检验报告_0930.md`。
export const RULE_WEIGHTS: Record<string, RuleWeight> = {
  // ========== 入场 ==========
  'entry.halved': {
    weight: 1.0,
    evidence: 'verified',
    placebo: { d20: +6.13, d60: +8.10, nReal: 4075 },
    note: '安慰剂检验最强项：真实 +8.28%/胜率 64.6% vs 对照 +2.62%/53.0%，胜率差 11.6pct。约一半超额是几何必然，另一半是真实特性。打折后按 +8~16% 规划（T4）',
  },
  'entry.deep_reversal': {
    weight: 0.8,
    evidence: 'verified',
    placebo: { d20: +2.72, d60: +1.85, nReal: 3504 },
    note: '安慰剂检验通过，但价值在胜率而非期望：真实胜率 60.9% vs 对照 52.5%（+8.4pct），60 日 E 几乎持平（7.14% vs 7.13%）。是"更容易买对"，不是"买对赚更多"',
  },
  'entry.divergence': {
    weight: 0.9,
    evidence: 'untested',
    note: '⚠️ 安慰剂检验漏测（TARGETS 未包含底背离）。但它是 quant_discover 全项目**唯一通过去聚类年度稳定性检验**的信号（p=0.023），且 L0 实验中 signal 子标准 RankIC +0.102 显著。暂给高权重，待补测（todo T24）',
  },
  'entry.base_break_c': {
    weight: 0.7,
    evidence: 'disputed',
    placebo: { d20: +10.68, d60: +2.27, nReal: 34 },
    note: '⚠️ 真实侧仅 n=34（命中率 0.023%，对照反而 0.104%），单样本权重 3%，统计不可靠。且 20 日 +12.38% → 60 日 +2.18% 的回落与 d04「越长越好（180 日 +41.97%）」不符。待大样本重测（todo T22）',
  },
  'entry.spring': {
    weight: 0.4,
    evidence: 'geometric',
    placebo: { d20: +0.43, d60: -0.21, nReal: 6731 },
    note: '安慰剂检验判为几何必然：60 日对照 +5.79% > 真实 +3.73%。样本充足（6731），结论可信——spring 的"统计规律"随机序列同样具备',
  },
  'entry.pullback': {
    weight: 0.3,
    evidence: 'geometric',
    placebo: { d20: +0.22, d60: -0.94, nReal: 27796 },
    note: '几何必然（n=27796，样本最充足）。真实 E20 +1.25% 甚至低于基准 +1.38% —— 趋势内回踩在 A 股无正超额。与 d09「甜点」表述需谨慎对待',
  },

  // ========== 回避 ==========
  'avoid.shrink_break': {
    weight: 0.9,
    evidence: 'untested',
    note: '量能类规则，对照组无 volume（量比恒 1）故无法检验。依据来自 d04「出清式跌破」，另 T9 已把量比 1.5~2.1 定为最优档',
  },
  'avoid.huge_volume': {
    weight: 0.9,
    evidence: 'untested',
    note: '量能类，未检验。依据 d32：量比 >2.1 巨量是最差档（胜率 68%），p=0.002 非聚类驱动',
  },
  'avoid.shrink_pullback': {
    weight: 0.8,
    evidence: 'untested',
    note: '量能类，未检验。回调段过度缩量 <0.7× 是崩塌前兆（31.5%）',
  },
  'avoid.range_middle': {
    weight: 0.7,
    evidence: 'geometric',
    placebo: { d20: -0.14, d60: +0.71, nReal: 72589 },
    note: '安慰剂检验支持"横盘不是买点"：真实 E20 +1.06% vs 基准 +1.38%，无正超额，且与对照一致。这条回避规则的方向被实证确认',
  },
  'avoid.weak_range': {
    weight: 0.6,
    evidence: 'untested',
    note: '未检验。与 range_middle 同源（d05 横盘研究）',
  },
  'avoid.gap_filled': {
    weight: 0.5,
    evidence: 'disputed',
    placebo: { d20: -0.13, d60: +0.91, nReal: 12042 },
    note: '⚠️ **方向存疑**：本规则回避"缺口已回补"（依据 d17：已回补胜率 24%）。但安慰剂实测未回补胜率 43.5% < 已回补 45.4%，**与 d17 的 28pct 分野方向相反**。在核对定义前（todo T21），本规则不应作为强回避项',
  },

  // ========== 退出 ==========
  'exit.trail': {
    weight: 1.0,
    evidence: 'untested',
    note: 'd24~d29 唯一有效的主动退出方式（trail(10/5) E 5.41/78.2% vs 死叉 2.41/36.8%）。T11 双盲显示在 101/200 根训练窗口内无收益差异，但方向不负面，保留',
  },
  'exit.target_days': {
    weight: 0.8,
    evidence: 'untested',
    note: '持有期甜点（90/180 日）。T11 实证：训练窗口走不到甜点期，规则无法兑现——保留但降低权重，勿作为训练默认（见 RISK_GUIDE_PRESET 的窗口错配说明）',
  },
};

/** 权重档位：不同使用场景下取不同的启用集合 */
export type WeightProfile = 'conservative' | 'balanced' | 'aggressive';

let currentProfile: WeightProfile = 'balanced';

/** 设置档位 */
export function setWeightProfile(p: WeightProfile) {
  currentProfile = p;
}

/** 当前档位 */
export function getWeightProfile(): WeightProfile {
  return currentProfile;
}

/** 查单条规则权重（无配置则回退中性值） */
export function weightOf(ruleId: string): RuleWeight {
  return (
    RULE_WEIGHTS[ruleId] || {
      weight: 0.5,
      evidence: 'untested',
      note: '未配置权重，回退中性值 0.5 —— 建议补入 RULE_WEIGHTS',
    }
  );
}

/**
 * 档位过滤：该规则在当前档位下是否启用
 * - conservative 只用通过安慰剂检验的入场信号（verified），回避项全开
 * - balanced     全部启用，靠 weight 排序（默认）
 * - aggressive   全部启用且等权（用于对照实验：检验"加权是否真的更好"）
 */
export function enabledUnderProfile(ruleId: string, category: string): boolean {
  const w = weightOf(ruleId);
  if (currentProfile === 'aggressive') return true;
  if (currentProfile === 'conservative') {
    if (category !== 'entry') return true;
    return w.evidence === 'verified';
  }
  // balanced：disputed 仍启用（方向未定论但不宜直接丢弃），靠低权重体现不确定性
  return true;
}

/** 有效权重（档位激进时等权） */
export function effectiveWeight(ruleId: string): number {
  return currentProfile === 'aggressive' ? 1.0 : weightOf(ruleId).weight;
}

const STRENGTH_FACTOR: Record<SignalStrength, number> = {
  strong: 1.0,
  medium: 0.7,
  weak: 0.4,
  avoid: 1.0,
};

/**
 * 按 有效权重 × 信号强度 排序信号——解决"多信号同时命中时听谁的"。
 * 同分时保持原有顺序（规则定义顺序）。
 */
export function rankSignals(signals: Signal[]): Signal[] {
  return signals
    .map((s, i) => ({
      s,
      i,
      score: effectiveWeight(s.ruleId) * (STRENGTH_FACTOR[s.strength] ?? 0.5),
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => ({ ...x.s, weight: +x.score.toFixed(3) }));
}

/** 导出为可读表格（供 UI 展示 / 调试 / 文档生成） */
export function describeWeights(): string[] {
  return Object.entries(RULE_WEIGHTS).map(([id, w]) => {
    const p = w.placebo
      ? ` placebo 20日${w.placebo.d20 >= 0 ? '+' : ''}${w.placebo.d20}%／60日${w.placebo.d60 >= 0 ? '+' : ''}${w.placebo.d60}%／n=${w.placebo.nReal}`
      : '';
    return `${id.padEnd(22)} w=${w.weight.toFixed(2)}  [${w.evidence}]${p}`;
  });
}
