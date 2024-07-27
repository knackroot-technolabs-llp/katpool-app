import type { WorkerStats } from './sharesManager'; // Import WorkerStats

export function stringifyHashrate(ghs: number): string {
  const unitStrings = ["M", "G", "T", "P", "E", "Z", "Y"];
  let unit = unitStrings[0];
  let hr = ghs * 1000; // Default to MH/s

  for (const u of unitStrings) {
    if (hr < 1000) {
      unit = u;
      break;
    }
    hr /= 1000;
  }

  return `${hr.toFixed(2)}${unit}H/s`;
}

export function getAverageHashrateGHs(stats: WorkerStats): number {
  const elapsedSeconds = (Date.now() - stats.startTime) / 1000;
  return (stats.minDiff * stats.varDiffSharesFound) / elapsedSeconds;
}
