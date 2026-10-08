import type { HoldingAdvice, RuleInput } from './types.ts';

// ============================================================
// 持有策略（d24 持有期与止损全景 / d25 退出规则回测 / d26 卖出谱系）
//
// 核心结论（与直觉相反，务必按此写规则）：
// 1. 固定百分比止损是**负期望**的：-5%~-15% 各档 ΔE 全负（腰斩信号 -15% 档仍 -19pct），
//    -5% 档触发率 66~89%（噪音区），被止损的赢家后续平均还赚 +13~30%
// 2. 回撤 IC +0.49（12/12 年为正）——**浮亏越深越该拿**；浮盈 IC -0.44（约 3/4 是大盘 beta）
// 3. 唯一有效的主动退出是**移动止盈 trail**；退出规则不要叠加（OR 组合是负改进）
// ============================================================

/** 通用禁用清单（所有信号共用） */
export const FORBIDDEN_EXITS = [
  '固定百分比止损：-5%~-15% 是噪音区，各档 ΔE 全负，触发率 66~89%，被止损的赢家后续平均还赚 +13~30%（d24）',
  '时间止损（N 天不涨就出）：六信号全败，且坑位之后往往正是甜点期（d25）',
  '均线破位退出（MA20/MA60 跌破卖出）：卖飞率 70%、卖对率仅 8%、20 日内再入场 78%，期望磨掉 87%（d27）',
  '跌破支撑/前低就卖：失败判定信号 ≠ 退出规则（spring 案例 E 从 8.91 砍到 4.83）（d25）',
  'K 线形态逃顶：形态类特征 AUC ≈0.5 且年度方向翻转，事前不可识别（d28）',
  '规则叠加（OR 组合）：负改进（d29）',
];

/** 状态语义提示 */
export const STATE_SEMANTICS = [
  '浮盈是最强的反向信号（IC -0.44，其中约 3/4 是大盘 beta，剔除后 -0.125）——浮盈大时用 trail 锁定，勿因浮盈加仓（d26）',
  '回撤越深越该拿（回撤 IC +0.49，12/12 年为正；深回撤组后续 E60 +41.9% vs 浅组 -2.4%）（d26）',
  '放量滞涨是差信号（腰斩样本 E60 2.0 vs 12.2）（d26）',
];

/** 按入场信号给出持有建议 */
export function holdingAdvice(input: RuleInput): HoldingAdvice | null {
  const pos = input.position;
  if (!pos) return null;
  const id = pos.entryRuleId || '';
  const base = { forbidden: FORBIDDEN_EXITS, notes: [...STATE_SEMANTICS] };

  // A1 腰斩：90 日甜点，40 日处是坑
  if (id === 'entry.halved') {
    return {
      ...base,
      targetDays: 90,
      pitfallDays: 40,
      allowTakeProfit: false,
      trail: { activate: 30, drawdown: 10 },
      notes: [...base.notes, '40 日处常见二次回踩（E 掉到 +4.86%），勿在此离场；trail(30/10) E净 16.76 > 持有 15.14（d25）'],
      source: 'd24 / d25',
    };
  }
  // A2 筑底跌破：越长越好，禁止止盈
  if (id === 'entry.base_break_c') {
    return {
      ...base,
      targetDays: 180,
      allowTakeProfit: false,
      notes: [
        ...base.notes,
        '持有越长越好：20 日 +14.84% → 60 日 +19.64% → 120 日 +30.46% → 180 日 +41.97%（4 周窗口远未吃完）；20 日就止盈 +10% 会把期望砍掉一半（d24）',
      ],
      source: 'd24',
    };
  }
  // A3 底背离：越长越好，禁止止盈
  if (id === 'entry.divergence') {
    return {
      ...base,
      targetDays: 180,
      allowTakeProfit: false,
      trail: { activate: 20, drawdown: 8 },
      notes: [...base.notes, '180 日 E +11.64%（胜率随持有下降至 53.6%，赚的是少数大反弹）；+10% 止盈砍 3.9pct（d24）'],
      source: 'd24',
    };
  }
  // A4 spring：U 型
  if (id === 'entry.spring') {
    return {
      ...base,
      targetDays: 180,
      pitfallDays: 60,
      allowTakeProfit: true,
      trail: { activate: 20, drawdown: 10 },
      notes: [...base.notes, 'U 型：20 日可用（60.9%）→ 60 日难受（51.9%）→ 180 日再起（+14.76%）'],
      source: 'd24',
    };
  }
  // A5 回踩：趋势完好则持有，回撤扩大才减仓
  if (id === 'entry.pullback') {
    return {
      ...base,
      targetDays: null,
      allowTakeProfit: true,
      notes: [...base.notes, '用"波段回撤是否扩大"而非"涨了多少"决定减仓；第 4 次以后回踩说明波段走弱（d09）'],
      source: 'd09',
    };
  }
  // A6 深跌后反转：短持有
  if (id === 'entry.deep_reversal') {
    return {
      ...base,
      targetDays: 20,
      allowTakeProfit: true,
      notes: [...base.notes, '深跌后的反转信号是 5~20 日短持有窗口（d10/d12）'],
      source: 'd10 / d12',
    };
  }
  // 未知信号：给通用建议
  return {
    ...base,
    targetDays: 90,
    allowTakeProfit: true,
    notes: [...base.notes, '未识别入场信号类型，按通用建议：持有 90 日、风控在仓位不在止损价'],
    source: 'd24',
  };
}

/** 仓位规则：风控落在份数，不落在价格止损 */
export function sizingAdvice(input: RuleInput) {
  const maxLots = input.position?.maxLots ?? 2;
  return {
    maxLots,
    note: `单票仓位上限 ${maxLots} 份——统计上价格止损各档 ΔE 全负，风险控制请落在仓位规模而非价格止损位（d24）`,
  };
}
