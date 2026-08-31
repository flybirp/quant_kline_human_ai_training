import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(os.homedir(), 'Documents', 'mainland_data_2014');

const app = express();
app.use(express.json());

// ---- 简单 LRU 缓存 ----
class LruCache {
  constructor(max = 300) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value); // 刷新到末尾
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

const klineCache = new LruCache(300);
let stockCodes = null;

function getStockCodes() {
  if (stockCodes) return stockCodes;
  const files = fs.readdirSync(DATA_DIR);
  stockCodes = files
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => f.slice(0, -4))
    .sort();
  return stockCodes;
}

function parseCsv(text) {
  const lines = text.split('\n');
  // 第一行表头
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 6) continue;
    const date = c[0];
    const open = Number(c[1]);
    const close = Number(c[2]);
    const high = Number(c[3]);
    const low = Number(c[4]);
    const volume = Number(c[5]);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    rows.push({ date, open, high, low, close, volume });
  }
  return rows;
}

function loadDaily(code) {
  const cached = klineCache.get(code);
  if (cached) return cached;
  const file = path.join(DATA_DIR, `${code}.csv`);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(text);
  klineCache.set(code, rows);
  return rows;
}

function getPeriodKey(date, period) {
  const d = new Date(date + 'T00:00:00');
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  // ISO 周：以周一为一周起点
  const day = d.getDay() || 7; // 周日=7
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day - 1));
  const my = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const md = String(monday.getDate()).padStart(2, '0');
  return `${my}-${mm}-${md}`;
}

function aggregate(rows, period) {
  if (period === 'day') return rows;
  const groups = new Map();
  for (const row of rows) {
    const key = getPeriodKey(row.date, period);
    if (!groups.has(key)) {
      groups.set(key, {
        date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      });
    } else {
      const g = groups.get(key);
      g.high = Math.max(g.high, row.high);
      g.low = Math.min(g.low, row.low);
      g.close = row.close; // 最新收盘
      g.volume += row.volume;
    }
  }
  return Array.from(groups.values());
}

app.get('/api/stocks', (req, res) => {
  res.json({ codes: getStockCodes(), total: getStockCodes().length });
});

app.get('/api/kline/:code', (req, res) => {
  const code = req.params.code;
  const period = ['day', 'week', 'month'].includes(req.query.period)
    ? req.query.period
    : 'day';

  const daily = loadDaily(code);
  if (!daily) {
    res.status(404).json({ error: `未找到股票 ${code} 的数据` });
    return;
  }
  const bars = aggregate(daily, period);
  res.json({ code, period, count: bars.length, bars });
});

// ---- AI 托管：LLM 决策代理 ----
// 从 server/.env 读取配置（无 dotenv 依赖，手动解析；已存在的环境变量优先）
function loadLocalEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadLocalEnv();

const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || '';

// 从 LLM 回复中容错提取 JSON（可能被 ```json ... ``` 包裹或前后有杂质文字）
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---- AI 决策日志落盘（JSON Lines：每次 LLM 调用的完整 input/output） ----
const AI_LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
const AI_LOG_FILE = path.join(AI_LOG_DIR, 'ai-decide.jsonl');

function logAiDecision(entry) {
  try {
    fs.mkdirSync(AI_LOG_DIR, { recursive: true });
    fs.appendFileSync(AI_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // 日志失败不影响主流程
  }
}

app.post('/api/ai/decide', async (req, res) => {
  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    res.status(503).json({
      error: 'LLM 未配置：请在 server/.env 填写 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL',
    });
    return;
  }
  const { system, user } = req.body || {};
  if (typeof system !== 'string' || typeof user !== 'string' || !user) {
    res.status(400).json({ error: '参数缺失：需要 system 与 user' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: 800,
        // 思考模式默认启用且深度为 high，思考链会耗尽 token 配额导致正文截断；
        // 逐根决策场景更看重低延迟与稳定输出，显式禁用
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: `LLM 返回 ${r.status}: ${t.slice(0, 300)}` });
      return;
    }
    const data = await r.json();
    const msg = data.choices?.[0]?.message ?? {};
    const content = msg.content || '';
    // 正文为空（推理 token 耗尽）时，退而从思考链中提取 JSON
    const parsed = extractJson(content) || extractJson(msg.reasoning_content || '');
    if (!parsed || !['buy', 'sell', 'hold'].includes(parsed.action)) {
      const finish = data.choices?.[0]?.finish_reason || 'unknown';
      res.status(502).json({
        error: `LLM 输出无法解析（finish=${finish}）: ${String(content || msg.reasoning_content || '').slice(0, 300)}`,
      });
      return;
    }
    const payload = {
      action: parsed.action,
      lots: Math.max(1, Math.round(Number(parsed.lots) || 1)),
      reason: String(parsed.reason || '').slice(0, 200),
    };
    // 决策日志落盘：完整 input（system+user）与 output
    logAiDecision({
      ts: new Date().toISOString(),
      usage: data.usage || null,
      system,
      user,
      raw: content || msg.reasoning_content || '',
      output: payload,
    });
    res.json(payload);
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'LLM 请求超时（30s）' : `LLM 请求失败: ${e.message}`;
    res.status(504).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dataDir: DATA_DIR, stocks: getStockCodes().length });
});

app.listen(PORT, () => {
  console.log(`K线训练后端已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR} (${getStockCodes().length} 只股票)`);
});
