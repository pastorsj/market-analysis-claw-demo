# data/generate

`demo-data-generate` writes the Nemotron text of the [`synthetic-market`](../packs/synthetic-market/README.md)
pack with [NeMo Data Designer](https://github.com/NVIDIA-NeMo/DataDesigner): the fictional companies' names and
profiles, the headline templates of their background news, and the twelve planted news stories.

The text is committed in `data/packs/synthetic-market/text/`, so building the pack needs no key and no network.
Run this tool only to change the text, or to cover a profile with more issuers than the committed text has.
It is its own uv project because Data Designer pins a different `pyarrow` than `demo-data`.

## How it fits

```text
generator/model.yaml ─┐
SEC ticker lists ─────┴─▶ roster (seeded) ─▶ Data Designer + Nemotron ─▶ checks ─▶ text/*.jsonl, checks.json
                                                                                           │
                          generator/build.py (seeded numbers), at `data prepare` ◀─────────┘
```

1. **Roster.** Each issuer slot gets an industry (a real SEC SIC code), an exchange, an invented name root and a
   four-letter ticker, all from seeded random streams (`roster.py`). A root that is a word in any SEC company
   title, or a ticker SEC lists, is skipped for the slot's next candidate. Slot N is the same in every roster
   with more than N slots, so every profile uses a prefix of the same text.
2. **Jobs** (`jobs.py`). The roster is Data Designer's seed dataset, read in order, so each answer belongs to one
   slot. Each job has one structured column, whose Pydantic `output_format` bounds the lengths:

   | Job | Records | Output |
   |---|---|---|
   | `companies` | one per issuer | `company_name` (the root plus one or two words), `profile` (one sentence) |
   | `headlines` | event type × sentiment (30) | 12 templates, each with one `{company}` placeholder |
   | `stories` | one per story (12) | `headline`, `summary` |

   The pack's background news fills a seeded template with the company name, so the number of calls grows
   with the issuers, not with the news.
3. **Checks** (`cli.py`). A name must start with its root, have no legal suffix, and match no SEC company title
   once casefolded and stripped of legal words; a slot whose name matches loses its root. A template needs
   exactly one placeholder; a story headline must name its company. Whatever fails is asked again, for at
   most 5 rounds. Tickers, roots and names must be unique. `checks.json` records the SEC files' SHA-256, the
   rounds, the model, the Data Designer version, the calls and tokens used, and each text file's SHA-256.

Rows already in the output are kept while they still pass the checks. A run therefore resumes after an
interruption, extends the text to a larger profile, and regenerates only what fails. Within a job, Data
Designer resumes an interrupted batch itself (`ResumeMode.IF_POSSIBLE`). Each seed is written to a file named
after its content for that: Data Designer's resume fingerprint covers a seed file's path, not a DataFrame's rows.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DESIGNER_API_KEY` | `INFERENCE_API_KEY` | the endpoint's key; Data Designer reads it from the environment at request time |
| `DATA_DESIGNER_BASE_URL` | `https://integrate.api.nvidia.com/v1` | any OpenAI-compatible endpoint |
| `DATA_DESIGNER_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | sent with thinking off |
| `DATA_DESIGNER_PARALLEL` | 8 | concurrent requests; build.nvidia.com rate-limits above that, and Data Designer backs off |
| `SEC_USER_AGENT` | – | a name and an email; SEC requires it to download its ticker files |

## Run

```bash
./scripts/demo.sh data generate                      # the default profile, into data/packs/synthetic-market/text
./scripts/demo.sh data generate --profile large --out "$HOME/market-demo-data/synthetic-market-text-large"
git diff --stat data/packs/synthetic-market/text     # review the text like any other change
```

`demo.sh` runs it with uv on the host, with the variables above from `.env`. A profile larger than the committed
text reads its text from `SYNTHETIC_MARKET_TEXT` at `data prepare`.

## Test

```bash
cd data/generate
uv sync
uv run pytest            # offline: the roster, the SEC checks and the loop, with a fake Data Designer
uv run pytest -m live    # a real 12-issuer run against the configured endpoint and SEC
```
