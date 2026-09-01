import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import { fetchKline } from '../api';
import type { Bar, Period, Trade, TrainingConfig, TrainingRecord } from '../types';
import { codeToStockName } from '../lib/stock';
import {
  buildOutcome,
  buildPredictionUserPrompt,
  buildWakeUserPrompt,
  checkTriggers,
  disciplineBlock,
  emptyDiscipline,
  normalizePrediction,
  PRED_WAIT_SYSTEM_PROMPT,
} from '../lib/predWait';
import type { Discipline, Prediction, PredWakeEvent } from '../lib/predWait';
import { klineAsciiBlock, loadKlineMode, type KlineMode } from '../lib/klineArt';
import AiLogPanel from '../components/AiLogPanel';
import { makeId } from '../lib/aiMessages';
import type { AiMessage } from '../lib/aiMessages';

const FUTURE_BARS = 30;
// 判定「重仓」的股票资产占总资产比例门槛
const HEAVY_RATIO = 0.6;

// 各副图指标使用的独立价格轴 id
const SCALE_IDS = {
  volume: 'volume',
  macd: 'macd',
  kdj: 'kdj',
} as const;

const MA_COLORS: Record<number, string> = {
  5: '#f0b90b',
  10: '#3b82f6',
  20: '#e879f9',
  60: '#2ebd85',
};

const PERIOD_LABELS: Record<Period, string> = {
  day: '日线',
  week: '周线',
  month: '月线',
};

interface Props {
  config: TrainingConfig;
  onFinish: (record: TrainingRecord) => void;
  onExit: () => void;
}

function toTimestamp(date: string): UTCTimestamp {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000) as UTCTimestamp;
}

function calcMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    result.push(i >= period - 1 ? sum / period : null);
  }
  return result;
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      prev = values[i];
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    result.push(prev);
  }
  return result;
}

function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEMA(dif, 9);
  const hist = dif.map((v, i) => (v - dea[i]) * 2);
  return { dif, dea, hist };
}

function calcKDJ(bars: Bar[]) {
  const kArr: number[] = [];
  const dArr: number[] = [];
  const jArr: number[] = [];
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - 8);
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = start; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    kArr.push(k);
    dArr.push(d);
    jArr.push(3 * k - 2 * d);
  }
  return { k: kArr, d: dArr, j: jArr };
}

// ---- AI 托管：prompt 与上下文构造（策略核心） ----

// 各周期喂给 LLM 的 K 线截断长度（日/周/月统一）
const AI_CONTEXT_BARS = 80;

// s1：系统 prompt——角色 + 双盲约束 + 合法动作 + 交易纪律 + 输出格式
const AI_SYSTEM_PROMPT = `你是一名纪律严谨的A股交易员，正在「双盲K线回放训练」系统中逐根K线做交易决策。

环境规则：
1. 你只能看到截至当前已揭示的K线，不知道股票代码、名称与真实日期；禁止猜测股票身份，禁止假设任何未来数据或消息面。
2. 每次必须且只能给出一个动作：
   - {"action":"buy","lots":N}：买入N份（N 必须在 1 到「可买份数」之间）
   - {"action":"sell","lots":N}：卖出N份（N 必须在 1 到「持有份数」之间）
   - {"action":"hold"}：观望不动
3. 「份」是仓位单位：总资金被等分为若干份，买入 N 份即动用 N 份资金，卖出 N 份即减持 N 份。

交易纪律：
- 交易存在手续费、滑点与印花税，频繁交易会被成本磨损。
- 优先控制回撤，其次追求收益；没有明确把握时果断观望。
- 善用分仓机制：分仓的意义在于分批进出，而非一次性满仓或空仓。
  - 持仓后回调不急于动作：若中长期趋势未破坏（回踩均线支撑、缩量企稳），此时用剩余份数补仓摊低成本比一味观望更值得执行——这正是保留现金份的意义；
  - 补仓的前提是趋势未坏：跌破关键支撑且放量下杀时止损离场，不要越跌越买；
  - 盈利时同理：分批止盈锁定利润，趋势完好时可持有剩余仓位。
- 决策只基于给定的多周期价格与量能走势数据。

只输出严格 JSON，不要任何其他文字：
{"action":"buy|sell|hold","lots":整数,"reason":"50字以内的决策理由"}`;

// s2：喂给 LLM 的上下文快照
interface AiContext {
  aiPrompt: string; // s4：用户自定义策略指令（可空）
  positions: number;
  lots: number;
  avgCost: number;
  price: number;
  floatPnlRate: number;
  daily: AiBarRow[]; // 已截断的日级 K 线（隐藏日期，用序号）
  weekly: AiBarRow[]; // 由已揭示日线聚合的周级 K 线
  monthly: AiBarRow[]; // 由已揭示日线聚合的月级 K 线
  recent20Change: number; // 近20根日线涨跌幅
  recent20Drawdown: number; // 近20根日线区间最大回撤（正值）
  volumeRatio: number; // 最新日线量 / 前20根日均量
  logs: string[]; // s3：近期决策记忆（含理由）
  discipline: Discipline; // 交易纪律短期记忆（本场行为统计与犯错记录）
  klineMode: KlineMode; // K 线呈现方式：csv / chart / image
  klineImage?: string; // image 模式：图表截图（jpeg base64，无 dataURL 前缀）
}

// K 线行：附带 MA5/20/60（基于全量已揭示数据计算，截取窗口后边界值依然准确）
// pct：较开盘涨跌幅（正=红阳线，负=绿阴线）；volRatio：当根量/前20根均量
interface AiBarRow {
  bar: Bar;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  pct: number;
  volRatio: number;
}

function fmt2(v: number): string {
  return v.toFixed(2);
}

const fmtMa = (v: number | null) => (v == null ? '—' : fmt2(v));

// 将已揭示日线聚合为周/月 K（与训练页折叠规则一致：最后一根允许是未完成周期）
function aggregateBars(daily: Bar[], p: 'week' | 'month'): Bar[] {
  const out: Bar[] = [];
  let curKey = '';
  for (const d of daily) {
    const key = periodKey(d.date, p);
    if (key !== curKey) {
      out.push({
        date: d.date,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      });
      curKey = key;
    } else {
      const g = out[out.length - 1];
      g.high = Math.max(g.high, d.high);
      g.low = Math.min(g.low, d.low);
      g.close = d.close;
      g.volume += d.volume;
    }
  }
  return out;
}

// 为一组 K 线附加 MA5/20/60 + 阳阴线涨跌幅 + 相对量能（量比）
function buildAiRows(bars: Bar[]): AiBarRow[] {
  const closes = bars.map((b) => b.close);
  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  return bars.map((bar, i) => {
    // 较开盘涨跌：正=红阳线，负=绿阴线，绝对值≈实体相对长度（直接呈现「红长绿短」形态）
    const pct = bar.open > 0 ? (bar.close - bar.open) / bar.open : 0;
    // 量比：当根量 / 此前 20 根均量（>1.5 显著放量，<0.7 显著缩量）
    const prev = bars.slice(Math.max(0, i - 20), i);
    const avgVol =
      prev.length > 0 ? prev.reduce((s, b) => s + b.volume, 0) / prev.length : 0;
    const volRatio = avgVol > 0 ? bar.volume / avgVol : 1;
    return {
      bar,
      ma5: ma5[i],
      ma20: ma20[i],
      ma60: ma60[i],
      pct,
      volRatio,
    };
  });
}

// K 线数据块（多周期统一格式：序号,开,高,低,收,涨跌%,量,量比,MA5,MA20,MA60）
function klineBlock(title: string, rows: AiBarRow[], tailNote: string): string[] {
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

// s2+s3+s4：拼装 user prompt
function buildAiUserPrompt(ctx: AiContext): string {
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
  lines.push(`本根合法动作：${actions.join(' / ')}`);
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

  // 多周期走势：按用户配置的呈现方式输出（csv 数字表 / chart 字符形态图 / image 附图说明）
  if (ctx.klineMode === 'image' && ctx.klineImage) {
    lines.push('【K线走势】见本消息附带的图表截图（当前周期视图，含均线与成交量副图；请结合图判断走势，周/月线结构参考下方市场统计）');
    lines.push('');
  } else if (ctx.klineMode === 'chart') {
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
    // csv：日线看近期细节，周线看中期结构，月线看长期格局
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

  lines.push('请基于以上多周期走势给出本根K线收盘后的决策，只输出 JSON。');
  return lines.join('\n');
}

// 折叠后的 bar，记录其覆盖的日线索引范围（相对日线子集 daySeg）
interface FoldedBar extends Bar {
  dayFrom: number;
  dayTo: number;
}

// 周期标识：日线=日期本身，月线=yyyy-mm，周线=所在周周一日期
function periodKey(date: string, period: Period): string {
  if (period === 'day') return date;
  const d = new Date(date + 'T00:00:00');
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  // 周：以周一为一周起点
  const dow = d.getDay() || 7; // 周日=7
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow - 1));
  const my = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const md = String(monday.getDate()).padStart(2, '0');
  return `${my}-${mm}-${md}`;
}

// 把「已揭示」的日线（前 revealedCount 根）折叠成周/月线；
// 末尾「进行中的周/月」也显示，作为一根未完成的部分 K 线（截至当前已揭示的日线）。
function foldBars(daySeg: Bar[], revealedCount: number, period: Period): FoldedBar[] {
  if (period === 'day') {
    return daySeg.slice(0, revealedCount).map((b, i) => ({ ...b, dayFrom: i, dayTo: i }));
  }
  const out: FoldedBar[] = [];
  let cur: FoldedBar | null = null;
  let curKey = '';
  for (let i = 0; i < revealedCount; i++) {
    const b = daySeg[i];
    const key = periodKey(b.date, period);
    if (!cur) {
      cur = { ...b, dayFrom: i, dayTo: i };
      curKey = key;
    } else if (curKey === key) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.dayTo = i;
    } else {
      out.push(cur);
      cur = { ...b, dayFrom: i, dayTo: i };
      curKey = key;
    }
  }
  if (cur) {
    // 末尾「进行中的周/月」也显示，作为一根未完成的部分 K 线
    out.push(cur);
  }
  return out;
}

// 把决策段起点对齐到所在周期（周/月）的第一根日线
function alignToPeriodStart(daySeg: Bar[], dayWarmup: number, period: Period): number {
  if (period === 'day') return dayWarmup;
  if (dayWarmup <= 0 || dayWarmup >= daySeg.length) return dayWarmup;
  const key = periodKey(daySeg[dayWarmup].date, period);
  let i = dayWarmup;
  while (i > 0 && periodKey(daySeg[i - 1].date, period) === key) i--;
  return i;
}

export default function Training({ config, onFinish, onExit }: Props) {
  const [period, setPeriod] = useState<Period>(config.period);
  const [maParams, setMaParams] = useState<number[]>(config.maParams);
  const [indicators, setIndicators] = useState({
    volume: true,
    macd: false,
    kdj: false,
  });
  const [daySeg, setDaySeg] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [dayWarmup, setDayWarmup] = useState(0); // 决策段起点（日线 index）
  const [dayVisible, setDayVisible] = useState(0); // 已揭示的日线数
  const [cash, setCash] = useState(config.initialCapital);
  const [shares, setShares] = useState(0);
  const [avgCost, setAvgCost] = useState(0);
  const [lots, setLots] = useState(0); // 已持有份数（0..positions）
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedRounds, setClosedRounds] = useState<number[]>([]);
  const [finished, setFinished] = useState(false);
  const [showCode, setShowCode] = useState(false); // 按住时临时显示代码
  const [buyLots, setBuyLots] = useState(1); // 买入份数（1..positions）
  const [sellLots, setSellLots] = useState(1); // 卖出份数（1..lots）

  // ---- AI 托管 ----
  const [aiAuto, setAiAuto] = useState(false); // 托管开关
  const [aiDeciding, setAiDeciding] = useState(false); // 是否正在等待 LLM 返回
  const [aiSpeed, setAiSpeed] = useState(1500); // 每步间隔 ms
  const [aiError, setAiError] = useState('');
  const [aiMode, setAiMode] = useState<'step' | 'pred_wait'>('step'); // 逐根 / 预测等待
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]); // AI 回复区渲染消息（与 aiLogsRef 分离）
  const decidingRef = useRef(false); // 防重入
  const aiLogsRef = useRef<string[]>([]); // 决策记忆滚动窗口（借鉴 FinMem 分层记忆）
  const aiUsedRef = useRef(false); // 本场是否发生过 AI 决策（用于 mode 标记）
  // 调度器模式：同一时刻最多一个 pending timer，杜绝并发爆发
  const aiTickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiAutoRef = useRef(false);
  const finishedRef = useRef(false);
  const aiDecideRef = useRef<() => void>(() => {}); // 指向最新渲染的决策函数，避免闭包过期

  // ---- pred_and_wait 模式专用状态/ref ----
  const aiModeRef = useRef<'step' | 'pred_wait'>('step');
  const pwTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pwTickFnRef = useRef<() => void>(() => {});
  const predictionRef = useRef<Prediction | null>(null); // 当前预测（空 = 尚未预测）
  const predStartDayRef = useRef(0); // 预测日（第 0 天）的日线索引
  const predWakeEventsRef = useRef<PredWakeEvent[]>([]); // 每次唤醒后的决策记录
  const dayVisibleRef = useRef(0); // 已揭示日线数 ref 镜像
  const dayWarmupRef = useRef(0); // 决策段起点 ref 镜像
  const baseAvgVolRef = useRef(0); // 预测日之前的近 20 日均量（供 volume 触发判定）

  useEffect(() => { finishedRef.current = finished; }, [finished]);
  useEffect(() => { aiDecideRef.current = aiDecideOnce; });
  useEffect(() => { aiModeRef.current = aiMode; }, [aiMode]);
  useEffect(() => { dayVisibleRef.current = dayVisible; }, [dayVisible]);
  useEffect(() => { dayWarmupRef.current = dayWarmup; }, [dayWarmup]);
  useEffect(() => { pwTickFnRef.current = pwTick; });

  // 持仓份数变化后，clamp 买卖份数到合法范围，杜绝选中非法份数
  useEffect(() => {
    const maxBuy = config.positions - lots;
    if (maxBuy > 0) setBuyLots((v) => Math.min(v, maxBuy));
    if (lots > 0) setSellLots((v) => Math.min(v, lots));
  }, [lots, config.positions]);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const auxSeriesRef = useRef<ISeriesApi<any>[]>([]);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // 供 crosshair 回调读取最新数据（订阅在初始化 effect 中，闭包拿不到最新 state）
  const displayBarsRef = useRef<FoldedBar[]>([]);
  const daySegRef = useRef<Bar[]>([]);
  const periodRef = useRef<Period>(period);
  const crosshairTipRef = useRef<HTMLDivElement | null>(null);

  // ref 镜像 state，保证 commit 后能立即读最新值（避免 React 批处理读取延迟）
  const cashRef = useRef(config.initialCapital);
  const sharesRef = useRef(0);
  const avgCostRef = useRef(0);
  const lotsRef = useRef(0);

  // 每根决策 bar 的「持仓状态(0/1)」「是否重仓(0/1)」序列，供统计页使用
  const positionSeriesRef = useRef<number[]>([]);
  const heavySeriesRef = useRef<number[]>([]);

  // 训练开始计时
  const sessionStartRef = useRef(0);

  const decisionBars = config.decisionBars;
  const decisionEndDay = dayWarmup + decisionBars; // 决策段终点（日线 index）

  useEffect(() => {
    sessionStartRef.current = Date.now();
  }, []);

  // 本次训练会话 id：decide 流水日志与 predict 对账日志共用，
  // 便于把一场训练在两个 jsonl 里的记录关联起来
  const sessionIdRef = useRef(String(Date.now()));

  // 交易纪律短期记忆：本场开仓/平仓/费用统计（喂回 AI 用于自我纠错）
  const disciplineRef = useRef<Discipline>(emptyDiscipline(config.initialCapital));
  // 预测有效期历史（检测 AI 是否机械重复同一 horizon）
  const horizonHistoryRef = useRef<number[]>([]);

  // ---- 数据加载（只预加载日线全量，周/月线由前端本地折叠）----
  const loadSegment = useCallback(
    async (code: string) => {
      setLoading(true);
      setLoadError('');
      try {
        const dayFull = await fetchKline(code, 'day');
        const totalMin = decisionBars + FUTURE_BARS;
        if (dayFull.length < totalMin) {
          throw new Error(
            `${code} 的日线只有 ${dayFull.length} 根，至少需要 ${totalMin} 根才能训练`,
          );
        }

        // ---- 指定模式：可选区间约束（起始/结束日期，YYYY-MM-DD）----
        const hasRange = config.mode === 'specified';
        const rangeStart = hasRange && config.startDate
          ? dayFull.findIndex((b) => b.date >= config.startDate!)
          : 0;
        if (rangeStart === -1) {
          throw new Error(`起始日期 ${config.startDate} 之后没有 K 线数据`);
        }
        // rangeEndIdx：区间内最后一根 bar 的索引（含）
        let rangeEndIdx = dayFull.length - 1;
        if (hasRange && config.endDate) {
          const overIdx = dayFull.findIndex((b) => b.date > config.endDate!);
          rangeEndIdx = (overIdx === -1 ? dayFull.length : overIdx) - 1;
        }
        if (rangeEndIdx - rangeStart + 1 < decisionBars) {
          throw new Error(
            `区间 ${config.startDate ?? dayFull[0].date} ~ ${config.endDate ?? dayFull[dayFull.length - 1].date} 内只有 ${rangeEndIdx - rangeStart + 1} 根决策 bar，少于设定的 ${decisionBars} 根`,
          );
        }

        // 决策段起点：指定了起始日期 → 定位到该日（或其后首个交易日）；否则在区间内随机
        let start: number;
        if (hasRange && config.startDate) {
          start = rangeStart;
        } else {
          const maxStart = Math.min(dayFull.length - decisionBars - 1, rangeEndIdx - decisionBars + 1);
          start = Math.floor(Math.random() * (maxStart + 1));
        }
        // 复盘用的未来数据：有结束日期时不得越过区间
        const futureLimit = hasRange && config.endDate ? rangeEndIdx + 1 : dayFull.length;
        const future = Math.min(FUTURE_BARS, futureLimit - start - decisionBars);
        const seg = dayFull.slice(0, start + decisionBars + future);

        setDaySeg(seg);
        setDayWarmup(start);
        setDayVisible(start);
        setCash(config.initialCapital);
        setShares(0);
        setAvgCost(0);
        setLots(0);
        setTrades([]);
        setClosedRounds([]);
        setFinished(false);
        cashRef.current = config.initialCapital;
        sharesRef.current = 0;
        avgCostRef.current = 0;
        lotsRef.current = 0;
        positionSeriesRef.current = [];
        heavySeriesRef.current = [];
        disciplineRef.current = emptyDiscipline(config.initialCapital);
        horizonHistoryRef.current = [];
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [
      decisionBars,
      config.initialCapital,
      config.mode,
      config.startDate,
      config.endDate,
    ],
  );

  useEffect(() => {
    loadSegment(config.code);
  }, [config.code, loadSegment]);

  function handlePeriodChange(p: Period) {
    if (p === period || finished) return;
    // 预测等待托管中禁止切周期：会改变决策段起点 dayWarmup，导致天级推进边界错乱
    if (aiAuto && aiMode === 'pred_wait') return;
    // 切换周期：仅切换显示/决策粒度，并对齐决策段起点到周期边界（周/月开头）。
    // 进度（dayVisible）与交易状态全部保留，时间绝不回退；数据仍是同一份日线，不重新请求。
    const warmup = alignToPeriodStart(daySeg, dayWarmup, p);
    setPeriod(p);
    setDayWarmup(warmup);
  }

  function toggleMa(p: number) {
    setMaParams((prev) =>
      prev.includes(p)
        ? prev.filter((x) => x !== p)
        : [...prev, p].sort((a, b) => a - b),
    );
  }

  function toggleIndicator(key: 'volume' | 'macd' | 'kdj') {
    setIndicators((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // 已揭示的日线折叠成当前周期（周/月只保留完整周期），供图表渲染与决策使用
  const displayBars = useMemo<FoldedBar[]>(() => {
    if (daySeg.length === 0) return [];
    return foldBars(daySeg, dayVisible, period);
  }, [daySeg, dayVisible, period]);

  // 决策段折叠后的完整周期总数（用于提前结束时的补齐）
  const fullDecisionCount = useMemo(() => {
    if (daySeg.length === 0) return 0;
    const full = foldBars(daySeg, daySeg.length, period);
    return full.filter((b) => b.dayFrom >= dayWarmup && b.dayTo < decisionEndDay).length;
  }, [daySeg, dayWarmup, decisionEndDay, period]);

  // 已决策的决策段折叠周期数（已揭示且落在决策段内的完整周期）
  const decidedCount = useMemo(
    () => displayBars.filter((b) => b.dayFrom >= dayWarmup && b.dayTo < decisionEndDay).length,
    [displayBars, dayWarmup, decisionEndDay],
  );

  // 同步 crosshair 回调所需的最新数据到 ref
  useEffect(() => {
    displayBarsRef.current = displayBars;
    daySegRef.current = daySeg;
    periodRef.current = period;
  }, [displayBars, daySeg, period]);

  // ---- 图表初始化 ----
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#0d1117' },
        textColor: '#8b949e',
        fontSize: 11,
        panes: {
          separatorColor: '#3f4752',
          separatorHoverColor: 'rgba(178, 181, 189, 0.15)',
        },
      },
      grid: {
        vertLines: { color: '#1c2330' },
        horzLines: { color: '#1c2330' },
      },
      rightPriceScale: { borderColor: '#2d333b', minimumWidth: 60 },
      timeScale: {
        borderColor: '#2d333b',
        visible: false,
        timeVisible: false,
        rightOffset: 8,
        barSpacing: 6,
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' },
        horzLine: { color: '#3b82f6', labelBackgroundColor: '#3b82f6' },
      },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#f6465d',
      downColor: '#2ebd85',
      borderUpColor: '#f6465d',
      borderDownColor: '#2ebd85',
      wickUpColor: '#f6465d',
      wickDownColor: '#2ebd85',
      priceScaleId: 'right',
    });

    chartRef.current = chart;
    candleRef.current = candle;
    markersPluginRef.current = createSeriesMarkers(candle, []);

    // 鼠标指向某根 K 线时，显示日期提示（周/月显示起止日期）
    const onCrosshairMove = (param: MouseEventParams) => {
      const tip = crosshairTipRef.current;
      if (!tip) return;
      if (!param.time || !param.point) {
        tip.style.display = 'none';
        return;
      }
      const ts = param.time as UTCTimestamp;
      const bar = displayBarsRef.current.find((b) => toTimestamp(b.date) === ts);
      if (!bar) {
        tip.style.display = 'none';
        return;
      }
      let label: string;
      if (periodRef.current === 'day') {
        label = bar.date;
      } else {
        const seg = daySegRef.current;
        const from = seg[bar.dayFrom]?.date ?? bar.date;
        const to = seg[bar.dayTo]?.date ?? bar.date;
        label = from === to ? from : `${from} ~ ${to}`;
      }
      tip.textContent = label;
      tip.style.display = 'block';
      tip.style.left = `${param.point.x}px`;
      tip.style.top = `${param.point.y - 8}px`;
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      markersPluginRef.current?.detach();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      auxSeriesRef.current = [];
      markersPluginRef.current = null;
    };
  }, []);

  // ---- 图表数据更新 ----
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || displayBars.length === 0) return;

    const shown = displayBars;
    const closes = shown.map((b) => b.close);

    candle.setData(
      shown.map((b) => ({
        time: toTimestamp(b.date),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    // 清理旧辅助 series
    for (const s of auxSeriesRef.current) chart.removeSeries(s);
    auxSeriesRef.current = [];

    // 开启的副图指标（从下往上堆叠）
    const enabledInd: Array<'volume' | 'macd' | 'kdj'> = [];
    if (indicators.volume) enabledInd.push('volume');
    if (indicators.macd) enabledInd.push('macd');
    if (indicators.kdj) enabledInd.push('kdj');
    const nBottom = enabledInd.length;

    // 副图独立 pane（pane 0 = 主图，pane 1 = 副图），pane 之间自带分隔线
    const hasBottomPane = chart.panes().length > 1;
    if (nBottom > 0 && !hasBottomPane) {
      const p = chart.addPane(true);
      p.setStretchFactor(0.42); // 副图约占总高 30%
    } else if (nBottom === 0 && hasBottomPane) {
      chart.removePane(1);
    }

    // 主图（K 线 + 均线）在 pane 0，底部留少量空白
    chart
      .priceScale('right')
      .applyOptions({ scaleMargins: { top: 0.05, bottom: nBottom > 0 ? 0.1 : 0.06 } });

    // 主图均线
    for (const p of maParams) {
      const ma = calcMA(closes, p);
      const line = chart.addSeries(LineSeries, {
        color: MA_COLORS[p] || '#8b949e',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(
        ma
          .map((v, i) => (v == null ? null : { time: toTimestamp(shown[i].date), value: v }))
          .filter((x): x is { time: UTCTimestamp; value: number } => x != null),
      );
      auxSeriesRef.current.push(line);
    }

    // 成交量
    if (indicators.volume) {
      const vol = chart.addSeries(
        HistogramSeries,
        {
          priceScaleId: SCALE_IDS.volume,
          priceFormat: { type: 'volume' },
          lastValueVisible: false,
          priceLineVisible: false,
        },
        1,
      );
      vol.setData(
        shown.map((b) => ({
          time: toTimestamp(b.date),
          value: b.volume,
          color: b.close >= b.open ? 'rgba(246,70,93,0.45)' : 'rgba(46,189,133,0.45)',
        })),
      );
      auxSeriesRef.current.push(vol);
    }

    // MACD
    if (indicators.macd) {
      const m = calcMACD(closes);
      const difLine = chart.addSeries(
        LineSeries,
        {
          priceScaleId: SCALE_IDS.macd,
          color: '#f0b90b',
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        },
        1,
      );
      difLine.setData(m.dif.map((v, i) => ({ time: toTimestamp(shown[i].date), value: v })));
      const deaLine = chart.addSeries(
        LineSeries,
        {
          priceScaleId: SCALE_IDS.macd,
          color: '#3b82f6',
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        },
        1,
      );
      deaLine.setData(m.dea.map((v, i) => ({ time: toTimestamp(shown[i].date), value: v })));
      const histSeries = chart.addSeries(
        HistogramSeries,
        {
          priceScaleId: SCALE_IDS.macd,
          lastValueVisible: false,
          priceLineVisible: false,
        },
        1,
      );
      histSeries.setData(
        m.hist.map((v, i) => ({
          time: toTimestamp(shown[i].date),
          value: v,
          color: v >= 0 ? '#f6465d' : '#2ebd85',
        })),
      );
      auxSeriesRef.current.push(difLine, deaLine, histSeries);
    }

    // KDJ
    if (indicators.kdj) {
      const kdj = calcKDJ(shown);
      const colors = ['#f0b90b', '#3b82f6', '#e879f9'];
      const series = [kdj.k, kdj.d, kdj.j];
      series.forEach((arr, idx) => {
        const line = chart.addSeries(
          LineSeries,
          {
            priceScaleId: SCALE_IDS.kdj,
            color: colors[idx],
            lineWidth: 1,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          },
          1,
        );
        line.setData(arr.map((v, i) => ({ time: toTimestamp(shown[i].date), value: v })));
        auxSeriesRef.current.push(line);
      });
    }

    // 分配各副图区域（副图 pane 内从下往上：量 → MACD → KDJ）
    enabledInd.forEach((name, i) => {
      const h = 1 / nBottom;
      const top = 1 - (i + 1) * h;
      const bottom = i * h;
      chart
        .priceScale(SCALE_IDS[name], 1)
        .applyOptions({ scaleMargins: { top, bottom } });
    });

    // 买卖标记（买入字加大加粗）
    const markers = trades
      .map((t) => {
        const b = displayBars[t.index];
        if (!b) return null;
        return {
          time: toTimestamp(b.date) as Time,
          position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
          color: t.side === 'buy' ? '#f6465d' : '#2ebd85',
          shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown',
          text: t.side === 'buy' ? '买' : '卖',
          size: t.side === 'buy' ? 1.5 : 1,
        } as SeriesMarker<Time>;
      })
      .filter((m): m is SeriesMarker<Time> => m != null);
    markersPluginRef.current?.setMarkers(markers);

    // 数据充足时滚动到最新，保持固定 K 线宽度；
    // 数据不足填满宽度时改为铺满整屏，避免右侧拥挤、左侧大片空白。
    const container = containerRef.current;
    const minBarsToFill = container ? Math.ceil(container.clientWidth / 6) : 50;
    if (shown.length >= minBarsToFill) {
      chart.timeScale().scrollToRealTime();
    } else {
      chart.timeScale().fitContent();
    }
  }, [displayBars, maParams, trades, indicators]);

  // 揭晓后追加显示未来 K 线（含决策段之后的未来周期）：
  // 渐进式快进揭示，避免 30 根未来 K 线一次性砸出来视觉突兀
  useEffect(() => {
    if (!finished || daySeg.length === 0) return;
    let cur = dayVisible;
    if (cur >= daySeg.length) return;
    const timer = window.setInterval(() => {
      cur = Math.min(cur + 1, daySeg.length);
      dayVisibleRef.current = cur;
      setDayVisible(cur);
      if (cur >= daySeg.length) window.clearInterval(timer);
    }, 60);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, daySeg.length]);

  // pred_and_wait 结束：计算打脸对账并落盘（供未来 AI 自我学习）
  useEffect(() => {
    if (!finished || aiModeRef.current !== 'pred_wait') return;
    const prediction = predictionRef.current;
    if (!prediction) return;
    const outcome = buildOutcome(
      prediction,
      daySegRef.current,
      predStartDayRef.current,
      predWakeEventsRef.current,
      { code: config.code, sessionId: sessionIdRef.current },
    );
    if (!outcome) return;
    fetch('/api/ai/predict-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(outcome),
    }).catch(() => {});
  }, [finished, config.code]);

  // ---- 交易操作 ----
  const currentBar: FoldedBar | undefined =
    displayBars.length > 0 ? displayBars[displayBars.length - 1] : undefined;
  const currentPrice = currentBar ? currentBar.close : 0;

  function commitCash(next: number) {
    cashRef.current = next;
    setCash(next);
  }

  function commitPosition(nextShares: number, nextAvgCost: number, nextLots: number) {
    sharesRef.current = nextShares;
    avgCostRef.current = nextAvgCost;
    lotsRef.current = nextLots;
    setShares(nextShares);
    setAvgCost(nextAvgCost);
    setLots(nextLots);
  }

  function doAction(
    side: 'buy' | 'sell' | 'hold',
    opts?: { lots?: number; actor?: 'human' | 'ai' },
  ) {
    if (finished || !currentBar) return;
    const actor = opts?.actor ?? 'human';

    if (side === 'buy') {
      // 分仓买入：按份数买入（人工用选择器值，AI 直接传参；执行时仍 clamp 保证合法）
      if (lotsRef.current >= config.positions || currentPrice <= 0) return;
      const lotCash = config.initialCapital / config.positions;
      const wantLots = Math.min(opts?.lots ?? buyLots, config.positions - lotsRef.current);
      if (wantLots <= 0) return;
      const budget = Math.min(lotCash * wantLots, cashRef.current);
      const buyPrice = currentPrice * (1 + config.slippage);
      const unitCost = buyPrice * (1 + config.feeRate);
      const n = Math.floor(budget / unitCost);
      if (n <= 0) return;
      const cost = n * unitCost;
      const newShares = sharesRef.current + n;
      const newAvg =
        (avgCostRef.current * sharesRef.current + cost) / newShares;
      // 现金不足时按实际成交金额折算买入份数
      const gainedLots = Math.max(1, Math.min(wantLots, Math.round(cost / lotCash)));
      commitCash(cashRef.current - cost);
      commitPosition(newShares, newAvg, lotsRef.current + gainedLots);
      // 纪律记忆：开仓次数 + 买入手续费（滑点已含在成交价中）
      disciplineRef.current.openCount += 1;
      disciplineRef.current.feesPaid += n * buyPrice * config.feeRate;
      setTrades((prev) => [
        ...prev,
        { side: 'buy', price: buyPrice, shares: n, date: currentBar.date, index: displayBars.length - 1, actor },
      ]);
    } else if (side === 'sell') {
      // 分仓卖出：按份数卖出（持仓等分），人工用选择器值，AI 直接传参
      if (sharesRef.current <= 0) return;
      const sellLotsWanted = Math.min(opts?.lots ?? sellLots, lotsRef.current);
      if (sellLotsWanted <= 0) return;
      const sellShares = Math.min(
        sharesRef.current,
        Math.max(1, Math.round((sharesRef.current * sellLotsWanted) / lotsRef.current)),
      );
      const sellPrice = currentPrice * (1 - config.slippage);
      const gross = sellShares * sellPrice;
      const fee = gross * config.feeRate;
      const tax = gross * config.stampTax;
      const net = gross - fee - tax;
      const profit = net - avgCostRef.current * sellShares;
      const remainShares = sharesRef.current - sellShares;
      const nextLots = lotsRef.current - sellLotsWanted;
      commitCash(cashRef.current + net);
      commitPosition(remainShares, avgCostRef.current, nextLots);
      // 纪律记忆：平仓结算（持有天数按距最近一次买入的 bar 数近似）+ 费用累计
      {
        const d = disciplineRef.current;
        d.closeCount += 1;
        d.feesPaid += fee + tax;
        const lastBuy = [...trades].reverse().find((t) => t.side === 'buy');
        const holdDays = lastBuy
          ? Math.max(1, displayBars.length - 1 - lastBuy.index)
          : 1;
        const costBasis = avgCostRef.current * sellShares;
        const rate = costBasis > 0 ? profit / costBasis : 0;
        d.closed.push({ days: holdDays, profit, rate });
        if (profit < 0) d.lossCloseCount += 1;
        // 平仓结算写入决策记忆：让 AI 下一轮就能看到这笔交易的结局
        aiLogsRef.current.push(
          `[平仓结算] 第${d.closeCount}笔：持有${holdDays}根，${profit >= 0 ? '盈利' : '亏损'} ${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(1)}%（${profit >= 0 ? '+' : ''}${profit.toFixed(0)}元）`,
        );
      }
      setClosedRounds((prev) => [...prev, profit]);
      setTrades((prev) => [
        ...prev,
        { side: 'sell', price: sellPrice, shares: sellShares, date: currentBar.date, index: displayBars.length - 1, actor },
      ]);
    }

    // pred_and_wait 下 AI 动作按「天」推进；人工/step 保持周期推进
    if (aiModeRef.current === 'pred_wait' && actor === 'ai') {
      advanceDay();
    } else {
      advance();
    }
  }

  function advance() {
    // 记录「刚被决策」的这根折叠 bar 的持仓状态（仅决策段内的完整周期）
    if (
      currentBar &&
      currentBar.dayFrom >= dayWarmup &&
      currentBar.dayTo < decisionEndDay
    ) {
      const equity = cashRef.current + sharesRef.current * currentBar.close;
      const stockValue = sharesRef.current * currentBar.close;
      positionSeriesRef.current.push(sharesRef.current > 0 ? 1 : 0);
      heavySeriesRef.current.push(equity > 0 && stockValue / equity >= HEAVY_RATIO ? 1 : 0);
    }

    // 推进：日线 +1 根；周/月推进到「下一根要揭示的日线」所在周期的末尾
    let next: number;
    if (period === 'day') {
      next = dayVisible + 1;
    } else {
      const curKey = periodKey(daySeg[dayVisible].date, period);
      next = dayVisible;
      while (next < daySeg.length && periodKey(daySeg[next].date, period) === curKey) {
        next++;
      }
    }
    setDayVisible(next);
    if (next >= decisionEndDay) setFinished(true);
  }

  // pred_and_wait：按「天」推进一根日线（等待期本地自动推进，不请求 AI、不交易）
  function advanceDay() {
    const idx = dayVisibleRef.current - 1;
    const endDay = dayWarmupRef.current + decisionBars;
    if (idx >= dayWarmupRef.current && idx < endDay && idx >= 0) {
      const bar = daySegRef.current[idx];
      if (bar) {
        const equity = cashRef.current + sharesRef.current * bar.close;
        const stockValue = sharesRef.current * bar.close;
        positionSeriesRef.current.push(sharesRef.current > 0 ? 1 : 0);
        heavySeriesRef.current.push(equity > 0 && stockValue / equity >= HEAVY_RATIO ? 1 : 0);
      }
    }
    const next = dayVisibleRef.current + 1;
    dayVisibleRef.current = next;
    setDayVisible(next);
    if (next >= endDay) {
      finishedRef.current = true;
      setFinished(true);
    }
  }

  // ---- AI 托管：上下文构造与决策循环 ----

  // 基于当前已揭示数据构造喂给 LLM 的上下文快照（双盲：K 线隐藏日期只用序号）
  function buildAiContext(): AiContext | null {
    if (!currentBar || displayBars.length === 0) return null;

    // 多周期走势：全部从「已揭示日线」派生（双盲视野与人类一致）；
    // 周期聚合后 MA 基于全量计算再截窗口，保证窗口边界数值准确
    const dailyBars = daySeg.slice(0, dayVisible);
    const weeklyBars = aggregateBars(dailyBars, 'week');
    const monthlyBars = aggregateBars(dailyBars, 'month');
    const daily = buildAiRows(dailyBars).slice(-AI_CONTEXT_BARS);
    const weekly = buildAiRows(weeklyBars).slice(-AI_CONTEXT_BARS);
    const monthly = buildAiRows(monthlyBars).slice(-AI_CONTEXT_BARS);

    // 近 20 根日线统计（纯价格/量统计，不含衍生指标）
    const tail = dailyBars.slice(-20);
    const lastDaily = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1] : null;
    const firstClose = tail.length > 0 ? tail[0].close : currentPrice;
    const recent20Change =
      firstClose > 0 && lastDaily
        ? (lastDaily.close - firstClose) / firstClose
        : 0;
    let peak = -Infinity;
    let maxDD = 0;
    for (const b of tail) {
      peak = Math.max(peak, b.high);
      if (peak > 0) maxDD = Math.max(maxDD, (peak - b.low) / peak);
    }
    const prev20 = dailyBars.slice(-21, -1);
    const avgVol =
      prev20.length > 0 ? prev20.reduce((s, b) => s + b.volume, 0) / prev20.length : 0;
    const volumeRatio =
      avgVol > 0 && lastDaily ? lastDaily.volume / avgVol : 1;

    // K 线呈现方式：image 模式截取当前图表（失败自动退回 csv）
    const klineMode = loadKlineMode();
    let klineImage: string | undefined;
    if (klineMode === 'image' && chartRef.current) {
      try {
        const canvas = chartRef.current.takeScreenshot();
        klineImage = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      } catch {
        klineImage = undefined;
      }
    }

    return {
      aiPrompt: localStorage.getItem('kline-ai-prompt') || '',
      positions: config.positions,
      lots,
      avgCost,
      price: currentPrice,
      floatPnlRate: shares > 0 && avgCost > 0 ? (currentPrice - avgCost) / avgCost : 0,
      daily,
      weekly,
      monthly,
      recent20Change,
      recent20Drawdown: maxDD,
      volumeRatio,
      logs: [...aiLogsRef.current],
      discipline: { ...disciplineRef.current, closed: [...disciplineRef.current.closed] },
      klineMode: klineMode === 'image' && klineImage ? 'image' : klineMode,
      klineImage,
    };
  }

  // AI 决策循环（调度器模式）：单一 pending timer + decidingRef 防重入 + ref 实时校验，
  // 响应到达时若托管已关/训练结束/bar 已变（如切周期）则丢弃结果
  function aiSchedule(delay?: number) {
    if (aiTickRef.current !== null) {
      clearTimeout(aiTickRef.current);
      aiTickRef.current = null;
    }
    if (!aiAutoRef.current || finishedRef.current || loading || loadError) return;
    aiTickRef.current = setTimeout(() => {
      aiTickRef.current = null;
      aiDecideRef.current(); // 调用最新渲染版本，保证闭包新鲜
    }, delay ?? aiSpeed);
  }

  async function aiDecideOnce() {
    if (!aiAutoRef.current || finishedRef.current || decidingRef.current) return;
    const barAtStart = displayBarsRef.current.length;
    if (barAtStart === 0) return;
    decidingRef.current = true;
    setAiDeciding(true);
    try {
      const ctx = buildAiContext();
      if (!ctx) return;
      const res = await fetch('/api/ai/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          system: AI_SYSTEM_PROMPT,
          user: buildAiUserPrompt(ctx),
          image: ctx.klineImage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
      // 执行前实时校验（用 ref 而非闭包）：托管已关 / 已结束 / bar 已变则丢弃
      if (!aiAutoRef.current || finishedRef.current) return;
      if (displayBarsRef.current.length !== barAtStart) return;
      const act: 'buy' | 'sell' | 'hold' =
        data.action === 'buy' || data.action === 'sell' ? data.action : 'hold';
      const lots = Math.max(1, Math.round(Number(data.lots) || 1));
      const actLabel =
        act === 'hold' ? '观望' : act === 'buy' ? `买入${lots}份` : `卖出${lots}份`;
      aiUsedRef.current = true;
      aiLogsRef.current.push(`[${actLabel}] ${String(data.reason || '').slice(0, 60)}`);
      setAiMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          ts: Date.now(),
          kind: 'step',
          action: act,
          lots: act === 'hold' ? undefined : lots,
          reason: String(data.reason || '').slice(0, 200),
        },
      ]);
      doAction(act, act === 'hold' ? { actor: 'ai' } : { lots, actor: 'ai' });
    } catch (e) {
      if (aiAutoRef.current) {
        setAiError(e instanceof Error ? e.message : String(e));
        setAiAuto(false); // 失败自动暂停，避免死循环烧 token
        aiAutoRef.current = false;
      }
    } finally {
      decidingRef.current = false;
      setAiDeciding(false);
      aiSchedule(); // 兜底重排下一轮（与 effect 触发互为双保险，幂等覆盖）
    }
  }

  // ---- pred_and_wait：调度与预测/唤醒 ----

  // 等待期单步：本地判定是否命中预测条件
  function pwTick() {
    pwTimerRef.current = null;
    if (!aiAutoRef.current || finishedRef.current || decidingRef.current) return;
    if (loading || loadError) return;

    // 尚未预测 → 先做第 0 天预测
    if (!predictionRef.current) {
      pwPredictOnce();
      return;
    }

    const arr = daySegRef.current;
    const visible = dayVisibleRef.current;
    const idx = visible - 1;
    const bar = arr[idx];
    if (!bar) return;

    const timeReached = idx >= predStartDayRef.current + predictionRef.current.horizon;
    const hits = checkTriggers(
      predictionRef.current,
      bar,
      { baseAvgVolume: baseAvgVolRef.current },
      timeReached,
    );

    if (hits.length > 0) {
      pwWakeOnce(hits[0].reason);
    } else {
      advanceDay();
      pwSchedule();
    }
  }

  function pwSchedule(delay?: number) {
    if (pwTimerRef.current !== null) {
      clearTimeout(pwTimerRef.current);
      pwTimerRef.current = null;
    }
    if (!aiAutoRef.current || finishedRef.current || loading || loadError) return;
    pwTimerRef.current = setTimeout(() => {
      pwTickFnRef.current();
    }, delay ?? aiSpeed);
  }

  // horizon 机械重复检测：连续 ≥3 轮同一有效期时给出警示文案（注入唤醒 prompt）
  function horizonRepeatHint(): string | undefined {
    const h = horizonHistoryRef.current;
    if (h.length < 3) return undefined;
    const last = h[h.length - 1];
    let n = 0;
    for (let i = h.length - 1; i >= 0 && h[i] === last; i--) n++;
    if (n < 3) return undefined;
    return `⚠ 注意：你已连续 ${n} 轮把预测有效期 horizon 设为 ${last} 个交易日。请结合当前最新走势重新评估有效期——震荡缩量期可适当拉长，临近关键位变盘可缩短，不要机械重复同一数值。`;
  }

  // 第 0 天：请求 AI 做结构化预测，随后执行初始动作并进入等待期
  async function pwPredictOnce() {
    if (!aiAutoRef.current || finishedRef.current || decidingRef.current) return;
    const barAtStart = dayVisibleRef.current;
    decidingRef.current = true;
    setAiDeciding(true);
    try {
      const ctx = buildAiContext();
      if (!ctx) return;
      const res = await fetch('/api/ai/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          mode: 'pred_and_wait',
          kind: 'predict',
          system: PRED_WAIT_SYSTEM_PROMPT,
          user: buildPredictionUserPrompt(ctx),
          image: ctx.klineImage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
      const prediction = normalizePrediction(data);
      if (!prediction) throw new Error('AI 预测输出无法解析');
      if (!aiAutoRef.current || finishedRef.current) return;
      if (dayVisibleRef.current !== barAtStart) return;

      horizonHistoryRef.current.push(prediction.horizon);

      predictionRef.current = prediction;
      predStartDayRef.current = dayVisibleRef.current - 1;
      predWakeEventsRef.current = [];

      // 预测日之前的近20日均量（供 volume 触发判定，与 buildAiContext 口径一致）
      const arr = daySegRef.current;
      const prev = arr.slice(Math.max(0, predStartDayRef.current - 20), predStartDayRef.current);
      baseAvgVolRef.current =
        prev.length > 0 ? prev.reduce((s, b) => s + b.volume, 0) / prev.length : 0;

      aiUsedRef.current = true;
      setAiMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          ts: Date.now(),
          kind: 'predict',
          horizon: prediction.horizon,
          bias: prediction.bias,
          initial_action: prediction.initial_action,
          initial_lots: prediction.initial_lots,
          expected_range: prediction.expected_range,
          triggers: prediction.triggers,
          summary: prediction.summary,
        },
      ]);

      if (prediction.initial_action === 'buy') {
        const lots = Math.max(1, Math.round(prediction.initial_lots || 1));
        aiLogsRef.current.push(`[预测建仓${lots}份] ${prediction.summary.slice(0, 40)}`);
        doAction('buy', { lots, actor: 'ai' });
      } else {
        aiLogsRef.current.push(`[预测观望] ${prediction.summary.slice(0, 40)}`);
        doAction('hold', { actor: 'ai' });
      }
      pwSchedule();
    } catch (e) {
      if (aiAutoRef.current) {
        setAiError(e instanceof Error ? e.message : String(e));
        setAiAuto(false);
        aiAutoRef.current = false;
      }
    } finally {
      decidingRef.current = false;
      setAiDeciding(false);
      pwSchedule();
    }
  }

  // 命中触发后唤醒 AI：请求新决策，可附修订预测
  async function pwWakeOnce(triggerReason: string) {
    if (!aiAutoRef.current || finishedRef.current || decidingRef.current) return;
    const prediction = predictionRef.current;
    if (!prediction) return;
    const barAtStart = dayVisibleRef.current;
    decidingRef.current = true;
    setAiDeciding(true);
    try {
      const ctx = buildAiContext();
      if (!ctx) return;
      const res = await fetch('/api/ai/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          mode: 'pred_and_wait',
          kind: 'wake',
          system: PRED_WAIT_SYSTEM_PROMPT,
          user: buildWakeUserPrompt(prediction, triggerReason, ctx, horizonRepeatHint()),
          image: ctx.klineImage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
      if (!aiAutoRef.current || finishedRef.current) return;
      if (dayVisibleRef.current !== barAtStart) return;

      const act: 'buy' | 'sell' | 'hold' =
        data.action === 'buy' || data.action === 'sell' ? data.action : 'hold';
      const lots = Math.max(1, Math.round(Number(data.lots) || 1));
      const reason = String(data.reason || '').slice(0, 200);
      const revised = normalizePrediction(data.revised);

      aiUsedRef.current = true;
      predWakeEventsRef.current.push({
        reason: triggerReason,
        action: act,
        lots,
        aiReason: reason,
        revised: revised ?? undefined,
      });
      const actLabel =
        act === 'hold' ? '观望' : act === 'buy' ? `买入${lots}份` : `卖出${lots}份`;
      aiLogsRef.current.push(`[唤醒·${actLabel}] ${reason.slice(0, 60)}`);
      if (revised) {
        predictionRef.current = revised;
        horizonHistoryRef.current.push(revised.horizon);
      }
      // 唤醒即新的「第 0 天」：重置到期基准日与均量基准。
      // 否则修订后的 horizon 仍按最初预测日判定到期，会出现「每天到期、每天唤醒」，
      // pred_and_wait 退化成逐根模式（AI 反复被『预测 N 个交易日到期』叫醒又反复给出同样的 horizon）。
      predStartDayRef.current = dayVisibleRef.current - 1;
      {
        const arr = daySegRef.current;
        const prev = arr.slice(Math.max(0, predStartDayRef.current - 20), predStartDayRef.current);
        baseAvgVolRef.current =
          prev.length > 0 ? prev.reduce((s, b) => s + b.volume, 0) / prev.length : 0;
      }

      setAiMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          ts: Date.now(),
          kind: 'wake',
          triggerReason,
          action: act,
          lots,
          reason,
          revised: revised ?? undefined,
        },
      ]);

      doAction(act, act === 'hold' ? { actor: 'ai' } : { lots, actor: 'ai' });
      pwSchedule();
    } catch (e) {
      if (aiAutoRef.current) {
        setAiError(e instanceof Error ? e.message : String(e));
        setAiAuto(false);
        aiAutoRef.current = false;
      }
    } finally {
      decidingRef.current = false;
      setAiDeciding(false);
      pwSchedule();
    }
  }

  // 触发器：开关 / 进度推进 / 速度切换 / 加载状态变化时（重新）调度
  useEffect(() => {
    if (aiAuto && !finished && !loading && !loadError) {
      if (aiMode === 'pred_wait') pwSchedule();
      else aiSchedule();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAuto, finished, loading, loadError, displayBars.length, aiSpeed, aiMode]);

  // 卸载时清理 pending timer
  useEffect(() => {
    return () => {
      if (aiTickRef.current !== null) clearTimeout(aiTickRef.current);
      if (pwTimerRef.current !== null) clearTimeout(pwTimerRef.current);
    };
  }, []);

  function endTraining() {
    if (finished) return;
    // 提前结束时，把尚未决策的决策段补齐成当前持仓状态
    const equity = cashRef.current + sharesRef.current * currentPrice;
    const stockValue = sharesRef.current * currentPrice;
    const pos = sharesRef.current > 0 ? 1 : 0;
    const heavy = equity > 0 && stockValue / equity >= HEAVY_RATIO ? 1 : 0;
    const targetLen = aiModeRef.current === 'pred_wait' ? decisionBars : fullDecisionCount;
    while (positionSeriesRef.current.length < targetLen) {
      positionSeriesRef.current.push(pos);
      heavySeriesRef.current.push(heavy);
    }
    setFinished(true);
  }

  // ---- 结果计算 ----
  const lastDecisionClose = daySeg[decisionEndDay - 1]?.close ?? currentPrice;
  const finalCapital = cash + shares * lastDecisionClose;
  const profit = finalCapital - config.initialCapital;
  const profitRate = config.initialCapital > 0 ? profit / config.initialCapital : 0;
  const winTrades = closedRounds.filter((p) => p > 0).length;
  const lossTrades = closedRounds.filter((p) => p < 0).length;
  const openCount = trades.filter((t) => t.side === 'buy').length;

  // 同区间股票本身的涨跌幅（用决策段首尾 close 估算）
  const decisionStartClose = daySeg[dayWarmup]?.close ?? 0;
  const rangeReturn =
    decisionStartClose > 0 ? (lastDecisionClose - decisionStartClose) / decisionStartClose : 0;

  function buildRecord(): TrainingRecord {
    // mode 推导：AI 做过决策且存在人工交易 → mixed；AI 做过决策 → ai；否则 manual
    const hasHumanTrades = trades.some((t) => t.actor !== 'ai');
    const mode: 'manual' | 'ai' | 'mixed' = aiUsedRef.current
      ? (hasHumanTrades ? 'mixed' : 'ai')
      : 'manual';
    // pred_wait 模式按「天」记录持仓序列，自然结束时补齐到 decisionBars
    if (aiModeRef.current === 'pred_wait') {
      const equity = cashRef.current + sharesRef.current * lastDecisionClose;
      const stockValue = sharesRef.current * lastDecisionClose;
      const pos = sharesRef.current > 0 ? 1 : 0;
      const heavy = equity > 0 && stockValue / equity >= HEAVY_RATIO ? 1 : 0;
      while (positionSeriesRef.current.length < decisionBars) {
        positionSeriesRef.current.push(pos);
        heavySeriesRef.current.push(heavy);
      }
    }
    return {
      id: String(Date.now()),
      code: config.code,
      stockName: codeToStockName(config.code),
      period,
      // 区间 = 决策段起止（不含预热历史；daySeg[0] 是上市首日，此前误用导致区间虚大）
      startDate: daySeg[dayWarmup]?.date ?? '',
      endDate: daySeg[decisionEndDay - 1]?.date ?? '',
      initialCapital: config.initialCapital,
      finalCapital: Math.round(finalCapital * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      profitRate,
      rangeReturn,
      trades,
      winTrades,
      lossTrades,
      openCount,
      positionSeries: [...positionSeriesRef.current],
      heavySeries: [...heavySeriesRef.current],
      durationMs: Date.now() - sessionStartRef.current,
      mode,
      createdAt: Date.now(),
    };
  }

  const progress = useMemo(() => {
    if (decisionBars <= 0) return 0;
    return Math.min(1, (dayVisible - dayWarmup) / decisionBars);
  }, [dayVisible, dayWarmup, decisionBars]);

  const floatPnl = shares > 0 ? (currentPrice - avgCost) * shares : 0;
  const floatPnlRate = shares > 0 && avgCost > 0 ? (currentPrice - avgCost) / avgCost : 0;
  // 本次训练累计盈亏：当前总资产（现金 + 持仓市值）相对初始资金（已实现 + 浮动）
  const equity = cash + shares * currentPrice;
  const totalPnl = equity - config.initialCapital;
  const totalPnlRate = config.initialCapital > 0 ? totalPnl / config.initialCapital : 0;

  return (
    <div className="training-wrap">
      <div className="training-toolbar">
        <button className="ghost-btn" onClick={onExit}>
          退出
        </button>

        <div className="tb-item">
          <span className="tb-label">代码</span>
          <span
            className="tb-value"
            style={{ cursor: finished ? 'default' : 'pointer', userSelect: 'none' }}
            onPointerDown={() => setShowCode(true)}
            onPointerUp={() => setShowCode(false)}
            onPointerLeave={() => setShowCode(false)}
            onPointerCancel={() => setShowCode(false)}
          >
            {finished || showCode ? config.code : '******'}
          </span>
        </div>

        <div className="tb-item">
          <span className="tb-label">周期</span>
          <div className="seg">
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <button
                key={p}
                className={`seg-btn ${period === p ? 'active' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12 }}
                disabled={aiAuto && aiMode === 'pred_wait'}
                onClick={() => handlePeriodChange(p)}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="tb-item">
          <span className="tb-label">均线</span>
          <div className="seg">
            {[5, 10, 20, 60].map((p) => (
              <button
                key={p}
                className={`seg-btn ${maParams.includes(p) ? 'active' : ''}`}
                style={{
                  padding: '4px 8px',
                  fontSize: 12,
                  borderColor: maParams.includes(p) ? MA_COLORS[p] : undefined,
                }}
                onClick={() => toggleMa(p)}
              >
                MA{p}
              </button>
            ))}
          </div>
        </div>

        <div className="tb-item">
          <span className="tb-label">指标</span>
          <div className="seg">
            <button
              className={`seg-btn ${indicators.volume ? 'active' : ''}`}
              style={{ padding: '4px 8px', fontSize: 12 }}
              onClick={() => toggleIndicator('volume')}
            >
              量
            </button>
            <button
              className={`seg-btn ${indicators.macd ? 'active' : ''}`}
              style={{ padding: '4px 8px', fontSize: 12 }}
              onClick={() => toggleIndicator('macd')}
            >
              MACD
            </button>
            <button
              className={`seg-btn ${indicators.kdj ? 'active' : ''}`}
              style={{ padding: '4px 8px', fontSize: 12 }}
              onClick={() => toggleIndicator('kdj')}
            >
              KDJ
            </button>
          </div>
        </div>

        <div className="tb-item">
          <span className="tb-label">仓位</span>
          <span className="tb-value">
            {lots} / {config.positions}
          </span>
        </div>

        <div className="tb-item">
          <span className="tb-label">进度</span>
          <span className="tb-value">
            {decidedCount} / {fullDecisionCount}
          </span>
        </div>

        <div className="tb-item" style={{ flex: 1 }}>
          <div
            style={{
              height: 6,
              background: 'var(--bg-elev)',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 0.2s',
              }}
            />
          </div>
        </div>
      </div>

      <div className="chart-area" ref={containerRef}>
        {loading && (
          <div className="overlay-hint">加载行情数据中…</div>
        )}
        {loadError && (
          <div className="overlay-hint" style={{ color: 'var(--up)' }}>
            {loadError}
          </div>
        )}
        {!finished && !loading && !loadError && (
          <div className="overlay-hint">
            双盲模式 · 隐藏代码与日期 · 逐根决策
          </div>
        )}
        <div className="crosshair-tip" ref={crosshairTipRef} />
      </div>

      <AiLogPanel
        messages={aiMessages}
        thinking={aiDeciding}
        error={aiError}
        running={aiAuto}
      />

      <div className="control-bar">
        {!finished ? (
          <>
            {/* ---- 人工决策区：买 / 观望 / 卖 ---- */}
            <div className="tb-group manual-zone">
              <span className="tb-chip zone-chip">人工</span>
              <span className="tb-chip up">买</span>
              <div className="seg">
                {Array.from({ length: config.positions - lots }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={`seg-btn ${buyLots === n ? 'active' : ''}`}
                    disabled={aiAuto}
                    onClick={() => setBuyLots(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                className="action-btn buy"
                disabled={lots >= config.positions || aiAuto || loading || !!loadError}
                onClick={() => doAction('buy')}
              >
                买入·{buyLots}
              </button>
              <button
                className="action-btn hold"
                disabled={aiAuto || loading || !!loadError}
                onClick={() => doAction('hold')}
              >
                观望
              </button>
              <div className="tb-sep inner" />
              <span className="tb-chip down">卖</span>
              <div className="seg">
                {Array.from({ length: lots }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={`seg-btn ${sellLots === n ? 'active' : ''}`}
                    disabled={aiAuto}
                    onClick={() => setSellLots(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                className="action-btn sell"
                disabled={lots <= 0 || aiAuto || loading || !!loadError}
                onClick={() => doAction('sell')}
              >
                卖出·{sellLots}
              </button>
            </div>
            <div className="tb-sep" />
            {/* ---- AI 决策区：模式 + 托管 ---- */}
            <div className="tb-group ai-zone">
              <span className="tb-chip ai zone-chip">AI 托管</span>
              <div className="seg">
                {(
                  [
                    ['step', '逐根'],
                    ['pred_wait', '预测'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    className={`seg-btn ${aiMode === m ? 'active' : ''}`}
                    disabled={aiAuto || loading || !!loadError}
                    onClick={() => {
                      setAiMode(m);
                      aiModeRef.current = m;
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className={`seg-btn ${aiAuto ? 'active' : 'cta'}`}
                disabled={loading || !!loadError}
                onClick={() => {
                  const next = !aiAuto;
                  setAiAuto(next);
                  aiAutoRef.current = next; // 立即同步，避免 useEffect 滞后窗口内误决策
                  setAiError('');
                  if (!next) {
                    if (aiTickRef.current !== null) {
                      clearTimeout(aiTickRef.current);
                      aiTickRef.current = null;
                    }
                    if (pwTimerRef.current !== null) {
                      clearTimeout(pwTimerRef.current);
                      pwTimerRef.current = null;
                    }
                  }
                  // 关闭托管 = 进入人工接管：插入系统提示（step 与 pred_wait 均适用）
                  if (!next) {
                    setAiMessages((prev) => [
                      ...prev,
                      { id: makeId(), ts: Date.now(), kind: 'notice', text: '人工接管了' },
                    ]);
                  }
                  // 预测模式：关闭 = 预测作废；重开 = 以当前 bar 为新第 0 天重新预测
                  if (aiModeRef.current === 'pred_wait') {
                    predictionRef.current = null;
                    predWakeEventsRef.current = [];
                    if (next) predStartDayRef.current = 0;
                  }
                }}
                title={
                  aiMode === 'pred_wait'
                    ? '开启后 AI 先做一次预测，之后仅在命中条件时唤醒'
                    : '开启后由 AI 逐根决策，随时可关闭接管'
                }
              >
                {aiAuto ? '关闭托管' : '开启托管'}
              </button>
              {aiAuto && (
                <>
                  <div className="tb-sep inner" />
                  <div className="tb-item">
                    <span className="tb-label">速度</span>
                    <div className="seg">
                      {([
                        ['慢', 2500],
                        ['快', 1200],
                        ['极速', 300],
                      ] as const).map(([label, ms]) => (
                        <button
                          key={ms}
                          className={`seg-btn ${aiSpeed === ms ? 'active' : ''}`}
                          onClick={() => setAiSpeed(ms)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div style={{ flex: 1 }} />
            <button className="ghost-btn danger" onClick={endTraining}>
              结束训练
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
            <div className="pnl-panel" style={{ flex: 1 }}>
              <div className="stat-chip">
                <span className="k">股票</span>
                <span className="v">{config.code}</span>
              </div>
              <div className="stat-chip">
                <span className="k">区间</span>
                <span className="v" style={{ fontSize: 13 }}>
                  {daySeg[0]?.date} ~ {daySeg[decisionEndDay - 1]?.date}
                </span>
              </div>
              <div className="stat-chip">
                <span className="k">初始资金</span>
                <span className="v">{config.initialCapital.toLocaleString()}</span>
              </div>
              <div className="stat-chip">
                <span className="k">最终资金</span>
                <span className="v">{Math.round(finalCapital).toLocaleString()}</span>
              </div>
              <div className="stat-chip">
                <span className="k">盈亏</span>
                <span className={`v ${profit >= 0 ? 'up' : 'down'}`}>
                  {profit >= 0 ? '+' : ''}
                  {Math.round(profit).toLocaleString()}（
                  {(profitRate * 100).toFixed(2)}%）
                </span>
              </div>
              <div className="stat-chip">
                <span className="k">胜率</span>
                <span className="v">
                  {winTrades + lossTrades > 0
                    ? ((winTrades / (winTrades + lossTrades)) * 100).toFixed(0) + '%'
                    : '—'}
                </span>
              </div>
              {aiUsedRef.current && (
                <div className="stat-chip">
                  <span className="k">模式</span>
                  <span className="v">
                    {trades.some((t) => t.actor !== 'ai') ? '人机混合' : 'AI 托管'}
                  </span>
                </div>
              )}
            </div>
            <button className="ghost-btn" onClick={onExit}>
              再来一场
            </button>
            <button className="primary-btn" style={{ width: 'auto', padding: '12px 24px' }} onClick={() => onFinish(buildRecord())}>
              保存并查看统计
            </button>
          </div>
        )}
      </div>

      <div
        className="control-bar"
        style={{ borderTop: 'none', paddingTop: 0, justifyContent: 'space-between' }}
      >
        <div className="pnl-panel">
          <div className="stat-chip">
            <span className="k">可用资金</span>
            <span className="v">{Math.round(cash).toLocaleString()}</span>
          </div>
          <div className="stat-chip">
            <span className="k">持仓</span>
            <span className="v">
              {shares > 0 ? `${shares} 股 · ${lots}/${config.positions} 仓` : '空仓'}
            </span>
          </div>
          <div className="stat-chip">
            <span className="k">成本价</span>
            <span className="v">{shares > 0 ? avgCost.toFixed(3) : '—'}</span>
          </div>
          <div className="stat-chip">
            <span className="k">现价</span>
            <span className="v">{currentPrice ? currentPrice.toFixed(3) : '—'}</span>
          </div>
          <div className="stat-chip">
            <span className="k">浮动盈亏</span>
            {shares > 0 ? (
              <span className={`v ${floatPnl >= 0 ? 'up' : 'down'}`}>
                {floatPnl >= 0 ? '+' : ''}
                {floatPnl.toFixed(2)}（
                {floatPnlRate >= 0 ? '+' : ''}
                {(floatPnlRate * 100).toFixed(2)}%）
              </span>
            ) : (
              <span className="v">—</span>
            )}
          </div>
          <div className="stat-chip">
            <span className="k">累计盈亏</span>
            <span
              className={`v ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}`}
              title="进入本次训练后的总盈亏（已实现 + 浮动，相对初始资金）"
            >
              {totalPnl >= 0 ? '+' : ''}
              {totalPnl.toFixed(2)}（
              {totalPnlRate >= 0 ? '+' : ''}
              {(totalPnlRate * 100).toFixed(2)}%）
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
