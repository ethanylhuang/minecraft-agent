import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { verifyM1BenchmarkSummary } from "./m1Verifier.js";

const summaryPath = process.argv[2];
if (!summaryPath) {
  throw new Error("Usage: npm run verify:m1 -- <runs/*_m1_benchmark_summary.json>");
}

const absoluteSummaryPath = resolve(summaryPath);
const summary = JSON.parse(await readFile(absoluteSummaryPath, "utf8"));
const summaryDir = dirname(absoluteSummaryPath);
const result = verifyM1BenchmarkSummary(summary, (logPath) => {
  const resolved = resolve(summaryDir, "..", logPath);
  return JSON.parse(readFileSync(resolved, "utf8"));
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
