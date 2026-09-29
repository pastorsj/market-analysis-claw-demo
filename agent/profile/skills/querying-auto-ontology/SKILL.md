---
name: querying-auto-ontology
description: Answers historical database questions through Auto Ontology
license: Apache-2.0
compatibility: Requires the auto_ontology MCP server (ask_question tool)
metadata:
  author: NVIDIA
  version: "1.0"
  hermes:
    tags:
      - auto-ontology
      - text-to-sql
      - structured-data
    related_skills:
      - predicting-with-kumo
      - analyzing-market-data
---

# Querying Auto Ontology

NVIDIA Auto Ontology maps business terms to database columns. It turns a
plain-language question into SQL, runs it, and returns the rows. You describe
the result you need; Auto Ontology writes the query.

## When to Use

- The selected sources include the `structured_retrieval` capability, and
- the question needs exact rows, counts, totals, filters, groupings, or a custom
  calculation over historical data, such as a sector rollup, a drawdown, or the
  correlation between two chosen assets.

Use `predicting-with-kumo` for future outcomes. Use `analyzing-market-data` for
the rankings and scans that its tools compute directly.

## Tool

`ask_question` (Hermes tool ID `mcp__auto_ontology__ask_question`)

| Argument | Value |
| --- | --- |
| `question` | One complete, self-contained question |

Auto Ontology answers over the data pack's database only. Pass only
`question`: never `target_db`, `prediction`, `conversation_id`, or `evidence`.

## Procedure

1. Write one complete question that keeps every requested entity, measure,
   filter, grouping, date window, and sort order. A call can take tens of
   seconds, so one well-formed question beats several narrow ones.
2. Call `ask_question` with only `question`.
3. Read `rows`, `row_count`, `truncated`, and `sql`. Base claims on `rows`; treat
   `answer` as a summary. `resolution_lineage` shows which tables and columns
   each phrase of the question resolved to.
4. If `truncated` is true, say the result is partial, or ask a narrower
   question.
5. If the result is empty, has the wrong grain, or answers a different
   question, retry once with a clearer question. Then report the gap.

## Pitfalls

- Do not write SQL yourself or paste SQL into the question. Describe the result.
- Auto Ontology's descriptions mention `search_terms` and `check_answerable`.
  Those tools are not enabled here, so go straight to `ask_question`.
- Keep measures at their natural grain. Ask for totals before a one-to-many join
  can multiply them.
- Ask separate questions for different time grains, such as daily and monthly.
- A correlation in the rows is not a cause.

## Example

Question: "Which sectors had the best equal-weight return last month, and how
many assets does each sector have?"

```
ask_question(
    question="For each sector, compute the equal-weight average adjusted return "
             "from 2026-08-01 to 2026-08-31 and the number of assets in the sector. "
             "Sort sectors by that return, highest first.",
)
```

Cite the rows with the result's `evidence_id`.
