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
  startDate?: string; // 指定模式：决策段起始日期（YYYY-MM-DD），留空随机
  endDate?: string; // 指定模式：决策段结束日期（YYYY-MM-DD），留空不限
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

// 训练环境快照：归因分析用（哪版策略/模型/规则下跑出的成绩）。
// AI 决策明细不在这里——按 sessionId 关联 server/logs/ai-decide.jsonl 全量可查。
export interface RecordMeta {
  // 设置页快照
  aiPrompt: string; // AI 策略指令（策略本体）
  riskGuide: string; // 风控指引
  klineMode: 'csv' | 'chart' | 'image'; // AI K线呈现方式
  positions: number; // 分仓数
  maParams: number[]; // 均线参数
  decisionBars: number; // 决策根数
  feeRate: number; // 手续费（小数，如 0.0003）
  slippage: number; // 滑点（小数）
  stampTax: number; // 印花税（小数）
  // 训练页/环境信息
  aiMode: 'step' | 'pred_wait'; // AI 托管模式
  llmModel: string; // 实际使用的 LLM 模型（server 回传）
  ruleVersion: number; // 交易规则版本（lib/limit.ts RULE_VERSION，跨版本成绩不可比）
  // 预测对错汇总（唯一留存点：原材料 daySeg 不落库，不存即丢失）
  predStats?: { total: number; hit: number; bullishMiss: number; bearishMiss: number };
}

export interface TrainingRecord {
  id: string;
  sessionId?: string; // 与 server/logs/ai-decide.jsonl、ai-predict.jsonl 的关联键
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
  meta?: RecordMeta; // 训练环境快照（旧记录无此字段）
  createdAt: number;
}
