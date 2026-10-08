import { REFUTED_PATTERNS } from './avoidRules.ts';
import { FORBIDDEN_EXITS } from './holdingRules.ts';
import type { PriorStat, RuleInput, RuleVerdict, Signal } from './types.ts';
import { evaluate } from './registry.ts';

// ============================================================
// 文本生成 —— prompt 文本由规则数据自动生成，避免手写文本与代码漂移
// 措辞原则：**正向指令优先**（"只找这三类买点"），禁令只作补充
// （LLM 对"不要做 X"的执行率明显低于"做 Y"）
// ============================================================

function priorText(p?: PriorStat): string {
  if (!p) return '';
  const parts = [`${p.metric} ${p.reported}`];
  if (p.winRate) parts.push(`胜率 ${p.winRate}`);
  if (p.discounted) parts.push(`打折后 ${p.discounted}`);
  if (p.winRateDiscounted) parts.push(`胜率 ${p.winRateDiscounted}`);
  if (p.yearly) parts.push(p.yearly);
  if (p.clusterRisk) parts.push(`⚠ ${p.clusterRisk}`);
  return `【${parts.join('；')}】[${p.source}]`;
}

function sigLine(s: Signal): string {
  const mark =
    s.strength === 'strong' ? '★' : s.strength === 'medium' ? '○' : s.strength === 'avoid' ? '✗' : '·';
  return `- ${mark} ${s.ruleName}：${s.detail}${s.prior ? ` ${priorText(s.prior)}` : ''}`;
}

/** 入场规则全文（用于策略预设 / 教学） */
export function describeEntries(): string {
  const lines = ['【优先建仓形态】（按强度排序，出现时积极建仓）'];
  lines.push('- ★ 腰斩：前期翻倍后单边腰斩，出清最彻底');
  lines.push('  【90日 E +19.93%／胜率 74.1%；实操按 +8~16%／胜率 57~66%（55% 样本在 2015，属危机 alpha）】[d06]');
  lines.push('- ★ 底背离：收盘创新低但量能萎缩于前一低点（缩量新低=卖压衰竭）');
  lines.push('  【60日 E +7.78%／胜率 57.0%；11/13 年为正 p=0.023 ✅ 全项目唯一年度稳定信号】[d18]');
  lines.push('- ○ 筑底深跌破 C 组：跌破支撑 10~15% 且量能不萎缩；最优档是跌破日量比 1.5~2.1');
  lines.push('  【20日 E +14.84%／胜率 79.6%（上界）；温和放量档 E +18.28%／胜率 88.5%，p=0.002 ✅】[d04/d32]');
  lines.push('- ○ 深跌后反转：底分型／缩量反击，须前 20 日跌幅 ≥30% 才可信');
  lines.push('  【深分型 20 日胜率 66.8%；浅跌中的底部信号是噪音】[d10/d12]');
  lines.push('- ○ spring：横盘支撑假跌破收回，深度 ≥5% 更可靠【深 spring 20 日胜率 60.8%；年度摇摆剧烈】[d21]');
  lines.push('- · 趋势内首次回踩：波段回撤 <5% 才优质【创新高率 82%；第 4 次后断崖衰减】[d09]');
  return lines.join('\n');
}

/** 回避清单全文 */
export function describeAvoids(): string {
  const lines = ['【回避清单】（历史胜率低于随机基准或已被证伪，宁可错过）'];
  for (const p of REFUTED_PATTERNS) lines.push(`- ${p.name}：${p.stat} [${p.source}]`);
  lines.push('- 缩量跌破（无人接盘）：历史 4 周收益为负、分年稳定为负 [d04]');
  lines.push('- 量比 >2.1 巨量：最差档（胜率 68%），抛售未尽 [d32]');
  lines.push('- 回调段极度缩量（<0.7 倍）：买盘消失，崩塌前兆（胜率 31.5%）[d14]');
  lines.push('- 横盘区间中段开仓、弱势横盘（RPS<20）[d05/d15]');
  lines.push('- 向上缺口已回补：持有锚失效（-9.5%／24%）[d17]');
  return lines.join('\n');
}

/** 持有与卖出全文 */
export function describeHolding(): string {
  const lines = ['【持有与卖出】（d24~d29）'];
  lines.push('持有期甜点：腰斩／绝望组 90 日（40 日处是坑，勿在此离场）；筑底跌破、底背离 越长越好（180 日 +41.97%，禁止止盈）；spring U 型。');
  lines.push('唯一有效的主动退出：移动止盈 trail（腰斩 30/10、底背离 20/8、spring 20/10），或干脆持有到期。');
  lines.push('已被证伪的退出做法——不要使用：');
  for (const f of FORBIDDEN_EXITS) lines.push(`- ${f}`);
  return lines.join('\n');
}

/** 当前上下文的实时判定文本（可直接注入 AI 上下文） */
export function describeVerdict(v: RuleVerdict): string[] | null {
  const lines: string[] = ['【quantRules 判定】（程序按 quant_discover 口径自动判定，非提示词）'];
  lines.push(`周线状态：${v.weeklyState}`);
  if (v.entries.length) {
    lines.push('入场信号：');
    for (const s of v.entries) lines.push(sigLine(s));
  } else {
    lines.push('入场信号：无命中');
  }
  if (v.avoids.length) {
    lines.push('回避项：');
    for (const s of v.avoids) lines.push(sigLine(s));
  }
  if (v.holding) {
    lines.push(
      `持有建议：甜点 ${v.holding.targetDays ?? '—'} 日${v.holding.pitfallDays ? `（${v.holding.pitfallDays} 日处是坑）` : ''}；` +
        `${v.holding.allowTakeProfit ? '允许止盈' : '禁止止盈'}` +
        `${v.holding.trail ? `；trail(${v.holding.trail.activate}/${v.holding.trail.drawdown})` : ''}`,
    );
  }
  if (v.exitSignals.length) {
    lines.push('已满足的退出条件：');
    for (const s of v.exitSignals) lines.push(sigLine(s));
  }
  if (v.sizing) lines.push(`仓位：${v.sizing.note}`);
  return lines.length > 1 ? lines : null;
}

/** 一键：给定上下文，评估并生成文本 */
export function describeContext(input: RuleInput): string[] | null {
  return describeVerdict(evaluate(input));
}
