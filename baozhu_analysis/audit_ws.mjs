// 对账用：stdin 喂 bars JSON，stdout 返回 weeklyState 结果（TS 版）
import { weeklyState } from '../web/src/lib/weeklyState.ts';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const bars = JSON.parse(input);
  console.log(JSON.stringify(weeklyState(bars)));
});
