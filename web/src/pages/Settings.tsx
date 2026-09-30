import { useState } from 'react';
import type { Period, TrainMode, TrainingConfig } from '../types';
import { loadKlineMode, saveKlineMode, type KlineMode } from '../lib/klineArt';
import {
  loadAiHorizon,
  loadAiMode,
  loadAiModels,
  loadAiRiskGuide,
  loadAiTradeBudget,
  saveAiHorizon,
  saveAiMode,
  saveAiModels,
  saveAiRiskGuide,
  saveAiTradeBudget,
  type AiHorizon,
  type AiMode,
  type AiModels,
} from '../lib/aiSettings';

interface Props {
  stocks: string[];
  loading: boolean;
  error: string;
  onStart: (config: TrainingConfig) => void;
  onBack: () => void;
}

// 训练买卖基准资金：固定为虚拟大额，与主页「爆竹coins」脱钩，
// 保证高价股（如茅台）也能正常买入，训练盈亏据此计算。
export const VIRTUAL_CAPITAL = 1_000_000;

const PERIOD_LABELS: Record<Period, string> = {
  day: '日线',
  week: '周线',
  month: '月线',
};

const MA_OPTIONS = [5, 10, 20, 60];
const POSITION_OPTIONS = [1, 2, 3, 4, 5];

// AI 托管：自定义策略指令持久化 key
const AI_PROMPT_KEY = 'kline-ai-prompt';

// 预设策略模板（点击填入文本框，可自由修改）
const AI_PROMPT_PRESETS: { label: string; text: string }[] = [
  { label: '通用', text: '' },
  {
    label: '趋势跟随',
    text: '你偏好趋势跟随策略：价格站上MA20且均线多头排列时顺势分批买入，跌破MA10减仓一半，跌破MA20清仓离场。',
  },
  {
    label: '低吸高抛',
    text: '你偏好均值回归策略：在关键支撑位（前低、MA20、MA60）附近缩量回踩时分批低吸补仓，不需要等待企稳确认；反弹至前高压力位分批止盈。',
  },
  {
    label: '保守防御',
    text: '你极度保守：默认保持空仓观望，只在胜率极高的信号（如放量突破叠加多周期走势确认）出现时才以最小份数参与，快进快出。',
  },
  {
    label: '出清买点',
    text: [
      '你采用「出清买点」体系（基于 A 股 12 年全市场日线统计先验，核心规律：底部质量看出清程度，不看守住没有）：',
      '',
      '【优先建仓形态】（出现时积极建仓）',
      '1. 腰斩：前期翻倍后无二次冲高地单边腰斩，出清最彻底（历史90日胜率74%/中位+15%；⚠ 55%样本在2015年，实操按 +8~16%/胜率57~66% 规划——它是危机 alpha，平时平庸、极端恐慌年爆发，不是稳定收益）。持有按90天设计（40天处是坑，勿在此离场），须承受-20%级别浮亏，宜分批建仓。',
      '2. 深跌破且量能不缩：筑底/横盘跌破支撑10~15%、跌破日量能不萎缩（恐慌释放、有人承接）——20日E+14.84%/胜率79.6%（⚠ 上界，真实约低16~32%）。最优档是跌破日量比1.5~2.1温和放量（E+18.28%/胜率88.5%，年度p=0.002 非聚类驱动）；量比>2.1巨量是最差档（胜率仅68%，抛售未尽）。持有越长越好（180日+41.97%），4周窗口远未吃完，禁止止盈。同等深度但缩量跌破=无人接盘，坚决回避。',
      '3. 底背离：收盘创新低但量能明显萎缩于前一个低点（缩量新低=卖压衰竭）——净增+5pct、60日期望+7.8%（✅ 全项目唯一通过年度方向稳定性检验的信号，11/13年为正 p=0.023，可放心使用）。两低点之间有过10~20%反弹的完整结构最可靠；持有越长越好（180日E+11.64%），禁止止盈。',
      '4. 深跌后的底部反转：前20日跌幅≥30%时反转信号才可信，且跌得越深越可靠；浅跌中的任何"底部信号"都是噪音。深跌+连跌后出现放量阳线收复近期高点（缩量反击）是高质量确认。',
      '',
      '【回避清单】（历史胜率低于随机基准，宁可错过）',
      '- 双底颈线突破：胜率46%且39%最终破底；前高/颈线是假突破陷阱带（杯柄突破同理仅37.6%）——价格回升至前高附近的"突破"要降权。',
      '- 放量跳空缺口：放量=一次性消耗（40%胜率）；缩量缺口反而强（57%）。',
      '- 回调段极度缩量（量能不足均量0.7倍）：买盘消失，崩塌前兆（31%胜率）。',
      '- 量比≥5的极端放量突破：疑似出货。',
      '',
      '【元认知】',
      '- 背景重于形态：大涨后任何看跌K线（吞没/顶分型/M头）的主体是"涨多了"的背景效应；下跌中的连续阴线反而是反弹前兆。不要被K线形状本身说服。',
      '- 量能语义：萎缩=衰竭（顶）或枯竭（底），放量=消耗。缩量创新低是买点信号，放量创新高要警惕。',
      '- 看空的天花板远低于做多：除非顶背离（且仅熊市有效），不要轻易以"看跌形态"作为清仓依据。',
      '- 仅有的两个有效减仓事前信号：强势股（前期大涨）出现向下跳空缺口（历史仅32%胜收）、熊市中的顶背离（量能萎缩的新高）。其余看跌形态（吞没/顶分型/M头/黑三鸦）全部证伪。',
      '- 2月（春节后）窗口多头历史胜率92%，此间多头信号权重可上调。',
    ].join('\n'),
  },
  {
    label: '趋势·回踩',
    text: [
      '你采用「趋势内回踩」体系（基于 A 股 12 年全市场统计先验，适配趋势行情；核心规律：低回撤波段的回踩才值得买）：',
      '',
      '【入场框架】',
      '1. 趋势确认：均线金叉/多头排列本身只是中等信号（胜率~50%），只用来确认"趋势在场"，不要见到金叉就追买——突破日收盘买入的期望并不好。',
      '2. 真正的买点在首次回踩：趋势确立后价格首次回踩快速均线带（不跌破），且波段内最大回撤<5%时——创新高率82.7%。回撤5~10%降到53%，>10%断崖衰减：波段回撤深度是回踩质量的第一因子。',
      '3. 浅回踩优于深回踩：触及均线带上方1~3%即获得支撑的最强（创新高率76.6%），跌破均线带的回踩要打折。',
      '',
      '【持有与离场】',
      '- 回踩次数是波段健康度仪表盘：第1~2次回踩质量最高，第4次之后的回踩创新高率显著衰减——多次回踩本身说明波段走弱，应逐步降仓。',
      '- 安静上涨优先：回撤越小的波段涨幅越大（回撤<5%的波段96%翻倍、1/3涨5倍）；高波动"妖股"型趋势回避。',
      '- 盈利单不急于兑现，用"波段回撤是否扩大"而非"涨了多少"决定减仓；均线死叉/连续跌破关键均线才清仓。',
      '',
      '【元认知】',
      '- 趋势打法在震荡市会反复打脸（回踩买在半山腰）：横盘市应切换为区间思路或观望，识别行情性质优先于执行买点。',
      '- 回踩的研究对象是趋势已确立波段内的均线回踩；若回踩的对象是突破前平台（跌回启动位），那是突破失败信号，性质完全不同——前者买、后者跑。',
    ].join('\n'),
  },
  {
    label: '横盘潜伏',
    text: [
      '你采用「横盘潜伏+确认触发」体系（基于 A 股 12 年全市场统计先验，适配震荡行情；核心规律：横盘本身不是买点，价值在右尾）：',
      '',
      '【潜伏筛选】（决定哪些横盘值得埋伏）',
      '1. 估值保护垫：低估值（PB<1）的横盘向下突破仅3.9%——买到的是"下有底"；高估值横盘（PB>10）向下41%，坚决回避。',
      '2. 量能趋势：区间内量能持续萎缩（尾部量不足头部0.8倍）的横盘是危险品；量能走平或微增的横盘才值得潜伏。',
      '3. 相对强度：高位横盘（个股显著强于同期市场）优于低位横盘——强势中继 vs 弱势停顿，历史胜率差11pct且逐年稳定。',
      '',
      '【确认触发】（潜伏后的加仓/入场信号）',
      '- 支撑假跌破收回（spring）：横盘下沿被跌破≥1%后1~3天内收盘收回，且跌破深度≥5%——胜率60.8%（⚠ 上界，年度摇摆剧烈：2014年99% → 2017年29%）。持有期U型：20日可用、60日难受、180日+14.76%；禁止「跌破支撑就卖」（E 从 8.91 砍到 4.83，-46%）——失败判定信号不等于退出规则。',
      '- 长挤压突破：波动率收敛（布林带宽低位）持续40天以上后的突破有真实增量（56.3%）；短期挤压（<20天）的突破无增量，不追。',
      '- 突破确认期纪律：突破后10日内回撤<3%才确认强势；回撤≥8%即隐性失败；跌回区间=确认失败。',
      '',
      '【纪律】',
      '- 约6成横盘最终不突破：潜伏仓位必须轻（试探份数），把主力仓位留给确认触发之后。',
      '- 突破方向未确认前不做方向赌博；估值/量能/强度三关未过的横盘直接放弃。',
    ].join('\n'),
  },
  {
    label: '三全态',
    text: [
      '你是「全气候」交易员：先判断当前行情状态，再执行对应打法（基于 A 股 12 年全市场统计先验；战绩反馈失准时优先怀疑状态判断错了，其次才是打法问题）。每个信号都有精确结构定义，必须逐条核对K线后才可认定，禁止凭大致印象套用。',
      '',
      '【第一步：判断行情状态】（依据已揭示K线的涨跌%、均线、量比；K线规律是分形的：若提供周线/月线图，用同一套形态语言在大级别上校准——月线级别的底背离/深跌比日线级别分量重得多，日线信号与大级别方向矛盾时相信大级别）',
      '- 深跌恐慌态：近20日累计跌幅≥20%，或近期跌速明显大于前期（加速下跌）。',
      '- 趋势态：MA5>MA20>MA60多头排列，收盘站稳MA20上方，波段自低点已有可观涨幅且回撤温和（<10%）。',
      '- 横盘态：价格在窄区间（高低点差<15%）内运行数周（≥15根）以上，无单边方向——上下文【形态特征】会给出程序判定的区间上下沿与当前位置，直接以它为锚。注意：均线走平是滞后的，区间形成早期 MA20 仍带斜率，勿因均线未走平而否认区间；滚动20根回撤若含区间形成前的下跌尾巴，判断状态以最近的价格活动范围为准，而非该回撤值。',
      '- 观望态：以上都不满足（浅跌、方向不明、宽幅震荡（区间差15~30%）、高位剧烈震荡）——空仓或最小份数，只做逐条核对无误的最高置信信号。',
      '- ⚠震荡市识别（先于一切打法）：近10~20根内收盘价反复上下穿越MA20（≥2个来回）即为震荡市——此时MA20是噪音线而非趋势锚：禁止把每次"放量收复MA20"当趋势修复入场、每次跌破当趋势失败止损，这种试探-止损-再试探的循环是最差路径。震荡市只允许两种动作：区间边界（下沿买/上沿卖，止损设区间边界外）或彻底观望，区间中段一律不开新仓（已持仓者的离场依据是跌破区间下沿，而非"处于中段"——不要因位置而清仓）。',
      '',
      '【深跌恐慌态 → 出清买点】（底部质量看出清程度，不看守住没有。入场前提：近20日跌幅≥10%即可关注（10~20%档信号质量中等：胜率53~59%），≥30%时信号最强（65~84%）；浅跌（<10%）中的一切"底部信号"都是噪音）',
      '信号A 底背离（逐条核对）：①存在一个局部低点L1，其后价格反弹离开；②不少于10天后出现第二个低点L2，收盘价低于L1创新低；③L2附近的成交量显著低于L1（量比口径<0.8倍为标准）；④L1→L2之间有过10~20%反弹的"完整结构"最可靠（一路阴跌中的背离质量减半）；⑤买点：L2后不再创新低、出现放量阳线时。',
      '信号B 深跌破有承接：①数周内低点反复贴在同一支撑位附近（相差±5%内）；②某日跌破该支撑10~15%（恐慌释放）；③跌破日及次日量能不萎缩（量比≥0.8——有人承接的下跌才是出清）；④买点：跌破后首根企稳阳线。⚠同等深度但量比<0.8的缩量阴跌破位=无人接盘，坚决回避。',
      '信号C 缩量反击：①出现量比≥1.5的大阴线或长上影阴线（关键K，空头发力）；②1~5天内出现阳线，收盘价收复该关键K的最高价（空头努力被击败）；③这根阳线量比越小越好（<关键K量比的0.3倍=空头彻底无力，胜率65%）。',
      '信号D 腰斩：①前期自低点上涨≥100%（翻倍）；②见顶后单边回落：途中反弹不超过20%、没有二次冲高；③收盘价跌破顶点一半=腰斩点，出清最彻底（90日胜率74%、中位+15%）。⚠节奏是U型不是V型：60日仅+9%，90日才充分展开——按60~90天持有设计，中途-20%浮亏是正常代价，用分批建仓摊薄，勿在半途恐慌割肉。',
      '信号E 巨量长上影（持仓减仓信号）：单日量比≥3且收盘较开盘回落≥5%（高开冲高大幅回落的长上影阴线）=顶部一次性消耗/出货形态——持仓者应立即减仓一半以上，空仓者禁止追买。⚠读图校验：判断"突破"必须以收盘价为准，上影线触及不算突破；收盘价在关键位下方的巨量阴线是危险信号而非强势信号。',
      '',
      '【趋势态 → 回踩买点】（低回撤波段的回踩才值得买）',
      '纪律一：不追买。金叉当天、长阳突破当天、放量新高的当天买入，历史期望都不好（突破日收盘买入胜率仅46%）——这些只用于确认"趋势在场"。',
      '纪律二：买点定义（逐条核对）：①价格自上方回落，触及短期均线带（MA5/MA10附近±3%）但收盘不跌破；②这是本波段自启动以来的第1~2次回踩；③波段最高点到本次回落低点的回撤<5%——三条全满足，历史20日创新高率83%。回撤5~10%质量减半；>10%直接放弃该回踩。',
      '纪律三：次数仪表盘：第3次回踩起质量逐次下降，第4次之后断崖——多次回踩本身说明波段走弱，逐次降仓而非越跌越买。',
      '关键区分：回踩短期均线（趋势的正常呼吸，买）≠跌回突破前平台或前低（突破失败信号，跑）——判定标准是回落的"位置"落在哪。',
      '离场：收盘连续跌破MA20或MA20/60死叉；盈利时不设涨幅目标，以"波段回撤是否扩大、均线是否破坏"决定去留。',
      '',
      '【横盘态 → 潜伏+确认】（横盘本身不是买点，价值在右尾）',
      '数据边界（如实认知）：你看不到估值与大盘数据，无法执行估值/相对强度过滤——用更保守的仓位与更严格的确认纪律补偿，宁可少做。',
      '潜伏筛选：①区间内量能趋势平稳或温和收敛，但不能枯竭（区间尾部量能不宜低于头部0.8倍——持续缩量阴跌的横盘是危险品）；②潜伏位贴近区间下沿，不在区间中段；③潜伏仓位必须轻（约6成横盘最终不突破），主力份数留给确认信号之后。',
      '确认信号A 假跌破收回（spring）：①区间下沿/近期最低支撑被收盘跌破≥1%；②1~3天内收盘重新收回支撑上方；③跌破深度≥5%的深spring胜率60.8%（洗盘更充分）；④止损设在spring最低价，不设在支撑位（支撑就在附近，设支撑位会被浅回踩扫损）。',
      '确认信号B 长挤压突破：①日内振幅/波动持续收敛处于近期低位≥40天（时间充分的筹码换手）；②随后向上突破区间——胜率56.3%。挤压<20天的短挤压突破无增量，不追。',
      '突破确认期纪律：突破后10日内回撤<3%才算强势确立；回撤≥8%即隐性失败（即便未跌回区间）；跌回区间=确认失败清仓。',
      '',
      '【任意状态通用】',
      '- 回避清单（结构定义）：价格回升至前高/颈线附近的"突破"（假突破陷阱带：双底颈线突破胜率46%且39%最终破底、杯柄突破38%）；当日量比≥2且收盘创新高的追买（极端放量量比≥5疑似出货）；向上跳空缺口且当日放量的（放量缺口40%胜率，缩量缺口反而57%）；持仓回调段量能萎缩到不足前段0.7倍的（买盘消失，崩塌前兆31%）。',
      '- 持仓铁律：买入/突破后10日内回撤<3%持有、≥8%减仓、跌回启动位清仓；向上跳空缺口是持有锚，收盘回补缺口立即离场（未回补组+18% vs 已回补组-10%）；止损设在结构性低点（跌破日最低价/spring最低价），不设在整数关口或名义支撑。',
      '- 持仓浮亏时识别出清式下跌（等待的艺术）：磨底尾段常见故意向下打穿支撑的假跌破（spring）与放量巨阴——量能不萎缩的巨阴跌破是恐慌真实换手而非崩塌（历史：跌破10~15%+量能不缩后市4周胜率78~81%，深spring收回60.8%），在此类出清位止损=卖在黎明前；真正该离场的是跌破后无力收回、或缩量阴跌无人承接。以ATR14为波动基准：1~2倍ATR的巨阴属正常出清，勿恐慌止损。',
      '- 止损锚选择：趋势确认后可用MA20做移动止损；震荡/横盘语境中MA20是噪音线，止损只设在区间边界或结构位（跌破日最低/spring最低价），否则会被反复扫损。',
      '- 开仓熔断（硬规则）：本局内同方向止损≥3次即进入强制冷静——此后仅区间突破、深跌出清信号（跌≥20%后的确认）或腰斩可解除，其余一切信号（含"放量收复MA20""趋势修复"）一律观望。轻仓试探也有手续费与滑点成本，连续止损说明你对行情状态的判断错了，需要的不是再试一次而是停下来。',
      '- 元认知：背景>形态，不要被K线形状说服——大涨后的看跌K线（吞没/顶分型/M头）主体是"涨多了"的背景效应，仅两个减仓信号有效：强势股（前期大涨后）的向下跳空缺口、熊市中的顶背离；量能语义（按语境消歧）：萎缩在横盘语境=买盘消失（危险），在深跌后创新低语境=卖压衰竭（底背离买点，勿读反）；放量=消耗，缩量创新低是买点信号、放量创新高要警惕；不轻易看空（历史做空天花板65%远低于做多84%）；2月春节后窗口多头胜率92%，多头信号权重可上调。',
      '- 预测等待模式下，离场/止损条件尽量写成 break_down 触发器（缺口对沿价、跌破日最低价、MA20），让系统自动唤醒你执行。',
    ].join('\n'),
  },
];

// 风控指引预设：持仓铁律（纪律性规则，与任何策略人设叠加使用）
// 注：放风控指引而非策略指令——策略指令预设是替换式（会覆盖已选人设），
//     风控指引是独立 textarea，可与「三全态/趋势跟随/自定义」等任意策略自由组合。
// [EXIT:v2] 是本版风控指引的版本标记：训练记录会把 riskGuide 存进 records.meta，
// 归因脚本 compare_prompts.py 据此把使用了新版退出规则的局归入 B 组（与旧基线 A 组对照）
const RISK_GUIDE_PRESET = [
  '[EXIT:v2] 以下持仓纪律基于 A 股 12 年全市场统计先验（quant_discover d24~d29 持有与卖出研究），与任何建仓风格兼容，应严格执行：',
  '【风控在仓位，不在止损价】固定百分比止损是负期望的：-5%~-15% 是噪音区，各档 ΔE 全负（腰斩信号 -15% 档仍 -19pct），-5% 档触发率 66~89%，被止损的赢家后续平均还赚 +13~30%；持有期回撤 IC +0.49（12/12 年为正）——浮亏越深越该拿。风险控制请落在单票仓位上限（份数），不要靠价格止损位。',
  '【已被证伪的退出做法，不要使用】固定百分比止损／时间止损（N 天不涨就出，六信号全败）／均线破位退出（卖飞 70%、卖对仅 8%、期望磨掉 87%）／跌破支撑或前低就卖（spring 案例 E 从 8.91 砍到 4.83）／K 线形态逃顶（AUC≈0.5）。退出规则不要叠加（OR 组合是负改进）。',
  '【唯一有效的主动退出】移动止盈 trail：浮盈达 X% 后自最高回落 Y% 卖出，参考档位 腰斩类(30/10)、底背离(20/8)、spring(20/10)、绝望组(20/8)；或干脆持有到期。',
  '【持有期甜点】腰斩/绝望组 90 日（40 日处是坑，勿在此离场）；筑底跌破、底背离 越长越好（180 日仍未吃完，禁止止盈）；spring U 型（20 日可用 → 60 日难受 → 180 日再起）。',
  '【状态语义】浮盈是最强的反向信号（IC -0.44，其中约 3/4 是大盘 beta）——浮盈大时用 trail 锁定、勿因浮盈加仓；回撤越深越该拿（回撤 IC +0.49）。',
  '- 突破/买入后10日确认期：回撤<3%=强势，坚定持有；回撤≥8%=隐性失败，减仓处理；跌回启动平台=确认失败，清仓。不能只看"是否跌破平台"二分。',
  '- 向上跳空缺口是持有锚：收盘回补缺口立即离场（历史未回补组+18%/已回补组-10%，分野28pct）。',
  '- 盈利时不急于兑现：趋势完好时让利润奔跑，用回撤深度而非涨幅决定减仓；统计上慢修复型（C组/底背离）禁止止盈。',
  '- 开仓熔断（硬规则）：本局内同方向被迫离场≥3次即停止入场，直到出现区间突破或深跌出清确认信号。',
  '- 预测等待模式下，离场条件优先用 trail 触发器（value=激活浮盈%、value2=自最高回落%）表达移动止盈；结构位离场仍可用 break_down，但勿把价格止损当风控主手段。',
].join('\n');

export default function Settings({ stocks, loading, error, onStart, onBack }: Props) {
  const [mode, setMode] = useState<TrainMode>('random');
  const [code, setCode] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [period, setPeriod] = useState<Period>('day');
  const [positions, setPositions] = useState(2);
  const [maParams, setMaParams] = useState<number[]>([5, 10, 20, 60]);
  const [decisionBars, setDecisionBars] = useState(101);
  const [feeRate, setFeeRate] = useState(0.03); // 百分比
  const [slippage, setSlippage] = useState(0.01); // 百分比
  const [stampTax, setStampTax] = useState(0.1); // 百分比
  const [aiPrompt, setAiPrompt] = useState(() => localStorage.getItem(AI_PROMPT_KEY) || '');
  const [klineMode, setKlineMode] = useState<KlineMode>(() => loadKlineMode());
  const [riskGuide, setRiskGuide] = useState(() => loadAiRiskGuide());
  const [aiMode, setAiMode] = useState<AiMode>(() => loadAiMode());
  const [aiModels, setAiModels] = useState<AiModels>(() => loadAiModels());
  const [aiHorizon, setAiHorizon] = useState<AiHorizon>(() => loadAiHorizon());
  const [aiTradeBudget, setAiTradeBudget] = useState(() => loadAiTradeBudget());

  function updateAiHorizon(next: Partial<AiHorizon>) {
    const merged = { ...aiHorizon, ...next };
    // 边界约束：min 1~10，max ≥min 且 ≤30
    merged.min = Math.max(1, Math.min(10, Math.round(Number(merged.min) || 3)));
    merged.max = Math.max(merged.min, Math.min(30, Math.round(Number(merged.max) || 15)));
    setAiHorizon(merged);
    saveAiHorizon(merged);
  }

  function updateKlineMode(m: KlineMode) {
    setKlineMode(m);
    saveKlineMode(m);
  }

  function updateAiPrompt(text: string) {
    setAiPrompt(text);
    localStorage.setItem(AI_PROMPT_KEY, text);
  }

  function toggleMa(p: number) {
    setMaParams((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p].sort((a, b) => a - b),
    );
  }

  function submit() {
    const cfg: TrainingConfig = {
      mode,
      code: code.trim(),
      period,
      ...(mode === 'specified'
        ? {
            startDate: startDate || undefined,
            endDate: endDate || undefined,
          }
        : {}),
      initialCapital: VIRTUAL_CAPITAL,
      positions: Math.max(1, Math.min(5, positions)),
      maParams: [...maParams].sort((a, b) => a - b),
      decisionBars: Math.max(1, decisionBars),
      feeRate: Math.max(0, feeRate) / 100,
      slippage: Math.max(0, slippage) / 100,
      stampTax: Math.max(0, stampTax) / 100,
    };
    onStart(cfg);
  }

  const canSubmit =
    !loading &&
    (mode === 'random' || code.trim().length > 0) &&
    !(mode === 'specified' && startDate && endDate && startDate > endDate);

  return (
    <div className="settings-wrap">
      <button className="link-btn" onClick={onBack} style={{ marginBottom: 8 }}>
        ← 返回主页
      </button>

      <div className="settings-title">开始一场 K 线训练</div>
      <div className="settings-sub">
        系统会隐藏股票代码与日期，逐根回放真实历史 K 线，请你做出买卖决策。
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(246,70,93,0.12)',
            border: '1px solid var(--up)',
            color: 'var(--up)',
            padding: '12px 16px',
            borderRadius: 8,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}

      <div className="form-group">
        <label className="form-label">训练品种</label>
        <div className="seg">
          <button
            className={`seg-btn ${mode === 'random' ? 'active' : ''}`}
            onClick={() => setMode('random')}
          >
            随机股票
          </button>
          <button
            className={`seg-btn ${mode === 'specified' ? 'active' : ''}`}
            onClick={() => setMode('specified')}
          >
            指定股票
          </button>
        </div>
      </div>

      {mode === 'specified' && (
        <div className="form-group">
          <label className="form-label">股票代码</label>
          <input
            className="input"
            list="stock-list"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="如 000001 / 600519"
            maxLength={6}
          />
          <datalist id="stock-list">
            {stocks.slice(0, 2000).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
      )}

      {mode === 'specified' && (
        <div className="form-group">
          <label className="form-label">
            训练区间
            <span className="form-hint">
              可选：决策从起始日期当天（或其后首个交易日）开始，结束日期前完成；留空则自动随机
            </span>
          </label>
          <div className="input-row">
            <div>
              <label className="form-hint" style={{ margin: '0 0 4px' }}>起始日期</label>
              <input
                className="input"
                type="date"
                value={startDate}
                max={endDate || undefined}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label className="form-hint" style={{ margin: '0 0 4px' }}>结束日期</label>
              <input
                className="input"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          {startDate && endDate && startDate > endDate && (
            <div className="form-hint" style={{ color: 'var(--up)' }}>
              起始日期不能晚于结束日期
            </div>
          )}
        </div>
      )}

      <div className="form-group">
        <label className="form-label">
          AI K线呈现
          <span className="form-hint">AI 托管决策时，K 线走势以何种形式喂给模型</span>
        </label>
        <div className="seg">
          {(
            [
              ['csv', 'CSV数据'],
              ['chart', '字符形态图'],
              ['image', '图表截图'],
            ] as [KlineMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              className={`seg-btn ${klineMode === m ? 'active' : ''}`}
              onClick={() => updateKlineMode(m)}
              title={
                m === 'csv'
                  ? '数字表格：OHLCV + 涨跌% + 量比 + MA，信息最全，适合纯文本模型'
                  : m === 'chart'
                    ? '字符画形态图：阴阳块 + 价格网格 + 量能条，形态直观，适合纯文本模型'
                    : '把当前周期图表截图发给模型（含MA与成交量），需 LLM 支持多模态'
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          AI 托管模式
          <span className="form-hint">训练页开启「AI 托管」后，AI 以哪种节奏做决策</span>
        </label>
        <div className="seg">
          <button
            className={`seg-btn ${aiMode === 'pred_wait' ? 'active' : ''}`}
            onClick={() => {
              setAiMode('pred_wait');
              saveAiMode('pred_wait');
            }}
            title="AI 先做一次结构化预测（方向/区间/触发条件/有效期），之后仅在触发条件命中或预测到期时被唤醒决策，并可修订预测。适合波段节奏，LLM 调用少、成本低"
          >
            预测等待
          </button>
          <button
            className={`seg-btn ${aiMode === 'step' ? 'active' : ''}`}
            onClick={() => {
              setAiMode('step');
              saveAiMode('step');
            }}
            title="AI 每根K线收盘后都决策一次（买/卖/观望）。响应密集、逐根盯盘，LLM 调用多、成本高"
          >
            逐根决策
          </button>
        </div>
        <div className="form-hint" style={{ marginTop: 8 }}>
          {aiMode === 'pred_wait'
            ? '预测等待：AI 先预测（方向/区间/触发条件/有效期），仅在条件命中或到期时被唤醒决策，可修订预测——接近真实波段交易节奏'
            : '逐根决策：AI 每根K线收盘后都给出买/卖/观望——决策密集，适合观察 AI 的短线反应'}
        </div>
        {aiMode === 'pred_wait' && (
          <div className="input-row" style={{ marginTop: 10 }}>
            <div>
              <label className="form-hint" style={{ margin: '0 0 4px' }}>有效期下限 min_horizon（交易日）</label>
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                value={aiHorizon.min}
                title="下限越高，AI 被唤醒/交易的频率越低（治频繁开仓的旋钮）：3=温和波段节奏，5+ = 强制低频长持"
                onChange={(e) => updateAiHorizon({ min: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="form-hint" style={{ margin: '0 0 4px' }}>有效期上限 max_horizon（交易日）</label>
              <input
                className="input"
                type="number"
                min={aiHorizon.min}
                max={30}
                value={aiHorizon.max}
                title="预测最长覆盖天数；AI 自定 horizon 在 [下限, 上限] 内，超界被程序截断"
                onChange={(e) => updateAiHorizon({ max: Number(e.target.value) })}
              />
            </div>
          </div>
        )}
        <div style={{ marginTop: 10, maxWidth: 260 }}>
          <label className="form-hint" style={{ margin: '0 0 4px' }}>开仓机会预算（仓位回合数/场）</label>
          <input
            className="input"
            type="number"
            min={1}
            max={20}
            value={aiTradeBudget}
            title="稀缺性约束：一场训练 AI 只有 N 个仓位回合（1回合=空仓建仓→清仓，回合内分批加/减仓不另耗机会；分仓数=2 时每回合最多 2买+2卖）；用尽后只能管理现有持仓或观望（止损不受限）；默认 6"
            onChange={(e) => {
              const v = Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 6)));
              setAiTradeBudget(v);
              saveAiTradeBudget(v);
            }}
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          LLM 模型
          <span className="form-hint">留空则使用 server/.env 的默认模型；API_KEY 等机密仍配置在 server/.env</span>
        </label>
        <div className="input-row">
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>默认模型（文本）</label>
            <input
              className="input"
              value={aiModels.model ?? ''}
              placeholder="如 deepseek-v4-flash"
              onChange={(e) => {
                const next = { ...aiModels, model: e.target.value.trim() || undefined };
                setAiModels(next);
                saveAiModels(next);
              }}
            />
          </div>
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>视觉模型（截图模式）</label>
            <input
              className="input"
              value={aiModels.visionModel ?? ''}
              placeholder="如 deepseek-v4-flash-vision-exp"
              onChange={(e) => {
                const next = { ...aiModels, visionModel: e.target.value.trim() || undefined };
                setAiModels(next);
                saveAiModels(next);
              }}
            />
          </div>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">K 线周期</label>
        <div className="seg">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <button
              key={p}
              className={`seg-btn ${period === p ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          分仓数
          <span className="form-hint">将资金分成几份，训练中可分仓买入 / 分仓卖出</span>
        </label>
        <div className="seg">
          {POSITION_OPTIONS.map((n) => (
            <button
              key={n}
              className={`seg-btn ${positions === n ? 'active' : ''}`}
              onClick={() => setPositions(n)}
            >
              {n} 仓
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          交易成本
          <span className="form-hint">用于模拟真实交易，训练盈亏会扣除这些费用</span>
        </label>
        <div className="input-row">
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>手续费 (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={0.001}
              value={feeRate}
              onChange={(e) => setFeeRate(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>滑点损失 (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={0.001}
              value={slippage}
              onChange={(e) => setSlippage(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="form-hint" style={{ margin: '0 0 4px' }}>印花税 (%)</label>
            <input
              className="input"
              type="number"
              min={0}
              step={0.001}
              value={stampTax}
              onChange={(e) => setStampTax(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">均线参数</label>
        <div className="check-group">
          {MA_OPTIONS.map((p) => (
            <div
              key={p}
              className={`check ${maParams.includes(p) ? 'active' : ''}`}
              onClick={() => toggleMa(p)}
            >
              MA{p}
            </div>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          决策根数
          <span className="form-hint">需要你逐根做买卖决策的数量</span>
        </label>
        <input
          className="input"
          type="number"
          min={1}
          value={decisionBars}
          onChange={(e) => setDecisionBars(Number(e.target.value))}
        />
      </div>

      <div className="form-group">
        <label className="form-label">
          风控指引
          <span className="form-hint">用自然语言描述你对 AI 托管的止盈止损/仓位/节奏等要求（非强制平仓，AI 领会后灵活执行）；留空则不设。与策略指令相互独立、可叠加</span>
        </label>
        <div className="seg" style={{ marginBottom: 8 }}>
          <button
            className="seg-btn"
            onClick={() => {
              setRiskGuide(RISK_GUIDE_PRESET);
              saveAiRiskGuide(RISK_GUIDE_PRESET);
            }}
            title={RISK_GUIDE_PRESET}
          >
            填入持仓铁律
          </button>
        </div>
        <textarea
          className="input"
          rows={2}
          value={riskGuide}
          onChange={(e) => {
            setRiskGuide(e.target.value);
            saveAiRiskGuide(e.target.value);
          }}
          placeholder="例：盈利 20% 以上分批止盈，亏损 8% 果断止损；趋势很强时可放宽到跌破 MA20 才离场……"
          style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
        />
      </div>

      <div className="form-group">
        <label className="form-label">
          AI 策略指令
          <span className="form-hint">训练页开启「AI 托管」时注入给 LLM 的个性化策略，留空则使用通用交易员人设</span>
        </label>
        <div className="seg" style={{ marginBottom: 8 }}>
          {AI_PROMPT_PRESETS.map((p) => (
            <button
              key={p.label}
              className="seg-btn"
              onClick={() => updateAiPrompt(p.text)}
              title={p.text || '通用交易员人设（留空）'}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          className="input"
          rows={3}
          value={aiPrompt}
          onChange={(e) => updateAiPrompt(e.target.value)}
          placeholder="例：只在价格站稳 MA20 上方时持仓，跌破 MA20 一律清仓……"
          style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
        />
      </div>

      <button className="primary-btn" disabled={!canSubmit} onClick={submit}>
        {loading ? '加载数据中…' : '开始训练'}
      </button>
    </div>
  );
}
