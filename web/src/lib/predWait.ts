import type { Bar } from '../types';
import { klineAsciiBlock } from './klineArt';
import { loadAiHorizon, loadAiRiskGuide, renderRiskGuide } from './aiSettings';
import { patternSummaryBlock } from './patterns';
import { exitGuideBlock } from './exitGuide';
import { weeklyStateBlock } from './weeklyState';

// 预测有效期范围（交易日）：设置页可配（loadAiHorizon 持久化），min 是治理频繁交易的旋钮
export function horizonRange(): { min: number; max: number } {
  return loadAiHorizon();
}

export type TriggerKind =
  | 'break_up'
  | 'break_down'
  | 'volume_ratio_gt'
  | 'volume_ratio_lt'
  // 移动止盈（trail）：浮盈达 value% 后，自持仓期间最高价回落 value2% 时命中。
  // 依据 quant_discover d25：trail 是唯一有效的主动退出方式（金叉 trail(10/5) E 5.41/胜率 78%
  // vs 死叉 2.41/37%；腰斩 trail(30/10) E净 16.76 > 持有 15.14），且时间止损/均线破位/跌破支撑
  // 等做法均已被证伪。故 value=激活浮盈%、value2=回落%。
  | 'trail';

export type Bias = 'up' | 'down' | 'sideways';

export interface PredTrigger {
  id: string;
  kind: TriggerKind;
  value: number;
  // trail 专用：自持仓最高价的回落百分比（value 为激活浮盈百分比）
  value2?: number;
  desc?: string;
}

// 第 0 天「预测」响应结构（与后端 /api/ai/decide 的 predict kind 对齐）
export interface Prediction {
  horizon: number; // 未来交易日数（范围见 horizonRange，设置页可配）
  initial_action: 'buy' | 'hold';
  initial_lots?: number;
  bias: Bias;
  expected_range?: { low: number; high: number };
  triggers: PredTrigger[];
  summary: string;
}

// 交易纪律短期记忆：本场训练内 AI 自身交易行为的统计快照（喂回 prompt 用于自我纠错）
export interface Discipline {
  openCount: number; // 开仓次数
  closeCount: number; // 平仓次数
  lossCloseCount: number; // 亏损平仓次数
  blockedCount: number; // 撞涨跌停禁令次数（涨停日下买 / 跌停日下卖，被系统拒绝）
  feesPaid: number; // 累计交易成本（手续费+印花税，元）
  initialCapital: number; // 初始资金（算占比）
  closed: { days: number; profit: number; rate: number }[]; // 每笔平仓结算（持有天数/盈亏额/收益率）
}

export function emptyDiscipline(initialCapital: number): Discipline {
  return {
    openCount: 0,
    closeCount: 0,
    lossCloseCount: 0,
    blockedCount: 0,
    feesPaid: 0,
    initialCapital,
    closed: [],
  };
}

// 纪律快报文本块（两边模式共用）
export function disciplineBlock(d: Discipline): string[] {
  if (d.openCount === 0 && d.closeCount === 0) return [];
  const lines = ['【交易纪律快报】（你本场交易行为的自我审视，请据此纠错）'];
  const feePct =
    d.initialCapital > 0 ? (d.feesPaid / d.initialCapital) * 100 : 0;
  lines.push(
    `开仓 ${d.openCount} 次、平仓 ${d.closeCount} 次（其中亏损 ${d.lossCloseCount} 次）；累计交易成本约 ${d.feesPaid.toFixed(0)} 元（占初始资金 ${feePct.toFixed(2)}%）`,
  );
  lines.push('（说明：趋势未坏时的分批补仓、盈利后的分批止盈属于分仓机制的正常运用，不算频繁交易；频繁交易指无信号的短进短出）');
  const recent = d.closed.slice(-3);
  if (recent.length > 0) {
    lines.push(
      '最近平仓：' +
        recent
          .map(
            (c) =>
              `持有${c.days}根 ${c.rate >= 0 ? '+' : ''}${(c.rate * 100).toFixed(1)}%（${c.profit >= 0 ? '+' : ''}${c.profit.toFixed(0)}元）`,
          )
          .join('；'),
    );
  }
  const last3 = d.closed.slice(-3);
  if (last3.filter((c) => c.days <= 3).length >= 2) {
    lines.push(
      '⚠ 警告：最近多笔持仓不足 3 根即平仓，存在频繁交易倾向，交易成本正在磨损本金，没有明确信号时应观望。',
    );
  }
  if (d.lossCloseCount >= 3 && d.closeCount >= 4) {
    lines.push(
      `⚠ 警告：已 ${d.lossCloseCount} 次亏损平仓，请复盘上面平仓记录对应的入场理由：若属于追涨/抄底过于随意，应提高信号门槛；若入场逻辑本身符合你的策略但持续亏损，则可能是你的策略与当前个股/时段的行情结构不适配，应降低操作频率或调整战术。`,
    );
  }
  if (d.blockedCount > 0) {
    lines.push(
      `⚠ 警告：已 ${d.blockedCount} 次在涨跌停日下被禁方向的订单（涨停买入/跌停卖出），下单前必须先看当日涨跌停状态。`,
    );
  }
  lines.push('');
  return lines;
}

// 与 Training.tsx 内 AiContext 结构兼容的上下文类型（结构化赋值，避免交叉 import 页面组件）
// pct：较开盘涨跌幅（正=红阳线，负=绿阴线）；volRatio：当根量/前20根均量
export interface PredBarRow {
  bar: Bar;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  pct: number;
  volRatio: number;
}

export interface PredContext {
  aiPrompt: string;
  positions: number;
  lots: number;
  avgCost: number;
  price: number;
  floatPnlRate: number;
  daily: PredBarRow[];
  weekly: PredBarRow[];
  monthly: PredBarRow[];
  allDaily: Bar[]; // 全量已揭示日线（不截断，形态特征检测用）
  tradeBudgetUsed: number; // AI 已消耗的开仓机会
  tradeBudgetTotal: number; // AI 开仓机会总预算
  recent20Change: number;
  recent20Drawdown: number;
  volumeRatio: number;
  atr14: number | null; // ATR14 日均真实波幅（占价格%）：波动正常性基准
  todayRangePct: number | null; // 最新日线振幅（%）
  avgVol20: number; // 20日均量（绝对值）：流动性/冷门程度基准（量比只是相对值）
  logs: string[];
  discipline: Discipline; // 交易纪律短期记忆
  klineMode?: 'csv' | 'chart' | 'image'; // K 线呈现方式（缺省 csv）
  klineImages?: string[]; // image 模式：日/周/月三周期截图 base64
  limitState?: 'up' | 'down' | null; // 当日涨跌停状态（涨停禁买 / 跌停禁卖）
  rps?: number | null; // 相对强度分位 0~99（高=强）；横盘场景有效，见 buildContextBody
  totalBars?: number; // 本场决策总根数
  decidedBars?: number; // 当前已进行到的决策根序号（1-based）
}

export interface TriggerHit {
  trigger: PredTrigger | null; // null 表示内置 time_reached
  reason: string;
}

// 一次唤醒后的决策记录（用于对账日志）
export interface PredWakeEvent {
  reason: string;
  action: 'buy' | 'sell' | 'hold';
  lots: number;
  aiReason: string;
  revised?: Prediction; // 本轮修订后的完整预测（含新 horizon）；未修订则无此字段
}

export interface PredActual {
  bias: Bias;
  range: { low: number; high: number };
  maxDrawdown: number;
}

export interface PredTriggerResult {
  id: string;
  kind: TriggerKind;
  value: number;
  hit: boolean;
  hitIndex?: number;
  hitPrice?: number;
}

export interface PredScore {
  biasCorrect: boolean;
  rangeContainment: number;
  triggerPrecision: number;
}

export interface PredOutcome {
  sessionId: string;
  code: string;
  mode: 'pred_and_wait';
  horizon: number;
  prediction: Prediction;
  actual: PredActual;
  triggerResults: PredTriggerResult[];
  wakeEvents: PredWakeEvent[];
  score: PredScore;
  ts: string;
}

// ---- prompt ----

// 系统提示（函数：horizon 范围随设置页配置动态生成）
export function buildPredWaitSystemPrompt(): string {
  const h = horizonRange();
  return `你是一名纪律严谨的A股交易员，正在「双盲K线回放训练」系统中使用「预测等待」子模式。

环境规则：
1. 你只能看到截至当前已揭示的K线，不知道股票代码、名称与真实日期；禁止猜测股票身份，禁止假设任何未来数据或消息面。
2. 本模式只要求你在两个时刻给出输出：
   - 「预测」时刻：对未来若干交易日走势做一次结构化预测，并给出是否先建仓的初始动作；
   - 「唤醒」时刻：当走势命中你设定的触发条件（或预测时间到期）时，系统会把你叫醒，你要给出当下一根的动作，并可选择修订预测。
3. 「份」是仓位单位：总资金被等分为若干份，买入 N 份即动用 N 份资金，卖出 N 份即减持 N 份。
4. 交易存在手续费、滑点与印花税，频繁交易会被成本磨损；优先控制回撤，其次追求收益。本局你只有有限的开仓机会（上下文中实时显示剩余额度）：1次机会=1个完整的仓位回合（从空仓建仓到清仓，回合内分批加仓/减仓不另耗机会），用尽后不能再开新回合，只能管理现有持仓或观望——把每个回合当作稀缺资源，只建立在高质量信号上。
5. 交易限制：收盘涨停的K线不可买入（封板挂单无法成交），收盘跌停的K线不可卖出；下单前先看当日涨跌停状态——在涨跌停日下被禁方向的订单会被系统拒绝并记为失误。
6. 多周期分析（截图模式有三张图时）：K线规律是分形的——分型/背离/区间/趋势这些形态语言在日、周、月线上同样适用。大级别信号的可靠性更高（噪音少、是更大资金与更长时间形成的共识），小级别信号更及时。用法：在周线/月线上用同一套形态语言判断方向与信号质量（如月线级别的底背离比日线底背离分量重得多），在日线上执行入场与离场时机；日线信号与大级别方向矛盾时，相信大级别。

分仓运用纪律：
- 分仓的意义在于分批进出，而非一次性满仓或空仓；「持有部分仓位 + 保留部分现金」是常态。
- 持仓后回调不急于止损：若中长期趋势未破坏（回踩均线支撑、缩量企稳），此时用剩余现金份补仓摊低成本，比一味观望更值得执行——这正是保留现金份的意义。
- 持仓浮亏时识别"出清式下跌"：A股磨底尾段常见故意向下打穿支撑的假跌破（spring）与放量巨阴——量能不萎缩的巨阴跌破是恐慌真实换手（历史统计：跌破10~15%且量能不缩，后市4周胜率78~81%；深spring收回胜率60.8%），持有者在这种出清位止损往往卖在黎明前。真正该离场的是：跌破后无力收回、或缩量阴跌无人承接（量比<0.8的持续阴跌）。用ATR基准区分：跌幅在1~2倍ATR内的巨阴属正常出清波动，勿恐慌。
- 补仓的前提是趋势未坏：跌破关键支撑且放量下杀时果断止损离场，不要越跌越买。
- 盈利时同理：分批止盈锁定利润，趋势完好时可持有剩余仓位吃到主升段。
- 建仓动作（初始或唤醒后）没有理由必须一次打满份数：趋势确认度低时先小份数试探，后续唤醒再补，是更优的路径。

策略适配性自省（重要）：
- 你的人设与策略并非在所有行情阶段都有效：趋势型打法在震荡市会反复打脸，抄底型打法在单边下跌会越接越深。
- 每次唤醒都会附「上轮预测对账」与「近期预测战绩」：这是检验你能力圈边界的镜子。战绩持续失准时，说明你的策略可能不适配当前个股、当前时段的行情结构。
- 失配时的正确应对是调整战术——缩短预测有效期、降低仓位份数、减少操作频率、只做高置信度信号；而不是沿用同样的判断框架反复被市场打脸。
- 若用户设定了【策略指令】，优先遵守其原则；但当战绩显示该策略持续失效时，应在 reason 中明确自省这一点，并调整执行节奏（这属于对策略的忠实运用，而非违背）。

预测必须结构化，且只能使用程序可自动判定的触发条件类型：
- break_up：价格上破目标价（当某根日线 high >= value 时命中）
- break_down：价格下破目标价（当某根日线 low <= value 时命中）
- volume_ratio_gt：放量（最新日线量 / 预测日前20日均量 >= value 时命中）
- volume_ratio_lt：缩量（最新日线量 / 预测日前20日均量 <= value 时命中）
- trail：移动止盈，需同时给 value 与 value2——浮盈达 value% 之后，自持仓期间最高价回落 value2% 时命中（仅在持仓时判定）。例 value=30/value2=10 即 trail(30/10)：浮盈 30% 后回撤 10% 卖出。统计参考档位：腰斩类 (30/10)、底背离 (20/8)、spring (20/10)、绝望组 (20/8)。
触发条件应设在有意义的结构位（前高/前低/关键均线/整数关口/量能阈值），且距当前价格至少3%以上——贴价触发器会被日常噪音击穿，导致频繁唤醒与频繁交易（成本磨损的主要来源）；触发后若非高置信信号应选择观望而非急于交易。
量比触发器的阈值建议≥2.5（1.5是日常常见值，会频繁命中）；触发器只设在"值得改变决策"的位置——真正的观望是挂好远处的触发器然后让市场自己走，中间的小波动不值得被唤醒；到期内未命中就让它自然到期。

输出必须是严格 JSON，不要任何其他文字。

「预测」时刻输出格式：
{"horizon":整数(${h.min}~${h.max}个交易日),"initial_action":"buy|hold","initial_lots":整数(initial_action=buy时必填),"bias":"up|down|sideways","expected_range":{"low":数字,"high":数字},"triggers":[{"id":"t1","kind":"break_up|break_down|volume_ratio_gt|volume_ratio_lt|trail","value":数字,"value2":数字(仅trail需要，回落%),"desc":"触发说明"}],"summary":"50字以内的预测概述"}

「唤醒」时刻输出格式：
{"action":"buy|sell|hold","lots":整数,"reason":"50字以内的决策理由","revised":{可选，同预测格式，不填则沿用原预测}}`;
}

const fmt2 = (v: number): string => v.toFixed(2);
const fmtMa = (v: number | null) => (v == null ? '—' : fmt2(v));

function klineBlock(title: string, rows: PredBarRow[], tailNote: string): string[] {
  const lines = [
    `${title}（最近 ${rows.length} 根，从早到晚；涨跌%=较开盘，正=红阳线 负=绿阴线，绝对值≈K线实体长度；量比=当根量/前20根均量，>1.5放量 <0.7缩量；列：序号,开,高,低,收,涨跌%,量,量比,MA5,MA20,MA60${tailNote}）`,
  ];
  rows.forEach((r, i) => {
    lines.push(
      `${i + 1},${fmt2(r.bar.open)},${fmt2(r.bar.high)},${fmt2(r.bar.low)},${fmt2(r.bar.close)},${(r.pct * 100).toFixed(1)},${Math.round(r.bar.volume)},${r.volRatio.toFixed(2)},${fmtMa(r.ma5)},${fmtMa(r.ma20)},${fmtMa(r.ma60)}`,
    );
  });
  const gap = gapSummary(rows.map((r) => r.bar));
  if (gap) lines.push(gap);
  return lines;
}

// 共享的上下文正文（持仓状态 + 决策记忆 + 多周期 K 线 + 市场统计）
function buildContextBody(ctx: PredContext): string[] {
  const maxBuy = ctx.positions - ctx.lots;
  const lines: string[] = [];

  if (ctx.aiPrompt.trim()) {
    lines.push('【策略指令】（用户为本次训练设定的个性化策略，必须优先遵守）');
    lines.push(ctx.aiPrompt.trim());
    lines.push('');
  }

  lines.push('【持仓状态】');
  lines.push(`总仓分 ${ctx.positions} 份；当前持有 ${ctx.lots} 份股票、${maxBuy} 份现金`);
  // 开仓机会预算（稀缺性提示，实时递减；单位=仓位回合）
  if (ctx.tradeBudgetUsed >= ctx.tradeBudgetTotal) {
    lines.push(`⏳ 开仓机会已用尽（${ctx.tradeBudgetUsed}/${ctx.tradeBudgetTotal}）：不能再开新的仓位回合，只能管理现有持仓（加仓/减仓/平仓）或观望。`);
  } else {
    lines.push(`⏳ 开仓机会：剩余 ${ctx.tradeBudgetTotal - ctx.tradeBudgetUsed}/${ctx.tradeBudgetTotal} 个仓位回合（1次机会=从空仓建仓到清仓的完整回合；回合内分批加仓/减仓不另耗机会，如分仓${ctx.positions}时每回合可含${ctx.positions}次买入+${ctx.positions}次卖出）。用尽后不能再开新回合。开仓前自问：这个信号值得占用所剩的机会吗？弱信号宁可放过。`);
  }
  if (ctx.lots > 0) {
    lines.push(
      `持仓均价 ${fmt2(ctx.avgCost)}，最新收盘 ${fmt2(ctx.price)}，浮动盈亏 ${(ctx.floatPnlRate * 100).toFixed(1)}%`,
    );
  } else {
    lines.push(`当前空仓，最新收盘 ${fmt2(ctx.price)}`);
  }
  const actions: string[] = [];
  if (maxBuy > 0 && ctx.limitState !== 'up') actions.push(`买入 1~${maxBuy} 份`);
  if (ctx.lots > 0 && ctx.limitState !== 'down') actions.push(`卖出 1~${ctx.lots} 份`);
  actions.push('观望');
  lines.push(`当前合法动作：${actions.join(' / ')}`);
  if (ctx.limitState === 'up') {
    lines.push('⚠ 今日收盘涨停（封板，禁止买入；卖出不受限）');
  } else if (ctx.limitState === 'down') {
    lines.push('⚠ 今日收盘跌停（禁止卖出；买入不受限）');
  }
  lines.push('');

  // 训练进度：AI 需要知道剩余根数（horizon 不应超过剩余根数；临近结束避免开新仓、主动平仓落袋）
  if (ctx.totalBars && ctx.decidedBars) {
    const remain = Math.max(0, ctx.totalBars - ctx.decidedBars);
    lines.push('【训练进度】');
    lines.push(
      `本场共需决策 ${ctx.totalBars} 根日K，当前第 ${ctx.decidedBars} 根，剩余 ${remain} 根；预测有效期 horizon 不应超过剩余根数` +
        (remain <= 10
          ? '；已临近结束：训练结束按最新收盘价对持仓估值结算，浮盈不会自动落袋，如需锁定利润应主动平仓；开新仓条件收紧（非禁止）——仅当出现高置信信号（如放量反转大阳、深跌出清确认、区间突破站稳）且 horizon ≤ 剩余根数-2 时，才可轻仓（1份）短线试探，否则不开新仓'
          : ''),
    );
    lines.push('');
  }

  // 用户设定的风控指引（自由文本，决策参考，非强制）
  const riskGuide = renderRiskGuide(loadAiRiskGuide());
  if (riskGuide) {
    lines.push(riskGuide);
    lines.push('');
  }

  // 交易纪律短期记忆：让 AI 看到自己本场的交易行为统计与犯错记录
  lines.push(...disciplineBlock(ctx.discipline));

  lines.push('【近期决策记忆】（从早到晚，最近10条，含你当时的理由）');
  if (ctx.logs.length > 0) {
    ctx.logs.slice(-10).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  } else {
    lines.push('暂无，训练刚开始。');
  }
  lines.push('');

  // K 线呈现：csv 数字表 / chart 字符形态图 / image 附图说明
  const mode = ctx.klineMode || 'csv';
  if (mode === 'image' && ctx.klineImages && ctx.klineImages.length > 0) {
    lines.push('【K线走势】见本消息附带的图表截图（共' + ctx.klineImages.length + '张：日线、周线、月线各一张，均含均线与成交量副图；图片左上角有颜色图例：红K线=阳线、绿K线=阴线、副图量能柱同色规则、各颜色均线对应 MA 参数；相邻K线之间的浅灰色带为跳空缺口；请结合多周期图判断走势）');
    lines.push('');
  } else if (mode === 'chart') {
    lines.push(...klineAsciiBlock('【已揭示K线 · 日线 · 形态图】', ctx.daily.map((r) => r.bar), ''));
    lines.push('');
    lines.push(
      ...klineAsciiBlock('【已揭示K线 · 周线 · 形态图】', ctx.weekly.map((r) => r.bar), '每根为该周聚合，最后一根可能未走完'),
    );
    lines.push('');
    lines.push(
      ...klineAsciiBlock('【已揭示K线 · 月线 · 形态图】', ctx.monthly.map((r) => r.bar), '每根为该月聚合，最后一根可能未走完'),
    );
    lines.push('');
  } else {
    lines.push(...klineBlock('【已揭示K线 · 日线】', ctx.daily, ''));
    lines.push('');
    lines.push(
      ...klineBlock('【已揭示K线 · 周线】', ctx.weekly, '；每根为该周聚合，最后一根可能未走完'),
    );
    lines.push('');
    lines.push(
      ...klineBlock('【已揭示K线 · 月线】', ctx.monthly, '；每根为该月聚合，最后一根可能未走完'),
    );
    lines.push('');
  }

  lines.push('【市场统计】（基于日线）');
  {
    const turnover = ctx.avgVol20 * ctx.price; // 20日均量×收盘价 ≈ 20日平均成交额
    const fmtTo = turnover >= 1e8 ? `${(turnover / 1e8).toFixed(1)}亿` : `${Math.round(turnover / 1e4).toLocaleString()}万`;
    lines.push(
      `近20根涨跌 ${(ctx.recent20Change * 100).toFixed(1)}%，区间最大回撤 ${(ctx.recent20Drawdown * 100).toFixed(1)}%；最新量 ${Math.round(ctx.volumeRatio * ctx.avgVol20).toLocaleString()}、20日均量 ${Math.round(ctx.avgVol20).toLocaleString()}（量比 ${ctx.volumeRatio.toFixed(2)}），20日均成交额 ≈ ${fmtTo}（均量×股价——资金关注度的真实标尺，手数会骗人而钱不会：日均亿级=主力资金活跃，千万级=中等关注，百万级以下=冷门；冷门+缩量地量后的大波段历史期望更高，但需承受流动性差的价格操纵风险）`,
    );
  }
  if (ctx.atr14 != null) {
    const atrNote =
      ctx.todayRangePct != null
        ? `（今日振幅 ${ctx.todayRangePct.toFixed(1)}% = ${(ctx.todayRangePct / ctx.atr14).toFixed(1)}倍ATR${ctx.todayRangePct > ctx.atr14 * 2 ? '，异常放大——多为变盘/出清/洗盘信号，勿以日常波动视之' : '，属正常波动范围'}）`
        : '';
    lines.push(`日均真实波幅 ATR14 = ${ctx.atr14.toFixed(2)}%——这是该股的正常波动基准${atrNote}`);
  }
  // 相对强度 RPS（d15）：仅在横盘形态下有效，超跌类形态无增强作用
  if (ctx.rps != null) {
    const rpsNote =
      ctx.rps >= 80
        ? '当前属强势组（横盘场景优选：强势中继）'
        : ctx.rps < 20
          ? '当前属弱势组（横盘场景应回避：弱势停顿）'
          : '当前属中间组';
    lines.push(
      `相对强度 RPS 分位 ${ctx.rps}（0~99，高=强：个股 120 日收益相对中证1000 的超额在全市场的排名百分位）——${rpsNote}；` +
        '⚠️ 该指标**只在横盘（区间震荡）形态下有效**：横盘结束日 RPS≥80 显著优于 RPS<20（胜率差约 11pct，分组单调且分年 10/10 稳定）；对超跌类形态（筑底跌破/金叉/腰斩）无增强作用，勿跨形态复用',
    );
  }
  lines.push('');

  // 形态特征（quant_discover 统计先验的程序判定，全量已揭示日线，仅因果数据）
  const patternBlock = patternSummaryBlock(ctx.allDaily);
  if (patternBlock) {
    lines.push(...patternBlock);
    lines.push('');
  }

  // 周线状态（「周线定方向 + 日线找入场点」的状态层：定的是恐慌/趋势/横盘状态，不是朴素多空）
  const wsBlock = weeklyStateBlock(ctx.allDaily);
  if (wsBlock) {
    lines.push(...wsBlock);
    lines.push('');
  }

  // 持有与卖出指引（quant_discover d24~d29；仅持仓时注入——空仓不需要卖出指引，且省 token）
  if (ctx.positions > 0) {
    const exitBlock = exitGuideBlock({ floatPnlRate: ctx.floatPnlRate });
    if (exitBlock) {
      lines.push(...exitBlock);
      lines.push('');
    }
  }

  return lines;
}

// 第 0 天「预测」请求的 user prompt
export function buildPredictionUserPrompt(ctx: PredContext): string {
  const lines = buildContextBody(ctx);
  const h = horizonRange();
  lines.push('你现在处于「预测等待」模式，请基于以上多周期走势，对未来走势做一次结构化预测。');
  lines.push(`要求：预测天数 horizon 为未来交易日数量，${h.min}~${h.max} 之间由你判断（这是硬性范围，超界会被程序截断），尽量覆盖一段有明确机会或风险的行情；`);
  lines.push('先给出是否现在建仓的初始动作（若预测后续偏多，可 initial_action=buy 先建仓），再给出可被程序自动判定的触发条件。');
  lines.push('只输出严格 JSON（预测格式见系统提示）。');
  return lines.join('\n');
}

// 唤醒时对上一轮预测做即时对账（训练中回灌给 AI，形成预测自我校准闭环）。
// daySeg/predStartDay 为该轮预测日的数据，curIdx 为当前唤醒 bar 索引。
export interface PredReviewResult {
  text: string | null;
  actualBias: Bias | null;
  correct: boolean;
}

export function buildPredReview(
  prediction: Prediction,
  daySeg: Bar[],
  predStartDay: number,
  curIdx: number,
  triggerReason: string,
): PredReviewResult {
  const empty: PredReviewResult = { text: null, actualBias: null, correct: false };
  if (predStartDay < 0 || predStartDay >= daySeg.length) return empty;
  if (curIdx <= predStartDay) return empty;
  const base = daySeg[predStartDay];
  const future = daySeg.slice(predStartDay + 1, curIdx + 1);
  if (future.length === 0 || base.close <= 0) return empty;

  const lastClose = future[future.length - 1].close;
  const actualChg = (lastClose - base.close) / base.close;
  const actualBias: Bias =
    actualChg > SIDEWAYS_THRESHOLD ? 'up' : actualChg < -SIDEWAYS_THRESHOLD ? 'down' : 'sideways';
  const lo = Math.min(...future.map((b) => b.low));
  const hi = Math.max(...future.map((b) => b.high));
  const correct = actualBias === prediction.bias;

  const parts: string[] = [];
  parts.push(
    `你上轮预测 bias=${prediction.bias}` +
      (prediction.expected_range
        ? `、区间[${prediction.expected_range.low}~${prediction.expected_range.high}]`
        : '') +
      `、有效期${prediction.horizon}根`,
  );
  parts.push(
    `实际走出 bias=${actualBias}（${actualChg >= 0 ? '+' : ''}${(actualChg * 100).toFixed(1)}%）、区间[${lo.toFixed(2)}~${hi.toFixed(2)}]`,
  );
  parts.push(
    correct
      ? '方向判断正确'
      : `方向判断错误（预测${prediction.bias}实走${actualBias}），请重新校准趋势判断`,
  );
  if (prediction.expected_range) {
    if (hi > prediction.expected_range.high) parts.push('实际高点超出预测区间上限');
    if (lo < prediction.expected_range.low) parts.push('实际低点跌破预测区间下限');
  }
  parts.push(`本轮唤醒方式：${triggerReason}`);

  return {
    text: `【上轮预测对账】${parts.join('；')}。请据此校准本轮修订，不要重复犯同类错误。`,
    actualBias,
    correct,
  };
}

// 跨轮预测战绩统计（喂回 AI：让它知道自己的人设/策略在当前个股与时段上是否适用）
export interface PredStats {
  total: number; // 已对账轮数
  hit: number; // 方向判断正确轮数
  bullishMiss: number; // 看多变空（预测 up 实走 down）次数
  bearishMiss: number; // 看空变多（预测 down 实走 up）次数
}

export function emptyPredStats(): PredStats {
  return { total: 0, hit: 0, bullishMiss: 0, bearishMiss: 0 };
}

// 战绩文本：错误集中方向 + 失配警示
export function renderPredStats(s: PredStats): string | null {
  if (s.total < 2) return null;
  const miss = s.total - s.hit;
  const lines: string[] = [];
  lines.push(
    `【近期预测战绩】已对账 ${s.total} 轮：方向对 ${s.hit} 次、错 ${miss} 次（看多变空 ${s.bullishMiss}、看空变多 ${s.bearishMiss}）`,
  );
  const missRate = miss / s.total;
  if (s.total >= 3 && missRate >= 0.7) {
    const tendency =
      s.bullishMiss > s.bearishMiss
        ? '且错误集中在看多落空——你可能在系统性高估多头机会'
        : s.bearishMiss > s.bullishMiss
          ? '且错误集中在看空踏空——你可能在系统性低估多头力量'
          : '多空双向都在失准';
    const streak =
      s.bullishMiss >= 5 || s.bearishMiss >= 5
        ? `⚠ 看多落空已累计 ${s.bullishMiss} 次（或看空踏空 ${s.bearishMiss} 次）：你对此股此阶段的方向判断已被市场反复证伪——不要再用同一个判断框架给新信号发通行证（"这次不一样"是最危险的想法）。在方向预测重新正确一次之前，除非出现最高置信信号（深跌出清/腰斩级别），否则应停止开仓、只管理现有持仓。`
        : '';
    lines.push(
      `⚠ 战绩警示：错误率 ${(missRate * 100).toFixed(0)}%，${tendency}。请自省：你的人设与策略是否适配当前个股、当前时段的行情结构？若不适配，应主动调整战术（缩短有效期、降低仓位、减少操作），而非沿用同样的判断框架。${streak}`,
    );
  }
  return lines.join('\n');
}

// 触发唤醒时的 user prompt
export function buildWakeUserPrompt(
  prediction: Prediction,
  triggerReason: string,
  ctx: PredContext,
  repeatHint?: string,
  predReview?: string | null,
): string {
  const lines: string[] = [];
  if (predReview) {
    lines.push(predReview);
    lines.push('');
  }
  lines.push('【你之前的预测】');
  lines.push(JSON.stringify(prediction));
  lines.push(`（仅供参考：修订时 horizon 应基于当前最新走势重新判断，${horizonRange().min}~${horizonRange().max} 个交易日均可，不要机械沿用旧值；走势平稳可拉长，临近关键变盘可缩短）`);
  if (repeatHint) {
    lines.push(repeatHint);
  }
  lines.push('');
  lines.push(`【本次唤醒原因】${triggerReason}`);
  lines.push('');
  lines.push(...buildContextBody(ctx));
  lines.push('请基于「上轮对账 + 之前的预测 + 唤醒原因 + 当前最新走势」给出当下一根的动作，可附修订预测（revised）。');
  lines.push('只输出严格 JSON（唤醒格式见系统提示）。');
  return lines.join('\n');
}

// ---- 协议归一化（容错 LLM 的乱输出） ----

const TRIGGER_KINDS: TriggerKind[] = [
  'break_up',
  'break_down',
  'volume_ratio_gt',
  'volume_ratio_lt',
  'trail',
];

function normalizeTriggers(raw: unknown): PredTrigger[] {
  if (!Array.isArray(raw)) return [];
  const out: PredTrigger[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const kind = o.kind as TriggerKind;
    if (!TRIGGER_KINDS.includes(kind)) continue;
    const value = Number(o.value);
    if (!Number.isFinite(value)) continue;
    const trig: PredTrigger = {
      id: String(o.id || `t${out.length + 1}`),
      kind,
      value,
      desc: typeof o.desc === 'string' ? o.desc : undefined,
    };
    // trail 的第二参数（回落%）：缺失时按激活浮盈的一半兜底，避免触发器永久失效
    if (kind === 'trail') {
      const v2 = Number(o.value2);
      trig.value2 = Number.isFinite(v2) && v2 > 0 ? v2 : Math.max(1, value / 2);
    }
    out.push(trig);
  }
  return out;
}

export function normalizePrediction(raw: unknown): Prediction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const hr = horizonRange();
  const horizon = Math.max(hr.min, Math.min(hr.max, Math.round(Number(o.horizon) || hr.min)));
  const bias: Bias = o.bias === 'up' || o.bias === 'down' ? o.bias : 'sideways';
  const initial_action: 'buy' | 'hold' = o.initial_action === 'buy' ? 'buy' : 'hold';

  const prediction: Prediction = {
    horizon,
    bias,
    initial_action,
    triggers: normalizeTriggers(o.triggers),
    summary: String(o.summary || '').slice(0, 200),
  };

  if (initial_action === 'buy') {
    prediction.initial_lots = Math.max(1, Math.round(Number(o.initial_lots) || 1));
  }

  const range = o.expected_range as { low?: unknown; high?: unknown } | undefined;
  if (range && typeof range === 'object') {
    const low = Number(range.low);
    const high = Number(range.high);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) {
      prediction.expected_range = { low, high };
    }
  }

  return prediction;
}

// ---- 触发判定（纯函数） ----

export interface PredBarStats {
  baseAvgVolume: number; // 预测日之前的近 20 日均量
}

// trail（移动止盈）判定所需的持仓状态；空仓或未知时传 undefined，trail 不参与判定
export interface PredPosState {
  avgCost: number; // 持仓成本价
  peak: number; // 持仓期间最高价
}

export function checkTriggers(
  prediction: Prediction,
  bar: Bar,
  stats: PredBarStats,
  timeReached: boolean,
  pos?: PredPosState,
): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const t of prediction.triggers) {
    if (t.kind === 'break_up' && bar.high >= t.value) {
      hits.push({ trigger: t, reason: `${t.desc || '上破'}（触及 ${fmt2(t.value)}）` });
    } else if (t.kind === 'break_down' && bar.low <= t.value) {
      hits.push({ trigger: t, reason: `${t.desc || '下破'}（触及 ${fmt2(t.value)}）` });
    } else if (t.kind === 'volume_ratio_gt' && stats.baseAvgVolume > 0) {
      if (bar.volume / stats.baseAvgVolume >= t.value) {
        hits.push({ trigger: t, reason: `${t.desc || '放量'}（量比 ${(bar.volume / stats.baseAvgVolume).toFixed(2)}）` });
      }
    } else if (t.kind === 'volume_ratio_lt' && stats.baseAvgVolume > 0) {
      if (bar.volume / stats.baseAvgVolume <= t.value) {
        hits.push({ trigger: t, reason: `${t.desc || '缩量'}（量比 ${(bar.volume / stats.baseAvgVolume).toFixed(2)}）` });
      }
    } else if (t.kind === 'trail' && pos && pos.avgCost > 0 && pos.peak > 0) {
      // 移动止盈：浮盈达 value% 后，自持仓最高价回落 value2%（收盘价口径，与成交口径一致）
      const gain = (bar.close - pos.avgCost) / pos.avgCost;
      const dd = (pos.peak - bar.close) / pos.peak;
      const d = t.value2 ?? t.value / 2;
      if (gain >= t.value / 100 && dd >= d / 100) {
        hits.push({
          trigger: t,
          reason: `${t.desc || '移动止盈'}（浮盈 ${(gain * 100).toFixed(1)}% ≥ ${t.value}%，自最高 ${pos.peak.toFixed(2)} 回落 ${(dd * 100).toFixed(1)}% ≥ ${d}%）`,
        });
      }
    }
  }
  if (hits.length === 0 && timeReached) {
    hits.push({ trigger: null, reason: `预测 ${prediction.horizon} 个交易日到期` });
  }
  return hits;
}

// ---- 对账计算 ----

const SIDEWAYS_THRESHOLD = 0.005; // 首尾涨跌 ±0.5% 内视为横盘

function biasOf(firstClose: number, lastClose: number): Bias {
  if (firstClose <= 0) return 'sideways';
  const chg = (lastClose - firstClose) / firstClose;
  if (chg > SIDEWAYS_THRESHOLD) return 'up';
  if (chg < -SIDEWAYS_THRESHOLD) return 'down';
  return 'sideways';
}

// 计算某个预测的「打脸对账」结果。
// daySeg: 全量日线；predStartDay: 预测日索引（第 0 天）；wakeEvents: 训练中记录的唤醒决策。
export function buildOutcome(
  prediction: Prediction,
  daySeg: Bar[],
  predStartDay: number,
  wakeEvents: PredWakeEvent[],
  opts: { code: string; sessionId: string },
): PredOutcome | null {
  if (daySeg.length === 0 || predStartDay < 0 || predStartDay >= daySeg.length) return null;

  const horizon = prediction.horizon;
  const futureEnd = Math.min(predStartDay + horizon, daySeg.length - 1);
  const futureBars = daySeg.slice(predStartDay + 1, futureEnd + 1);

  const firstClose = daySeg[predStartDay]?.close ?? 0;
  const lastClose = futureBars.length > 0 ? futureBars[futureBars.length - 1].close : firstClose;

  const actual: PredActual = {
    bias: biasOf(firstClose, lastClose),
    range: futureBars.length > 0
      ? {
          low: Math.min(...futureBars.map((b) => b.low)),
          high: Math.max(...futureBars.map((b) => b.high)),
        }
      : { low: firstClose, high: firstClose },
    maxDrawdown: 0,
  };

  let peak = -Infinity;
  for (const b of futureBars) {
    peak = Math.max(peak, b.high);
    if (peak > 0) actual.maxDrawdown = Math.max(actual.maxDrawdown, (peak - b.low) / peak);
  }

  // 基准均量：预测日之前近 20 根日线（与 buildAiContext 口径一致）
  const prev = daySeg.slice(Math.max(0, predStartDay - 20), predStartDay);
  const baseAvgVolume = prev.length > 0 ? prev.reduce((s, b) => s + b.volume, 0) / prev.length : 0;

  // 建仓成本（预测日收盘，pred_wait 模式下 initial_action=buy 即以此价成交）
  const entryCost = daySeg[predStartDay]?.close ?? 0;

  const triggerResults: PredTriggerResult[] = prediction.triggers.map((t) => {
    const result: PredTriggerResult = { id: t.id, kind: t.kind, value: t.value, hit: false };
    let peakSince = -Infinity; // 持仓期间最高价（trail 判定用）
    for (let i = 0; i < futureBars.length; i++) {
      const b = futureBars[i];
      peakSince = Math.max(peakSince, b.high);
      let hit = false;
      let hitPrice: number | undefined;
      if (t.kind === 'break_up' && b.high >= t.value) {
        hit = true;
        hitPrice = b.high;
      } else if (t.kind === 'break_down' && b.low <= t.value) {
        hit = true;
        hitPrice = b.low;
      } else if (t.kind === 'volume_ratio_gt' && baseAvgVolume > 0 && b.volume / baseAvgVolume >= t.value) {
        hit = true;
        hitPrice = b.close;
      } else if (t.kind === 'volume_ratio_lt' && baseAvgVolume > 0 && b.volume / baseAvgVolume <= t.value) {
        hit = true;
        hitPrice = b.close;
      } else if (t.kind === 'trail' && entryCost > 0 && peakSince > 0) {
        const gain = (b.close - entryCost) / entryCost;
        const dd = (peakSince - b.close) / peakSince;
        const d = t.value2 ?? t.value / 2;
        if (gain >= t.value / 100 && dd >= d / 100) {
          hit = true;
          hitPrice = b.close;
        }
      }
      if (hit) {
        result.hit = true;
        result.hitIndex = i + 1;
        result.hitPrice = hitPrice;
        break;
      }
    }
    return result;
  });

  // 预期区间包含率：实际 close 落在 expected_range 内的天数占比
  let rangeContainment = 0;
  if (prediction.expected_range && futureBars.length > 0) {
    const { low, high } = prediction.expected_range;
    const contained = futureBars.filter((b) => b.close >= low && b.close <= high).length;
    rangeContainment = contained / futureBars.length;
  }

  const validTriggers = triggerResults.length;
  const hitTriggers = triggerResults.filter((t) => t.hit).length;

  return {
    sessionId: opts.sessionId,
    code: opts.code,
    mode: 'pred_and_wait',
    horizon,
    prediction,
    actual,
    triggerResults,
    wakeEvents,
    score: {
      biasCorrect: actual.bias === prediction.bias,
      rangeContainment,
      triggerPrecision: validTriggers > 0 ? hitTriggers / validTriggers : 0,
    },
    ts: new Date().toISOString(),
  };
}
