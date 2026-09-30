// ============================================================
// LLM-as-a-Verifier 通用验证模块（L0.2）
// 依据：LLM-as-a-Verifier (arXiv 2607.05391) 的交易化落地
//  - 字母量表 A~T（G=20）：数字 token 有首位坍缩，字母撑满量表
//  - 连续分：score 标签后字母槽位 top-20 logprobs，A~T 子集重归一化取期望
//  - 重复评估 K 次均值（默认 K=3，论文 K=8 的成本折中）
//  - 标准分解：C=5 交易子标准（signal/timing/sizing/risk/process）
//  - logprobs 不可用时 fallback：同 prompt 采样 N=2K 次 argmax 平均
//
// ⚠️ 防结果锚定：buildSubject 任何模式都永不含 postTrade10/20/60（元验证目标变量）
//    signal/sizing/process 用 entry 模式，timing/risk 用 full 模式
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- server/.env（幂等解析；已存在的环境变量优先，index.js 先跑过也无妨） ----
function loadLocalEnv() {
  const envPath = path.join(HERE, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadLocalEnv();

// ---- 字母量表 ----
const LETTERS = 'ABCDEFGHIJKLMNOPQRST'; // A=1 ... T=20
const MIN_R = 1;
const MAX_R = 20;

// v2（2026-09-11）：对齐 quant_discover 大版本（d24~d32 + 两份审计）
//   - risk 判据推翻重写：固定百分比止损被量化否决（ΔE 全负、dd IC +0.49），
//     风控主战场从「价格止损位」转移到「仓位规模」
//   - sizing 判据强化：承接风控主责（价格止损无效后的唯一风控手段是仓位）
//   - timing 判据重写：从「波动结构是否合理」改为对照各信号的统计持有期甜点 + 五类被证伪的退出做法
//   - signal 判据：纳入 A2 量比 1.5~2.1 温和放量（唯一 p=0.002 的增强条件），
//     并把「量比>2.1 巨量」从模糊的极端放量中单列为最差档
export const CRITERIA_VERSION = 'v2';

// 默认交易五子标准（等权；判据嵌入 quant_discover 统计先验——verifier 与被验证者共享同一套市场认知）
// ⚠️ 先验数字均为报告值（上界）：幸存者偏差致正期望类真实值低 16%~32%，
//    9 条核心结论仅底背离通过年度方向稳定性检验——判据只引用「方向与分档」，不依赖绝对幅度
// subjectMode：signal/sizing/process 只看决策时信息（entry）；timing/risk 须看持有段+出场（full）
export const DEFAULT_CRITERIA = [
  {
    name: 'signal',
    subjectMode: 'entry',
    weight: 0.2,
    instruction:
      '入场信号是否为高质量结构（底背离五条件/出清式跌破——最佳档是跌破日量比 1.5~2.1 温和放量/深spring/深跌≥30%后的反转/趋势回踩甜点/区间下沿潜伏），而非模糊冲动；是否踩雷（前高颈线追突破/放量缺口/浅跌抄底/区间中段追/量比>2.1 巨量=抛售未尽是最差档/量比≥5 极端放量）',
  },
  {
    name: 'timing',
    subjectMode: 'full',
    weight: 0.2,
    instruction:
      '入场与离场时机是否符合该信号类型的统计甜点：持有期（A1 腰斩/A5 绝望组 90 日、A2 筑底跌破/A3 底背离 越长越好、A4 spring U 型；A1/A5 的 40 日处是坑，勿在此离场）；入场看确认期回撤深度（回撤<3% 直接上才是强势确认、≥8% 即隐性失败，等回踩会系统性只等到失败者）；离场是否踩了已被证伪的做法（固定百分比止损/时间止损/均线破位退出/跌破支撑就卖/K 线逃顶/规则叠加）',
  },
  {
    name: 'sizing',
    subjectMode: 'entry',
    weight: 0.2,
    instruction:
      '仓位规模是否承担了风险控制的主责（统计上价格止损无效：各档 ΔE 全负，回撤越深越该拿，风控手段只剩仓位）；仓位是否与信号置信度匹配（高置信重仓、试探信号轻仓、分批优于满仓一把梭）；是否按信号强度分档，而非一刀切',
  },
  {
    name: 'risk',
    subjectMode: 'full',
    weight: 0.2,
    instruction:
      '离场安排是否符合统计证据：① 是否禁用了固定百分比止损（-5%~-15% 是噪音区，ΔE 全负；持有期回撤 IC +0.49、12/12 年为正，浮亏越深越该拿）；② 风险控制是否落在仓位规模而非价格止损位；③ 若用主动退出，是否为移动止盈 trail（如 A1 trail(30/10)、A3 trail(20/8)）或持有到该信号对应的甜点期；④ 是否避开了已被证伪的退出做法（均线破位——卖飞 70%/期望磨掉 87%、时间止损、跌破支撑就卖、K 线逃顶、规则叠加是负改进）',
  },
  {
    name: 'process',
    subjectMode: 'entry',
    weight: 0.2,
    instruction:
      '决策理由与动作是否自洽：无自我矛盾、无幻觉价格（引用的价位/量比/形态须与上下文一致）、理由能推出动作',
  },
];

// ---- LLM 配置（verifier 可用独立模型；缺省回落主模型） ----
function llmConfig(modelOverride) {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.LLM_API_KEY || '';
  const model =
    (typeof modelOverride === 'string' && modelOverride.trim()) ||
    process.env.VERIFY_MODEL ||
    process.env.LLM_MODEL ||
    '';
  if (!base || !key || !model) {
    throw new Error('LLM 未配置：请在 server/.env 填写 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（或 VERIFY_MODEL）');
  }
  return { base, key, model };
}

// ---- subject 构建（分级截断：entry / full；永不包含 postTrade*） ----
export function buildSubject(trade, mode = 'entry') {
  const c = trade?.context || {};
  const o = trade?.outcome || {};
  const L = [];
  L.push(`Stock: ${trade.code} ${trade.stockName || ''}`.trimEnd());
  L.push(`Source: ${trade.source || 'unknown'}${trade.round ? ` (${trade.round})` : ''}`);
  L.push('');
  L.push('## Action');
  L.push(`BUY ${trade.date} @ ${trade.price} (position weight ${trade.weight})`);
  L.push('');
  L.push(
    '## Visible market context at decision time (daily bars up to and including the entry day; decision made after that close, execution at that close price)'
  );
  L.push(c.barsCsv || '(market data unavailable for this trade)');
  if (Array.isArray(c.features) && c.features.length) {
    L.push('');
    L.push('## Detected patterns (programmatic detectors, with historical stats)');
    for (const f of c.features) L.push(`- ${f}`);
  }
  if (mode === 'full') {
    L.push('');
    L.push('## Holding period (entry to exit)');
    const hs = c.holdingSummary;
    if (hs && typeof hs === 'object') {
      L.push(
        `Held ${o.holdDays ?? '?'} trading days. From entry price: max drawdown -${hs.maxDrawdown}%, max gain +${hs.maxGain}%. ` +
          `Exit close position within the entry-to-exit price range: ${Math.round((hs.closeQuantile ?? 0) * 100)}% (0 = at range low, 100 = at range high).`
      );
    } else {
      L.push('(holding-period summary unavailable)');
    }
    L.push('');
    L.push('## Exit');
    const kind = o.estimated ? 'position held to round end, valued at round-end close (estimated)' : 'closed';
    L.push(`SELL ${o.pairedSellDate} @ ${o.pairedSellPrice} (${kind})`);
    // 卖出时点形态（与买入侧同一套检测器，跑到卖出日为止）——让离场时机有形态证据可依，
    // 而不是只能对着持有段摘要「算账」（补 L0.1b 缺口）
    if (Array.isArray(c.sellFeatures) && c.sellFeatures.length) {
      L.push('');
      L.push('## Patterns detected at the exit bar (same detectors, data up to and including the exit day)');
      for (const f of c.sellFeatures) L.push(`- ${f}`);
    }
  }
  return L.join('\n');
}

// ---- 打分 prompt（论文模板的交易化；量表 G 可调，默认 A~T） ----
function lettersFor(scale) {
  const n = Math.max(2, Math.min(20, Math.round(scale)));
  return LETTERS.slice(0, n);
}

export function buildPrompt(subject, criterion, letters) {
  const last = letters[letters.length - 1];
  const mid = letters[Math.floor((letters.length - 1) / 2)];
  return `You are an expert A-share trading reviewer. You will see a trade record: its visible market context at decision time, the actions taken (entry size and exit), and the holding-period price process. You will NOT see any post-exit forward returns.

Evaluation Criterion: ${criterion.instruction}

Trade Context:
${subject}

Carefully analyze the trade against the criterion above, then provide your final score:

<score> LETTER_A_TO_${last} </score>

Rating Rules: Rate the trade on an A–${last} scale based on the evaluation criterion (A = completely fails, ${mid} = borderline, ${last} = exemplary). Output ONLY the score tag.`;
}

function buildPairPrompt(subjectA, subjectB, criterion) {
  return `You are an expert A-share trading reviewer. Compare two trade records (A and B) against the evaluation criterion. You will NOT see any post-exit forward returns.

Evaluation Criterion: ${criterion.instruction}

Trade A:
${subjectA}

Trade B:
${subjectB}

Carefully analyze both trades, then decide which one better satisfies the criterion:

<winner> A </winner> or <winner> B </winner>

Rating Rules: Output ONLY the winner tag.`;
}

// ---- LLM 调用（logprobs 必开；reasoning_effort: low 实测必须，否则重度推理耗尽 max_tokens） ----
async function callLLM({ prompt, model }) {
  const cfg = llmConfig(model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 4096,
        logprobs: true,
        top_logprobs: 20,
        reasoning_effort: 'low',
      }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`LLM 返回 ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return { data: await r.json(), model: cfg.model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('LLM 请求超时（120s）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 字母槽位 logprobs → A~T 分布 ----
// 字母常与 '>' 合并为单 token（如 '>C'）：定位 <score> 标签后字母所在 token，
// 读它的 top_logprobs；候选按 strip 字母归并（'C'/' C'/'>C' → C），A~T 子集内重归一化
function letterDistFromSlot(slot, letters) {
  if (!slot || !Array.isArray(slot.top_logprobs) || !slot.top_logprobs.length) return null;
  const raw = new Map();
  for (const cand of slot.top_logprobs) {
    const tok = cand.token || '';
    // 恰含一个量表字母、其余为非字母（' C' / '>C' / '\tC' 等）
    const m = tok.match(/^[^A-Za-z]*([A-Za-z])[^A-Za-z]*$/);
    if (!m) continue;
    const idx = letters.indexOf(m[1].toUpperCase());
    if (idx < 0) continue;
    const p = Math.exp(cand.logprob);
    raw.set(m[1].toUpperCase(), (raw.get(m[1].toUpperCase()) || 0) + p);
  }
  if (!raw.size) return null;
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  const dist = {};
  for (const [k, v] of raw) dist[k] = v / total;
  return dist;
}

// 在 logprobs.content 中定位「score 标签后字母」的 token（按重建文本偏移；失败时按 token 形态兜底）
function locateScoreSlot(content, lpContent, letters) {
  const re = new RegExp(`<score>\\s*([${letters[0]}-${letters[letters.length - 1]}])`, 'i');
  const m = content.match(re);
  if (!m) return { slot: null, letter: null };
  const letter = m[1].toUpperCase();
  const letterStart = m.index + m[0].indexOf(m[1]);
  const tagEnd = m.index + m[0].length; // 字母后位置（含可能空白）
  let acc = 0;
  let afterTagIdx = -1;
  const tokens = [];
  for (let i = 0; i < lpContent.length; i++) {
    const tok = lpContent[i].token || '';
    const start = acc;
    acc += tok.length;
    tokens.push({ start, end: acc, tok, lp: lpContent[i] });
    if (afterTagIdx === -1 && start >= tagEnd - 1) afterTagIdx = i;
    if (letterStart >= start && letterStart < start + tok.length) return { slot: lpContent[i], letter };
  }
  // 兜底：字母未落在任何 token（content 与 token 拼接不一致）→ 取标签后第一个单字母 token
  if (afterTagIdx >= 0) {
    for (let j = afterTagIdx; j < Math.min(afterTagIdx + 3, tokens.length); j++) {
      if (/^[^A-Za-z]*[A-Za-z][^A-Za-z]*$/.test(tokens[j].tok)) return { slot: tokens[j].lp, letter };
    }
  }
  return { slot: null, letter };
}

// ---- 单次绝对打分：返回 { r: 1~G 期望字母值, method, dist, usage } ----
async function scoreOnce({ subject, criterion, model, letters }) {
  const L = letters || LETTERS;
  const { data, model: usedModel } = await callLLM({ prompt: buildPrompt(subject, criterion, L), model });
  const ch = data.choices?.[0] || {};
  const content = ch.message?.content || '';
  const usage = data.usage || null;
  const lpContent = ch.logprobs?.content;

  if (Array.isArray(lpContent) && lpContent.length) {
    const { slot } = locateScoreSlot(content, lpContent, L);
    const dist = letterDistFromSlot(slot, L);
    if (dist) {
      let r = 0;
      for (const [g, p] of Object.entries(dist)) r += p * (L.indexOf(g) + 1);
      return { r, method: 'logprobs', dist, content, usage, model: usedModel };
    }
  }
  // fallback：无 logprobs / 槽位解析失败 → argmax 字母（采样法）；
  // 正文为空（reasoning 偶发耗尽 max_tokens）时从思考链兜底提取
  const fallbackText = /<score>/i.test(content) ? content : ch.message?.reasoning_content || '';
  const m = fallbackText.match(new RegExp(`<score>\\s*([${L[0]}-${L[L.length - 1]}])`, 'i'));
  if (m) {
    const idx = L.indexOf(m[1].toUpperCase());
    if (idx >= 0) return { r: idx + 1, method: 'sampling', dist: null, content, usage, model: usedModel };
  }
  throw new Error(`无法解析 score 标签: ${String(content || fallbackText).slice(0, 200)}`);
}

// ---- 单次成对比较：返回 { pFirst: P(前者胜), method, usage } ----
// ⚠️ 前者（subjectFirst）恒置于 prompt 的 Trade A 位 → P(前者胜) = P(A 槽)，
//    与模型 argmax 输出哪个字母无关（字母槽的 top_logprobs 分布本身携带 A/B 概率）
async function pairOnce({ subjectFirst, subjectSecond, criterion, model }) {
  const { data } = await callLLM({
    prompt: buildPairPrompt(subjectFirst, subjectSecond, criterion),
    model,
  });
  const ch = data.choices?.[0] || {};
  const content = ch.message?.content || '';
  const usage = data.usage || null;
  const lpContent = ch.logprobs?.content;

  if (Array.isArray(lpContent) && lpContent.length) {
    const m = content.match(/<winner>\s*([ABab])/);
    if (m) {
      const letterStart = m.index + m[0].indexOf(m[1]);
      let acc = 0;
      for (const lp of lpContent) {
        const tok = lp.token || '';
        if (letterStart >= acc && letterStart < acc + tok.length) {
          const raw = new Map();
          for (const cand of lp.top_logprobs || []) {
            const cm = (cand.token || '').match(/^[^A-Za-z]*([ABab])[^A-Za-z]*$/);
            if (!cm) continue;
            const lab = cm[1].toUpperCase();
            raw.set(lab, (raw.get(lab) || 0) + Math.exp(cand.logprob));
          }
          const pA = raw.get('A') || 0;
          const pB = raw.get('B') || 0;
          if (pA + pB > 0) return { pFirst: pA / (pA + pB), method: 'logprobs', usage };
          break;
        }
        acc += tok.length;
      }
    }
  }
  // fallback：argmax（前者在 A 位，答 A 即前者胜）；正文空时从思考链兜底
  const fallbackText = /<winner>/i.test(content) ? content : ch.message?.reasoning_content || '';
  const m = fallbackText.match(/<winner>\s*([ABab])/);
  if (m) return { pFirst: m[1].toUpperCase() === 'A' ? 1 : 0, method: 'sampling', usage };
  throw new Error(`无法解析 winner 标签: ${String(content || fallbackText).slice(0, 200)}`);
}

// ---- 简单并发池 ----
async function runPool(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- 缓存与日志 ----
const CACHE_FILE = path.join(HERE, '..', 'data', 'verify-cache.json');
const VERIFY_LOG_FILE = path.join(HERE, '..', 'logs', 'ai-verify.jsonl');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  } catch {
    // 缓存失败不影响主流程
  }
}

function logVerify(entry) {
  try {
    fs.mkdirSync(path.dirname(VERIFY_LOG_FILE), { recursive: true });
    fs.appendFileSync(VERIFY_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // 日志失败不影响主流程
  }
}

// ---- unified 交易加载（trades-unified.jsonl 懒加载索引） ----
const TRADES_FILE_DEFAULT = path.join(HERE, '..', '..', 'baozhu_analysis', 'trades-unified.jsonl');
let tradesIndex = null;

export function loadUnifiedTrade(id) {
  const file = process.env.VERIFY_TRADES_FILE || TRADES_FILE_DEFAULT;
  if (!tradesIndex || tradesIndex.file !== file) {
    tradesIndex = { file, map: new Map() };
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line);
          tradesIndex.map.set(t.id, t);
        } catch {
          // 跳过坏行
        }
      }
    }
  }
  return tradesIndex.map.get(id) || null;
}

// ---- 标准归一化 ----
function normalizeCriteria(criteria) {
  const list = Array.isArray(criteria) && criteria.length ? criteria : DEFAULT_CRITERIA;
  return list.map((c) => ({ weight: 0.2, subjectMode: 'entry', ...c }));
}

function sameAsDefault(criteria) {
  return !Array.isArray(criteria) || !criteria.length;
}

// ---- 主接口：绝对分 verify ----
// verify({ trade?, subject?, tradeId?, criteria?, repeats?, model?, useCache?, concurrency? })
//   → { score, method, subScores, variance, ... }
export async function verify(opts = {}) {
  const { trade, subject, tradeId, criteria, model, useCache = true, concurrency = 5 } = opts;
  const repeats = Math.max(1, Math.min(8, Math.round(opts.repeats ?? 3)));
  const scale = Math.max(2, Math.min(20, Math.round(opts.scale ?? 20)));
  const letters = lettersFor(scale);
  const crits = normalizeCriteria(criteria);

  if (!subject && !trade) throw new Error('verify 需要 trade 或 subject');
  if (subject && typeof subject !== 'string') throw new Error('subject 必须为字符串');

  const subjects = crits.map((c) => (subject ? subject : buildSubject(trade, c.subjectMode || 'entry')));
  const resolvedModel = llmConfig(model).model; // 提前解析以进缓存键

  // 缓存键 = hash(tradeId|subjectHash + criteriaVersion + model + repeats + scale)
  const subjKey = tradeId || (subject ? `s:${sha256(subject)}` : `t:${trade?.id || sha256(JSON.stringify(trade))}`);
  const critKey = sameAsDefault(criteria) ? `default-${CRITERIA_VERSION}` : sha256(JSON.stringify(criteria));
  const cacheKey = sha256(`${subjKey}|${critKey}|${resolvedModel}|${repeats}|G${scale}`);
  if (useCache) {
    const hit = loadCache()[cacheKey];
    if (hit && hit.score !== undefined) return { ...hit, cached: true };
  }

  // C × K 次调用
  const tasks = [];
  for (let ci = 0; ci < crits.length; ci++) {
    for (let k = 0; k < repeats; k++) {
      tasks.push(
        () =>
          scoreOnce({ subject: subjects[ci], criterion: crits[ci], model, letters })
            .then((r) => ({ ci, ...r }))
            .catch((e) => ({ ci, error: e.message }))
      );
    }
  }
  let results = await runPool(tasks, concurrency);

  // logprobs 完全不可用 → fallback 补采样至 N=2K（论文 fallback 口径）
  const okResults = results.filter((r) => !r.error);
  const needsSamplingFallback = okResults.length > 0 && okResults.every((r) => r.method === 'sampling');
  if (needsSamplingFallback) {
    const extra = await runPool(tasks.slice(0, crits.length * repeats), concurrency);
    results = results.concat(extra);
  }

  const final = results.filter((r) => !r.error);
  if (!final.length) {
    const err = results[0]?.error || 'unknown';
    throw new Error(`verify 全部调用失败: ${err}`);
  }

  // 聚合：subScores（mean/std 归一分）+ 加权总分
  const maxR = letters.length;
  const subScores = {};
  const critMeans = [];
  let weightSum = 0;
  let score = 0;
  const allNormR = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const methods = new Set();

  for (let ci = 0; ci < crits.length; ci++) {
    const rs = final.filter((r) => r.ci === ci);
    const norms = rs.map((r) => (r.r - MIN_R) / (maxR - MIN_R));
    const mean = norms.length ? norms.reduce((a, b) => a + b, 0) / norms.length : 0;
    const std = norms.length > 1 ? Math.sqrt(norms.reduce((s, v) => s + (v - mean) ** 2, 0) / norms.length) : 0;
    subScores[crits[ci].name] = { mean: +mean.toFixed(4), std: +std.toFixed(4), n: rs.length };
    const w = Number(crits[ci].weight) || 0;
    score += w * mean;
    weightSum += w;
    critMeans.push(mean);
    allNormR.push(...norms);
    for (const r of rs) {
      methods.add(r.method);
      if (r.usage) {
        usage.prompt_tokens += r.usage.prompt_tokens || 0;
        usage.completion_tokens += r.usage.completion_tokens || 0;
        usage.total_tokens += r.usage.total_tokens || 0;
      }
    }
  }
  score = weightSum > 0 ? score / weightSum : critMeans.reduce((a, b) => a + b, 0) / critMeans.length;
  const variance =
    allNormR.length > 1
      ? allNormR.reduce((s, v) => s + (v - score) ** 2, 0) / allNormR.length
      : 0;

  const out = {
    tradeId: tradeId || trade?.id || null,
    score: +score.toFixed(4),
    method: methods.size === 1 ? [...methods][0] : 'mixed',
    subScores,
    variance: +variance.toFixed(4),
    repeats,
    scale,
    criteriaVersion: sameAsDefault(criteria) ? CRITERIA_VERSION : 'custom',
    model: resolvedModel,
    usage,
    successes: final.length,
    total: results.length,
    errors: results
      .filter((r) => r.error)
      .map((r) => `c${r.ci}: ${r.error}`.slice(0, 200)),
  };

  if (useCache && out.successes === out.total) {
    const cache = loadCache();
    cache[cacheKey] = out;
    saveCache(cache);
  }
  logVerify({ ts: new Date().toISOString(), ...out });
  return out;
}

// ---- 主接口：成对比较 verifyPair（位置互换平均） ----
export async function verifyPair({ subjectA, subjectB, criterion, model }) {
  if (typeof subjectA !== 'string' || typeof subjectB !== 'string') {
    throw new Error('verifyPair 需要 subjectA 与 subjectB');
  }
  const crit = criterion && criterion.instruction ? { weight: 0.2, subjectMode: 'entry', ...criterion } : DEFAULT_CRITERIA[0];

  const [pAfirst, pAsecond] = await Promise.all([
    pairOnce({ subjectFirst: subjectA, subjectSecond: subjectB, criterion: crit, model }),
    pairOnce({ subjectFirst: subjectB, subjectSecond: subjectA, criterion: crit, model }),
  ]);
  const prefProb = (pAfirst.pFirst + (1 - pAsecond.pFirst)) / 2;

  // 顺带各打一次绝对分（同 criterion）
  const [sa, sb] = await Promise.all([
    scoreOnce({ subject: subjectA, criterion: crit, model }),
    scoreOnce({ subject: subjectB, criterion: crit, model }),
  ]);
  const out = {
    prefProb: +prefProb.toFixed(4),
    scoreA: +((sa.r - MIN_R) / (MAX_R - MIN_R)).toFixed(4),
    scoreB: +((sb.r - MIN_R) / (MAX_R - MIN_R)).toFixed(4),
    method: pAfirst.method === pAsecond.method ? pAfirst.method : 'mixed',
    criterion: crit.name || null,
    model: sa.model,
    usage: [pAfirst, pAsecond, sa, sb].reduce(
      (u, r) => ({
        prompt_tokens: u.prompt_tokens + (r.usage?.prompt_tokens || 0),
        completion_tokens: u.completion_tokens + (r.usage?.completion_tokens || 0),
        total_tokens: u.total_tokens + (r.usage?.total_tokens || 0),
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    ),
  };
  logVerify({ ts: new Date().toISOString(), kind: 'pair', ...out });
  return out;
}
