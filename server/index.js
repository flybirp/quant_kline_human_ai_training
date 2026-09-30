import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { verify, verifyPair, loadUnifiedTrade } from './lib/verifier.js';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(os.homedir(), 'Documents', 'mainland_data_2014');

const app = express();
// 图表截图模式：jpeg base64 可达数百 KB，默认 100kb 限制会返回 413
app.use(express.json({ limit: '10mb' }));

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

// 轻量接口：返回某股日线根数（随机抽股预检用，复用 kline 缓存，不做周期聚合）
app.get('/api/stock-days/:code', (req, res) => {
  const daily = loadDaily(req.params.code);
  if (!daily) {
    res.status(404).json({ error: `未找到股票 ${req.params.code} 的数据` });
    return;
  }
  res.json({ code: req.params.code, days: daily.length });
});

// ---- 训练记录：JSON 文件存储（server/data/records.json） ----
const DATA_DIR_PATH = path.dirname(fileURLToPath(import.meta.url));
const RECORDS_FILE = path.join(DATA_DIR_PATH, 'data', 'records.json');

function loadRecordsFile() {
  try {
    const data = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    return {
      records: Array.isArray(data.records) ? data.records : [],
      starred: Array.isArray(data.starred) ? data.starred.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return { records: [], starred: [] };
  }
}

function saveRecordsFile(data) {
  fs.mkdirSync(path.dirname(RECORDS_FILE), { recursive: true });
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/records', (req, res) => {
  res.json(loadRecordsFile());
});

// 新增一条训练记录（按 id 去重）
app.post('/api/records', (req, res) => {
  const record = req.body && req.body.record;
  if (!record || typeof record !== 'object' || !record.id) {
    res.status(400).json({ error: 'invalid record' });
    return;
  }
  const data = loadRecordsFile();
  data.records = [record, ...data.records.filter((r) => r.id !== record.id)];
  saveRecordsFile(data);
  res.json(data);
});

// 整体替换（localStorage 一次性迁移用）
app.put('/api/records', (req, res) => {
  const body = req.body || {};
  const records = Array.isArray(body.records) ? body.records : null;
  if (!records) {
    res.status(400).json({ error: 'invalid records array' });
    return;
  }
  const starred = Array.isArray(body.starred)
    ? body.starred.filter((x) => typeof x === 'string')
    : [];
  saveRecordsFile({ records, starred });
  res.json({ records, starred });
});

app.delete('/api/records', (req, res) => {
  saveRecordsFile({ records: [], starred: [] });
  res.json({ records: [], starred: [] });
});

// 收藏标记 toggle
app.post('/api/records/star', (req, res) => {
  const id = req.body && req.body.id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const data = loadRecordsFile();
  data.starred = data.starred.includes(id)
    ? data.starred.filter((x) => x !== id)
    : [...data.starred, id];
  saveRecordsFile(data);
  res.json({ starred: data.starred });
});

// ---- AI 托管：LLM 决策代理 ----
// 从 server/.env 读取配置（无 dotenv 依赖，手动解析；已存在的环境变量优先）
function loadLocalEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    // 变量名兼容连字符写法（如 LLM_MODEL-WITH-VISION），存取时按原样保留
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadLocalEnv();

const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || '';
// 多模态模型（图表截图模式）；兼容连字符旧写法 LLM_MODEL-WITH-VISION
const LLM_MODEL_VISION =
  process.env.LLM_MODEL_VISION || process.env['LLM_MODEL-WITH-VISION'] || '';

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
const PREDICT_LOG_FILE = path.join(AI_LOG_DIR, 'ai-predict.jsonl');

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
  const { system, user, mode, kind, sessionId, image } = req.body || {};
  if (typeof system !== 'string' || typeof user !== 'string' || !user) {
    res.status(400).json({ error: '参数缺失：需要 system 与 user' });
    return;
  }
  // 会话 id：一场训练一个（前端生成），用于把流水日志与对账日志关联
  const sid = typeof sessionId === 'string' && sessionId ? sessionId : null;
  // 图表截图（jpeg base64）：日/周/月三周期多图；有图时 user 消息转多模态格式，需 LLM 支持视觉输入
  const images = Array.isArray(req.body?.images)
    ? req.body.images.filter((s) => typeof s === 'string' && s)
    : typeof image === 'string' && image
      ? [image]
      : [];
  // 模型选择：设置页可携带 model / visionModel 覆盖 .env 默认（留空/缺省用 .env）
  const reqModel = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : null;
  const reqVisionModel =
    typeof req.body?.visionModel === 'string' && req.body.visionModel.trim()
      ? req.body.visionModel.trim()
      : null;
  const useModel = images.length > 0
    ? (reqVisionModel || LLM_MODEL_VISION)
    : (reqModel || LLM_MODEL);
  if (images.length > 0 && !useModel) {
    res.status(400).json({
      error: '当前为图表截图模式，但未配置多模态模型：请在训练设置页填写视觉模型，或在 server/.env 添加 LLM_MODEL_VISION，或把「AI K线呈现」切回 CSV/字符形态图',
    });
    return;
  }
  const userContent =
    images.length > 0
      ? [
          { type: 'text', text: user },
          ...images.map((b64) => ({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${b64}` },
          })),
        ]
      : user;
  // 取证：记录每张截图的 base64 体积（诊断"图内容异常/空白"——正常单张约 60~150KB）
  const imgSizes = images.map((b64) => b64.length);

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
        model: useModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
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

    // pred_and_wait 的「预测」响应：返回完整 Prediction JSON，由前端做归一化/截断
    const isPredict = mode === 'pred_and_wait' && kind === 'predict';
    if (isPredict) {
      if (!parsed || typeof parsed !== 'object') {
        const finish = data.choices?.[0]?.finish_reason || 'unknown';
        res.status(502).json({
          error: `LLM 输出无法解析（finish=${finish}）: ${String(content || msg.reasoning_content || '').slice(0, 300)}`,
        });
        return;
      }
      logAiDecision({
        ts: new Date().toISOString(),
        sessionId: sid,
        mode,
        kind,
        model: useModel,
        usage: data.usage || null,
        imgSizes,
        system,
        user,
        raw: content || msg.reasoning_content || '',
        output: parsed,
      });
      res.json({ ...parsed, model: useModel });
      return;
    }

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
    // pred_and_wait 的「唤醒」响应可附修订预测，原样透传给前端归一化
    if (mode === 'pred_and_wait' && kind === 'wake' && parsed.revised && typeof parsed.revised === 'object') {
      payload.revised = parsed.revised;
    }
    // 决策日志落盘：完整 input（system+user）与 output
    logAiDecision({
      ts: new Date().toISOString(),
      sessionId: sid,
      mode,
      kind,
      model: useModel,
      usage: data.usage || null,
      imgSizes,
      system,
      user,
      raw: content || msg.reasoning_content || '',
      output: payload,
    });
    res.json({ ...payload, model: useModel });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'LLM 请求超时（30s）' : `LLM 请求失败: ${e.message}`;
    res.status(504).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
});

// ---- RPS 相对强度分位（quant_discover d15 口径）----
// rel_ret_120d = 个股 120 日收益 − 中证1000 同期收益；RPS = 当日全市场截面百分位（0~99，高=强）
// 数据由 baozhu_analysis/build_rps.py 预计算（server/data/rps/{code}.csv）
// ⚠️ 唯一稳定用法是**横盘**场景（分组单调递增、分年 10/10）：RPS≥80 强势中继、RPS<20 弱势停顿；
//    对超跌类形态无增强作用，勿跨形态复用。
const RPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'rps');
const RPS_DIR_OK = fs.existsSync(RPS_DIR);
const rpsCache = new Map(); // code -> Map(date -> 分位)

function loadRpsSeries(code) {
  if (rpsCache.has(code)) return rpsCache.get(code);
  const m = new Map();
  const f = path.join(RPS_DIR, `${code}.csv`);
  if (RPS_DIR_OK && fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const p = line.split(',');
      if (p.length >= 2 && p[0]) m.set(p[0], Number(p[1]));
    }
  }
  rpsCache.set(code, m);
  return m;
}

app.get('/api/rps', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: '参数缺失或非法：code 需为 6 位数字' });
    return;
  }
  const series = loadRpsSeries(code);
  const date = String(req.query.date || '').trim();
  if (date) {
    // 精确命中；无该日（停牌/非交易日）时取之前最近一个交易日
    let rps = series.get(date);
    let used = date;
    if (rps === undefined) {
      const earlier = [...series.keys()].filter((d) => d <= date).sort();
      if (earlier.length) {
        used = earlier[earlier.length - 1];
        rps = series.get(used);
      }
    }
    res.json({ code, date: used, rps: rps ?? null });
    return;
  }
  res.json({ code, series: [...series.entries()] });
});

// ---- LLM-as-a-Verifier（L0.2）：绝对分 verify / 成对 verifyPair ----
// body（absolute，默认）: { tradeId | trade | subject, criteria?, repeats?, model?, useCache? }
// body（pair）: { mode: 'pair', subjectA, subjectB, criterion?, model? }
app.post('/api/ai/verify', async (req, res) => {
  const b = req.body || {};
  try {
    if (b.mode === 'pair') {
      const result = await verifyPair({
        subjectA: b.subjectA,
        subjectB: b.subjectB,
        criterion: b.criterion,
        model: b.model,
      });
      res.json(result);
      return;
    }
    let trade = null;
    let subject = null;
    let tradeId = null;
    if (typeof b.tradeId === 'string' && b.tradeId) {
      trade = loadUnifiedTrade(b.tradeId);
      if (!trade) {
        res.status(404).json({ error: `trades-unified.jsonl 中不存在 tradeId: ${b.tradeId}` });
        return;
      }
      tradeId = b.tradeId;
    } else if (b.trade && typeof b.trade === 'object') {
      trade = b.trade;
      tradeId = b.trade.id || null;
    } else if (typeof b.subject === 'string' && b.subject) {
      subject = b.subject;
    } else {
      res.status(400).json({ error: '参数缺失：需要 tradeId / trade / subject 之一' });
      return;
    }
    const result = await verify({
      trade,
      subject,
      tradeId,
      criteria: b.criteria,
      repeats: b.repeats,
      model: b.model,
      useCache: b.useCache !== false,
    });
    res.json(result);
  } catch (e) {
    const status = /LLM 未配置/.test(e.message) ? 503 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ---- 打脸对账日志落盘（pred_and_wait 训练结束时前端提交 Outcome） ----
app.post('/api/ai/predict-log', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || !body.prediction) {
    res.status(400).json({ error: '参数缺失：需要 prediction 等对账字段' });
    return;
  }
  try {
    fs.mkdirSync(AI_LOG_DIR, { recursive: true });
    fs.appendFileSync(PREDICT_LOG_FILE, JSON.stringify(body) + '\n');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `写入日志失败: ${e.message}` });
  }
});

// ---- 复盘 API 已移除：训练页直接用 record.trades 画买卖点，无需后端参与 ----

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dataDir: DATA_DIR, stocks: getStockCodes().length });
});

app.listen(PORT, () => {
  console.log(`K线训练后端已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR} (${getStockCodes().length} 只股票)`);
});
