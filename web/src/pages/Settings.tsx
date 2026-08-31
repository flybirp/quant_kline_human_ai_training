import { useState } from 'react';
import type { Period, TrainMode, TrainingConfig } from '../types';

interface Props {
  stocks: string[];
  loading: boolean;
  error: string;
  onStart: (config: TrainingConfig) => void;
  onBack: () => void;
}

// 训练买卖基准资金：固定为虚拟大额，与主页「爆竹coins」脱钩，
// 保证高价股（如茅台）也能正常买入，训练盈亏据此计算。
export const VIRTUAL_CAPITAL = 1_000_000;

const PERIOD_LABELS: Record<Period, string> = {
  day: '日线',
  week: '周线',
  month: '月线',
};

const MA_OPTIONS = [5, 10, 20, 60];
const POSITION_OPTIONS = [1, 2, 3, 4, 5];

// AI 托管：自定义策略指令持久化 key
const AI_PROMPT_KEY = 'kline-ai-prompt';

// 预设策略模板（点击填入文本框，可自由修改）
const AI_PROMPT_PRESETS: { label: string; text: string }[] = [
  { label: '通用', text: '' },
  {
    label: '趋势跟随',
    text: '你偏好趋势跟随策略：价格站上MA20且均线多头排列时顺势分批买入，跌破MA10减仓一半，跌破MA20清仓离场。',
  },
  {
    label: '低吸高抛',
    text: '你偏好均值回归策略：在关键支撑位（前低、MA20、MA60）附近缩量回踩时分批低吸补仓，不需要等待企稳确认；反弹至前高压力位分批止盈。',
  },
  {
    label: '保守防御',
    text: '你极度保守：默认保持空仓观望，只在胜率极高的信号（如放量突破叠加多周期走势确认）出现时才以最小份数参与，快进快出。',
  },
];

export default function Settings({ stocks, loading, error, onStart, onBack }: Props) {
  const [mode, setMode] = useState<TrainMode>('random');
  const [code, setCode] = useState('');
  const [period, setPeriod] = useState<Period>('day');
  const [positions, setPositions] = useState(2);
  const [maParams, setMaParams] = useState<number[]>([5, 10, 20, 60]);
  const [decisionBars, setDecisionBars] = useState(101);
  const [feeRate, setFeeRate] = useState(0.03); // 百分比
  const [slippage, setSlippage] = useState(0.01); // 百分比
  const [stampTax, setStampTax] = useState(0.1); // 百分比
  const [aiPrompt, setAiPrompt] = useState(() => localStorage.getItem(AI_PROMPT_KEY) || '');

  function updateAiPrompt(text: string) {
    setAiPrompt(text);
    localStorage.setItem(AI_PROMPT_KEY, text);
  }

  function toggleMa(p: number) {
    setMaParams((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p].sort((a, b) => a - b),
    );
  }

  function submit() {
    const cfg: TrainingConfig = {
      mode,
      code: code.trim(),
      period,
      initialCapital: VIRTUAL_CAPITAL,
      positions: Math.max(1, Math.min(5, positions)),
      maParams: [...maParams].sort((a, b) => a - b),
      decisionBars: Math.max(1, decisionBars),
      feeRate: Math.max(0, feeRate) / 100,
      slippage: Math.max(0, slippage) / 100,
      stampTax: Math.max(0, stampTax) / 100,
    };
    onStart(cfg);
  }

  const canSubmit =
    !loading && (mode === 'random' || code.trim().length > 0);

  return (
    <div className="settings-wrap">
      <button className="link-btn" onClick={onBack} style={{ marginBottom: 8 }}>
        ← 返回主页
      </button>

      <div className="settings-title">开始一场 K 线训练</div>
      <div className="settings-sub">
        系统会隐藏股票代码与日期，逐根回放真实历史 K 线，请你做出买卖决策。
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(246,70,93,0.12)',
            border: '1px solid var(--up)',
            color: 'var(--up)',
            padding: '12px 16px',
            borderRadius: 8,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}

      <div className="form-group">
        <label className="form-label">训练品种</label>
        <div className="seg">
          <button
            className={`seg-btn ${mode === 'random' ? 'active' : ''}`}
            onClick={() => setMode('random')}
          >
            随机股票
          </button>
          <button
            className={`seg-btn ${mode === 'specified' ? 'active' : ''}`}
            onClick={() => setMode('specified')}
          >
            指定股票
          </button>
        </div>
      </div>

      {mode === 'specified' && (
        <div className="form-group">
          <label className="form-label">股票代码</label>
          <input
            className="input"
            list="stock-list"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="如 000001 / 600519"
            maxLength={6}
          />
          <datalist id="stock-list">
            {stocks.slice(0, 2000).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">K 线周期</label>
        <div className="seg">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <button
              key={p}
              className={`seg-btn ${period === p ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          分仓数
          <span className="form-hint">将资金分成几份，训练中可分仓买入 / 分仓卖出</span>
        </label>
        <div className="seg">
          {POSITION_OPTIONS.map((n) => (
            <button
              key={n}
              className={`seg-btn ${positions === n ? 'active' : ''}`}
              onClick={() => setPositions(n)}
            >
              {n} 仓
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          交易成本
          <span className="form-hint">用于模拟真实交易，训练盈亏会扣除这些费用</span>
        </label>
        <div className="input-row">
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>手续费 (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={0.001}
              value={feeRate}
              onChange={(e) => setFeeRate(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>滑点损失 (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={0.001}
              value={slippage}
              onChange={(e) => setSlippage(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>印花税 (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={0.001}
              value={stampTax}
              onChange={(e) => setStampTax(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">均线参数</label>
        <div className="check-group">
          {MA_OPTIONS.map((p) => (
            <div
              key={p}
              className={`check ${maParams.includes(p) ? 'active' : ''}`}
              onClick={() => toggleMa(p)}
            >
              MA{p}
            </div>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          决策根数
          <span className="form-hint">需要你逐根做买卖决策的数量</span>
        </label>
        <input
          className="input"
          type="number"
          min={1}
          value={decisionBars}
          onChange={(e) => setDecisionBars(Number(e.target.value))}
        />
      </div>

      <div className="form-group">
        <label className="form-label">
          AI 策略指令
          <span className="form-hint">训练页开启「AI 托管」时注入给 LLM 的个性化策略，留空则使用通用交易员人设</span>
        </label>
        <div className="seg" style={{ marginBottom: 8 }}>
          {AI_PROMPT_PRESETS.map((p) => (
            <button
              key={p.label}
              className="seg-btn"
              onClick={() => updateAiPrompt(p.text)}
              title={p.text || '通用交易员人设（留空）'}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          className="input"
          rows={3}
          value={aiPrompt}
          onChange={(e) => updateAiPrompt(e.target.value)}
          placeholder="例：只在价格站稳 MA20 上方时持仓，跌破 MA20 一律清仓……"
          style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
        />
      </div>

      <button className="primary-btn" disabled={!canSubmit} onClick={submit}>
        {loading ? '加载数据中…' : '开始训练'}
      </button>
    </div>
  );
}
