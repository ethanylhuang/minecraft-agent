# M1 Validation Checklist

This checklist separates local implementation checks from accepted benchmark evidence.

## Local Checks

Run these before any benchmark attempt:

```sh
npm install
npm test
npm run build
npm run smoke:early
```

For full primitive smoke validation, use a prepared survival world with nearby logs and stone:

```sh
npm run smoke
```

Smoke runs may use scripted fixture logic because they validate primitive tools, not accepted benchmark performance.

## Accepted Benchmark Evidence

Accepted M1 task-runner evidence must use a real LLM provider. Scripted providers, deterministic planners, and hard-coded policies do not count.

Run Gemma 4 31B first:

```sh
npm run benchmark:m1 -- \
  --provider gemini-compatible \
  --primary-model gemma-4-31b-it \
  --runs 3
```

The benchmark command enforces:

- at least 3 runs;
- task `early_sequence`;
- `allowScriptedFixtures=false`;
- non-scripted provider;
- Gemma 4 31B as the first configured model route;
- a documented Gemma failure evidence path before fallback-completed runs are accepted;
- every run must complete;
- every run log must mark `benchmarkEvidence.accepted=true`.

Fallback to Gemini 3.1 Flash, or the nearest available Gemini Flash-class model, only after Gemma failure evidence has been captured:

```sh
npm run benchmark:m1 -- \
  --provider gemini-compatible \
  --primary-model gemma-4-31b-it \
  --fallback-provider gemini-compatible \
  --fallback-model gemini-2.5-flash \
  --gemini-api-key <key> \
  --gemma-failure-evidence <path-to-gemma-failure-log-or-manifest> \
  --runs 3
```

## Required Artifacts

Keep the generated files under `runs/`:

- three `early_sequence` run logs;
- one `m1_benchmark_summary` log;
- any Gemma failure logs used to justify fallback.

Each run log must include observations, prompt references, raw provider outputs, validated tool calls, tool results, retry counts, active provider/model, fallback decision when used, elapsed time, final score, and benchmark evidence status.

Fallback evidence passed through `--gemma-failure-evidence` must be a JSON manifest with at least three failed Gemma 4 31B run logs and one or more repeatable failure reasons:

```json
{
  "primaryModel": "gemma-4-31b",
  "failedRuns": 3,
  "evidenceLogs": [
    "runs/gemma-failure-1.json",
    "runs/gemma-failure-2.json",
    "runs/gemma-failure-3.json"
  ],
  "repeatableFailures": ["invalid tool calls within retry budget"]
}
```
