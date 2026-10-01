<!--
SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Models and routing

Hermes sends every model call to Switchyard as the route `market-research`. `SWITCHYARD_ROUTES` in `.env`
picks how Switchyard serves that route, and `AGENT_*_MODEL` pick the models. How the templates, the judge and
the latch work is in [`infra/switchyard/README.md`](../infra/switchyard/README.md). This page records which
combination is the default and why.

## Recommendation

**On build.nvidia.com (the default), Nemotron 3 Ultra alone: `SWITCHYARD_ROUTES=passthrough.nemotron`**, with
`nvidia/nemotron-3-ultra-550b-a55b` as the efficient model and Nemotron 3 Super (thinking off) for Hermes'
auxiliary and fallback calls. `.env.example` ships this. build.nvidia.com serves no GPT model, so the choice
there is between Ultra alone and the all-Nemotron escalation (Super answers, Ultra takes over). In the
2026-09-30 bake-off (17 questions over both packs, two runs each), Ultra alone passed 13 of 34 runs and
Super → Ultra 12. Super → Ultra was also twice as slow at the median (140 s against 72 s), failed 4 jobs
against none, and left 6 of its 30 reports without a citation (Ultra alone: 4 of 34).

**With a provider that serves GPT-6 Sol, pin it: `SWITCHYARD_ROUTES=pinned-capable.nemotron-gpt`**, with
`CAPABLE_BASE_URL` and `CAPABLE_API_KEY` pointed at that provider ([configuration](configuration.md#1-inference-endpoint)).
Sol pinned passed 24 of 34 runs, Ultra escalating to Sol 20, and Ultra alone 13. Sol was also the fastest
of the three at the median (60 s), but its p95 was the worst (617 s): a model stream sometimes ended early and
Hermes noticed only 5 to 10 minutes later ([limits](#limits-of-this-bake-off)).

**Ultra → Sol escalation is not the default.** The tuned judge escalates less often and more usefully than
before (10 of 34 runs; 7 of the 10 passed, 5 of them on questions Ultra alone did not pass both times), but
it still trails Sol pinned by 4 runs, and it saves less than it seems: once a run escalates it stays on Sol,
so Sol still served 93 of its 186 agent turns (Sol pinned: 219), and every turn before the switch also costs a
judge call.

**What to use where:**

| Situation | `SWITCHYARD_ROUTES` and models | Passed (of 34) |
|---|---|---|
| build.nvidia.com (default) | `passthrough.nemotron`, efficient Nemotron 3 Ultra (`nvidia/nemotron-3-ultra-550b-a55b`) | A0: 13 |
| GPT-6 Sol from any OpenAI-compatible provider | `pinned-capable.nemotron-gpt`, capable GPT-6 Sol on `CAPABLE_BASE_URL` | A1: 24 |
| Ultra escalating to GPT-6 Sol | `escalation.nemotron-gpt`, the same capable settings | A2: 20 |
| All-Nemotron escalation on build.nvidia.com | `escalation.nemotron`: Super → Ultra, 3.5 Lightning judge (the commented block in `.env.example`) | A4: 12 |

Switching is an `.env` edit plus `./scripts/demo.sh restart switchyard`; the sandbox is not rebuilt.

**One OpenAI-compatible endpoint for every model.** If your organization runs an OpenAI-compatible gateway
that serves both Nemotron and GPT models, there are two ways to use it:
- *Only for the capable model* (as the bake-off did): keep `INFERENCE_BASE_URL` on build.nvidia.com and set
  `CAPABLE_BASE_URL` and `CAPABLE_API_KEY` to the gateway.
- *For every model*: set `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` to the gateway, leave `CAPABLE_*` empty,
  use the model ids its `GET /v1/models` lists, and give the retriever its own build.nvidia.com key
  (`RETRIEVER_API_KEY`).

Either way the gateway's URL and key live only in your `.env`, and `./scripts/demo.sh doctor --keys` checks
that every model id the template uses is listed.

### The default on build.nvidia.com

The replay bundle was recorded with the default on 2026-09-29: Ultra alone on build.nvidia.com, every
profile, on a Brev A100 VM. That was four `record` runs of the featured questions (three of all six, one of
two), unjudged, not a bake-off. What they showed:

- **Citation tokens.** Ultra there often writes `【evidence:<id>】` or `【hermes-receipt:<id>】` instead of
  `[evidence:<id>]`, or names the receipt in prose. Before the API accepted the bracketed forms, 4 of 5
  answers in the first run had no citations. In the committed bundle 4 of 5 are cited; the Event Reaction
  answer names its receipts in a prose "Sources" line, which does not count.
- **Event Reaction is unstable, as H1 was.** Of four attempts, two listed the eight planted events and their
  returns through Auto Ontology. One reached the Hermes run deadline after asking Auto Ontology to read a
  spilled-over tool result, and one reported the 2,000-issuer short-form news stream instead of the planted
  events, without the publication-session return.
- **Market Leaders** scanned from August 1 in every run: 21 sessions, not 20. The strongest and weakest
  assets match the oracle (Aether, Cascade), but Aether's +0.21% is not the oracle's 20-session −0.94%.
- **Large-Universe Scan** names the oracle's strongest and weakest issuers but misreads the unit: the tool's
  returns are fractions (4.19 is +419%), which the committed answer labels "×" and another run showed as
  "+4.191 %".
- **Cybersecurity Rules** made one retrieval and covers Regulation S-K Item 106 only. It does not mention
  Form 8-K Item 1.05, which the earlier recording with GPT-6 Sol did.
- The anomaly and Galena answers matched their receipts in every run. Auto Ontology took 68 to 186 s per
  query with Super and 3.5 Lightning on build.nvidia.com, and 332 s on each unanswerable request.

### Tuning Ultra for the current packs

On 2026-09-30 the featured questions of both packs ran with Ultra alone on build.nvidia.com, on the Brev
A100 VM, before and after tuning: 14 runs before (one failed), 30 after, unjudged. What they showed, and what changed:

| Gap | Cause | Change | After |
|---|---|---|---|
| A job failed after 5 minutes of "Service temporarily overloaded" | build.nvidia.com sends the error inside an HTTP 200 stream, and Switchyard 0.3.0 passes it through | Hermes falls back to `market-research-fallback` (Super) after two failed tries ([how](../infra/switchyard/README.md#routes)) | A simulated overload finished on Super in 15 s |
| Universes the pack does not have (`top_50` on `synthetic-market`), or `all_assets` and Auto Ontology detours on `us-equities` | Hermes lists the tools once, when the sandbox starts, and a `DATA_PACK` switch kept the sandbox, so the model saw the previous pack's universes | A pack switch recreates the sandbox ([OpenShell](openshell.md)) | No invalid universe on a fresh sandbox |
| "The 20 sessions ending August 31" scanned from August 3: 21 sessions instead of 20 | The model does not count trading days, even with a worked example | `market_scan` takes `sessions=20` with `end` | Both packs' Market Leaders match their oracles |
| Anomaly deviations shown as percentages | Nothing said they are robust z-scores | The tool description and the result's limitation say so | No later run showed them as percentages |
| A ranking sent to Auto Ontology, which returned dollar price changes as "returns" | The routing table did not say where leaders and laggards go | `SOUL.md` sends rankings over any window to the market tools | Moves and Filings matches its oracle |
| Receipts named in prose ("evidence `hermes-receipt:<id>`") instead of cited | Ultra rarely writes the `[evidence:<id>]` token as instructed | The API counts a receipt id in code or bold as a citation | 20 of 30 answers were cited before this change; 27 of 30 would have been |

Ultra loaded no skill in any of these runs, although `SOUL.md` asks it to before a tool's first call. Guidance
that must reach it therefore lives in `SOUL.md` and the tool descriptions, not only in the skills.

Still open:
- **Form 8-K Item 1.05** searches 7 to 12 times for the four-business-day deadline, which the eCFR sections in
  the corpus do not state, then says so. A "search each topic once" line in the tool description did not
  change it.
- Ultra reads "which had the strongest and weakest returns" as one of each.
- Scope slips vary by run, for example news for every issuer instead of the 12 most liquid.

The escalation judge's prompt now escalates only for a failure it can name: a stuck or invalid tool loop, an
error used as data, or a report with a missing citation, a wrong window or unit, an unanswered part, a
contradiction or no evidence. The bake-off below measures it ([the tuned judge](#the-tuned-judge-measured)).

## Models and ids

| Role | Model | build.nvidia.com id (`https://integrate.api.nvidia.com/v1`) |
|---|---|---|
| Efficient (default: every turn) | Nemotron 3 Ultra 550B-A55B | `nvidia/nemotron-3-ultra-550b-a55b` |
| Judge and auxiliary calls, thinking off | Nemotron 3 Super 120B-A12B | `nvidia/nemotron-3-super-120b-a12b` |
| Capable (escalation and pinned templates) | GPT-6 Sol, over the Responses API | not served; the id your provider lists, e.g. `gpt-6-sol` |
| Judge for the all-Nemotron escalation | Nemotron 3.5 Lightning 30B-A3B | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Candidate efficient model | Nemotron 3.5 Super | to be evaluated once it is served publicly |

On any other OpenAI-compatible endpoint, use the ids its `GET /v1/models` lists; `./scripts/demo.sh doctor
--keys` checks every id the template uses. Retrieval always uses the retriever endpoint (build.nvidia.com):
`nvidia/nemotron-3-embed-1b` and `nvidia/llama-nemotron-rerank-vl-1b-v2`.

## How the bake-off was run

**When and where.** 2026-09-30, after the tuning above, on a Brev VM with one A100 (40 GB) and every profile
(`core,retrieval,analytics-gpu,kumo,ontology`: the GPU market tools, the local Kumo NIM and Auto Ontology),
OpenShell 0.1.2, Hermes v2026.9.24 and Switchyard 0.3.0. First `synthetic-market`, then `us-equities`, each
with a sandbox started for that pack.

**Endpoints.** The Nemotron arms ran on build.nvidia.com, as the default does. GPT-6 Sol came from an
OpenAI-compatible gateway through `CAPABLE_BASE_URL` and `CAPABLE_API_KEY`, while the Nemotron side of those
arms stayed on build.nvidia.com.

**Arms.** Models: Ultra is Nemotron 3 Ultra 550B-A55B, Sol is GPT-6 Sol, Super is Nemotron 3 Super
120B-A12B, and Lightning is Nemotron 3.5 Lightning 30B-A3B.
Every arm used `SWITCHYARD_CONFIRMATIONS=1`.

| Arm | `SWITCHYARD_ROUTES` | Efficient | Capable | Judge and auxiliary calls | Endpoints |
|---|---|---|---|---|---|
| A0 Ultra alone | `passthrough.nemotron` | Ultra | – | Super (auxiliary only) | build.nvidia.com |
| A1 Sol pinned | `pinned-capable.nemotron-gpt` | – | Sol | Super (auxiliary only) | Sol on the gateway, Super on build.nvidia.com |
| A2 Ultra → Sol | `escalation.nemotron-gpt` | Ultra | Sol | Super, with the tuned judge prompt | Sol on the gateway, the rest on build.nvidia.com |
| A4 Super → Ultra | `escalation.nemotron` | Super | Ultra | Lightning, with the tuned judge prompt | build.nvidia.com |

**Questions.** Each pack's six featured questions plus `outcome-prediction` and `large-universe-scan`, and on
`synthetic-market` also `story-event-context` ([data packs](data-packs.md)): 9 and 8 questions, each sent
with its own `sources`, as the UI's cards send them. Every question ran twice per arm: pass 1 in the order
A0, A1, A2, A4 and pass 2 in reverse, so a busy hour on an endpoint does not land on one arm. That is
17 questions × 4 arms × 2 = 136 runs, one at a time.

**Procedure.**
1. Point `.env` at the arm (the table above) and run `./scripts/demo.sh restart switchyard`. That re-renders
   the routes, clears latches and `/v1/stats`, and refreshes the API's model ids. The sandbox is untouched.
2. Submit each question through `POST /v1/jobs/async/submit` and wait for it to finish. Every job is a fresh
   Hermes session, so every question starts on the efficient model.
3. Save the job's export (`GET /v1/jobs/async/job/{id}/export`: report, `execution.v2` events, receipts) and
   Switchyard's per-session stats (`GET /v1/routing/session-stats?session_id=<job id>`, which include the
   judge's calls).
4. Score every run: a deterministic check and an LLM judge (below).

**Deterministic checks.** The reference values come from each pack's `eval/oracles/`, computed read-only
against the active DuckDB. Every check also needs the job to succeed, the question's tool to be called, and
at least one citation. These runs predate the change that measures a window's return from the close before
it: then `market_scan`, `price_context` and the oracles all started from the window's first close, so the
checks compared like with like. With the change, the oracles' strongest and weakest stay the same for
`synthetic-market`'s Market Leaders and both packs' Large-Universe Scan; on `us-equities`, Market Leaders'
weakest is BABA instead of CRWV, and February's weakest three are BMNR, IBM and CRWD instead of IBM, AMD
and BMNR.

| Question | Check |
|---|---|
| `market-leaders` | names the oracle's strongest and weakest; the strongest's return matches within display rounding |
| `news-sentiment-reaction` | gives the oracle's mean five-session return for each sentiment label (12 most liquid issuers); addresses causation |
| `unusual-sessions` | says the scores are neither forecasts nor explanations |
| `peer-network` | names the oracle's most correlated declared-peer pair |
| `cyber-disclosure-rules` | cites Form 8-K Item 1.05, gives the four-business-day deadline or says the corpus does not state it, and names a company whose 8-K in the corpus reports Item 1.05 |
| `news-and-filings` | names the issuer with the most negative news; retrieved from the SEC filings |
| `moves-and-filings` | names the oracle's three strongest and three weakest stocks of February; retrieved from the SEC filings |
| `story-event-context` | names at least 10 of the 12 story issuers; at least 90% of its percentages match a receipt |
| `outcome-prediction` | names the model's top three, its top stock first |
| `large-universe-scan` | names the oracle's strongest and weakest |
| `intraday-ranges` | names the stock with the widest range |

**The answer judge.** GPT-6 Sol on the gateway (Responses API, `reasoning.effort = "medium"`,
`store = false`, JSON-schema output), three independent samples per run, majority vote. It sees whether the
pack is synthetic or real, the question, short reference facts written from the oracles and the pack, a
digest of the run's receipts (each capped at 40,000 characters) and the report. It never sees the arm or the
model. System prompt, verbatim:

```text
You grade reports written by a financial market-research agent in a software demo. The agent answers one analyst question by calling read-only tools (market analytics over a market dataset, a Kumo prediction model, Auto Ontology over the same database, and retrieval over real SEC filings and eCFR Title 17) and then writes a cited report. The DATASET line says whether the market dataset is synthetic (fictional issuers) or real; the filings and regulations are always real.

You receive the question, reference facts written by the evaluator, a digest of the tool evidence the agent actually received, and the agent's final report. Grade against the evidence and the reference facts, not your own knowledge. Do not penalize the report for omitting something the evidence does not contain, but do penalize any claim, number, date or entity that the evidence does not support. The tools return returns and volatilities as fractions (0.22 is 22%) and anomaly deviations as robust z-scores: a fraction shown as a percentage without scaling, or a z-score shown as a percentage, is a wrong number. The evidence is the receipt the agent's tools recorded: retrieved passages are cut at 1,500 characters there, while the agent read them in full. A detail attributed to a retrieved document whose snippet is cut off is unverifiable rather than fabricated: lower grounding by at most one point for it. Fail a report for claims the evidence contradicts or that no evidence could plausibly support.

Score each criterion from 1 (very poor) to 5 (excellent):
- correctness: agrees with the reference facts and the evidence; numbers, windows, units and rankings are right.
- grounding: every factual claim is traceable to the evidence; fabrication scores 1.
- completeness: answers every part of the question that the evidence can support.
- honesty: states real limits (missing data, truncated results, synthetic data, no causality or forecasting where relevant) without refusing what the evidence supports.
Then give overall (1-5) and pass: true only if you would show this report to a customer at a product demo (no fabricated facts, the main parts of the question answered or honestly declared unavailable).
```

**Metrics.**
- *Pass*: the deterministic check passes **and** at least two of the three judge samples say pass.
- *Judge mean*: the mean of the samples' overall score (1–5).
- *Grounded %*: the share of percentages in the report that match a number in the run's receipts, as given
  or × 100, within display rounding.
- *Tool calls, errors, duplicates*: calls that reported an error or produced a failed receipt; duplicates
  repeat the same tool with the same arguments.
- *Escalated*: any agent turn was served by the capable model. A *false latch* is an escalated run of a
  question that Ultra alone (A0) passed both times; a *rescue* is an escalated run that passed on a question
  A0 did not pass both times.
- *Fallback turns*: agent turns served by `market-research-fallback` after the agent's model was overloaded.
- *Latency*: submit to completion, as the API records it (one job at a time, so no queueing).

## Results

| Arm | Pass | synthetic | us-equities | Deterministic | Judge pass | Judge mean | Grounded % | Tool calls / errors / duplicates | Escalated | False latch | Rescue | p50 s | p95 s | Failed jobs | Median input tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A0 Ultra alone | 13/34 | 7/18 | 6/16 | 28/34 | 16/34 | 3.31 | 97 | 108 / 5 / 0 | – | – | – | 72 | 329 | 0 | 29,841 |
| **A1 Sol pinned** | **24/34** | **13/18** | **11/16** | 25/34 | **28/34** | **3.93** | 97 | 260 / 12 / 96 | – | – | – | **60** | 617 | 4 | 25,404 |
| A2 Ultra → Sol | 20/34 | 11/18 | 9/16 | 24/34 | 23/34 | 3.68 | 97 | 180 / 5 / 55 | 10/34 | 2 | 5 | 80 | 409 | 1 | 35,222 |
| A4 Super → Ultra | 12/34 | 8/18 | 4/16 | 23/34 | 13/34 | 2.85 | 100 | 95 / 4 / 0 | 18/34 | 2 | 6 | 140 | 489 | 4 | 28,442 |

Served models (agent turns over the arm's 34 runs; Switchyard's upstream calls add the judge's):

| Arm | Agent turns served by | Upstream calls, judge included | Latch turn (escalated runs) |
|---|---|---|---|
| A0 | Ultra 145, Super 2 (fallback) | Ultra 145, Super 2 | – |
| A1 | Sol 219 | Sol 219, Super 1 | – |
| A2 | Ultra 91, Sol 93, Super 2 (fallback) | Super 100, Sol 93, Ultra 91 | turn 1 in 5 runs, 2 in 1, 3 in 2, 6 in 1, 7 in 1 |
| A4 | Ultra 64, Super 41, Lightning 16 (fallback) | Lightning 77, Ultra 64, Super 41 | turn 0 in 8 runs, 1 in 5, 2 in 5 |

Per question, one letter per run: `P` pass, `f` fail, `d` the deterministic check failed, `*` escalated,
`~` at least one turn on the fallback route.

| Pack | Question | A0 | A1 | A2 | A4 |
|---|---|---|---|---|---|
| synthetic | market-leaders | P~ P | P P | P P | fd~ P |
| synthetic | news-sentiment-reaction | fd fd | fd P | fd P* | fd* fd |
| synthetic | unusual-sessions | fd P | P P | fd P | fd* f* |
| synthetic | peer-network | P P | P P | P P | P P* |
| synthetic | cyber-disclosure-rules | f~ f | fd P | fd* P* | f* P* |
| synthetic | news-and-filings | f f | fd P | fd* fd~ | fd~ P* |
| synthetic | story-event-context | fd f | fd P | fd fd | f* fd |
| synthetic | outcome-prediction | f P | P P | P P | f* P |
| synthetic | large-universe-scan | f P | fd P | P P | P P |
| us | market-leaders | fd P | fd P | P P | fd~ fd~ |
| us | intraday-ranges | f P | P P | f f | fd P* |
| us | unusual-sessions | fd f | P P | P* P* | P* P* |
| us | peer-network | f f | f fd | fd P | fd P* |
| us | cyber-disclosure-rules | f f | fd P | fd* P* | fd f~ |
| us | moves-and-filings | P P | fd P | P* P* | f* f |
| us | outcome-prediction | f P | P P | f f | f* f* |
| us | large-universe-scan | f P | P P | fd P | f* f* |

What the numbers show:
- **Sol pinned is still the strongest arm**, as on 2026-09-29, and the margin held on both packs. Its
  failures were mostly bugs, not the model: of its 4 failed jobs, one ran out of tool calls because
  `market_scan` ignored `start` when `sessions` was also given, two lost a receipt to an Auto Ontology phrase
  longer than the receipt allows, and one waited on a stalled stream. Both bugs are fixed. The same
  `market_scan` bug is behind 87 of its 96 duplicate calls.
- **Ultra alone is the better build.nvidia.com choice.** It never failed a job, and its misses are in the
  report, not the tools: 4 of 34 reports had no citation, and the judge failed most of the rest for a wrong
  scope, window or claim, for example calling a strongly negative correlation a pair that "moved together".
- **Super → Ultra is slower and less reliable than Ultra alone.** Its judge escalated 18 of 34 runs, 8 of
  them at the first turn, so it mostly runs Ultra with extra calls; 6 of its 30 reports had no citation. Its
  fallback route serves 3.5 Lightning, and 2 of its 4 failed jobs ended on HTTP 404 errors from its model
  calls during a nine-minute burst.
- **Two questions were held back by the tools in every arm**, and both are fixed since ([after the
  fixes](#after-the-tool-fixes)). The news tools had no universe filter, so `news-sentiment-reaction` got all
  545 news items instead of the 12 most liquid issuers' 13; only three runs on Sol answered or flagged it
  correctly. The relationship tool did not say that its graph links declared same-industry peers or that a
  negative correlation means opposite moves, so on `us-equities` most reports called it a whole-market graph
  or listed an opposite-moving pair among those that "moved together".

### The tuned judge, measured

The tuned judge prompt ([above](#tuning-ultra-for-the-current-packs)) against the 2026-09-29 one (on the
retired `market-analysis` pack, one run per question), in A2:

| | 2026-09-29 | 2026-09-30, tuned |
|---|---|---|
| Runs escalated | 6 of 12 (50%) | 10 of 34 (29%) |
| Escalated runs that passed | 5 of 6 | 7 of 10 |
| Rescues | 2 | 5 |
| False latches, of A2's runs on questions A0 always passed | 3 of 6 (50%) | 2 of 6 (33%) |
| A2 passes against A1's | 6 against 11 | 20 against 24 |

The tuned prompt is more selective, and most of its escalations are worth it. It still escalates late in some
runs (turns 6 and 7, after Ultra had already searched or scanned several times), and 11 of the 24 runs it left
on Ultra still failed, mostly for report-level faults (a scope, a window, a misread number) that the judge,
which sees each message cut to 900 characters, rarely catches. The rule set before the first bake-off was to
adopt escalation only if it passes within one question of Sol pinned with false latches at 10% or less; it
meets neither.

### After the tool fixes

The news-universe, `market_scan` window and relationship-description fixes reached the box after the
bake-off. The two questions they change then ran twice more on the two build.nvidia.com arms, graded the same
way (the tables above keep the bake-off's own runs):

| Pack | Question | A0 Ultra alone | A4 Super → Ultra |
|---|---|---|---|
| synthetic | news-sentiment-reaction | P P (was fd fd) | fd~ P* (was fd* fd) |
| synthetic | peer-network | P P (was P P) | P* P (was P P*) |
| us | peer-network | fd P (was f f) | P* P* (was fd P*) |

Each arm passed 5 of 6. Ultra's miss had no citation; Super → Ultra's was an overloaded turn that fell back
to Lightning, which replied with a plan instead of calling the tool. The other news runs reported the 12
issuers' 13 news items, and every `us-equities` report said the graph links declared peers and kept the
opposite-moving pair apart from the pairs that moved together.

### Limits of this bake-off

- **Two runs per question.** A one-run difference on a question is noise: A0 passed 7 of its 17 questions
  once and failed them once. Across 34 runs the gaps between A1, A2 and A0 (24, 20, 13) are larger than that.
- **Sol judged Sol.** The judge is the A1 model. It was blind to the arm, graded against reference facts and
  the receipts, and voted over three samples, but self-preference cannot be ruled out. The deterministic
  checks do not favour Sol (A0 28/34, A1 25/34); the gap comes from the judge.
- **Receipts, not full passages.** The judge read the receipts, which cut retrieved passages at 1,500
  characters, and it was told so.
- **Receipts, not tool descriptions.** The judge never sees what the tools tell the model. On `peer-network`
  it first counted "PageRank" and "daily-return correlations", which the relationship tool's description
  states, as unsupported, in every arm. That question's reference facts now quote the description, and its runs were
  graded again; the tables use the second grades, which added 2 passes to A2 and 1 to A4.
- **Stalled streams.** Model streams sometimes ended early, from the gateway's Sol and from build.nvidia.com's
  Nemotron models alike. Switchyard logged the early end within a second, but in at least four runs Hermes,
  behind the OpenShell proxy, saw the connection close only 5 to 10 minutes later and retried (three on Sol in
  A1, one on Lightning in A4). This inflates the p95 of the affected arms more than their pass rates.
- **Endpoint load.** build.nvidia.com answered with "Service temporarily overloaded" often enough that A0,
  A2 and A4 served 20 turns on their fallback route. During A4's second pass, Switchyard's model calls failed
  with HTTP 404 for nine minutes.
- **Fixes during the run.** The receipt fix reached the box between the two packs, and the news-universe,
  `market_scan` window and relationship-graph fixes only after the run ([after the tool
  fixes](#after-the-tool-fixes)).

## The earlier bake-off (2026-09-29)

The first bake-off ran on the retired `market-analysis` pack: its seven hero questions (H1 to H7) and five
more, once per arm, on the same kind of gateway for every model, with the stack on a laptop and Auto
Ontology off. Sol pinned passed 11 of 12; Ultra alone and Ultra → Sol 6 each (the old judge latched falsely on
half of Ultra's passes); Ultra → Sol with two confirmations 6; and Super → Ultra 3. Those results set today's defaults, and the 2026-09-30 bake-off confirms them.

## Repeating the bake-off

Repeat it when a model id, a template, the judge prompt or the endpoint's model set changes.

1. `./scripts/demo.sh up` with the profiles to measure, then `./scripts/demo.sh check`.
2. For each arm: set the arm's lines in `.env` (table above), run `./scripts/demo.sh restart switchyard`, and
   confirm the rendered line in `./scripts/demo.sh logs switchyard` (`switchyard: <template> on <endpoint> …`).
3. Submit each question one at a time through the API (`POST /v1/jobs/async/submit`, with the question's
   `sources` from `questions.yaml` as `data_sources`), wait for it to finish, and save
   `GET /v1/jobs/async/job/{id}/export` and `GET 127.0.0.1:4000/v1/routing/session-stats?session_id={id}`.
4. Run every arm twice, the second pass in reverse arm order.
5. Score each run with the checks and the judge prompt above, and fill in the tables.
6. Put `.env` back on the winner and restart Switchyard.

The bake-off took about 8 hours, one run at a time; the Sol arms' stalls and build.nvidia.com's overloads took
a large share of it.
