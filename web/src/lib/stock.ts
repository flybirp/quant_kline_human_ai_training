// 根据 A 股代码前缀推一个板块名。本地数据没有真实股票名称，
// 用前缀映射 + 代码本身组合展示，避免编造所谓「真实」名称。
export function codeToStockName(code: string): string {
  if (/^(600|601|603|605)/.test(code)) return `沪A·${code}`;
  if (/^688/.test(code)) return `科创·${code}`;
  if (/^002/.test(code)) return `深A·${code}`;
  if (/^000/.test(code)) return `深A·${code}`;
  if (/^300/.test(code)) return `创业·${code}`;
  if (/^(83|87|88)/.test(code)) return `北证·${code}`;
  if (/^4/.test(code)) return `北证·${code}`;
  return `股票·${code}`;
}
