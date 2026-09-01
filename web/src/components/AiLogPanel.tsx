import { useEffect, useRef } from 'react';
import type { AiMessage } from '../lib/aiMessages';
import {
  actionColor,
  actionLabel,
  biasColor,
  biasLabel,
  triggerKindLabel,
} from '../lib/aiMessages';

interface Props {
  messages: AiMessage[];
  thinking: boolean;
  error: string;
  running: boolean;
}

function StepCard({ m }: { m: Extract<AiMessage, { kind: 'step' }> }) {
  return (
    <div className="ai-log-card">
      <span className="ai-log-badge" style={{ color: actionColor(m.action) }}>
        {actionLabel(m.action, m.lots)}
      </span>
      <span className="ai-log-text">{m.reason}</span>
    </div>
  );
}

function PredictCard({ m }: { m: Extract<AiMessage, { kind: 'predict' }> }) {
  return (
    <div className="ai-log-card ai-log-card-block">
      <div className="ai-log-head">
        <span className="ai-log-badge" style={{ color: biasColor(m.bias) }}>
          {biasLabel(m.bias)}
        </span>
        <span className="ai-log-meta">预测未来 {m.horizon} 日</span>
        <span
          className="ai-log-badge"
          style={{ color: m.initial_action === 'buy' ? 'var(--up)' : 'var(--text-dim)' }}
        >
          {m.initial_action === 'buy' ? `先建仓${m.initial_lots ?? 1}份` : '先观望'}
        </span>
      </div>
      {m.expected_range && (
        <div className="ai-log-meta">
          预期区间 {m.expected_range.low.toFixed(2)} ~ {m.expected_range.high.toFixed(2)}
        </div>
      )}
      {m.triggers.length > 0 && (
        <ul className="ai-log-triggers">
          {m.triggers.map((t) => (
            <li key={t.id}>
              <span className="ai-log-trigger-kind">{triggerKindLabel(t.kind)}</span>
              <span>{t.value}</span>
              {t.desc && <span className="ai-log-meta"> · {t.desc}</span>}
            </li>
          ))}
        </ul>
      )}
      {m.summary && <div className="ai-log-text">{m.summary}</div>}
    </div>
  );
}

function WakeCard({ m }: { m: Extract<AiMessage, { kind: 'wake' }> }) {
  return (
    <div className="ai-log-card ai-log-card-block">
      <div className="ai-log-head">
        <span className="ai-log-badge ai-log-badge-wake">{m.triggerReason}</span>
        <span className="ai-log-badge" style={{ color: actionColor(m.action) }}>
          {actionLabel(m.action, m.lots)}
        </span>
      </div>
      <div className="ai-log-text">{m.reason}</div>
      {m.revised && (
        <div className="ai-log-meta">
          修订预测：{biasLabel(m.revised.bias)} · {m.revised.horizon} 日
          {m.revised.summary ? ` · ${m.revised.summary}` : ''}
        </div>
      )}
    </div>
  );
}

export default function AiLogPanel({ messages, thinking, error, running }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息自动滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const visible = messages.length > 0 || thinking || !!error || running;

  if (!visible) return null;

  let statusText = '';
  let statusClass = 'ai-log-status';
  if (thinking) {
    statusText = 'AI 思考中…';
  } else if (error) {
    statusText = `AI 已暂停：${error}`;
    statusClass += ' ai-log-status-error';
  } else if (running) {
    statusText = 'AI 托管中';
  } else {
    statusText = 'AI 已接管';
  }

  return (
    <div className="ai-log-panel">
      <div className={statusClass}>
        <span className="ai-log-status-icon">🤖</span>
        <span className="ai-log-status-text">{statusText}</span>
      </div>
      <div className="ai-log-list" ref={listRef}>
        {messages.map((m) => {
          if (m.kind === 'step') return <StepCard key={m.id} m={m} />;
          if (m.kind === 'predict') return <PredictCard key={m.id} m={m} />;
          if (m.kind === 'wake') return <WakeCard key={m.id} m={m} />;
          return (
            <div key={m.id} className="ai-log-notice">
              {m.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
