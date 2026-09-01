import { useEffect, useState } from 'react';
import { computeCoins, fetchRecords, INITIAL_COINS } from '../store';

interface Props {
  onStart: () => void;
}

export default function Home({ onStart }: Props) {
  const [coins, setCoins] = useState(INITIAL_COINS);

  useEffect(() => {
    let alive = true;
    fetchRecords()
      .then(({ records }) => {
        if (alive) setCoins(computeCoins(records));
      })
      .catch(() => {
        // 拉取失败保持起始值
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="home-wrap">
      <div className="home-card">
        <div className="home-coin-label">总资金 · 爆竹coins</div>
        <div className="home-coin-value">{coins.toLocaleString('zh-CN')}</div>
        <div className="home-coin-hint">
          起始资金 {INITIAL_COINS.toLocaleString('zh-CN')}，随训练盈亏累计 · 虚拟概念，不限制买卖
        </div>

        <div className="home-actions">
          <button className="home-btn primary" onClick={onStart}>
            开始训练
          </button>
        </div>
      </div>
    </div>
  );
}
