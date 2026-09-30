---
name: searching-documents
description: Finds cited passages in the selected document sources
license: Apache-2.0
compatibility: Requires the retrieval MCP server (retrieve_evidence tool)
metadata:
  author: NVIDIA
  version: "1.1"
  hermes:
    tags:
      - retrieval
      - documents
      - citations
      - nemotron
    related_skills:
      - analyzing-market-data
      - querying-auto-ontology
---

# Searching documents

`retrieve_evidence` searches every document source selected for this turn. It
ranks passages with NVIDIA Nemotron retrieval models and returns short passages
with their titles, citations, and dates.

## When to Use

- The selected sources include the `unstructured_retrieval` capability, and
- the answer depends on what a document says: a filing, disclosure, regulation,
  policy, or quotation.

Numbers calculated from data belong to `analyzing-market-data` or
`querying-auto-ontology`.

## Tool

`retrieve_evidence` (Hermes tool ID `mcp__retrieval__retrieve_evidence`)

| Argument | Value |
| --- | --- |
| `query` | A focused description of the passage you need |
| `top_k` | Leave unset at first; raise it only if the first result is too thin |

The application limits the search to the selected sources. Pass only `query`
and, when needed, `top_k`.

## Procedure

1. Write one focused query per distinct topic. Name the concept you need, not
   the answer you expect. To find one company's documents, put its name in the
   query.
2. Make one call even when several document sources are selected. Their
   passages are ranked together.
3. Keep only passages that directly support a claim, and note each passage's
   title, citation, and date.
4. If nothing relevant comes back, rephrase once with different key terms. Then
   say the selected documents do not cover the question.
5. That makes at most two searches per topic. A question about a rule and the
   filings that apply it has two topics: search the rule, then the filings.
   When the passages cover only part of a rule, cite what they show and name
   what is missing rather than searching again.

## Pitfalls

- Keep what a document's author claims separate from what a rule or policy
  requires.
- Quote exact wording only when the wording matters. Otherwise paraphrase and
  cite.
- Never answer a document question from general knowledge or web search.
- Link a document to a stock in the market data only through the passage's
  `ticker` metadata. A matching company name alone does not prove it is the
  same entity.

## Example

Question: "What must a company disclose after a material cybersecurity
incident, and how quickly?"

```
retrieve_evidence(query="disclosure requirements and deadline after a material cybersecurity incident")
```

Answer from the returned passages and cite the result's `evidence_id` after each
claim.
