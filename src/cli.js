import { runDailyScan, monitorTrades } from './index.js';
import {
  runBacktest,
  runMonteCarloSimulation,
  runParameterSensitivity,
  runWalkForwardTest,
} from './services/backtestService.js';

const command = process.argv[2];

if (command === 'scan') {
  await runDailyScan();
  process.exit(0);
} else if (command === 'monitor') {
  await monitorTrades();
  process.exit(0);
} else if (command === 'backtest') {
  const daysArg = Number(process.argv[3]) || 365;
  const result = await runBacktest({ lookbackDays: daysArg });
  console.log(
    JSON.stringify(
      {
        config: result.config,
        benchmarkTrend: result.benchmarkTrend,
        summary: result.summary,
        tradesSample: result.trades.slice(-5),
      },
      null,
      2
    )
  );
  process.exit(0);
} else if (command === 'sensitivity') {
  const daysArg = Number(process.argv[3]) || 365;
  const result = await runParameterSensitivity({ lookbackDays: daysArg });
  console.log(JSON.stringify(result.topResults.slice(0, 5), null, 2));
  process.exit(0);
} else if (command === 'walk-forward') {
  const trainDays = Number(process.argv[3]) || 1095;
  const testDays = Number(process.argv[4]) || 730;
  const result = await runWalkForwardTest({ trainDays, testDays });
  console.log(
    JSON.stringify(
      {
        selectedParams: result.selectedParams,
        trainingTopSummary: result.trainingTopSummary,
        testSummary: result.testSummary,
      },
      null,
      2
    )
  );
  process.exit(0);
} else if (command === 'monte-carlo') {
  const daysArg = Number(process.argv[3]) || 365;
  const iterations = Number(process.argv[4]) || 500;
  const backtest = await runBacktest({ lookbackDays: daysArg });
  const result = runMonteCarloSimulation({ trades: backtest.trades, iterations });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} else {
  console.log('Usage: node src/cli.js <scan|monitor|backtest [days]|sensitivity [days]|walk-forward [trainDays] [testDays]|monte-carlo [days] [iterations]>');
  process.exit(1);
}
