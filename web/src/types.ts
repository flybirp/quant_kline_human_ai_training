export type Period = 'day' | 'week' | 'month';

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type TrainMode = 'random' | 'specified';

export interface TrainingConfig {
  mode: TrainMode;
  code: string;
  period: Period;
  initialCapital: number; // 虚拟资金基准：仅用于买卖与盈亏计算，与主页「爆竹coins」无关
  positions: number; // 分仓数 1-5
  maParams: number[];
  decisionBars: number;
  feeRate: number; // 手续费比例，如 0.0003
  slippage: number; // 滑点比例，如 0.0001
  stampTax: number; // 印花税比例，如 0.001
}

export interface Trade {
  side: 'buy' | 'sell';
  price: number;
  shares: number;
  date: string;
  index: number;
  actor?: 'human' | 'ai'; // 该笔交易由人还是 AI 执行（AI 托管模式）
}

export interface TrainingRecord {
  id: string;
  code: string;
  stockName: string;
  period: Period;
  startDate: string;
  endDate: string;
  initialCapital: number;
  finalCapital: number;
  profit: number;
  profitRate: number;
  rangeReturn: number; // 同区间股票本身的涨跌幅（用于跑赢区间率）
  trades: Trade[];
  winTrades: number;
  lossTrades: number;
  openCount: number; // 开仓（买入）次数
  positionSeries: number[]; // 决策段每根 bar 持仓状态 0/1
  heavySeries: number[]; // 决策段每根 bar 是否重仓（>=60% 资金占用）0/1
  durationMs: number; // 训练耗时（ms）
  mode?: 'manual' | 'ai' | 'mixed'; // 人工 / AI 托管 / 人机混合
  createdAt: number;
}
