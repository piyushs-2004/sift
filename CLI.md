# sift

A data quality gate for pipelines. Profile a file, freeze what "good" looks like into a
contract, then fail the build when a future file breaks it.

Zero dependencies. One Node file. Nothing is sent anywhere.

```bash
npx sift-data profile orders.csv
```

## The problem it solves

Bad data doesn't throw an exception. An upstream team renames a column, changes a currency
field from a number to `"INR 420.00"`, or an export silently truncates — and your pipeline
runs green while the dashboard quietly reports the wrong number. Nobody notices for three
weeks, and by then someone has made a decision on it.

Sift turns that into a build failure.

## Commands

```bash
sift profile orders.csv                          # what's wrong with it
sift contract orders.csv -o contracts/orders.json # freeze what "good" means
sift check today.csv -c contracts/orders.json     # enforce; exits 1 on breach
sift diff yesterday.csv today.csv                 # drift, no contract needed
sift init                                         # scaffold sift.config.json
sift run                                          # every check in the config
```

The contract is plain JSON you commit and review in pull requests like any other code.

## Built for real files

**Streaming.** Files are parsed incrementally, so memory stays flat regardless of size —
a 180 MB / 2M-row file profiles in about 20 seconds at ~350 MB peak RSS. Uniqueness and
duplicate detection use 53-bit hashes rather than retaining values, which is what keeps
that number bounded on wide files with many distinct columns.

**Formats.** `.csv` `.tsv` `.json` `.ndjson`, any of them `.gz`, plus `-` for stdin.
Delimiters are auto-detected; override with `--delimiter`.

**Globs.** `sift check "data/**/*.csv.gz" -c contracts/orders.json` checks every match and
returns a single aggregate exit code.

**Column filters.** `--ignore "debug_*,_internal*"` or `--only "id,amount,status"` when a
file carries columns you don't govern.

**Sampling.** `--max-rows 100000` for a fast read of a very large file.

## Quarantine: keep the good rows

A contract breach usually doesn't mean the whole file is worthless — it means some rows are
bad. Split them:

```bash
sift check orders.csv -c contracts/orders.json \
  --quarantine rejects/orders_bad.csv \
  --pass-out clean/orders_good.csv
```

The quarantine file is the original columns plus `_sift_row` (the line number in the source
file) and `_sift_errors` (why it failed):

```csv
order_id,amount,status,_sift_row,_sift_errors
2,-30,paid,3,amount: -30 below min 0
3,999999,cancelled,4,"amount: 999999 above max 5000; status: ""cancelled"" not in allowed values"
```

Now your pipeline can load the clean rows and route the rejects to whoever owns the source,
instead of failing the whole run or loading the bad data.

## Freshness

A file that's stale is as broken as a file that's malformed, and far easier to miss:

```bash
sift check orders.csv -c contracts/orders.json --max-age 24h
```

Accepts `30m`, `6h`, `2d`, `1w`.

## One command for a whole project

```bash
sift init          # writes sift.config.json
sift run           # runs every check in it
```

```json
{
  "failOn": "critical",
  "checks": [
    {
      "name": "orders-daily",
      "files": "data/orders_*.csv",
      "contract": "contracts/orders.json",
      "maxAge": "24h",
      "quarantine": "quarantine/orders_rejects.csv",
      "passOut": "clean/orders_clean.csv"
    },
    {
      "name": "events-stream",
      "files": "data/events/**/*.ndjson.gz",
      "contract": "contracts/events.json",
      "failOn": "warning",
      "ignore": "debug_*,_internal*"
    }
  ]
}
```

Paths inside a config resolve relative to the config file, so `sift run -C configs/prod.json`
works from anywhere in the repo. `sift run` prints a per-check summary and exits non-zero if
any check failed.

## Alerting

```bash
sift check orders.csv -c contracts/orders.json --webhook "$SLACK_WEBHOOK_URL"
```

Slack and Teams webhook URLs get a formatted message; anything else receives the full JSON
result. Fires only on failure.

## Docker

```bash
docker build -t sift .
docker run --rm -v "$PWD:/work" sift check data/orders.csv -c contracts/orders.json
```

## What a contract enforces

| Check | Fires when |
|---|---|
| `column_missing` | A promised column is gone |
| `column_added` | A new column appeared (info by default, `--strict-columns` to reject) |
| `type_changed` | A column's inferred type narrowed or shifted incompatibly |
| `null_in_required` | Nulls appeared in a column that had none |
| `null_rate_exceeded` | Null rate rose beyond the agreed headroom |
| `uniqueness_lost` | A key column now has repeats |
| `row_count_drop` | Row count fell beyond tolerance — usually a broken extract |
| `duplicates_exceeded` | Duplicate rows above the allowance |
| `unexpected_pii` | A column now looks like personal data and wasn't declared as such |

Type checking widens rather than pins: a column declared `decimal` accepts `integer`, and
anything accepts `empty`. It fails when a number becomes a string, not when 4 becomes 4.0.

## Install

```bash
npm install -g sift-data     # global
npx sift-data profile x.csv  # no install
npm install --save-dev sift-data  # per-project
```

Node 16+. No dependencies, so it installs in about a second and adds nothing to your
security surface.

## Choosing which columns may never be null

By default Sift infers: a column with zero nulls in your sample becomes `required`.
**That is a draft, not a decision.** Evidence tells you what *was* true; it can't tell
you what *matters*. A column that happened to be complete on a good day gets pinned and
fires false alarms forever; a critical join key with one stray null gets marked optional
and guards nothing.

So override it. Three ways, in increasing durability.

### Flags, for a quick pass

```bash
sift contract orders.csv \
  --required order_id,amount \
  --optional customer_email \
  --unique order_id \
  --allowed "status=paid|pending|refunded" \
  --range "amount=0:5000" \
  --min-rows 100 \
  -o contracts/orders.json
```

`--required` implies a zero null tolerance unless you also set `--max-null` for that column.

### A rules file, for anything you'll keep

```bash
sift contract orders.csv --emit-rules sift.rules.json
```

Every knob comes out as `"infer"`, with a note showing what Sift saw:

```json
{
  "defaults": { "required": "infer", "null_tolerance_pp": 5 },
  "rules":    { "allow_new_columns": true },
  "columns": {
    "order_id": {
      "_inferred": "integer, 0.0% null, 500 distinct, unique",
      "required": "infer",
      "unique": "infer",
      "max_null_pct": "infer"
    }
  }
}
```

An unedited template changes nothing. Replace an `"infer"` with a value to pin it:

```json
"order_id": { "required": true, "unique": true, "description": "join key to fact_orders" },
"region":   { "required": false, "max_null_pct": 40 },
"status":   { "allowed_values": ["paid", "pending", "refunded"] }
```

```bash
sift contract orders.csv -r sift.rules.json -o contracts/orders.json
```

Commit the rules file. It's the record of what your team decided, reviewable in a PR.

### Per-column keys

| Key | Effect |
|---|---|
| `required` | Any null is a critical violation |
| `unique` | Repeats, or nulls in a key, are critical |
| `max_null_pct` | Null-rate ceiling before a warning |
| `type` | Pin the expected type instead of inferring it |
| `allowed_values` | Restrict to a fixed set |
| `min` / `max` | Numeric bounds |
| `pii` | Declare personal data so it stops being flagged as unexpected |
| `description` | Free text, carried into the contract for reviewers |

Global keys under `rules`: `allow_new_columns`, `allow_missing_columns`,
`max_row_drop_pct`, `max_duplicate_pct`, `min_rows`.
Under `defaults`, `required` accepts `infer` (default), `all`, or `none`.

### Regenerating without losing your work

This is the part that matters. Pass the old contract when you rebuild against a new sample:

```bash
sift contract new_sample.csv -c contracts/orders.json -o contracts/orders.json
```

Declared rules carry forward and win. If `order_id` was declared unique and the new
sample has duplicates, the contract still says unique — and `sift check` still fails.
Regenerating against a broken file never launders the breakage into the contract.

Declared rules also survive for columns missing from the new sample, so a dropped column
doesn't quietly disappear from the contract along with its rule.

### Reading the output

Violations are tagged by origin, so you know whether a failure broke a rule a human chose
or one Sift guessed:

```
critical  Column "order_id" is no longer unique — 110 repeated value(s). [declared rule]
warning   Column "customer_email" is 11.3% null, above the ceiling of 5%.
```

A declared rule failing is a conversation with the upstream team. An inferred rule failing
might just mean the inference was wrong — loosen it and move on.

### Precedence

```
inferred from sample  <  rules file (-r)  <  contract's declared block (-c)  <  CLI flags
```

---

## Integrations

### GitHub Actions

A reusable action ships in `.github/actions/sift`:

```yaml
name: data quality
on: [pull_request]

jobs:
  sift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: ./.github/actions/sift
        with:
          files: 'data/orders*.csv'
          contract: 'contracts/orders.json'
          max-age: '24h'
          comment: 'true'
```

It writes the findings to the job summary and, with `comment: true`, to the PR. Or call the
CLI directly for JUnit output your test reporter already understands:

```yaml
      - run: npx sift-data check "data/*.csv" -c contracts/orders.json -f junit -o results.xml
      - uses: mikepenz/action-junit-report@v4
        if: always()
        with: { report_paths: results.xml }
```

### Airflow

Put the gate *before* the load, so bad data never reaches the warehouse.

```python
from airflow.operators.bash import BashOperator

check = BashOperator(
    task_id="data_contract_check",
    bash_command=(
        "npx sift-data check /data/orders_{{ ds }}.csv "
        "-c /opt/airflow/contracts/orders.json "
        "--max-age 26h "
        "--quarantine /data/rejects/orders_{{ ds }}.csv "
        "--pass-out /data/clean/orders_{{ ds }}.csv"
    ),
)

extract >> check >> load >> transform
```

A non-zero exit fails the task, stops the DAG, and triggers your existing alerting — no new
alerting infrastructure to build. With `--pass-out`, point the load task at the clean file
and it carries on with the good rows while the rejects go to whoever owns the source.

To branch instead of failing:

```python
from airflow.operators.python import BranchPythonOperator
import subprocess

def gate(**_):
    code = subprocess.run([
        "npx", "sift-data", "check", "/data/orders.csv",
        "-c", "/opt/airflow/contracts/orders.json", "-q"
    ]).returncode
    return "load" if code == 0 else "notify_owner"
```

### Python, without Node in the DAG

```python
import json, subprocess

out = subprocess.run(
    ["npx", "sift-data", "check", "orders.csv", "-c", "contract.json",
     "-f", "json", "--exit-zero"],
    capture_output=True, text=True
)
result = json.loads(out.stdout)
if not result["passed"]:
    blocking = [v for f in result["files"] for v in f["violations"]
                if v["severity"] == "critical"]
    raise ValueError(f"{len(blocking)} blocking data issues")
```

### dbt

Run it as a pre-hook on the seed or source-loading step:

```yaml
# dbt_project.yml
on-run-start:
  - "{{ log('checking source contracts', info=true) }}"
```

```bash
# or simply, in your orchestration script
sift check seeds/orders.csv -c contracts/orders.json && dbt run
```

### Cron / any scheduler

```bash
#!/usr/bin/env bash
set -euo pipefail

for f in /exports/*.csv; do
  name=$(basename "$f" .csv)
  if ! sift check "$f" -c "/contracts/$name.json" -q; then
    echo "Contract breach in $f" | mail -s "Data alert: $name" data-team@company.com
    exit 1
  fi
done
```

### Makefile

```make
check:
	@sift check data/*.csv -c contracts/orders.json

.PHONY: check
```

---

## Options

```
-o, --out <path>        Write output to a file instead of stdout
-c, --contract <path>   Contract to validate against
-f, --format <fmt>      human | json | junit | markdown
    --fail-on <sev>     critical | warning | info | none   (default: critical)
    --tolerance <pp>    Null-rate headroom when generating a contract (default: 5)
    --row-tolerance <%> Allowed row-count drop (default: 30)
    --strict-columns    Reject new columns
    --max-rows <n>      Stop after n rows
-q, --quiet             Print only on failure
```

**Exit codes:** `0` passed · `1` violations at or above `--fail-on` · `2` usage or read error.

## Tuning the contract

The generated contract is a starting point, not gospel. Two edits worth making by hand:

**Loosen what genuinely varies.** A `region` column that legitimately gains values shouldn't
be pinned. Raise `max_null_pct` on columns you know are optional.

**Tighten what actually matters.** Set `"required": true` and `"unique": true` on your join
keys even if the sample didn't prove it, because that's the failure that corrupts everything
downstream.

Start with `--fail-on warning` in a non-blocking job for a week. Watch what fires. Once the
noise is gone, move it into the blocking path.

## Using it as a library

Whole-file, for something small:

```js
const { parseCSV, profile, buildContract, checkContract } = require('sift-data');

const { rows, fields } = parseCSV(fs.readFileSync('orders.csv', 'utf8'));
const p = profile(rows, fields);
const violations = checkContract(JSON.parse(contractJson), p);

if (violations.some(v => v.severity === 'critical')) throw new Error('contract breach');
```

Streaming, for anything real:

```js
const { readRows } = require('sift-data/lib/reader');
const { Accumulator, rowValidator } = require('sift-data/lib/pipeline');
const { checkContract } = require('sift-data');

let acc;
readRows('orders.csv.gz', {}, {
  onHeader: fields => { acc = new Accumulator(fields); },
  onRow:    row    => acc.push(row),
  onEnd:    ()     => {
    const violations = checkContract(contract, acc.finalize());
    console.log(violations);
  },
  onError:  err    => { throw err; }
});
```

Validate individual rows as they stream past — useful inside an existing ETL loop:

```js
const validate = rowValidator(contract);
for (const row of myStream) {
  const errs = validate(row);
  if (errs) quarantine.push({ row, errs });
  else load(row);
}
```

## Limitations, stated plainly

- **No Excel.** Convert first, or use the browser version, which reads xlsx directly.
- **Type inference is evidence-based**, so a column that happens to hold only digits in the
  sample is inferred as an integer. Check the contract before committing it.
- **PII matching is pattern-based.** It catches emails, phone numbers, card numbers and
  ID formats. It will miss names and free-text notes, and it can false-positive on order
  IDs. It is a first pass, not a compliance review.
- **Files, not warehouses.** Sift reads files. For profiling a Snowflake or BigQuery table
  in place, use Great Expectations or Soda — this is the tool for the moment data arrives as
  a file, which is still how a great deal of it arrives.
- **Uniqueness uses 53-bit hashes.** A collision can only under-report uniqueness, never
  invent a key that isn't there. Beyond 20M distinct values per column it reports uniqueness
  as unknown rather than guessing.

If you need warehouse-native profiling with a full expectation suite, use Great Expectations.
Sift is for the case where a file lands, something is wrong with it, and you want to know
before it becomes someone's quarterly number.

## Web version

The browser version at [your URL] does the same profiling with no install — plus xlsx
support, a cleaned-file export, and a **Download contract** button, so you can generate
your first contract without touching a terminal, then hand it to the CLI.

MIT licensed.
