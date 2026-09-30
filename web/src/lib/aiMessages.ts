import type { Prediction, PredTrigger, Bias } from './predWait';

// AI 回复区消息（判别联合）。与 aiLogsRef（决策记忆，喂 LLM）彻底分离，专用于 UI 渲染。
export type AiMessage =
  | {
      id: string;
      ts: number;
      kind: 'step';
      action: 'buy' | 'sell' | 'hold';
      lots?: number;
      reason: string;
    }
  | {
      id: string;
      ts: number;
      kind: 'predict';
      horizon: number;
      bias: Bias;
      initial_action: 'buy' | 'hold';
      initial_lots?: number;
      expected_range?: { low: number; high: number };
      triggers: PredTrigger[];
      summary: string;
    }
  | {
      id: string;
      ts: number;
      kind: 'wake';
      triggerReason: string;
      action: 'buy' | 'sell' | 'hold';
      lots: number;
      reason: string;
      revised?: Prediction;
    }
  | {
      id: string;
      ts: number;
      kind: 'notice';
      text: string;
    };

let seq = 0;
export function makeId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

export function biasLabel(bias: Bias): string {
  if (bias === 'up') return '↑ 看多';
  if (bias === 'down') return '↓ 看空';
  return '→ 横盘';
}

export function biasColor(bias: Bias): string {
  if (bias === 'up') return 'var(--up)';
  if (bias === 'down') return 'var(--down)';
  return 'var(--text-dim)';
}

export function actionLabel(action: 'buy' | 'sell' | 'hold', lots?: number): string {
  if (action === 'buy') return lots != null ? `买入 ${lots} 份` : '买入';
  if (action === 'sell') return lots != null ? `卖出 ${lots} 份` : '卖出';
  return '观望';
}

export function actionColor(action: 'buy' | 'sell' | 'hold'): string {
  if (action === 'buy') return 'var(--up)';
  if (action === 'sell') return 'var(--down)';
  return 'var(--text-dim)';
}

export function triggerKindLabel(kind: PredTrigger['kind']): string {
  switch (kind) {
    case 'break_up':
      return '上破';
    case 'break_down':
      return '下破';
    case 'volume_ratio_gt':
      return '放量';
    case 'volume_ratio_lt':
      return '缩量';
    case 'trail':
      return '移动止盈';
    default:
      return kind;
  }
}
