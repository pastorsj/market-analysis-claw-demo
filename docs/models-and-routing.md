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
auxiliary calls. `.env.example` ships this. build.nvidia.com serves no GPT model, so the choice there is
between Ultra alone and the all-Nemotron escalation (Super answers, Ultra takes over). In the bake-off below,
Ultra alone passed 6 of 12 questions and Super → Ultra passed 3.

**With a provider that serves GPT-6 Sol, pin it: `SWITCHYARD_ROUTES=pinned-capable.nemotron-gpt`**, with
`CAPABLE_BASE_URL` and `CAPABLE_API_KEY` pointed at that provider ([configuration](configuration.md#1-inference-endpoint)).
In the 2026-09-29 bake-off, Sol pinned passed 11 of 12 questions. Nemotron 3 Ultra alone passed 6, and Ultra
with escalation to Sol also passed 6. Sol pinned was also the fastest arm apart from Super (p50 33 s, p95
79 s), made the fewest tool calls (41 against Ultra's 63), and read about a third of Ultra's input tokens per
question (median 36k against 115k). It has no judge, so it also avoids escalation's failure mode: a failed
judge call fails the agent's turn.

Ultra → Sol escalation lost for three reasons:
- It fixed little. The judge escalated 6 of 12 runs and rescued 2 questions that Ultra failed (H4, H5). The
  runs that stayed on Ultra kept Ultra's failures (H3, H7, the anomaly and peer-network questions): Ultra
  mostly fails in how its final report reads the evidence, for example anomaly deviations reported as
  percentage returns, and the judge rarely flags that.
- It switched when it did not need to. Three escalations were on questions that Ultra alone passed, so it
  latched on 3 of Ultra's 6 passing questions: a 50% false-latch rate, against the 10% bar set before the
  bake-off. Each switch costs a discarded Ultra reply, on top of a judge call for every earlier turn.
- With two confirmations (A3) it escalated only twice, and it took twice as long at the median (66 s).

**What to use where:**

| Situation | `SWITCHYARD_ROUTES` and models |
|---|---|
| build.nvidia.com (default) | `passthrough.nemotron`, efficient Nemotron 3 Ultra (`nvidia/nemotron-3-ultra-550b-a55b`); A0 passed 6/12 |
| GPT-6 Sol from any OpenAI-compatible provider | `pinned-capable.nemotron-gpt`, capable GPT-6 Sol on `CAPABLE_BASE_URL`; A1 passed 11/12 |
| Ultra escalating to GPT-6 Sol | `escalation.nemotron-gpt`, the same capable settings; A2 passed 6/12 with a 50% false-latch rate |
| All-Nemotron escalation on build.nvidia.com | `escalation.nemotron`: Super → Ultra, 3.5 Lightning judge (the commented block in `.env.example`). A4 passed 3/12. Its judge escalated at the first turn in 7 of 10 escalations, so it behaves like Ultra with overhead |
| Nemotron 3.5 Super | not yet: the text preview passed 5/12 and made invalid tool calls (company names as asset ids, windows out of order) |

Switching is an `.env` edit plus `./scripts/demo.sh restart switchyard`; the sandbox is not rebuilt.

The bake-off ran on one OpenAI-compatible gateway that serves both Nemotron and GPT-6 models, not on
build.nvidia.com. The Nemotron models are the same, but the build.nvidia.com arms were not re-measured there.

### The default on build.nvidia.com

The replay bundle was recorded with the default on 2026-09-29: Ultra alone on build.nvidia.com, every
profile, on a Brev A100 VM. That was four `record` runs of the featured questions (three of all six, one of
two), unjudged, not a bake-off. What they showed:

- **Citation tokens.** Ultra there often writes `【evidence:<id>】` or `【hermes-receipt:<id>】` instead of
  `[evidence:<id>]`, or names the receipt in prose. Before the API accepted the bracketed forms, 4 of 5
  answers in the first run had no citations. In the committed bundle 5 of 6 are cited; the Event Reaction
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

## Models and ids

| Role | Model | build.nvidia.com id (`https://integrate.api.nvidia.com/v1`) |
|---|---|---|
| Efficient (default: every turn) | Nemotron 3 Ultra 550B-A55B | `nvidia/nemotron-3-ultra-550b-a55b` |
| Judge and auxiliary calls, thinking off | Nemotron 3 Super 120B-A12B | `nvidia/nemotron-3-super-120b-a12b` |
| Capable (escalation and pinned templates) | GPT-6 Sol, over the Responses API | not served; the id your provider lists, e.g. `gpt-6-sol` |
| Judge for the all-Nemotron escalation | Nemotron 3.5 Lightning 30B-A3B | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Later efficient model | Nemotron 3.5 Super | not served yet |

On any other OpenAI-compatible endpoint, use the ids its `GET /v1/models` lists; `./scripts/demo.sh doctor
--keys` checks every id the template uses. Retrieval always uses the retriever endpoint (build.nvidia.com):
`nvidia/nemotron-3-embed-1b` and `nvidia/llama-nemotron-rerank-vl-1b-v2`.

## How the bake-off was run

**When and where.** 2026-09-29, on an OpenAI-compatible gateway serving Nemotron and GPT-6 models, with the full
stack running locally on colima (arm64, 4 CPU, 9 GB): profiles `core,retrieval,analytics` plus the hosted
Kumo endpoint, the `market-analysis` pack at its default `qualification` profile, OpenShell 0.1.2, Hermes
v2026.9.24 and Switchyard 0.3.0. Auto Ontology was off, as it is by default, so `ask_question` was not
available and "company announcements" meant the pack's short-form `market_news` stream.

> **Note.** That pack has since been replaced by `synthetic-market` and `us-equities`, with new questions
> ([data packs](data-packs.md)); its fictional briefs are gone. The bake-off below describes it as it was and has
> not been re-run on the new packs.

**Procedure.**
1. Point `.env` at the arm (the table below) and run `./scripts/demo.sh restart switchyard`. That re-renders
   the routes, clears latches and `/v1/stats`, and refreshes the API's model ids. The sandbox is untouched.
2. Submit each question through `POST /v1/jobs/async/submit`, one at a time (the API runs one job at a
   time), and wait for it to finish. Every job is a fresh Hermes session, so every question starts on the
   efficient model.
3. Save the job's export (`GET /v1/jobs/async/job/{id}/export`: report, `execution.v2` events, receipts),
   Switchyard's per-session stats (`GET /v1/routing/session-stats?session_id=<job id>`, which include the
   judge's calls) and, per arm, `/v1/stats` and the `libsy.run` spans from Phoenix (escalation verdicts).
4. Score every run (below). One run per question and arm (k = 1): 12 questions × 6 arms = 72 runs.

**Arms.** All on that gateway. Models: Ultra is Nemotron 3 Ultra 550B-A55B, Sol is GPT-6 Sol, Super is
Nemotron 3 Super 120B-A12B, Lightning is Nemotron 3.5 Lightning 30B-A3B, and 3.5 Super is the Nemotron 3.5 Super
text preview.

| Arm | `SWITCHYARD_ROUTES` | Efficient | Capable | Judge | Confirmations |
|---|---|---|---|---|---|
| A0 Ultra alone | `passthrough.nemotron` | Ultra | (unused) | (aux calls only) | – |
| A1 Sol pinned | `pinned-capable.nemotron-gpt` | (unused) | Sol | (aux calls only) | – |
| A2 Ultra → Sol, c1 | `escalation.nemotron-gpt` | Ultra | Sol | Super | 1 |
| A3 Ultra → Sol, c2 | `escalation.nemotron-gpt` | Ultra | Sol | Super | 2 |
| A4 Super → Ultra | `escalation.nemotron` | Super | Ultra | Lightning | 1 |
| A5 3.5 Super → Sol | `escalation.nemotron-gpt` | 3.5 Super | Sol | Super | 1 |

**Questions.** The seven hero questions and five questions from `data/packs/market-analysis/questions.yaml`,
one per remaining tag, skipping those a hero question already covers. Questions from `questions.yaml` use
their own `sources`; hero questions use every default source. The hero questions, verbatim:

- **H1:** For each company announcement published August 18-28, 2026, show the stock's return on the
  announcement day and over the next two trading sessions.
- **H2:** Across all 2,000 companies in the large universe, which had the strongest and weakest returns from
  January 2, 2024 to August 31, 2026, and how did their volatility compare?
- **H3:** At the August 24, 2026 close, which companies are most likely to lose more than 5% over the next 5
  calendar days?
- **H4:** What does Title 17 require a public company to disclose about a material cybersecurity incident, and
  by when? Cite the sections.
- **H5:** What did Galena Semiconductor say about export-license exposure, and which mitigations did it
  mention?
- **H6:** Which companies had the most unusual trading sessions in late August 2026, what did each company
  announce that day, and which Form 8-K provisions in Title 17 would govern that kind of announcement?
- **H7:** At the August 24, 2026 close, which three companies does the model rate most likely to fall more
  than 5% over the next 5 calendar days? For each, how has it traded over the last 20 sessions, and what had it
  announced before the anchor?

| Id | Kind | Deterministic check (besides: job succeeded, required tools called, at least one citation) |
|---|---|---|
| H1 | event returns (analytics) | ≥ 90% of the report's percentages match a receipt value; ≥ 5 event rows |
| H2 | 2,000-issuer scan | names the oracle's strongest (`asset-qualification-0646`) and weakest (`…-0802`) |
| H3 | Kumo prediction | names the model's top three, and its top company first |
| H4 | Title 17 retrieval | cites Form 8-K Item 1.05 and "four business days" |
| H5 | missing evidence | invents no mitigations and says the statement was not found (no citation needed) |
| H6 | anomalies + news + rules | mentions Form 8-K and an Item or § 249.308; ≥ 2 citations |
| H7 | prediction + prices + news | names the model's top three, top company first |
| market-leaders | 20-session scan | oracle strongest (Aether, −0.94%) and weakest (Cascade), within 0.1 pp |
| market-multivariate-anomalies | anomaly scan | says the scores are not forecasts and not causal |
| market-news-cybersecurity-disclosures | SEC retrieval | ≥ 2 citations |
| market-peer-network | relationship graph | calls `analyze_market_relationships` |
| market-comparison-cybersecurity | filings vs. rules | retrieved from both corpora; cites Item 1.05 or Item 106 |

The oracle values come from the pack's `eval/oracles/*.sql` (`recent_adjusted_returns.sql`) and the same
adjusted-close arithmetic over the 2,000-issuer universe, computed read-only against the active DuckDB.
H5's premise was deliberately unanswerable: the Galena brief (`market_briefs`) was opt-in and not in the
default build, so the honest answer was "not found".

> **Note.** The bake-off ran before `market_briefs` became a default corpus, so the H5 check and reference
> facts here describe that earlier build, where H5 was unanswerable. The default build now includes the eight
> fictional briefs, so H5 is answerable by default (the Galena brief names the export-license review and its
> possible mitigations). These results were not re-measured against that build.
>
> A single spot check on that build (all profiles, including `ontology` and the local Kumo NIM, on a Brev A100
> VM with Sol pinned): all seven hero questions completed with citations, in 18 to 183 s each (H1 was the
> slowest: two Auto Ontology queries of 50 and 96 s). H5 now quotes the Galena brief's export-license review and
> its two possible mitigations. This was one unjudged run, not a repeat of the bake-off.

**Metrics.**
- *Pass*: the deterministic check passes **and** a majority of three blinded LLM-judge samples say pass.
- *Judge mean*: the mean of the three samples' overall score (1–5).
- *Grounded %*: the share of percentages in the report that match a number in the run's receipts, as given
  or × 100, within display rounding. It is computed over the runs that report percentages.
- *Tool validity*: tool calls, calls that reported an error or produced a failed receipt, and duplicate calls
  (same tool, same arguments).
- *Escalation*: a run escalated when any agent turn was served by the capable model. The latch turn is the
  index of the first capable turn (0 means the judge escalated the first turn). A *false latch* is an
  escalated run whose question A0 (Ultra alone) passed; a *rescue* is an escalated run that passed where A0
  failed.
- *Latency*: submit to completion, as the API records it (no queueing: one job at a time).
- *Served models*: the `served_model` of every agent turn (the `llm.call` events the UI shows), plus every
  upstream call Switchyard made for the session, judge calls and discarded efficient replies included.
- *Errors*: failed jobs and Switchyard's upstream errors (answer and judge clients).

**The answer judge.** GPT-6 Sol on the same gateway (Responses API, `reasoning.effort = "medium"`, `store = false`,
JSON-schema output), three independent samples per run, majority vote. It sees the question, short reference
facts written from the oracles and the pack, a digest of the run's receipts (each capped at 40,000 characters)
and the report. It never sees the arm or the model. System prompt, verbatim:

```text
You grade reports written by a financial market-research agent in a software demo. The agent answers one analyst question by calling read-only tools (market analytics over a synthetic market dataset, a Kumo prediction model, and retrieval over real SEC filings and eCFR Title 17) and then writes a cited report. All issuers, prices and events in the market dataset are fictional; the filings and regulations are real.

You receive the question, reference facts written by the evaluator, a digest of the tool evidence the agent actually received, and the agent's final report. Grade against the evidence and the reference facts, not your own knowledge. Do not penalize the report for omitting something the evidence does not contain, but do penalize any claim, number, date or entity that the evidence does not support. The evidence is the receipt the agent's tools recorded: retrieved passages are cut at 1,500 characters there, while the agent read them in full. A detail attributed to a retrieved document whose snippet is cut off is unverifiable rather than fabricated: lower grounding by at most one point for it. Fail a report for claims the evidence contradicts or that no evidence could plausibly support.

Score each criterion from 1 (very poor) to 5 (excellent):
- correctness: agrees with the reference facts and the evidence; numbers and rankings are right.
- grounding: every factual claim is traceable to the evidence; fabrication scores 1.
- completeness: answers every part of the question that the evidence can support.
- honesty: states real limits (missing data, truncated results, synthetic data, no causality or forecasting where relevant) without refusing what the evidence supports.
Then give overall (1-5) and pass: true only if you would show this report to a customer at a product demo (no fabricated facts, the main parts of the question answered or honestly declared unavailable).
```

Each run's user message is `QUESTION`, `REFERENCE FACTS`, `JOB STATUS`, `TOOL EVIDENCE` (the receipts as JSON)
and `REPORT`. The reference facts per question:

- **H1:** In this deployment (no Auto Ontology), company announcements are the synthetic short-form market_news
  stream (headline-level 'market-pulse' items). Between August 18 and 28, 2026 it holds 2,000 items, one per issuer,
  all published on August 26 after the close (21:15-21:54 UTC), so the aligned session is August 27 and the
  two-session outcome session is August 31. analyze_news_price_relationship returns the two-session forward return
  and caps the event list; an announcement-day return needs price_context. A good answer reports how many
  announcements match, that the list is a subset, gives returns that match the evidence, and either gives or
  honestly explains the missing day return.
- **H2:** Over the 2,000-issuer universe, strongest: [{'asset_id': 'asset-qualification-0646', 'ret':
  4.1913585964367135, 'vol': 0.015523845908692319}, {'asset_id': 'asset-qualification-1570', 'ret':
  3.9406756511816106, 'vol': 0.012740247669611782}, {'asset_id': 'asset-qualification-0230', 'ret':
  3.3287885896718503, 'vol': 0.010755589937117293}]; weakest: [{'asset_id': 'asset-qualification-1553', 'ret':
  -0.6603970184297887, 'vol': 0.017218744363522477}, {'asset_id': 'asset-qualification-1618', 'ret':
  -0.6679966060893072, 'vol': 0.01880120130216647}, {'asset_id': 'asset-qualification-0802', 'ret':
  -0.7262989082385838, 'vol': 0.017556638464608722}] (ret = adjusted-close return as a fraction; vol = daily return
  std).
- **H3:** The Kumo prediction in the evidence is the answer: the report must rank companies by the model's
  probabilities exactly as the evidence gives them, state the anchor and horizon, and not present model
  probabilities as certainties.
- **H4:** Form 8-K Item 1.05 requires disclosing a material cybersecurity incident (nature, scope, timing, material
  impact or reasonably likely impact) within four business days of determining the incident is material; materiality
  is determined without unreasonable delay; a delay is possible when the US Attorney General finds a substantial
  risk to national security or public safety. Regulation S-K Item 106 (17 CFR 229.106) covers annual
  risk-management, strategy and governance disclosure. The Title 17 corpus does not contain Form 8-K's Item 1.05
  instructions, so no retrieved passage states the four-business-day deadline. Stating the deadline while flagging
  that the retrieved text does not contain it, or saying it cannot be verified, are both acceptable; presenting it
  as a fact the citations support is an unsupported claim. Credit only sections that appear in the evidence.
- **H5:** No document or tool in this deployment contains Galena Semiconductor's statements about export-license
  exposure or any mitigations (the Galena brief is not in this build). Galena's market_news items are headline-level
  only. A correct answer says it could not find the statement or mitigations; naming specific mitigations is
  fabrication and fails.
- **H6:** In this deployment (no Auto Ontology), company announcements are the synthetic short-form market_news
  stream (headline-level 'market-pulse' items). Between August 18 and 28, 2026 it holds 2,000 items, one per issuer,
  all published on August 26 after the close (21:15-21:54 UTC), so the aligned session is August 27 and the
  two-session outcome session is August 31. analyze_news_price_relationship returns the two-session forward return
  and caps the event list; an announcement-day return needs price_context. Same-day announcements for anomalous
  sessions may not exist; saying none were found is correct when the evidence shows none. Form 8-K items (e.g. 1.01,
  2.02, 7.01, 8.01, 1.05 under 17 CFR 249.308) may be cited only if retrieved. The report must not claim the
  fictional companies filed 8-Ks or that announcements caused the anomalies.
- **H7:** The Kumo prediction in the evidence gives the three most likely decliners. The anchor is August 24, 2026
  21:00 UTC: announcements published after it (including every market_news item dated August 26) must not be
  presented as made before the anchor. Trading over the last 20 sessions must come from price_context or market_scan
  evidence.
- **market-leaders:** The question names no universe; the pack's story universe is the 12 reviewed assets. A report
  that scans the 2,000-issuer universe instead is acceptable if it says so and matches its evidence. Reviewed
  universe, 20 sessions ending 2026-08-31, adjusted-close return: top [{'asset_id': 'asset-aether', 'ticker':
  'AETH', 'company_name': 'Aether Compute', 'adjusted_return': -0.00942937136442823, 'daily_volatility':
  0.01606015330748355}, {'asset_id': 'asset-fathom', 'ticker': 'FTHM', 'company_name': 'Fathom Data Systems',
  'adjusted_return': -0.026237153617632458, 'daily_volatility': 0.013132972527089332}, {'asset_id': 'asset-delta',
  'ticker': 'DLTP', 'company_name': 'Delta Power Systems', 'adjusted_return': -0.048853352363034785,
  'daily_volatility': 0.013084621788446512}]; bottom [{'asset_id': 'asset-galena', 'ticker': 'GLNA', 'company_name':
  'Galena Semiconductor', 'adjusted_return': -0.1248309637601911, 'daily_volatility': 0.01760099933185831},
  {'asset_id': 'asset-kestrel', 'ticker': 'KSTR', 'company_name': 'Kestrel Mobility', 'adjusted_return':
  -0.12947948343272397, 'daily_volatility': 0.011511771453288872}, {'asset_id': 'asset-cascade', 'ticker': 'CASC',
  'company_name': 'Cascade Networks', 'adjusted_return': -0.1443768510100536, 'daily_volatility':
  0.011849928870307285}] (fractions).
- **market-multivariate-anomalies:** The ranked sessions and feature explanations must come from the
  market_anomaly_scan evidence; the report must say anomaly scores are neither forecasts nor causal explanations.
- **market-news-cybersecurity-disclosures:** Companies, filing dates and described effects must come from the
  retrieved SEC filings; say what the filings do not state.
- **market-peer-network:** Centrality, strongest relationships and unusual-return comparisons must come from the
  analyze_market_relationships (and any market_scan) evidence.
- **market-comparison-cybersecurity:** Map facts from retrieved issuer filings to retrieved Title 17 requirements
  (e.g. Form 8-K Item 1.05, Regulation S-K Item 106) and say which conclusions the evidence cannot support.

## Results

One run per question and arm. Pass = the deterministic check and the judge majority both pass.

| Arm | Pass | Deterministic | Judge pass | Judge mean (1–5) | Grounded % | Tool calls / errors / duplicates | Escalated | False latch | Rescue | p50 s | p95 s | Failed jobs | Router errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A0 Ultra alone | 6/12 | 12/12 | 6/12 | 3.17 | 98 | 63 / 0 / 1 | – | – | – | 36 | 107 | 0 | 0 |
| **A1 Sol pinned** | **11/12** | 11/12 | **11/12** | **4.22** | 100 | 41 / 2 / 0 | – | – | – | **33** | **79** | 0 | 0 |
| A2 Ultra → Sol, c1 | 6/12 | 10/12 | 6/12 | 3.58 | 99 | 53 / 1 / 0 | 6/12 | 3 | 2 | 36 | 101 | 1 | 0 |
| A3 Ultra → Sol, c2 | 6/12 | 11/12 | 7/12 | 3.44 | 100 | 74 / 0 / 2 | 2/12 | 1 | 1 | 66 | 135 | 0 | 0 |
| A4 Super → Ultra, c1 | 3/12 | 8/12 | 5/12 | 2.86 | 86 | 63 / 0 / 2 | 10/12 | 5 | 1 | 25 | 106 | 0 | 0 |
| A5 3.5 Super → Sol, c1 | 5/12 | 9/12 | 5/12 | 3.00 | 92 | 71 / 8 / 0 | 4/12 | 1 | 2 | 41 | 109 | 0 | 0 |

Served models and routing overhead (counts over the arm's 12 runs):

| Arm | Agent turns served by | All upstream calls, judge included | Escalation verdicts (Phoenix) | Latch turn per escalated run | Median input tokens per run |
|---|---|---|---|---|---|
| A0 | Ultra 72 | Ultra 72 | – | – | 114,853 |
| A1 | Sol 59 | Sol 59 | – | – | 35,860 |
| A2 | Ultra 42, Sol 21 | Super 48, Ultra 42, Sol 21 | continue 42, escalate 6, latched 15 | 4, 5, 3, 0, 5, 2 | 109,278 |
| A3 | Ultra 87, Sol 5 | Super 89, Ultra 87, Sol 5 | continue 74, pending 13, escalate 2, latched 3 | 8, 4 | 281,837 |
| A4 | Ultra 61, Super 10 | Ultra 61, Lightning 20, Super 10 | continue 10, escalate 10, latched 51 | 0, 2, 0, 0, 0, 0, 1, 0, 2, 1 | 30,160 |
| A5 | 3.5 Super 67, Sol 9 | Super 71, 3.5 Super 67, Sol 9 | continue 67, escalate 4, latched 5 | 10, 2, 16, 10 | 114,817 |

No arm had a Switchyard upstream error, a judge parse failure or a rejected handoff to Sol. Per question
(judge mean; `*` = escalated; `[det]` = deterministic check failed):

| Question | A0 | A1 | A2 | A3 | A4 | A5 |
|---|---|---|---|---|---|---|
| H1 | fail 2.0 | fail 1.0 [det] | fail 2.0* [det] | PASS 4.0 | fail 2.0* | fail 2.0* [det] |
| H2 | PASS 3.7 | PASS 5.0 | PASS 5.0 | PASS 5.0 | PASS 5.0* | PASS 4.0 |
| H3 | fail 3.7 | PASS 3.7 | fail 3.7 | fail 2.3 | fail 3.3* | fail 3.0 |
| H4 | fail 2.0 | PASS 3.7 | PASS 4.0* | PASS 4.0* | fail 1.0 [det] | fail 2.0 |
| H5 | fail 2.0 | PASS 5.0 | PASS 5.0* | fail 2.0 | PASS 4.7* | PASS 5.0* |
| H6 | fail 1.0 | PASS 4.7 | job failed | fail 2.0 | fail 2.0* | PASS 4.3* |
| H7 | PASS 3.7 | PASS 4.7 | fail 3.0 | PASS 4.0 | fail 1.0 [det] | PASS 3.3 |
| market-leaders | PASS 5.0 | PASS 5.0 | PASS 5.0* | PASS 4.0 | fail 2.0* | fail 2.0 |
| market-multivariate-anomalies | PASS 4.3 | PASS 5.0 | fail 3.0 | fail 4.0 [det] | fail 4.0* [det] | fail 2.3 [det] |
| market-news-cybersecurity-disclosures | PASS 5.0 | PASS 5.0 | PASS 4.3* | fail 3.3 | PASS 3.3* | PASS 4.0* |
| market-peer-network | fail 1.7 | PASS 4.0 | fail 2.3 | fail 2.0 | fail 4.0* [det] | fail 2.0 [det] |
| market-comparison-cybersecurity | PASS 4.0 | PASS 4.0 | PASS 4.7* | PASS 4.7* | fail 2.0* | fail 2.0 |

What the numbers show:
- **Ultra's failures are in reading evidence, not in calling tools.** Its tool calls were valid, and 98% of its
  percentages match a receipt, yet the judge failed half its reports. Typical faults: anomaly-scan deviations
  reported as percentage returns (H6, the peer network), announcement-day returns silently dropped (H1), and
  the Form 8-K four-business-day deadline stated as if the retrieved Title 17 text said so (H4; it does not).
- **Sol refuses rather than guesses.** It declined H1 without calling a tool (its only failure), and it
  flags what the evidence does not contain (H4, H5).
- **Escalation rarely triggers where it would help.** The judge sees each message cut to about 900
  characters, so it catches loops and missing citations, not a misread table. Latches mostly came late (A2:
  median turn 3.5; A3: turns 4 and 8), so escalated runs paid for Ultra's turns and then Sol's.
- **Lightning escalates Super almost at once** (7 of 10 at the first turn), so A4 is Ultra with a judge's
  overhead, and its reports often lacked citations.
- **Nemotron 3.5 Super (text preview)** made 8 invalid tool calls: company names and `reviewed_assets` passed
  as asset ids, and an anomaly scoring window that started before its training window ended.

### Checked against the criteria set before the run

These are the adoption criteria for A2, set before the bake-off and measured against A0 and A1.

| Criterion | A2 result | Met |
|---|---|---|
| No question that A0 passes regresses | H7 and the anomaly question stayed on Ultra and failed; H6 failed on a receipt bug (below) | no (run-to-run noise at k = 1) |
| Passes within one question of A1 | 6 against 11 | no |
| False latches ≤ 10% of A0's passing runs | 3 of 6 (50%) | no |
| Judge parse failures ≤ 2%, no user-visible failure caused by the judge | no judge errors; every verdict was continue, pending, escalate or latched | yes |
| p50 ≤ A0 + 15%, p95 ≤ A0 + 25% | 36 s against 36 s; 101 s against 107 s | yes |
| No 400 on the handoff to Sol | none | yes |

The "Ultra is not good enough" trigger (A0 fails at least two questions that A1 passes) fired: H3, H4, H5, H6
and the peer network.

### Limits of this bake-off

- **Small sample.** k = 1 and 12 questions, so a one-question difference is noise: A0 and A2 swapped several
  Ultra-only results between runs. The Sol-pinned margin (11 against 6) is well outside that noise.
- **Sol judged Sol.** The judge is the A1 model. The judge was blind to the arm, graded against reference
  facts and the receipts, and voted over three samples, but self-preference cannot be ruled out. The
  deterministic checks do not favour Sol (A0 12/12, A1 11/12); the gap comes from the judge's grounding
  checks. The judge's notes on Ultra's failures name concrete, verifiable errors, such as the percentage
  returns above.
- **Receipts, not full passages.** The judge read the receipts, which cut retrieved passages at 1,500
  characters, and it was told so.
- **One deployment shape.** Auto Ontology was off, so the 8 synthetic news events and `ask_question` were not
  in play. The judge ran on the gateway while A1, A4 and A5 were running; no arm saw a gateway error.
- **One unrelated failure.** A2's H6 failed because a retrieved SEC exhibit contains a `\x03` control character
  from PDF extraction. The API rejects that receipt (422), and the job then fails with "the evidence for its
  tool calls was not recorded". Any arm could hit this, and it is unrelated to routing. It has since been fixed:
  the corpus builder drops such characters, and the receipts plugin replaces any a tool still returns.

## Repeating the bake-off

Repeat it when a model id, a template, the judge prompt or the endpoint's model set changes.

1. `./scripts/demo.sh up` with the profiles to measure, then `./scripts/demo.sh check`.
2. For each arm: set the arm's lines in `.env` (table above), run `./scripts/demo.sh restart switchyard`, and
   confirm the rendered line in `./scripts/demo.sh logs switchyard` (`switchyard: <template> on <endpoint> …`).
3. Submit the 12 questions one at a time through the API (`POST /v1/jobs/async/submit`, with each
   `questions.yaml` question's `sources` as `data_sources`), wait for each to finish, and save
   `GET /v1/jobs/async/job/{id}/export` and `GET 127.0.0.1:4000/v1/routing/session-stats?session_id={id}`.
4. After the arm, save `GET 127.0.0.1:4000/v1/stats`, and read the `libsy.run` spans (`evidence.verdict`) from
   Phoenix for the arm's time window.
5. Score each run with the checks and the judge prompt above, and fill in the tables.
6. Put `.env` back on the winner and restart Switchyard.

One pass (72 runs, one at a time) took 63 minutes, plus about 20 minutes for the judge.
