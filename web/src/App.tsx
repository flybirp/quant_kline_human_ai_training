import { useState } from 'react';
import Home from './pages/Home';
import Settings from './pages/Settings';
import Training from './pages/Training';
import Stats from './pages/Stats';
import { fetchStocks } from './api';
import { saveRecord } from './store';
import type { TrainingConfig, TrainingRecord } from './types';

type View = 'home' | 'settings' | 'training' | 'stats';

export default function App() {
  const [view, setView] = useState<View>('home');
  const [stocks, setStocks] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<TrainingConfig | null>(null);

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
        code = list[Math.floor(Math.random() * list.length)];
      }
      setConfig({ ...cfg, code });
      setView('training');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleFinish(record: TrainingRecord) {
    saveRecord(record);
    setView('stats');
  }

  function handleExit() {
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
          />
        )}
        {view === 'stats' && (
          <Stats
            onBack={() => setView('home')}
            onGoTrain={() => setView('settings')}
          />
        )}
      </main>
    </div>
  );
}
