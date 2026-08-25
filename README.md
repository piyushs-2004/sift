# Sift

**Audit, clean and gate any spreadsheet — without uploading it anywhere.**

[![ci](https://github.com/piyushs-2004/sift/actions/workflows/ci.yml/badge.svg)](https://github.com/piyushs-2004/sift/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sift-data)](https://www.npmjs.com/package/sift-data)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Two halves of one idea:

- **[The web app](https://piyushs-2004.github.io/sift/)** — drop in a CSV or Excel file, get a
  data quality audit, a personal-data scan, a cleaned export, and a warehouse schema.
  Runs entirely in your browser; the file never leaves your machine.
- **[The CLI](CLI.md)** — the same engine as a pipeline gate. Freeze a known-good file into
  a contract, then fail the build when a future file breaks it.

---

## Why

Bad data doesn't throw an exception.

An upstream team renames a column, an export truncates halfway, a currency field turns from
a number into `"INR 420.00"` — and the pipeline runs green. The dashboard quietly reports
the wrong number, nobody notices for three weeks, and by then someone has made a decision
on it.

Sift turns that into a build failure.

## 60 seconds

```bash
npx sift-data profile orders.csv                          # what's wrong with it
npx sift-data contract orders.csv -o contracts/orders.json # freeze what "good" means
npx sift-data check today.csv -c contracts/orders.json     # exits 1 when it breaks
```

Or open the [web app](https://piyushs-2004.github.io/sift/) and drag a file in — no install.

## What it checks

| | |
|---|---|
| **Structure** | duplicate rows, missing primary key, empty columns, mixed formats, leading/trailing whitespace |
| **Completeness** | null rates per column, and *where* nulls fall across the file — nulls bunched at one end usually mean a truncated export, not missing data |
| **Drift** | added/removed columns, type shifts, null-rate movement, row-count collapse |
| **Domain** | allowed value sets, numeric ranges, uniqueness, required fields |
| **Freshness** | a file that's stale is as broken as one that's malformed, and easier to miss |
| **Privacy** | columns that look like emails, phone numbers, payment cards, or government IDs |

## Contracts you actually control

Sift infers a first draft from your file. **That's a draft, not a decision** — evidence tells
you what *was* true, not what *matters*. A column that happened to be complete on a good day
shouldn't be pinned forever, and a critical join key with one stray null shouldn't be waved
through.

So override it, and your overrides survive regeneration:

```bash
sift contract orders.csv \
  --required order_id,amount \
  --optional customer_email \
  --allowed "status=paid|pending|refunded" \
  --range "amount=0:100000" \
  -o contracts/orders.json
```

Failures are tagged by origin, so you can tell a rule a human chose from one Sift guessed:

```
critical  Column "order_id" is no longer unique — 110 repeated value(s). [declared rule]
warning   Column "customer_email" is 11.3% null, above the ceiling of 5%.
```

Full detail in **[CLI.md](CLI.md)**.

## Keep the good rows

A breach usually doesn't mean the whole file is worthless — it means some rows are bad:

```bash
sift check orders.csv -c contracts/orders.json \
  --quarantine rejects.csv --pass-out clean.csv
```

The quarantine file carries `_sift_row` and `_sift_errors` so whoever owns the source knows
exactly what to fix, while your pipeline loads the clean rows and carries on.

## Built for real files

Streaming parser, so memory stays flat regardless of size — a 180 MB / 2M-row file profiles
in about 20 seconds at ~350 MB peak. Reads `.csv` `.tsv` `.json` `.ndjson`, any of them
`.gz`, plus stdin. Globs, column filters, JUnit/Markdown/JSON output, Docker image, and a
reusable GitHub Action.

Zero runtime dependencies. Node 16+.

## Where it doesn't apply

For profiling a Snowflake or BigQuery table in place, use
[Great Expectations](https://greatexpectations.io) or [Soda](https://www.soda.io) — they're
better at it and better resourced. Sift is for the moment data arrives as a *file*, which is
still how a great deal of it arrives.

PII matching is pattern-based: it catches structured identifiers and will miss names and
free-text notes. First pass, not a compliance review.

## Development

```bash
git clone https://github.com/piyushs-2004/sift.git
cd sift
npm test          # 182 tests, no framework, no dependencies
node bin/sift.js --help
```

The web app is a single self-contained file at `docs/index.html` — no build step. Open it
in a browser to work on it.

## License

MIT
