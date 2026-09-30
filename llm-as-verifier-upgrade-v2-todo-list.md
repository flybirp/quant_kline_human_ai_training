# LLM-as-a-Verifier 落地 TODO（v2）

> 依据：[LLM-as-a-Verifier: A General-Purpose Verification Framework](https://arxiv.org/html/2607.05391)（2026-07, Stanford/Berkeley/NVIDIA）
> 核心思想：把「验证」作为第四个扩展轴（预训练/后训练/测试时计算之后），**无需额外训练**。
> 三个 scaling 维度：① 分数粒度（logprobs 期望 → 连续分）② 重复评估（方差缩减）③ 标准分解（复杂度缩减）。
>
> 本仓架构：**三层递进 + 晋级门槛**——L0 资格赛（baozhu 元验证）→ L1 shadow 唤醒对账 → L2 回放沙箱 best-of-N → 远期 DPO/RL。

---

## 〇、论文机制与本仓映射

### 〇.1 论文的四个介入时机

| 时机 | 论文机制 | 原文依据 | 本仓映射 |
|---|---|---|---|
| 执行中 | 前缀打分：每步对轨迹前缀 τ₁:ₜ 打分，进度曲线 ρₜ | VOC 实测：代码 0.848 / 机器人 0.966；失败轨迹分数停滞 | **L1** 唤醒对账（唤醒=以偏差结尾的前缀） |
| 执行中 | TurboAgent 在线监控 | "surface the live verifier score… monitored, **paused, or rolled back**"——干预由**人**发起，无自动中途修正 | L1 采 shadow 模式的直接依据 |
| 执行后、提交前 | best-of-N（PPT 锦标赛）：N 条候选**全部执行完**，verifier 两两比较选优提交 | SWE-Bench 候选产出 patch 过测试、TB 轨迹含 "failure signals in logs"；"trajectory with the highest normalized score is **submitted**" | **L2** 回放沙箱（训练页回放=sandbox） |
| 存档后 | RL 奖励塑形 | "shaping is applied **offline to stored trajectories**"（LIBERO 1.8× 样本效率）；GRPO 组内过程分 | 远期 DPO/RL |

### 〇.2 论文明确没有的（本仓延伸处须自行验证）

- 未执行候选的「执行前验证」——verifier 的判别力来自轨迹内的执行证据（日志/工具输出/失败信号），抽掉执行只剩决策+理由是论文未测的弱设定
- verifier 自动中途干预——TurboAgent 的暂停/回滚是人发起的

### 〇.3 三层架构总图与晋级门槛

```
┌─ L0 · 资格赛：baozhu 元验证（离线，不动线上）─────────────────────┐
│  L0.1 数据层（人工 843 笔落库+上下文重建）                          │
│  L0.2 通用 verifier 模块（server/lib/verifier.js）                 │
│  L0.3 批量验证 + 元验证（RankIC/后续走势/分年）                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ 门槛（核心）：score vs 出场后 20/60 日后续收益（postTrade20/60）
               │       的 RankIC > 0.05 且分年多数同号
               │       score vs pnlPct 仅作 sanity（无相关则直接淘汰，不作晋级依据）
               │  不达标 → verifier 降级为纯离线研究工具，止步于此
┌──────────────▼──────────────────────────────────────────────────┐
│ L1 · 训练页 shadow 唤醒对账（只记录不干预）                        │
│  L1.1 server 新增 kind=verify 钩子：唤醒时前缀打分                 │
│       + 偏差诊断（运气性 vs 逻辑性）+ 应对决策评估，写 jsonl        │
│  L1.2 滚动元验证（诊断 vs 实际走势）                               │
│  L1.3 消费侧（达标后做）：AI 交易批量验证、                          │
│       复盘徽章、Stats 质量曲线                                     │
└──────────────┬──────────────────────────────────────────────────┘
               │ 达标后：verifier 诊断进 AI 上下文（参考信号，不强制）
               │ 门槛：滚动 RankIC 达 L0 同等标准
┌──────────────▼──────────────────────────────────────────────────┐
│ L2 · 回放沙箱 best-of-N（论文主场景复刻，训练页独有）               │
│  L2.1 N 候选初始预测（方向/份数/触发器）各自完整回放执行             │
│  L2.2 PPT 选优（ring pass + pivot，O(N·k)）→ 提交正式记录          │
│  L2.3 偏好对留存（最优 vs 被弃候选 → 远期微调储备）                  │
└──────────────┬──────────────────────────────────────────────────┘
               │ 积累足够偏好对后
┌──────────────▼──────────────────────────────────────────────────┐
│ 远期 · DPO/RL（论文 Eq.7.2 用法）· 跨轮次能力追踪                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## L0 · 资格赛：baozhu 元验证

> 目标：用 843 笔人工历史交易回答一个前置问题——**verifier 的质量分在交易领域有没有超越运气的预测力**。论文对象（代码/机器人）有结果锚，交易没有，这一步论文帮不了，只能自测。

### L0.1 数据层

**统一交易 schema**（`server/data/trades-unified.jsonl`，一行一交易）：

```jsonc
{
  "id": "h-第4轮-0001",          // h- 人工 / a- AI 前缀 + 序号
  "source": "human",             // "human" | "ai"
  "round": "第4轮",              // 人工轮次（第1~5轮）；AI 交易为 null（由 sessionId 关联）
  "sessionId": null,             // AI 交易的关联键（human 为 null）
  "code": "000068",
  "stockName": "华控赛格",
  "side": "buy",                 // 建仓方向（A 股配对交易恒为 buy；保留字段为未来扩展）
  "date": "2023-03-22",
  "price": 3.66,
  "weight": 1.0,
  "context": {                   // 决策时可见信息（人工=事后重建）
    "barsCsv": "...",            // 交易日前 60 根 OHLCV+涨跌%+量比+MA 的 CSV
    "features": ["底背离✓..."],  // 程序检测的形态特征（Python 版，与 patterns.ts 同口径）
    "reconstructed": true,       // 人工交易的诚实标记
    "aiReason": null,
    "aiPrompt": null
  },
  "outcome": {                   // 后验结果（配对完成后填；元验证目标变量）
    "pairedSellDate": "2023-03-27",
    "pnlPct": -3.28,
    "holdDays": 5,
    "postTrade10": 1.2,          // 卖出后 10/20/60 根走势（⚠️ 元验证目标变量，永不进 verifier subject）
    "postTrade20": -0.5,
    "postTrade60": 2.1,
    "estimated": false           // true = 持有到期按波段结束日收盘估值
  }
}
```

- [x] **L0.1a** `baozhu_analysis/normalize_human_trades.py`：复用 `analyze.py` 的 FIFO 配对（843 笔），字段清洗（代码 6 位防丢零、日期统一、weight 0~1、轮次规范），持有到期 175 笔沿用「波段结束日收盘估值」口径并标 `estimated: true`，输出 `trades-unified.jsonl`（`h-` 前缀）+ 清洗对账报告
  - ✅ 完成：843 笔（第1轮=431/第2轮=13/第4轮=397/其他=2），涨跌停约束对账 0 笔违规、2 笔跌停日卖出顺延次交易日重算，报告见 `baozhu_analysis/trades-unified-report.md`
- [x] **L0.1b** 上下文重建：barsCsv 可重建 656/843（145 笔早于 2014 数据起点 + 43 笔无行情 + 17 笔脏代码置 null）；features 命中 649；postTrade10/20/60 可用约 654/654/652
  - ✅ **TS↔Py 对账**（2026-09-09 补做，`audit_patterns.py`）：抽样 200 笔，从原始 CSV 重建「数据起点→buy_date 全量历史」分别跑 patterns.ts（node 直跑 TS 真源）与 patterns_py.py，`pattern_summary_block` 输出**逐字一致 200/200**——verifier 的 features 层与训练页 AI 所见同口径坐实（patterns 若改动可重跑对账）
- [x] **L0.1c** 抽查 10 笔：barsCsv 窗口为含 buy_date 当根的前 60 根、末行收盘=买入价、postTrade 可手工复核——全部通过（见对账报告）

### L0.2 通用 verifier 模块

**论文机制与本仓映射**：

| 论文概念 | 论文实现 | 本仓映射 |
|---|---|---|
| 分数量表 | 字母 A~T（1~20 分），单 token——数字 token 有首位坍缩（打 15 时 '1' 概率集中），字母撑满 G=20 | 同用字母量表 |
| 连续分（Eq.3.1） | top-20 logprobs 中 A~T 子集重归一化取期望 `R = Σ p_g·φ(v_g)` | φ(A)=1…φ(T)=20，线性归一到 [0,1] |
| 成对评估 | Task + Trajectory A/B，Bradley-Terry `P(i≻j)=σ(R_i−R_j)`（Eq.3.2）；Ring pass 消位置偏差 | L0 元验证默认单对象绝对分；轮次对比用成对+位置互换；**L2 用完整 PPT**（见 L2.2） |
| 重复评估 | K 次独立评估取均值，方差 O(1/K)；论文 K=8，tie 率恒 0 | 默认 K=3（成本折中），元验证可升 K=8 |
| 标准分解 | C 个子标准独立评估，外层等权平均；三标准 75→78.3% | C=5（交易五子标准，见下） |
| PPT 排序 | ring pass → pivot 选择 → pivot rounds，O(Nk) | **L2 启用**（N 候选轨迹选优）；L0/L1 不需要 |
| 默认配置 | G=20, K=8, C=3 | G=20, K=3, C=5 |

**打分 prompt 模板**（论文模板的交易化）：

```text
You are an expert A-share trading reviewer. You will see a trade record:
its visible market context at decision time, the actions taken (entry
size and exit), and the holding-period price process. You will NOT see
any post-exit forward returns.

Evaluation Criterion: {criterion.instruction}

Trade Context:
{subject}                          ← buildSubject(unifiedTrade, mode) 输出

Carefully analyze the trade against the criterion above, then provide
your final score:

<score> LETTER_A_TO_T </score>

Rating Rules: Rate the trade on an A–T scale based on the evaluation
criterion (A = completely fails, J = borderline, T = exemplary).
Output ONLY the score tag.
```

**subject 分级截断规则（防结果锚定）**：

```js
// buildSubject(trade, mode) 两种模式，⚠️ 任何模式都永不含 postTrade10/20/60
//（那是元验证的目标变量，喂进 subject 即泄漏——verifier 会拿它「算账」污染 RankIC）
//
// mode='entry'：入场前上下文（barsCsv + features）+ 建仓动作（日期/价格/仓位）
//   → 用于 signal / sizing / process 三个子标准（这三个只该看决策时信息）
// mode='full' ：entry 内容 + 持有段走势摘要（最大回撤/涨幅/价格分位）+ 出场动作
//   （日期/价格/closed 或 estimated）→ 用于 timing / risk 两个子标准
//   （评离场时机与止损安排必须看到持有过程，但依然看不到出场后走势）
//
// 推论：score vs pnlPct 的相关因此测的是「从过程结构推断结果的能力」
//（论文 VOC 的精神），而非「读数算账」——它才配作 sanity 门槛
```

**连续分数计算**（请求参数经 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 实测）：

```js
// 1) 请求：logprobs: true, top_logprobs: 20, temperature: 0.7, max_tokens: 4096
//    ⚠️ 必须传 reasoning_effort: "low" —— 两模型均为重度推理模型，
//    不传则 reasoning 耗尽 max_tokens（8192 仍不够），content 永远为空、
//    logprobs 只挂在 reasoning_content 上；enable_thinking: false 无效
//    low 档下 reasoning ~140-2700 tokens，finish=stop，content 正常输出
// 2) 解析 <score> 后第一个 token 的 top-20 候选：
//    ⚠️ 字母常与 '>' 合并为单 token（如 '>C'）——定位「score 标签后的第一个
//    token」读它的 top_logprobs（即字母槽位的分布）；候选按 strip 字母归并
//    （'C' / ' C' / '\tC' → C），再在 A~T 子集内重归一化
// 3) 期望分 R = Σ_g p_g × φ(g)
// 4) 归一化 score = (R − 1) / 19 ∈ [0,1]
// 注：字母槽分布较集中（top 候选 2~4 个变体，归并后主字母 ~0.8-1.0），
//    单次调用的连续性有限——连续分辨率主要来自 K 次重复采样（论文 K 轴），
//    temperature 0.7 保证重复间分布有变化
// 成本参考：极简 prompt（34 输入 token）下单次 ~148 completion tokens
//    （141 reasoning + 7 content）；真实 subject 含 60 根 barsCsv（~2k token）
//    时输入与 reasoning 均数倍增长，以 L0.2 验收的成本项实测为准
```

**聚合**：`finalScore = (1/C) Σ_c [(1/K) Σ_k R_{c,k}]`，附 subScores（mean/std）。

**logprobs 不可用时的 fallback**：同 prompt 采样 N=2K 次取 argmax 平均，结果标注 method，元验证时与 logprobs 法对照。

**模块接口**：

```js
verify({ subject, criteria[], scale = 20, repeats = 3, model })
  → { score, method, subScores, variance }
verifyPair({ subjectA, subjectB, criterion, model })
  → { prefProb, scoreA, scoreB }   // 位置互换平均
buildSubject(unifiedTrade, mode: 'entry' | 'full') → string
  // 分级截断：entry=入场前上下文+建仓动作；full=+持有段+出场动作；
  // 两模式均永不含 postTrade*（见分级截断规则）
```

**默认交易五子标准**（`DEFAULT_CRITERIA` v1，等权；判据嵌入 quant_discover 统计先验——verifier 与被验证者共享同一套市场认知）：

```js
[
  { name: 'signal',  instruction: '入场信号是否为高质量结构（底背离五条件/出清式跌破且量能不缩/深spring/深跌≥30%后的反转/趋势回踩甜点/区间下沿潜伏），而非模糊冲动；是否踩雷（前高颈线追突破/放量缺口/浅跌抄底/区间中段追/量比≥5极端放量）', weight: 0.2 },
  { name: 'timing',  instruction: '入场/离场时机在该股波动结构中是否合理（对照区间位置、确认期回撤深度：突破后10日回撤<3%强势/≥8%隐性失败）', weight: 0.2 },
  { name: 'sizing',  instruction: '仓位与信号置信度是否匹配（高置信重仓、试探信号轻仓；分批优于满仓一把梭）', weight: 0.2 },
  { name: 'risk',    instruction: '止损/离场安排是否明确且设在结构位（跌破日最低/spring低点/区间边界外），而非整数关口或名义支撑', weight: 0.2 },
  { name: 'process', instruction: '决策理由与动作是否自洽：无自我矛盾、无幻觉价格（引用的价位/量比/形态须与上下文一致）、理由能推出动作', weight: 0.2 },
]
// 注：「同方向止损≥3次熔断」为整局轨迹判据——L0 单笔 subject 无局内上下文故不入
// instruction，仅在 L1/L2 的轨迹级验证中作为额外检查项
```

**API 与日志**：

- [x] `POST /api/ai/verify`：body `{ tradeId | subject, criteria?, repeats?, mode?: 'absolute'|'pair', model? }`（另支持 `trade` 对象直传与 `scale`）
- [x] 日志 `server/logs/ai-verify.jsonl`：tradeId + method + subScores + 总分 + model + token 用量（含逐次失败 errors）
- [x] 缓存 `server/data/verify-cache.json`：键 = hash(tradeId + criteriaVersion + model + repeats + scale)，实测二次调用 0.04s 命中

**L0.2 验收（对照论文实证预期）**（模块：`server/lib/verifier.js`，2026-09-08 实测，模型 deepseek-v4-flash）：

- [x] 冒烟 3 个合成 subject（明显好/差/中性）：排序正确（0.79 > 0.03 > 0）、不扎堆 ✓
- [x] 粒度自检：G=5 vs G=20，G=20 极差 0.79 vs G=5 0.47（区分度提升）且总方差 0.160 ≤ 0.173（std 不升）✓
- [x] 成对一致性：已知强弱对 P(强≻弱)=1.0、1.0，换位（弱作 A）prefProb=0，不翻转 ✓（修复了 winner 槽语义 bug：前者恒在 A 位，P(前者胜)=P(A 槽)）
- [ ] 重复方差：同 subject 3 组 K=3，组间极差实测 0.056~0.096，**超 0.05 阈值**——根因：字母槽分布尖锐多峰（主字母 p≈1，偶发整档跳变）+ sizing/process 子分在「半仓×高置信信号」类样本上意见分裂（0.32~0.65 漂移）；K=8 并未收敛（组间均值漂移 0.16）。**判定：不阻塞 L0.3**——元验证看横截面秩相关（N≥100 时单笔 ±0.1 噪声被平均），若 L0.3 RankIC 不足，重复方差为首要嫌疑（预案：升 K、降 sizing/process 权重、criteria 版本化迭代）
- [x] 成本：真实 60 根 barsCsv subject 单笔 C(5)×K(3)=15 次调用、36.6s、51.7k tokens（3.4k/次）、0 errors；正文空兜底（reasoning 耗尽时从思考链提取）已内置；**抽样 100 笔先行**（约 520 万 token，flash 级成本可忽略）→ 进行中

### L0.3 批量验证与元验证

- [x] **L0.3a** `verify_trades.py`：分层抽样 + 全量断点续跑（缓存跳过）。已完成 **574/656**（82 笔因 API 余额耗尽未跑；n=574 标准误 ±0.04，统计功效足够）
- [x] **L0.3b** `trades_verified.csv`：原字段 + score/subScores/variance/method/usage
- [x] **L0.3c 元验证（主菜，N=574，2026-09-09 终判）**：
  - sanity：score vs `pnlPct` **RankIC=+0.276（p<0.001）**——有「从过程结构推断结果」的能力，不淘汰
  - 核心：score vs `postTrade20` **+0.046（p=0.28，未达 0.05）**；vs `postTrade60` +0.023（p=0.58）——**总分不达标**
  - 分年稳定性：7/12 同号（多数，但幅度小且不显著）
  - 高质亏损单 40% vs 低质盈利单 43%——无显著分层
  - **子标准分解（关键发现）**：`signal` vs postTrade20 **+0.102（p=0.014）**、vs postTrade60 **+0.097（p=0.020）**，分年同号 7/12、8/12——**signal 子标准单独过晋级线**；signal 高组 postTrade20 均值 +2.78% vs 低组 +0.06%。而 `timing` vs pnlPct +0.776 但 vs postTrade20 −0.02（纯粹的「读持有段算账」，无预测力，sanity 相关主要由此贡献）；sizing/risk/process 无判别力
  - signal 预测力分轮次：第1轮 +0.137(p=0.012) / 第4轮 +0.027(n.s.)——第4轮入场质量可能更同质化
- [x] **L0.3d 轮次进化分析**：第1轮平均 0.1747 → 第4轮 0.1885（相对 +8%），贡献项 process +0.044、signal +0.029、risk −0.008——1457 倍复利在 verifier 评分视角下轮次间过程质量提升存在但微弱
- [ ] **L0.3e 人机对照**：抽 30 笔用户盲评 vs verifier 分（需用户参与，未做）
- [x] **L0.3f 晋级判定**：**总分不达标**（postTrade20/60 均未过 0.05 且不显著）→ 按门槛 verifier 不进 L1，定位为离线研究工具。**但 signal 子标准独立达标**（两 horizon 显著 + 分年多数同号），criteria v2 迭代方向明确：① 剥离/降权 timing 的「读盘算账」通道（或 timing 仅评入场时机不喂持有段）② signal 主导总分或单列 signalScore 供消费 ③ 迭代后按缓存键 criteriaVersion 重跑（若继续，建议 K=1 省成本，见 L0.2 成本项）

---

## L1 · 训练页 shadow 唤醒对账

> 时机：pred_wait 唤醒 = 行情已超出预测（触发器 fired）= 一条以「偏差」结尾的轨迹前缀。
> 论文依据：VOC 前缀打分证明执行中打分校准（0.848/0.966）；TurboAgent 姿态 = 监控不自动干预。
> shadow-first 的理由：verifier 自动中途干预是论文未验证的延伸，先积累「诊断 vs 实际走势」对照数据。

- [ ] **L1.1** server 端唤醒钩子：`kind=verify`，输入 = 本次预测原文 + 唤醒前的持有段走势 + 触发器信息，输出：
  - 前缀质量分（0~1）
  - 偏差诊断：**运气性**（分数仍高，触发是噪音）vs **逻辑性**（分数坍塌，预测依据失效）
  - 应对决策评估（主 AI 修订/离场理由的质量）
  - 只写 `ai-decide.jsonl`（kind=verify），**不进入决策流程**
  - 冒烟验收：合成一次模拟唤醒（预测原文 + 触发器 + 持有段），确认 verify 记录完整落 jsonl 且决策流无感知
- [ ] **L1.2** 滚动元验证：verifier 诊断 vs 后续实际走势的对照表；达 L0 同等 RankIC 门槛后，把诊断作为**参考信号**注入 AI 下一轮上下文（仍不强制）
- [ ] **L1.3 消费侧（达标后做）**：
  - AI 交易提取落库 `extract_ai_trades.py`（records + ai-decide.jsonl → unified `a-` 前缀）
  - 训练结束批量验证本场全部交易（后台异步，失败静默降级）→ `record.verified`
  - 复盘页：交易列表质量列（色阶 ≥0.7 金 / 0.4~0.7 灰 / <0.4 红）+ verifier 点评（总分+最弱子标准）
  - Stats 页：决策质量曲线 + 质量-收益散点

---

## L2 · 回放沙箱 best-of-N

> 论文主场景的忠实复刻：候选**全部执行完**再验证选优。训练页的回放 = 论文的 sandbox；
> 实盘不可行（动作不可逆、无法并行试错）——**仅训练系统可做**，这是训练页作为 best-of-N 落地点的最硬理由。
> 双重收益：① 训练局质量（论文 Oracle Pass@5 92.1% vs Pass@1 83.1%，候选池确有更优解）；
> ② 偏好对数据（最优 vs 被弃候选）= 远期微调的储备。

- [ ] **L2.1** N 候选采样与并行回放：pred_wait 初始预测时采样 N=3~5 个候选（方向/份数/触发器组合），各自独立回放执行（各自的唤醒、离场），形成 N 条完整交易轨迹。**每条候选的完整轨迹含义**：回放中触发唤醒时，应对决策（修订/离场）同样由主 AI 在该分支内生成——即每条候选 = 一次完整的 agent 运行，成本 = N ×（1 次初始预测 + 该分支各自的唤醒应对次数）。**前提：L0/L1 达标**
- [ ] **L2.2** PPT 选优：ring pass（随机哈密顿环，每候选 A/B 位各一次消位置偏差）→ pivot 选择（top-k）→ pivot rounds → `argmax wᵢ/cᵢ`，O(N·k)；最优轨迹提交为正式记录
- [ ] **L2.3** 偏好对留存：每局（最优, 被弃）对入 `server/data/preference-pairs.jsonl`（含完整轨迹与分数），远期 DPO/GRPO 用
- [ ] 成本控制：flash 级 verifier（论文原设计：便宜模型验证贵模型输出）；候选多样性保障（同模型高温采样易雷同——论文 SWE-Bench 用异构模型池，本仓可 temperature 0.9+去重，或接入第二个模型做异构池，需在 server/.env 新增配置，当前仅 deepseek 系）

---

## 远期

- **DPO/RL**：偏好对充足后做过程分奖励（论文 Eq.7.2：GRPO 组内 reasoning 分）
- **跨轮次能力追踪**：unified 数据层上第5轮（AI 托管轮）vs 人工各轮质量对比

---

## 风险与成本

| 风险 | 缓解 |
|---|---|
| verifier 分数被结果锚定（给了 pnl 就只会「算账」） | subject 分级截断（见 L0.2）：永不含 postTrade*；signal/sizing/process 用 entry 模式，timing/risk 用 full 模式——score vs pnlPct 相关由此成为「过程推断能力」测量而非泄漏 |
| 模型/端点更换后 logprobs 不可用 | fallback 采样法（模块内置，标注 method），元验证时两法对照 |
| verifier 幻觉（评了不存在的价格/信号） | subject 只给结构化文本；process 子标准专查自洽；抽查人审 |
| 成本失控 | 缓存 + **抽样 100 笔先行**；flash 模型；L2 的 N 控制在 3~5 |
| L1 自动干预无论文背书 | shadow-first：只记录不干预，滚动元验证达标后才进上下文（仍不强制） |
| 质量分与直觉冲突（L0.3e 校准失败） | criteria 版本化迭代（criteriaVersion 进缓存键），而非强行信任 |
| schema 演进破坏旧文件 | schemaVersion 字段 + 只追加不修改 |

## 实施顺序

```
L0.1 数据层（人工）→ L0.2 verifier 模块（冒烟）→ L0.3 抽样100笔 → 晋级判定
  ├─ 达标 → L1 shadow 唤醒对账 → L1.2 滚动元验证 → L1.3 消费侧
  │            └─ 达标 → L2 回放 best-of-N（攒偏好对）→ 远期 DPO
  └─ 不达标 → verifier 留在离线分析当研究工具，止步
```
