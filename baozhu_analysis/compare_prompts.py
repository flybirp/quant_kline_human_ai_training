#!/usr/bin/env python3
"""T11 双盲对照归因：新旧策略 prompt 的 A/B 对比。

数据源（双源关联）：
1. server/data/records.json —— 每局的收益/胜率/区间基准（meta.aiPrompt 保存了当时用的策略指令）
2. server/logs/ai-decide.jsonl —— 每次决策的完整理由（按 sessionId 关联），用于检测「铁律违反」

分组：aiPrompt 中含 --tag-b 指定标记的为 B 组（新），其余为 A 组（旧/基线）。

指标：
- 局数、平均收益、中位收益、胜率
- 超额收益 = profitRate − rangeReturn×100（相对"买入持有该区间"的增量）
- 平均开仓次数 / 平均交易笔数
- 铁律违反率（启发式：对决策理由做关键词匹配，见 VIOLATIONS）

用法：
  python3 compare_prompts.py                        # 默认以 [EXIT:v2] 作为 B 组标记
  python3 compare_prompts.py --tag-b "出清买点v3"
  python3 compare_prompts.py --show-violations      # 打印被判违规的原始理由
"""
import argparse
import json
import re
import statistics
from pathlib import Path

ROOT = Path(__file__).parent.parent
RECORDS = ROOT / 'server' / 'data' / 'records.json'
DECIDE_LOG = ROOT / 'server' / 'logs' / 'ai-decide.jsonl'

# 铁律违反关键词（依据 quant_discover d24~d29 已证伪的退出做法）
# ⚠️ 启发式：AI 提到这些词不等于一定违规，仅作"疑似违反率"的粗筛，需人工抽查确认
VIOLATIONS = {
    '固定止损': r'止损',
    '均线破位退出': r'跌破\s*MA|MA\s*\d+\s*.*?(卖|离场|出)|均线.*?破位|破位.*?离场',
    '时间止损': r'\d+\s*(天|日|根).{0,4}(不涨|没涨|未涨)|时间止损|持有\s*\d+\s*(天|日).{0,4}(了|够)',
    '跌破支撑就卖': r'跌破支撑|跌破前低|支撑.*?失守',
    'K线逃顶': r'吞没|顶分型|M头|黑三鸦',
}


def load_records():
    d = json.loads(RECORDS.read_text(encoding='utf-8'))
    return d.get('records', []) if isinstance(d, dict) else d


def load_reasons_by_session():
    """sessionId -> [卖出决策理由...]

    只看 action=='sell' 的决策：提到"止损"不等于执行了止损卖出，
    用卖单理由才能度量"实际用哪种方式离场"。
    """
    out = {}
    if not DECIDE_LOG.exists():
        return out
    for line in DECIDE_LOG.read_text(encoding='utf-8').split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        sid = e.get('sessionId')
        o = e.get('output') or {}
        if o.get('action') != 'sell':
            continue
        reason = o.get('reason') or ''
        if sid and reason:
            out.setdefault(sid, []).append(reason)
    return out


def stats_of(group, reasons_by_sid, collect=None):
    if not group:
        return None
    profits = [r.get('profitRate', 0) for r in group]
    excess = []
    for r in group:
        rr = r.get('rangeReturn')
        if rr is not None:
            excess.append(r.get('profitRate', 0) - float(rr) * 100)
    wins = sum(r.get('winTrades', 0) for r in group)
    losses = sum(r.get('lossTrades', 0) for r in group)
    trades = sum(len(r.get('trades', [])) for r in group)

    # 铁律违反（按局统计：该局出现过即计 1 次违反）
    viol = {k: 0 for k in VIOLATIONS}
    viol_sessions = 0
    checked = 0
    samples = []
    for r in group:
        sid = r.get('sessionId')
        reasons = reasons_by_sid.get(sid, [])
        if not reasons:
            continue
        checked += 1
        hit_any = False
        for name, pat in VIOLATIONS.items():
            for reason in reasons:
                if re.search(pat, reason, re.I):
                    viol[name] += 1
                    hit_any = True
                    if collect and len(samples) < 12:
                        samples.append((name, r.get('code'), reason))
                    break
        if hit_any:
            viol_sessions += 1

    return {
        'n': len(group),
        'avg_profit': statistics.mean(profits) if profits else 0,
        'med_profit': statistics.median(profits) if profits else 0,
        'win_rate': (wins / (wins + losses) * 100) if (wins + losses) else 0,
        'avg_excess': statistics.mean(excess) if excess else None,
        'avg_open': statistics.mean([r.get('openCount', 0) for r in group]),
        'avg_trades': trades / len(group),
        'viol_checked': checked,
        'viol_sessions': viol_sessions,
        'viol_rate': (viol_sessions / checked * 100) if checked else None,
        'viol_detail': viol,
        'samples': samples,
    }


def fmt(v, nd=2, suffix=''):
    return '—' if v is None else f'{v:.{nd}f}{suffix}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tag-b', default='[EXIT:v2]', help='B 组（新 prompt）的版本标记')
    ap.add_argument('--ai-mode', default='', help='只统计该 aiMode 的局（如 pred_wait），保证 A/B 同质可比')
    ap.add_argument('--kline-mode', default='', help='只统计该 klineMode 的局（如 image / csv），保证呈现方式一致')
    ap.add_argument('--show-violations', action='store_true')
    args = ap.parse_args()

    records = load_records()
    # 可比性过滤：A/B 必须用同样的训练模式与 K 线呈现方式，否则差异无法归因到 prompt
    if args.ai_mode:
        records = [r for r in records if (r.get('meta') or {}).get('aiMode') == args.ai_mode]
    if args.kline_mode:
        records = [r for r in records if (r.get('meta') or {}).get('klineMode') == args.kline_mode]
    reasons = load_reasons_by_session()
    # 分组标记可能写在策略指令（aiPrompt）或风控指引（riskGuide）里，两者都查
    def tagged(r):
        m = r.get('meta') or {}
        text = f"{m.get('aiPrompt') or ''}\n{m.get('riskGuide') or ''}"
        return args.tag_b in text

    A = [r for r in records if not tagged(r)]
    B = [r for r in records if tagged(r)]

    sa, sb = stats_of(A, reasons, collect=args.show_violations), stats_of(B, reasons, collect=args.show_violations)
    filt = f'｜过滤: aiMode={args.ai_mode or "全部"}, klineMode={args.kline_mode or "全部"}'
    print(f'总记录 {len(records)} 局｜A 组（旧/基线）{len(A)} 局｜B 组（新 {args.tag_b}）{len(B)} 局{filt}')
    print(f'（决策日志可关联 {len(reasons)} 个 session）\n')

    if not sa and not sb:
        print('无记录')
        return

    rows = [
        ('局数', lambda s: s['n'], ''),
        ('平均收益', lambda s: s['avg_profit'], '%'),
        ('中位收益', lambda s: s['med_profit'], '%'),
        ('胜率', lambda s: s['win_rate'], '%'),
        ('超额(相对区间)', lambda s: s['avg_excess'], '%'),
        ('平均开仓次数', lambda s: s['avg_open'], ''),
        ('平均交易笔数', lambda s: s['avg_trades'], ''),
        ('铁律违反率(疑)', lambda s: s['viol_rate'], '%'),
    ]
    print(f'{"指标":<16}{"A组(旧)":>14}{"B组(新)":>14}{"差异":>14}')
    print('-' * 58)
    for name, get, suffix in rows:
        va = get(sa) if sa else None
        vb = get(sb) if sb else None
        diff = (vb - va) if (va is not None and vb is not None) else None
        print(f'{name:<16}{fmt(va, 2, suffix):>14}{fmt(vb, 2, suffix):>14}{fmt(diff, 2, suffix):>14}')

    for label, s in (('A', sa), ('B', sb)):
        if not s or not s['viol_detail']:
            continue
        det = '，'.join(f'{k} {v}局' for k, v in s['viol_detail'].items() if v)
        print(f'\n{label} 组铁律违反明细（{s["viol_checked"]} 局可查）: {det or "无"}')

    if args.show_violations and sa:
        print('\n== 违规样本（启发式匹配，需人工确认）==')
        for name, code, reason in (sa.get('samples') or [])[:12]:
            print(f'  [{name}] {code}: {reason[:70]}')

    n_min = min(len(A), len(B))
    print(f'\n⚠️ 样本提示：两组较小样本 {n_min} 局。'
          f'{"样本过少，差异不具统计意义，建议每组≥15局再下结论。" if n_min < 15 else "可进一步做配对检验（同股票同时段）。"}')


if __name__ == '__main__':
    main()
