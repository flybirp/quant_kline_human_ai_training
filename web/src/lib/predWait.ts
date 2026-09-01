import type { Bar } from '../types';
import { klineAsciiBlock } from './klineArt';

// 预测天数上限（交易日）。AI 自定 horizon，超限截断为该值。
export const MAX_HORIZON = 15;

export type TriggerKind =
  | 'break_up'
  | 'break_down'
  | 'volume_ratio_gt'
  | 'volume_ratio_lt';

export type Bias = 'up' | 'down' | 'sideways';

export interface PredTrigger {
  id: string;
  kind: TriggerKind;
  value: number;
  desc?: string;
}

// 第 0 天「预测」响应结构（与后端 /api/ai/decide 的 predict kind 对齐）
export interface Prediction {
  horizon: number; // 未来交易日数，1~MAX_HORIZON
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
  feesPaid: number; // 累计交易成本（手续费+印花税，元）
  initialCapital: number; // 初始资金（算占比）
  closed: { days: number; profit: number; rate: number }[]; // 每笔平仓结算（持有天数/盈亏额/收益率）
}

export function emptyDiscipline(initialCapital: number): Discipline {
  return {
    openCount: 0,
    closeCount: 0,
    lossCloseCount: 0,
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
      `⚠ 警告：已 ${d.lossCloseCount} 次亏损平仓，请复盘上面平仓记录对应的入场理由，是否存在追涨/抄底过于随意的问题。`,
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
  recent20Change: number;
  recent20Drawdown: number;
  volumeRatio: number;
  logs: string[];
  discipline: Discipline; // 交易纪律短期记忆
  klineMode?: 'csv' | 'chart' | 'image'; // K 线呈现方式（缺省 csv）
  klineImage?: string; // image 模式：图表截图 base64
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

export const PRED_WAIT_SYSTEM_PROMPT = `你是一名纪律严谨的A股交易员，正在「双盲K线回放训练」系统中使用「预测等待」子模式。

环境规则：
1. 你只能看到截至当前已揭示的K线，不知道股票代码、名称与真实日期；禁止猜测股票身份，禁止假设任何未来数据或消息面。
2. 本模式只要求你在两个时刻给出输出：
   - 「预测」时刻：对未来若干交易日走势做一次结构化预测，并给出是否先建仓的初始动作；
   - 「唤醒」时刻：当走势命中你设定的触发条件（或预测时间到期）时，系统会把你叫醒，你要给出当下一根的动作，并可选择修订预测。
3. 「份」是仓位单位：总资金被等分为若干份，买入 N 份即动用 N 份资金，卖出 N 份即减持 N 份。
4. 交易存在手续费、滑点与印花税，频繁交易会被成本磨损；优先控制回撤，其次追求收益。

预测必须结构化，且只能使用程序可自动判定的触发条件类型：
- break_up：价格上破目标价（当某根日线 high >= value 时命中）
- break_down：价格下破目标价（当某根日线 low <= value 时命中）
- volume_ratio_gt：放量（最新日线量 / 预测日前20日均量 >= value 时命中）
- volume_ratio_lt：缩量（最新日线量 / 预测日前20日均量 <= value 时命中）

输出必须是严格 JSON，不要任何其他文字。

「预测」时刻输出格式：
{"horizon":整数(1~15个交易日),"initial_action":"buy|hold","initial_lots":整数(initial_action=buy时必填),"bias":"up|down|sideways","expected_range":{"low":数字,"high":数字},"triggers":[{"id":"t1","kind":"break_up|break_down|volume_ratio_gt|volume_ratio_lt","value":数字,"desc":"触发说明"}],"summary":"50字以内的预测概述"}

「唤醒」时刻输出格式：
{"action":"buy|sell|hold","lots":整数,"reason":"50字以内的决策理由","revised":{可选，同预测格式，不填则沿用原预测}}`;

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
  if (ctx.lots > 0) {
    lines.push(
      `持仓均价 ${fmt2(ctx.avgCost)}，最新收盘 ${fmt2(ctx.price)}，浮动盈亏 ${(ctx.floatPnlRate * 100).toFixed(1)}%`,
    );
  } else {
    lines.push(`当前空仓，最新收盘 ${fmt2(ctx.price)}`);
  }
  const actions: string[] = [];
  if (maxBuy > 0) actions.push(`买入 1~${maxBuy} 份`);
  if (ctx.lots > 0) actions.push(`卖出 1~${ctx.lots} 份`);
  actions.push('观望');
  lines.push(`当前合法动作：${actions.join(' / ')}`);
  lines.push('');

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
  if (mode === 'image' && ctx.klineImage) {
    lines.push('【K线走势】见本消息附带的图表截图（当前周期视图，含均线与成交量副图；请结合图判断走势，周/月线结构参考下方市场统计）');
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
  lines.push(
    `近20根涨跌 ${(ctx.recent20Change * 100).toFixed(1)}%，区间最大回撤 ${(ctx.recent20Drawdown * 100).toFixed(1)}%，最新量/前20根均量 = ${ctx.volumeRatio.toFixed(2)}`,
  );
  lines.push('');

  return lines;
}

// 第 0 天「预测」请求的 user prompt
export function buildPredictionUserPrompt(ctx: PredContext): string {
  const lines = buildContextBody(ctx);
  lines.push('你现在处于「预测等待」模式，请基于以上多周期走势，对未来走势做一次结构化预测。');
  lines.push(`要求：预测天数 horizon 为未来交易日数量，1~${MAX_HORIZON} 之间由你判断，尽量覆盖一段有明确机会或风险的行情；`);
  lines.push('先给出是否现在建仓的初始动作（若预测后续偏多，可 initial_action=buy 先建仓），再给出可被程序自动判定的触发条件。');
  lines.push('只输出严格 JSON（预测格式见系统提示）。');
  return lines.join('\n');
}

// 触发唤醒时的 user prompt
export function buildWakeUserPrompt(
  prediction: Prediction,
  triggerReason: string,
  ctx: PredContext,
  repeatHint?: string,
): string {
  const lines: string[] = [];
  lines.push('【你之前的预测】');
  lines.push(JSON.stringify(prediction));
  lines.push('（仅供参考：修订时 horizon 应基于当前最新走势重新判断，1~15 个交易日均可，不要机械沿用旧值；走势平稳可拉长，临近关键变盘可缩短）');
  if (repeatHint) {
    lines.push(repeatHint);
  }
  lines.push('');
  lines.push(`【本次唤醒原因】${triggerReason}`);
  lines.push('');
  lines.push(...buildContextBody(ctx));
  lines.push('请基于「之前的预测 + 唤醒原因 + 当前最新走势」给出当下一根的动作，可附修订预测（revised）。');
  lines.push('只输出严格 JSON（唤醒格式见系统提示）。');
  return lines.join('\n');
}

// ---- 协议归一化（容错 LLM 的乱输出） ----

const TRIGGER_KINDS: TriggerKind[] = [
  'break_up',
  'break_down',
  'volume_ratio_gt',
  'volume_ratio_lt',
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
    out.push({
      id: String(o.id || `t${out.length + 1}`),
      kind,
      value,
      desc: typeof o.desc === 'string' ? o.desc : undefined,
    });
  }
  return out;
}

export function normalizePrediction(raw: unknown): Prediction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const horizon = Math.max(1, Math.min(MAX_HORIZON, Math.round(Number(o.horizon) || 1)));
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

export function checkTriggers(
  prediction: Prediction,
  bar: Bar,
  stats: PredBarStats,
  timeReached: boolean,
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

  const triggerResults: PredTriggerResult[] = prediction.triggers.map((t) => {
    const result: PredTriggerResult = { id: t.id, kind: t.kind, value: t.value, hit: false };
    for (let i = 0; i < futureBars.length; i++) {
      const b = futureBars[i];
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
