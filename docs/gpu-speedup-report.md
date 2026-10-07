<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# GPU speedup report: why the recordings showed none, and what changed

Measured on 2026-10-06 and 2026-10-07 on the two deployments, with the stack's own `POST /benchmark` (matched CPU/GPU
pairs on the tools' compute timers) and with the Benchmark tab's own comparison in freshly recorded sessions.

## Summary

- Of the 47 market stages in the `us-equities` recordings of 2026-10-01, **3 showed a speedup** (all minute-bar scans over
  the 50 most liquid stocks). Now **23 of the 25 market stages in the bundle qualify** (recorded on the A100 box; only the
  two peer-graph stages do not). The same questions asked live on the B200 box qualify in **19 of 21 stages**; the two
  that do not are anomaly scans.
- There were three causes, and none was a broken GPU: the questions asked small calls (the CPU wins below a few hundred
  thousand rows); the Benchmark tab's parity check called a scan of more than one batch a mismatch, so large scans could
  never qualify; and its 20 s budget stopped slow calls after two pairs, short of the five a claim needs.
- Two shapes still cannot show a reliable speedup: the peer-network graph (a fixed small graph, 0.7x to 1.2x) and the
  anomaly scan over a liquid universe (1.0x to 1.4x; below 1x on the B200 host's faster CPU on some pairs).

## Why a stage showed no speedup

A stage claims a speedup only when the payloads match, at least 5 pairs ran inside the budget, and the GPU was faster in
**every** pair (`api/src/demo_api/benchmark/runner.py`).

| Cause | Effect | Fix |
|---|---|---|
| Questions over the 50 most liquid stocks, and `price_context` for named stocks | 22 to 43 ms of work on the CPU; each GPU operation has a fixed cost of 25 to 60 ms here, so the CPU wins (0.4x to 0.9x) | Daily questions use the 1,000 most liquid stocks over 2025 and later; minute-bar questions the 50 or 500 most liquid; no question calls `price_context` |
| `payload.batches` compared between engines | The CPU reads minute bars in 256 MiB batches and the GPU in 1 GiB, so any scan of more than one batch (500 stocks and up) reported a false mismatch and could never qualify | `EXECUTION_FIELDS` in `tools/market-analytics/src/market_analytics/benchmark.py`; test added |
| `benchmark_budget_seconds` of 20 | A 500-stock minute-bar scan takes about 10 s on the CPU, so only 2 pairs ran | Default 90 s (5 pairs take about 55 s); the guard's default matches |
| One lost pair hides the claim | A median of 1.03x with 3 of 5 pairs won shows nothing | Unchanged (the rule is deliberate); questions now give the GPU more than a hair of margin |

## The two hosts differ

| | Brev | TME |
|---|---|---|
| GPU | A100 40 GB, driver 595, persistence mode on | B200 183 GB, driver 610.57, persistence mode off |
| CPU | Xeon 2.2 GHz, 12 vCPUs | Granite Rapids, 16 vCPUs |
| A 50-stock `market_scan` (CPU / GPU) | 23 / 28 ms | 9 / 17 ms |
| A 1,000-stock `market_scan` over 2025 (CPU / GPU) | 65 / 30 ms | 30 / 17 ms |

TME's CPU is about 2.5x faster, so every daily margin is smaller there. The GPU's fixed cost is lower, but not by enough.
Its NVIDIA persistence mode is off (`nvidia-smi -pm 1` would enable it; nothing was changed on the host). The numbers below
are medians of repeated `POST /benchmark` runs (5 pairs each, 2 to 3 runs); "wins" is the pairs the GPU won.

| Call shape | Brev A100 | TME B200 |
|---|---|---|
| `market_scan`, 50 most liquid, any window | 0.80x to 0.90x (0 of 5) | 0.52x to 0.60x (0 of 5) |
| `market_anomaly_scan`, 50 most liquid | 0.68x to 0.72x | 0.53x |
| `market_scan`, 500 most liquid | 1.25x to 1.57x (5 of 5) | 0.92x to 1.30x (1 to 5 of 5) |
| `market_anomaly_scan`, 500 most liquid | 1.00x to 1.02x | 0.91x to 0.93x (0 of 5) |
| **`market_scan`, 1,000 most liquid** | **2.1x to 2.3x (5 of 5)** | **1.6x to 1.9x (5 of 5)** |
| `market_anomaly_scan`, 1,000 most liquid | 1.0x to 1.4x (5 of 5) | 1.0x to 1.1x (3 to 4 of 5) |
| `market_scan`, every stock, 2025 and later | 2.5x to 2.9x (5 of 5) | 2.2x to 2.5x (5 of 5) |
| `market_scan`, every stock, 20 sessions | 1.4x to 1.5x | 1.1x to 1.2x (lost pairs) |
| `market_anomaly_scan`, every stock | 1.5x to 2.1x | 1.1x to 2.0x (lost pairs) |
| `intraday_scan`, 50 most liquid | 3.8x to 4.2x | 3.4x |
| **`intraday_scan`, 500 most liquid** | **8.3x to 9.2x** | **8.0x to 8.9x** |

## Before and after, by session

Recorded Benchmark results: before is the 2026-10-01 bundle on the A100; after is the freshly recorded sessions on each
box. Bold is a stage that claims a speedup. Rows marked † were not re-recorded: both columns show the 2026-10-01
A100 recording.

| Session | Shape | Before (A100) | After, Brev A100 | After, TME B200 |
|---|---|---|---|---|
| `market-leaders` featured | scan x2, 1,000 most liquid, 2025-01-02 to 2026-03-12 | 0.46x, 0.46x | **2.2x**, **2.3x** | **2.0x**, **1.8x** |
| `unusual-sessions` featured | anomaly, 1,000 most liquid, July 2025 to January 2026 | 0.59x | **1.2x** | 1.03x, no claim |
| `intraday-ranges` featured † | minute bars, 50 most liquid | **4.1x** | **4.1x** | **4.1x** |
| `intraday-drawdowns` featured | minute bars, 500 most liquid | **4.2x** (50 stocks) | **9.0x** | **8.7x** |
| `moves-and-filings` featured | minute bars, 50 most liquid, x2, plus filings | 0.82x, 0.80x | **4.2x**, **4.1x** | **4.1x**, **4.0x** |
| `large-universe-scan` | scan x2, 1,000 most liquid | 0.54x, 0.55x | **2.2x**, **2.2x** | **2.1x**, **2.0x** |
| `volatility-ranking` | scan x2, 1,000 most liquid | 0.41x, 0.41x | **2.2x**, **2.1x** | **2.0x**, **1.9x** |
| `peer-relative-returns` | scan x2, 1,000 most liquid | 0.46x, 0.49x | **2.1x**, **2.1x** | **2.0x**, **1.8x** |
| `calendar-2025` (was `second-half-2025`) | scan x2, 1,000 most liquid | 0.68x, 0.69x | **2.3x**, **2.3x** | **1.9x**, **1.9x** |
| `heaviest-sessions` † | minute bars, 50 most liquid | **3.9x** | **3.9x** | **3.9x** |
| `leaders-unusual-sessions` conversation | scan x2, then anomaly | 0.47x, 0.44x, 0.59x, 0.54x | **2.1x**, **2.4x**, **1.2x** | **1.6x**, **1.8x**, 1.10x no claim |
| `laggards-follow-up` (was `april-2025-follow-up`) | scan x2, 1,000 most liquid | 0.44x, 0.88x | **2.1x**, **2.1x** | **1.8x**, **1.7x** |
| `intraday-volatility-follow-up` | minute bars, 500 most liquid, x2 | 0.63x, 0.62x | **10.8x**, **11.0x** | **9.9x**, **11.8x** |
| `peer-network`, `central-industries` † | relationship graph (fixed) | 0.83x, 0.78x | 0.83x, 0.78x | 0.83x, 0.78x |

Across the whole bundle, by tool (before, 2026-10-01 | after, this branch):

| Tool | Stages that claim a speedup, before | after | Median CPU/GPU ratios, after |
|---|---|---|---|
| `market_scan` | 0 of 16 | 14 of 14 | 2.08x to 2.40x |
| `intraday_scan` | 3 of 5 | 7 of 7 | 3.87x to 10.98x |
| `market_anomaly_scan` | 0 of 5 | 2 of 2 (A100) | 1.18x to 1.23x |
| `price_context` | 0 of 17 | no stage | the tool is no longer called by any question |
| `analyze_market_relationships` | 0 of 4 | 0 of 2 | 0.78x to 0.83x |

## Decisions and their cost

- **Why not every stock?** Every-stock scans win by more (2.3x to 2.9x), but they rank micro-caps: BVC (+7,414%, liquidity
  rank 1,557) and CUEN lead the returns, daily moves reach 262x below rank 1,300, and BVC alone filled all ten places of an
  every-stock anomaly scan that was recorded. `liquid_1000` (a new universe in `pack.yaml`) drops the worst of that and keeps
  a margin on both hosts.
- **Corporate-action artifacts.** ASST's split adjustment (2026-02-05) and AZN's listing change (2026-02-02) fill any
  scan of February 2026 over a universe that holds them, so the anomaly question scores July 2025 to January 30, 2026 and
  the volatility ranking ends on that date.
- **Anomaly scan.** Over a liquid universe its GPU time (about 100 ms) is mostly host-side NumPy and cuml.accel call
  overhead against a CPU time of about 115 ms. It qualified on the A100 recordings (1.2x) and not on TME's (1.03x). It stays
  featured with that honest result; a real fix is engineering on the GPU path (see below).
- **Peer network.** The graph tool cannot be limited or enlarged, so no question wording changes its 0.8x. It stays an
  example, no longer featured, with its stage shown without a claim.
- **Retired.** `nvidia-results-and-prices`, `bank-results` and the conversations `price-context-follow-up`,
  `mega-cap-follow-up`, `peer-network-follow-up`, `peer-links-follow-up`, `headlines-and-prices`, `incidents-and-prices`
  (single-stock `price_context` calls cannot win); `april-2025-anomalies`, `fourth-quarter-anomalies` (short scoring
  windows) and `prediction-follow-up` (a five-session window). The pack went from 30 questions and 15 conversations
  (45 sessions) to 26 and 8 (34 sessions).
- **Filings pairing.** `moves-and-filings` ranks minute-bar sessions of the 50 most liquid stocks, not an every-stock scan,
  because the filings corpus covers the 100 most liquid issuers.

## Validation

- Unit, UI, contracts and compose suites: `./scripts/demo.sh test` passes (every Python project, ruff, 735 UI tests).
- `./scripts/demo.sh test e2e`: 66 Playwright tests pass, including a replay of all 34 `us-equities` sessions.
- The GPU guard (`demo-eval perf`, market cases) on the running stacks: 12 passed, 0 failed on Brev and on TME.
- Answer-quality eval on Brev for the five questions whose oracles changed: `moves-and-filings`, `large-universe-scan`,
  `unusual-sessions` and `intraday-ranges` pass; `market-leaders` first failed two checks because of two defects in the
  checks, not the answer (the oracle read only 100 rows, so "the weakest" was the 100th-ranked of 1,000 stocks, and the
  percent matcher could not read "+3,653.4%"), and passes after both were fixed.
- One recording flake: the second turn of `laggards-follow-up` stopped on Hermes' idle budget twice on Brev, then
  recorded on the third attempt.

## Open items

1. **Anomaly scan on a fast CPU.** Profile `market_anomaly_scan` on the GPU engine and move more of it (the quantile, the
   medians for the robust z-scores) onto the GPU, or accept a thin result for `unusual-sessions`.
2. **TME persistence mode.** Enable it on the host (`sudo nvidia-smi -pm 1`) and re-measure: the first call after an idle
   period can pay driver initialization. Nothing was changed on the host.
3. **Hermes idle budget** on `laggards-follow-up` turn 2 (two failures in three attempts on Brev).
4. **Recordings come from the A100 box** to match `perf.yaml`'s recorded speedups. TME's own recordings were validation
   only and are not committed.

## Reproducing

```bash
./scripts/demo.sh test gpu --perf      # the guard's market cases on a running analytics-gpu stack
./scripts/demo.sh record --question market-leaders --question intraday-drawdowns
curl -s -X POST http://127.0.0.1:3010/benchmark -H 'content-type: application/json' \
  -d '{"tool":"market_scan","arguments":{"universe_id":"liquid_1000","start":"2025-01-02T00:00:00Z","end":"2026-03-12T23:59:59Z","metrics":["return","volatility","volume"],"limit":20},"pairs":5,"budget_seconds":90}'
```
