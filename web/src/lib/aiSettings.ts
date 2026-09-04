// AI 托管的风控指引（用户在训练设置页自由填写，localStorage 持久化）。
// 性质：决策参考而非强制平仓——用户可用自然语言描述止盈止损/仓位/节奏等任何风控偏好，由 AI 领会执行。

// ---- AI 托管模式（逐根 / 预测等待）----
export type AiMode = 'step' | 'pred_wait';
export const AI_MODE_KEY = 'kline-ai-mode';

export function loadAiMode(): AiMode {
  const v = localStorage.getItem(AI_MODE_KEY);
  return v === 'step' ? 'step' : 'pred_wait';
}

export function saveAiMode(m: AiMode): void {
  localStorage.setItem(AI_MODE_KEY, m);
}

// ---- LLM 模型名（设置页可覆盖 .env 默认；留空 = 用 server/.env）----
// 注意：仅模型名走设置页，API_KEY / BASE_URL 属机密仍留 server/.env。
export interface AiModels {
  model?: string; // 默认模型（文本）
  visionModel?: string; // 视觉模型（图表截图模式）
}
export const AI_MODEL_KEY = 'kline-ai-model';
export const AI_VISION_MODEL_KEY = 'kline-ai-vision-model';

export function loadAiModels(): AiModels {
  const model = localStorage.getItem(AI_MODEL_KEY) || '';
  const visionModel = localStorage.getItem(AI_VISION_MODEL_KEY) || '';
  return {
    model: model.trim() || undefined,
    visionModel: visionModel.trim() || undefined,
  };
}

export function saveAiModels(m: AiModels): void {
  if (m.model) localStorage.setItem(AI_MODEL_KEY, m.model);
  else localStorage.removeItem(AI_MODEL_KEY);
  if (m.visionModel) localStorage.setItem(AI_VISION_MODEL_KEY, m.visionModel);
  else localStorage.removeItem(AI_VISION_MODEL_KEY);
}

export const AI_RISK_GUIDE_KEY = 'kline-ai-risk-guide';

// ---- 预测等待模式：预测有效期范围（交易日）----
// min 是治理频繁开仓的关键旋钮：horizon 下限越高，AI 被唤醒/交易的频率越低
// （horizon=1 等于每天被叫醒一次，退化成逐根模式）。
export interface AiHorizon {
  min: number; // 有效期下限（1~10）
  max: number; // 有效期上限（≥min，≤30）
}
export const AI_HORIZON_KEY = 'kline-ai-horizon';

export function loadAiHorizon(): AiHorizon {
  const v = localStorage.getItem(AI_HORIZON_KEY);
  if (v) {
    try {
      const o = JSON.parse(v) as { min?: unknown; max?: unknown };
      const min = Math.max(1, Math.min(10, Math.round(Number(o.min) || 3)));
      const max = Math.max(min, Math.min(30, Math.round(Number(o.max) || 15)));
      return { min, max };
    } catch {
      // 非法 JSON 走默认
    }
  }
  return { min: 3, max: 15 };
}

export function saveAiHorizon(h: AiHorizon): void {
  const min = Math.max(1, Math.min(10, Math.round(Number(h.min) || 3)));
  const max = Math.max(min, Math.min(30, Math.round(Number(h.max) || 15)));
  localStorage.setItem(AI_HORIZON_KEY, JSON.stringify({ min, max }));
}

// ---- AI 开仓机会预算（稀缺性约束：治频繁交易的行为设计，非频率禁令）----
// 一场训练中 AI 只有 N 次开仓机会，用尽后只能持有/平仓/观望；
// 平仓（含止损）不受预算限制——风控优先。prompt 实时显示剩余额度。
export const AI_TRADE_BUDGET_KEY = 'kline-ai-trade-budget';

export function loadAiTradeBudget(): number {
  const v = Number(localStorage.getItem(AI_TRADE_BUDGET_KEY));
  if (Number.isFinite(v) && v >= 1 && v <= 20) return Math.round(v);
  return 6; // 默认：一场 101 根决策约 6 次开仓（波段节奏）
}

export function saveAiTradeBudget(n: number): void {
  const v = Math.max(1, Math.min(20, Math.round(Number(n) || 6)));
  localStorage.setItem(AI_TRADE_BUDGET_KEY, String(v));
}

export function loadAiRiskGuide(): string {
  return localStorage.getItem(AI_RISK_GUIDE_KEY) || '';
}

export function saveAiRiskGuide(text: string): void {
  const t = text.trim();
  if (t) {
    localStorage.setItem(AI_RISK_GUIDE_KEY, t);
  } else {
    localStorage.removeItem(AI_RISK_GUIDE_KEY);
  }
}

// 渲染为 prompt 文本块（step 与 pred_and_wait 两种模式共用）；未填写返回 null
export function renderRiskGuide(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return [
    '【风控指引】（用户设定，供决策参考，非强制平仓；请领会其意图并结合走势结构与自身判断灵活执行）',
    t,
  ].join('\n');
}
