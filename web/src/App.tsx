import { useEffect, useState } from 'react';
import Home from './pages/Home';
import Settings from './pages/Settings';
import Training from './pages/Training';
import Stats from './pages/Stats';
import { fetchStocks } from './api';
import { migrateLocalRecords, saveRecord } from './store';
import { WARMUP_MIN_BARS } from './lib/limit';
import type { TrainingConfig, TrainingRecord } from './types';

type View = 'home' | 'settings' | 'training' | 'stats';

export default function App() {
  const [view, setView] = useState<View>('home');
  const [stocks, setStocks] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<TrainingConfig | null>(null);
  const [replayRecord, setReplayRecord] = useState<TrainingRecord | null>(null);

  // 启动时把旧版 localStorage 记录一次性迁移到服务端 JSON 文件
  useEffect(() => {
    migrateLocalRecords();
  }, []);

  async function ensureStocks(): Promise<string[]> {
    if (stocks.length > 0) return stocks;
    const list = await fetchStocks();
    setStocks(list);
    return list;
  }

  async function handleStart(cfg: TrainingConfig) {
    setError('');
    setLoading(true);
    try {
      let code = cfg.code;
      if (cfg.mode === 'random') {
        const list = await ensureStocks();
        // 预检重抽：跳过上市过短的股票（预热 30 根 + 决策根数不足的无法训练）
        let picked = '';
        for (let attempt = 0; attempt < 10; attempt++) {
          const c = list[Math.floor(Math.random() * list.length)];
          try {
            const res = await fetch(`/api/stock-days/${encodeURIComponent(c)}`);
            if (!res.ok) continue;
            const { days } = await res.json();
            if (Number(days) >= WARMUP_MIN_BARS + cfg.decisionBars + 1) {
              picked = c;
              break;
            }
          } catch {
            continue;
          }
        }
        if (!picked) {
          throw new Error('多次随机抽股均数据不足（上市过短），请重试或改用指定股票');
        }
        code = picked;
      }
      setReplayRecord(null); // 新训练，清掉可能的复盘记录
      setConfig({ ...cfg, code });
      setView('training');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleReplay(record: TrainingRecord) {
    // 从历史记录进入复盘：用 record 的配置重建训练页（不加 AI 托管）
    const cfg: TrainingConfig = {
      mode: 'specified',
      code: record.code,
      period: record.period,
      startDate: record.startDate,
      endDate: record.endDate,
      initialCapital: record.initialCapital,
      positions: record.meta?.positions ?? 2,
      maParams: record.meta?.maParams ?? [5, 10, 20, 60],
      decisionBars: record.meta?.decisionBars ?? record.positionSeries.length,
      feeRate: record.meta?.feeRate ?? 0.0003,
      slippage: record.meta?.slippage ?? 0.0001,
      stampTax: record.meta?.stampTax ?? 0.001,
    };
    setReplayRecord(record);
    setConfig(cfg);
    setView('training');
  }

  async function handleFinish(record: TrainingRecord) {
    try {
      await saveRecord(record);
    } catch (e) {
      console.error('保存训练记录失败', e);
    }
    setView('stats');
  }

  function handleExit() {
    setReplayRecord(null);
    setView('home');
    setConfig(null);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-logo">
          爆竹<span>K线</span> · Web
        </div>
        {view !== 'training' && (
          <nav className="app-nav">
            <button
              className={`nav-btn ${view === 'home' ? 'active' : ''}`}
              onClick={() => setView('home')}
            >
              主页
            </button>
            <button
              className={`nav-btn ${view === 'settings' ? 'active' : ''}`}
              onClick={() => setView('settings')}
            >
              训练设置
            </button>
            <button
              className={`nav-btn ${view === 'stats' ? 'active' : ''}`}
              onClick={() => setView('stats')}
            >
              历史统计
            </button>
          </nav>
        )}
        {loading && <div style={{ color: 'var(--text-dim)' }}>加载中…</div>}
      </header>

      <main className="app-main">
        {view === 'home' && (
          <Home
            onStart={() => setView('settings')}
          />
        )}
        {view === 'settings' && (
          <Settings
            stocks={stocks}
            loading={loading}
            error={error}
            onStart={handleStart}
            onBack={() => setView('home')}
          />
        )}
        {view === 'training' && config && (
          <Training
            config={config}
            onFinish={handleFinish}
            onExit={handleExit}
            replayRecord={replayRecord ?? undefined}
          />
        )}
        {view === 'stats' && (
          <Stats
            onBack={() => setView('home')}
            onGoTrain={() => setView('settings')}
            onOpenRecord={handleReplay}
          />
        )}
        {view === 'replay' && replayRecord && (
          <Replay record={replayRecord} onBack={() => setView('stats')} />
        )}
      </main>
    </div>
  );
}
