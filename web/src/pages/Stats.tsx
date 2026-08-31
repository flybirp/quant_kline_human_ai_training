import { useEffect, useMemo, useState } from 'react';
import { clearRecords, loadRecords, loadStarred, toggleStarred, INITIAL_COINS } from '../store';
import { downloadTrainingCSV } from '../lib/export';
import type { TrainingRecord } from '../types';

interface Props {
  onBack: () => void;
  onGoTrain: () => void;
}

// 持仓率/重仓率：单场训练的逐根决策 bar 中状态为 1 的比例
function holdingRateOf(r: TrainingRecord): number {
  const total = r.positionSeries.length;
  if (total === 0) return 0;
  return r.positionSeries.reduce((s, v) => s + v, 0) / total;
}

function heavyRateOf(r: TrainingRecord): number {
  const total = r.positionSeries.length;
  if (total === 0) return 0;
  return r.heavySeries.reduce((s, v) => s + v, 0) / total;
}

function fmtPct(x: number, fractionDigits = 2): string {
  if (!Number.isFinite(x)) return '∞';
  return (x * 100).toFixed(fractionDigits) + '%';
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '0秒';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分${String(s).padStart(2, '0')}秒`;
  if (m > 0) return `${m}分${String(s).padStart(2, '0')}秒`;
  return `${s}秒`;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Summary {
  n: number;
  winRate: number; // 训练胜率：profit>0 场次 / 总场次
  beatMarketRate: number; // 跑赢区间率：profitRate>rangeReturn 的占比
  profitRatio: number; // 训练盈亏比：sum(正盈亏) / |sum(负盈亏)|
  holdingDays: number; // 持仓天数：positionSeries sum
  holdingRate: number; // 持仓率：holdingDays / 总决策 bar 数
  heavyRate: number; // 重仓率：heavyDays / 总决策 bar 数
  totalDurationMs: number; // 训练耗时：所有场次累计训练耗时
  openTotal: number; // 开仓次数
  openWinRate: number; // 开仓胜率：盈利平仓 / 总平仓
  maxGain: number; // 最大盈利：单场最高 profitRate
  maxDrawdown: number; // 最大回撤：累计 finalCapital 曲线最大跌幅
  fireworkTotal: number; // 当前累计爆竹数
  curve: number[]; // 累计爆竹数随场次曲线
  firstAt: number; // 首场 createdAt
  lastAt: number; // 末场 createdAt
}

function computeSummary(records: TrainingRecord[]): Summary {
  const n = records.length;
  if (n === 0) {
    return {
      n: 0, winRate: 0, beatMarketRate: 0, profitRatio: 0,
      holdingDays: 0, holdingRate: 0, heavyRate: 0,
      totalDurationMs: 0, openTotal: 0, openWinRate: 0,
      maxGain: 0, maxDrawdown: 0, fireworkTotal: INITIAL_COINS,
      curve: [], firstAt: 0, lastAt: 0,
    };
  }

  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const wins = sorted.filter((r) => r.profit > 0).length;
  const winRate = wins / n;

  const beat = sorted.filter((r) => r.profitRate > r.rangeReturn).length;
  const beatMarketRate = beat / n;

  const totalWin = sorted.filter((r) => r.profit > 0).reduce((s, r) => s + r.profit, 0);
  const totalLossAbs = Math.abs(
    sorted.filter((r) => r.profit < 0).reduce((s, r) => s + r.profit, 0),
  );
  const profitRatio = totalLossAbs > 0 ? totalWin / totalLossAbs : totalWin > 0 ? Infinity : 0;

  let holdingDays = 0;
  let heavyDays = 0;
  let totalDecisionBars = 0;
  for (const r of sorted) {
    holdingDays += r.positionSeries.reduce((s, v) => s + v, 0);
    heavyDays += r.heavySeries.reduce((s, v) => s + v, 0);
    totalDecisionBars += r.positionSeries.length;
  }
  const holdingRate = totalDecisionBars > 0 ? holdingDays / totalDecisionBars : 0;
  const heavyRate = totalDecisionBars > 0 ? heavyDays / totalDecisionBars : 0;

  const totalDurationMs = sorted.reduce((s, r) => s + r.durationMs, 0);

  const openTotal = sorted.reduce((s, r) => s + r.openCount, 0);
  const totalWinRounds = sorted.reduce((s, r) => s + r.winTrades, 0);
  const totalLossRounds = sorted.reduce((s, r) => s + r.lossTrades, 0);
  const totalClosed = totalWinRounds + totalLossRounds;
  const openWinRate = totalClosed > 0 ? totalWinRounds / totalClosed : 0;

  const maxGain = sorted.reduce((m, r) => Math.max(m, r.profitRate), 0);

  // 累计净盈亏曲线上的最大回撤：以「累计盈亏」作净值序列
  let running = 0;
  let peak = -Infinity;
  let maxDD = 0;
  for (const r of sorted) {
    running += r.profit;
    peak = Math.max(peak, running);
    if (peak > 0) {
      const dd = (peak - running) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  // 爆竹曲线：总资金按每场训练收益率复利累计
  const curve: number[] = [];
  let acc = INITIAL_COINS;
  for (const r of sorted) {
    acc = Math.round(acc * (1 + r.profitRate) * 100) / 100;
    curve.push(acc);
  }

  return {
    n,
    winRate,
    beatMarketRate,
    profitRatio,
    holdingDays,
    holdingRate,
    heavyRate,
    totalDurationMs,
    openTotal,
    openWinRate,
    maxGain,
    maxDrawdown: maxDD,
    fireworkTotal: acc,
    curve,
    firstAt: sorted[0].createdAt,
    lastAt: sorted[n - 1].createdAt,
  };
}

// 简单的 SVG 折线图：自绘坐标轴 + 累计曲线 + 数据点
function FireworkChart({ curve }: { curve: number[] }) {
  if (curve.length === 0) {
    return (
      <div className="chart-empty">
        尚无训练记录，完成第一场训练后此处将显示累计爆竹数量曲线
      </div>
    );
  }
  const W = 1000;
  const H = 260;
  const padL = 60;
  const padR = 30;
  const padT = 18;
  const padB = 38;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const N = curve.length;
  const maxV = Math.max(...curve, 1);

  const xOf = (i: number) =>
    N <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (N - 1);
  const yOf = (v: number) => padT + innerH - (innerH * v) / maxV;

  const points = curve.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  const pathD = points
    .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
    .join(' ');

  // 5 档网格（圆整最大值到比较干净的刻度）
  const yTicks = 5;
  const yStep = maxV / yTicks;
  const grid = Array.from({ length: yTicks + 1 }, (_, i) => i * yStep);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="fireworks-svg" preserveAspectRatio="none">
      {grid.map((g, i) => {
        const y = yOf(g);
        return (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y}
              y2={y}
              stroke="#e2e5ea"
              strokeDasharray="3,3"
            />
            <text x={padL - 6} y={y + 4} textAnchor="end" fontSize={11} fill="#9ba2aa">
              {Math.round(g).toLocaleString()}
            </text>
          </g>
        );
      })}
      <path d={pathD} fill="none" stroke="#c84054" strokeWidth={2.5} />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#c84054" />
      ))}
      {/* 末端标签 */}
      {points.length > 0 && (
        <text
          x={points[points.length - 1].x - 4}
          y={points[points.length - 1].y - 8}
          fontSize={13}
          fill="#c84054"
          textAnchor="end"
          fontWeight={700}
        >
          {curve[curve.length - 1].toLocaleString()}
        </text>
      )}
    </svg>
  );
}

interface ItemProps {
  record: TrainingRecord;
  starred: boolean;
  onToggleStar: () => void;
}

function RecordItem({ record, starred, onToggleStar }: ItemProps) {
  const hRate = holdingRateOf(record);
  const heavyR = heavyRateOf(record);
  const totalRounds = record.winTrades + record.lossTrades;
  const openWin = totalRounds > 0 ? record.winTrades / totalRounds : 0;
  const rangePct = record.rangeReturn * 100;
  const pnlPct = record.profitRate * 100;
  return (
    <div className="record-item-card">
      <div className="ric-head">
        <span className="badge blue">双盲训练</span>
        <span className="ric-name">{record.stockName}</span>
        <span className="ric-time">{fmtDateTime(record.createdAt)}</span>
        <span style={{ flex: 1 }} />
        <button
          className={`star-btn ${starred ? 'on' : ''}`}
          onClick={onToggleStar}
          aria-label="收藏"
        >
          ★
        </button>
      </div>
      <div className="ric-stats">
        <RicCell k="持仓率" v={`${(hRate * 100).toFixed(2)}%`} />
        <RicCell k="重仓率" v={`${(heavyR * 100).toFixed(2)}%`} />
        <RicCell k="开仓胜率" v={totalRounds > 0 ? `${(openWin * 100).toFixed(2)}%` : '—'} />
        <RicCell k="区间涨跌幅" v={`${rangePct >= 0 ? '+' : ''}${rangePct.toFixed(2)}%`} highlight="up" />
        <RicCell k="盈亏" v={`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`} highlight={pnlPct >= 0 ? 'up' : 'down'} />
      </div>
    </div>
  );
}

function RicCell({ k, v, highlight }: { k: string; v: string; highlight?: 'up' | 'down' }) {
  return (
    <div className="ric-cell">
      <div className="ric-cell-v" data-color={highlight || ''}>{v}</div>
      <div className="ric-cell-k">{k}</div>
    </div>
  );
}

export default function Stats({ onBack, onGoTrain }: Props) {
  const [records, setRecords] = useState<TrainingRecord[]>(() => loadRecords());
  const [starred, setStarred] = useState<string[]>(() => loadStarred());
  const [sort, setSort] = useState<'time' | 'profit'>('time');

  // 切到本页时刷新一次
  useEffect(() => {
    setRecords(loadRecords());
    setStarred(loadStarred());
  }, []);

  const summary = useMemo(() => computeSummary(records), [records]);

  const sortedRecords = useMemo(() => {
    const arr = [...records];
    if (sort === 'time') return arr.sort((a, b) => b.createdAt - a.createdAt);
    return arr.sort((a, b) => b.profitRate - a.profitRate);
  }, [records, sort]);

  function handleClear() {
    if (window.confirm('确定清空所有历史训练记录吗？此操作不可撤销。')) {
      clearRecords();
      setRecords([]);
    }
  }

  function handleExport() {
    if (records.length === 0) {
      window.alert('当前没有可导出的训练记录');
      return;
    }
    downloadTrainingCSV(records);
  }

  function handleToggleStar(id: string) {
    setStarred(toggleStarred(id));
  }

  return (
    <div className="stats-wrap">
      {/* 顶部栏：返回 / 用户 / 子标题 / 数据导出 */}
      <header className="stats-top">
        <button className="ghost-btn-small" onClick={onBack}>
          ← 返回主页
        </button>
        <div className="stats-top-center">
          <div className="stats-top-title">用户6594</div>
          <div className="stats-top-sub">当前季度训练记录</div>
        </div>
        <button className="ghost-btn-small primary-text" onClick={handleExport}>
          数据导出
        </button>
      </header>

      {/* 单一 Tab */}
      <div className="stats-tabs">
        <div className="stats-tab active">1.进行中</div>
      </div>

      {/* 第一区：爆竹数量曲线 */}
      <section className="card fireworks-card">
        <div className="card-head fireworks-head">
          <h3 className="card-title">爆竹数量曲线</h3>
          <div className="fireworks-head-right">
            <div className="fireworks-total-row">
              <span className="dot" />
              <span className="k-label">重置期间</span>
              <span className="v-emphasis">{summary.fireworkTotal.toLocaleString()}</span>
            </div>
            <div className="fireworks-meta">
              <div>共{summary.n}场训练</div>
              <div>第 {summary.n} 次训练</div>
            </div>
          </div>
        </div>
        <FireworkChart curve={summary.curve} />
        <div className="card-foot fireworks-foot">
          <span>{summary.firstAt ? fmtDateTime(summary.firstAt) : '—'}</span>
          <span>{summary.lastAt ? fmtDateTime(summary.lastAt) : '—'}</span>
        </div>
      </section>

      {/* 第二区：训练数据统计（蓝色卡） */}
      <section className="stats-summary-card">
        <div className="summary-head">
          <h3 className="card-title">训练数据</h3>
          <span className="summary-state">
            训练结果：{summary.n > 0 ? '进行中' : '暂无'}
          </span>
        </div>
        <div className="summary-grid">
          <Cell k="训练场次" v={String(summary.n)} />
          <Cell k="训练胜率" v={fmtPct(summary.winRate)} />
          <Cell k="跑赢区间率" v={fmtPct(summary.beatMarketRate)} />
          <Cell k="训练盈亏比" v={summary.profitRatio.toFixed(2)} />
          <Cell k="持仓时间" v={`${summary.holdingDays}天`} />
          <Cell k="持仓率" v={fmtPct(summary.holdingRate)} />
          <Cell k="重仓率" v={fmtPct(summary.heavyRate)} />
          <Cell k="训练耗时" v={fmtDuration(summary.totalDurationMs)} />
          <Cell k="开仓次数" v={String(summary.openTotal)} />
          <Cell k="开仓胜率" v={fmtPct(summary.openWinRate)} />
          <Cell k="最大盈利" v={fmtPct(summary.maxGain)} />
          <Cell k="最大回撤" v={`-${fmtPct(summary.maxDrawdown)}`} extraClass="down" />
        </div>
      </section>

      {/* 排序条 */}
      <div className="sort-bar">
        <button
          className={`sort-btn ${sort === 'time' ? 'active' : ''}`}
          onClick={() => setSort('time')}
        >
          训练时间 <span className="caret">{sort === 'time' ? '↓' : '↕'}</span>
        </button>
        <button
          className={`sort-btn ${sort === 'profit' ? 'active' : ''}`}
          onClick={() => setSort('profit')}
        >
          训练收益 <span className="caret">{sort === 'profit' ? '↓' : '↕'}</span>
        </button>
        <div className="toolbar-right">
          {records.length > 0 && (
            <button className="ghost-btn-small" onClick={handleClear}>
              清空记录
            </button>
          )}
        </div>
      </div>

      {/* 第三区：训练明细列表 */}
      {sortedRecords.length === 0 ? (
        <div className="empty-state">
          <div className="big">📈</div>
          <div>还没有训练记录，快去开始第一场 K 线训练吧</div>
          <button
            className="primary-btn"
            style={{ width: 'auto', marginTop: 20, padding: '12px 32px' }}
            onClick={onGoTrain}
          >
            去训练
          </button>
        </div>
      ) : (
        <div className="record-list">
          {sortedRecords.map((r) => (
            <RecordItem
              key={r.id}
              record={r}
              starred={starred.includes(r.id)}
              onToggleStar={() => handleToggleStar(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Cell({ k, v, extraClass }: { k: string; v: string; extraClass?: string }) {
  return (
    <div className="summary-cell">
      <span className="summary-k">{k}</span>
      <span className={`summary-v ${extraClass || ''}`}>{v}</span>
    </div>
  );
}
