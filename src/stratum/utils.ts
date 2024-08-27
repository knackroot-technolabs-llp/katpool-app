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
  const windowSize = 10 * 60 * 1000; // 10 minutes window
  const relevantShares: { timestamp: number, difficulty: number }[] = [];

  // Use Denque's toArray() method to filter relevant shares
  stats.recentShares.toArray().forEach(share => {
    if (Date.now() - share.timestamp <= windowSize) {
      relevantShares.push(share);
    }
  });

  if (relevantShares.length === 0) return 0;

  const avgDifficulty = relevantShares.reduce((acc, share) => acc + share.difficulty, 0) / relevantShares.length;
  const timeDifference = (Date.now() - relevantShares[0].timestamp) / 1000; // in seconds

  return (avgDifficulty * relevantShares.length) / timeDifference;
}