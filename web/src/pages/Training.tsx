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
}

// K 线行：附带 MA5/20/60（基于全量已揭示数据计算，截取窗口后边界值依然准确）
interface AiBarRow {
  bar: Bar;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
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

// 为一组 K 线附加 MA5/20/60
function buildAiRows(bars: Bar[]): AiBarRow[] {
  const closes = bars.map((b) => b.close);
  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  return bars.map((bar, i) => ({ bar, ma5: ma5[i], ma20: ma20[i], ma60: ma60[i] }));
}

// K 线数据块（多周期统一格式：序号,开,高,低,收,量,MA5,MA20,MA60）
function klineBlock(title: string, rows: AiBarRow[], tailNote: string): string[] {
  const lines = [
    `${title}（最近 ${rows.length} 根，从早到晚，格式：序号,开,高,低,收,量,MA5,MA20,MA60${tailNote}）`,
  ];
  rows.forEach((r, i) => {
    lines.push(
      `${i + 1},${fmt2(r.bar.open)},${fmt2(r.bar.high)},${fmt2(r.bar.low)},${fmt2(r.bar.close)},${Math.round(r.bar.volume)},${fmtMa(r.ma5)},${fmtMa(r.ma20)},${fmtMa(r.ma60)}`,
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

  lines.push('【近期决策记忆】（从早到晚，最近10条，含你当时的理由）');
  if (ctx.logs.length > 0) {
    ctx.logs.slice(-10).forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  } else {
    lines.push('暂无，训练刚开始。');
  }
  lines.push('');

  // 多周期走势：日线看近期细节，周线看中期结构，月线看长期格局
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
  const [aiReason, setAiReason] = useState(''); // 最新一条决策理由
  const [aiError, setAiError] = useState('');
  const decidingRef = useRef(false); // 防重入
  const aiLogsRef = useRef<string[]>([]); // 决策记忆滚动窗口（借鉴 FinMem 分层记忆）
  const aiUsedRef = useRef(false); // 本场是否发生过 AI 决策（用于 mode 标记）
  // 调度器模式：同一时刻最多一个 pending timer，杜绝并发爆发
  const aiTickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiAutoRef = useRef(false);
  const finishedRef = useRef(false);
  const aiDecideRef = useRef<() => void>(() => {}); // 指向最新渲染的决策函数，避免闭包过期

  useEffect(() => { finishedRef.current = finished; }, [finished]);
  useEffect(() => { aiDecideRef.current = aiDecideOnce; });

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
        // 决策段起点：在日线中随机定位，保证其后有足够的决策段 + 未来数据
        const maxStart = dayFull.length - decisionBars - 1;
        const start = Math.floor(Math.random() * (maxStart + 1));
        const future = Math.min(FUTURE_BARS, dayFull.length - start - decisionBars);
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
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [decisionBars, config.initialCapital],
  );

  useEffect(() => {
    loadSegment(config.code);
  }, [config.code, loadSegment]);

  function handlePeriodChange(p: Period) {
    if (p === period || finished) return;
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

  // 揭晓后追加显示未来 K 线（含决策段之后的未来周期）
  useEffect(() => {
    if (finished && daySeg.length > 0) {
      setDayVisible(daySeg.length);
    }
  }, [finished, daySeg.length]);

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
      setClosedRounds((prev) => [...prev, profit]);
      setTrades((prev) => [
        ...prev,
        { side: 'sell', price: sellPrice, shares: sellShares, date: currentBar.date, index: displayBars.length - 1, actor },
      ]);
    }

    advance();
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
          system: AI_SYSTEM_PROMPT,
          user: buildAiUserPrompt(ctx),
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
      setAiReason(`${actLabel} —— ${data.reason || ''}`);
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

  // 触发器：开关 / 进度推进 / 速度切换 / 加载状态变化时（重新）调度
  useEffect(() => {
    if (aiAuto && !finished && !loading && !loadError) aiSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAuto, finished, loading, loadError, displayBars.length, aiSpeed]);

  // 卸载时清理 pending timer
  useEffect(() => {
    return () => {
      if (aiTickRef.current !== null) clearTimeout(aiTickRef.current);
    };
  }, []);

  function endTraining() {
    if (finished) return;
    // 提前结束时，把尚未决策的决策段折叠周期补齐成当前持仓状态
    const equity = cashRef.current + sharesRef.current * currentPrice;
    const stockValue = sharesRef.current * currentPrice;
    const pos = sharesRef.current > 0 ? 1 : 0;
    const heavy = equity > 0 && stockValue / equity >= HEAVY_RATIO ? 1 : 0;
    while (positionSeriesRef.current.length < fullDecisionCount) {
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
    return {
      id: String(Date.now()),
      code: config.code,
      stockName: codeToStockName(config.code),
      period,
      startDate: daySeg[0]?.date ?? '',
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

      {!finished && (aiAuto || aiReason || aiError) && (
        <div className="ai-bar">
          {aiDeciding ? (
            <span className="ai-status">AI 思考中…</span>
          ) : aiError ? (
            <span className="ai-status ai-status-error">AI 已暂停：{aiError}</span>
          ) : (
            <span className="ai-status">
              {aiAuto ? 'AI ' : 'AI（已接管）'}
              {aiReason}
            </span>
          )}
        </div>
      )}

      <div className="control-bar">
        {!finished ? (
          <>
            <div className="tb-item">
              <span className="tb-label">买</span>
              <div className="seg">
                {Array.from({ length: config.positions - lots }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={`seg-btn ${buyLots === n ? 'active' : ''}`}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    disabled={aiAuto}
                    onClick={() => setBuyLots(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
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
            <div className="tb-item">
              <span className="tb-label">卖</span>
              <div className="seg">
                {Array.from({ length: lots }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={`seg-btn ${sellLots === n ? 'active' : ''}`}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    disabled={aiAuto}
                    onClick={() => setSellLots(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="action-btn sell"
              disabled={lots <= 0 || aiAuto || loading || !!loadError}
              onClick={() => doAction('sell')}
            >
              卖出·{sellLots}
            </button>
            <div className="tb-item">
              <span className="tb-label" style={{ fontSize: 14, fontWeight: 700 }}>
                AI
              </span>
              <div className="seg">
                <button
                  className={`seg-btn ${aiAuto ? 'active' : ''}`}
                  style={{ padding: '6px 16px', fontSize: 15, fontWeight: 700 }}
                  disabled={loading || !!loadError}
                  onClick={() => {
                    const next = !aiAuto;
                    setAiAuto(next);
                    aiAutoRef.current = next; // 立即同步，避免 useEffect 滞后窗口内误决策
                    setAiError('');
                    if (!next && aiTickRef.current !== null) {
                      clearTimeout(aiTickRef.current);
                      aiTickRef.current = null;
                    }
                  }}
                  title="开启后由 AI 逐根决策，随时可关闭接管"
                >
                  托管{aiAuto ? '中' : ''}
                </button>
              </div>
            </div>
            {aiAuto && (
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
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={() => setAiSpeed(ms)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <button className="ghost-btn" onClick={endTraining}>
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
          {shares > 0 && (
            <div className="stat-chip">
              <span className="k">浮动盈亏</span>
              <span className={`v ${floatPnl >= 0 ? 'up' : 'down'}`}>
                {floatPnl >= 0 ? '+' : ''}
                {floatPnl.toFixed(2)}（
                {floatPnlRate >= 0 ? '+' : ''}
                {(floatPnlRate * 100).toFixed(2)}%）
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
