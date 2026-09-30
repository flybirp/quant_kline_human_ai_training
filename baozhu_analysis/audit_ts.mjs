// 对账用：stdin 喂 bars JSON（date/open/high/low/close/volume），stdout 返回特征行（无标题无 - 前缀）
import { patternSummaryBlock } from '../web/src/lib/patterns.ts';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const bars = JSON.parse(input);
  const lines = patternSummaryBlock(bars);
  console.log(JSON.stringify(lines ? lines.slice(1).map((s) => s.replace(/^- /, '')) : null));
});
