#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('../lib/core.js');
var reader = require('../lib/reader.js');
var pipe = require('../lib/pipeline.js');

var C = process.stdout.isTTY && !process.env.NO_COLOR ? {
  dim: '\x1b[2m', red: '\x1b[31m', yel: '\x1b[33m', blu: '\x1b[34m',
  grn: '\x1b[32m', bold: '\x1b[1m', off: '\x1b[0m'
} : { dim: '', red: '', yel: '', blu: '', grn: '', bold: '', off: '' };

var SEV_RANK = { info: 0, warning: 1, critical: 2 };
var VERSION = '0.2.0';

function usage(code) {
  console.log(`
sift ${VERSION} — data quality gate for pipelines

  ${C.bold}sift profile${C.off} <files...>                Profile files and print findings
  ${C.bold}sift contract${C.off} <file> [-o out.json]     Write a contract from a known-good file
  ${C.bold}sift check${C.off} <files...> -c contract.json Validate, exit non-zero on breach
  ${C.bold}sift diff${C.off} <old> <new>                  Compare two files directly, no contract
  ${C.bold}sift run${C.off} [-C sift.config.json]         Run every check defined in a config file
  ${C.bold}sift init${C.off}                              Write a starter sift.config.json

Files may be globs ("data/*.csv", "exports/**/*.csv.gz") and may be .csv .tsv
.json .ndjson, optionally .gz. Use - to read CSV from stdin.

Input
  -f, --format <fmt>      Output format: human | json | junit | markdown
      --in <fmt>          Force input format: csv | ndjson | json
      --delimiter <ch>    Force a delimiter (use \\t for tab)
      --encoding <enc>    Input encoding (default utf8)
      --max-rows <n>      Stop after n rows — a fast sample of a huge file
      --ignore <globs>    Skip columns matching these patterns (comma separated)
      --only <globs>      Consider only columns matching these patterns

Contract authoring
  -r, --rules <path>      Rules file whose settings override inference
      --emit-rules <p>    Write an editable starter rules file and stop
      --tolerance <pp>    Null-rate headroom (default 5)
      --row-tolerance <%> Allowed row-count drop (default 30)
      --min-rows <n>      Absolute row floor
      --strict-columns    Reject new columns
      --required a,b      Force columns to reject nulls
      --optional c        Allow nulls despite a clean sample
      --unique id         Enforce uniqueness
      --not-unique x      Stop enforcing uniqueness
      --max-null "a=25"   Per-column null ceiling, percent
      --allowed "s=a|b"   Restrict a column to a fixed value set
      --range "amt=0:1e6" Numeric bounds
      --require-all       Default every column to required
      --require-none      Default every column to optional
      --unique-together "a,b"  Composite key: this column combo must be unique
                          (repeatable for more than one combination)
      --allow-empty       A file with zero data rows is expected, not an error
      --deviation "a=30"  Flag if a numeric column's average moves more than
                          this percent from the baseline (catches unit/scale bugs)
      --deviation-tolerance <pct>  Same, as a default for every numeric column

Enforcement
  -c, --contract <path>   Contract to validate against
      --fail-on <sev>     critical | warning | info | none  (default critical)
      --max-age <dur>     Fail if the file is older than e.g. 6h, 2d, 1w
      --track <path>      Log each run's row count to a history file
      --row-deviation <%> Fail if row count deviates from the rolling
                          average by more than this percent (needs --track)
      --sla <time[tz]>   Fail if the file arrived after this time, e.g.
                          "06:00" or "06:00+05:30" for IST
      --no-regression     Fail if quality score dropped vs last passing run
                          (needs --track)
      --gate <overrides>  Override severity per check code. Comma-separated.
                          Values: critical, warning, info, off
                          e.g. "sla_breach=info,empty_file=off"
                          Default behaviour is unchanged for every code.
      --conditional <spec> Business logic rule, repeatable. Format:
                          "col=val:other_col.not_null"
                          "status=refunded:refund_amount.not_null"
                          "country=IN|NP:currency.INR"
      --quarantine <path> Write offending rows here, with a reason column
      --pass-out <path>   Write the rows that passed here
      --webhook <url>     POST the result on failure — Slack, Teams, Discord,
                          PagerDuty, or generic JSON, auto-detected from the URL
      --webhook-key <k>   Routing/integration key some platforms need
                          (e.g. PagerDuty). Also read from SIFT_WEBHOOK_KEY.
      --alert-on <sev>    Severity that triggers the webhook (default: --fail-on)
      --alert-always      Also send a heartbeat ping when everything passes
      --exit-zero         Always exit 0; report only

Output
  -o, --out <path>        Write output to a file
  -q, --quiet             Print only on failure
      --no-color          Disable colour
  -h, --help  ·  -v, --version

Exit codes
  0  passed   1  violations at or above --fail-on   2  usage or read error
`);
  process.exit(code == null ? 0 : code);
}

/* ================= argument parsing ================= */
function args(argv) {
  var o = {
    _: [], format: 'human', failOn: 'critical', tolerance: 5, rowTolerance: 30,
    declared: { columns: {}, rules: {}, defaults: {} }, read: {}
  };
  function mark(names, key, val) {
    String(names).split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      .forEach(function (n) {
        o.declared.columns[n] = o.declared.columns[n] || {};
        o.declared.columns[n][key] = val;
      });
  }
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    else if (a === '-v' || a === '--version') { console.log(VERSION); process.exit(0); }
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '-c' || a === '--contract') o.contract = argv[++i];
    else if (a === '-C' || a === '--config') o.config = argv[++i];
    else if (a === '-f' || a === '--format') o.format = argv[++i];
    else if (a === '-r' || a === '--rules') o.rules = argv[++i];
    else if (a === '--emit-rules') o.emitRules = argv[++i] || 'sift.rules.json';
    else if (a === '--in') o.read.format = argv[++i];
    else if (a === '--delimiter') o.read.delimiter = argv[++i];
    else if (a === '--encoding') o.read.encoding = argv[++i];
    else if (a === '--max-rows') o.read.maxRows = +argv[++i];
    else if (a === '--ignore') o.ignore = String(argv[++i]).split(',');
    else if (a === '--only') o.only = String(argv[++i]).split(',');
    else if (a === '--fail-on') o.failOn = argv[++i];
    else if (a === '--max-age') o.maxAge = argv[++i];
    else if (a === '--track') o.track = argv[++i];
    else if (a === '--row-deviation') o.rowDeviation = +argv[++i];
    else if (a === '--sla') {
      var slaVal = argv[++i];
      var slaParts = slaVal.split(/(?=[+-])/);
      o.sla = { by: slaParts[0] };
      if (slaParts[1]) o.sla.timezone = slaParts[1];
    }
    else if (a === '--no-regression') o.noRegression = true;
    else if (a === '--gate') {
      // --gate "sla_breach=info,row_count_deviation=warning,empty_file=off"
      o.declared.rules.gates = o.declared.rules.gates || {};
      String(argv[++i]).split(',').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv.length === 2) o.declared.rules.gates[kv[0].trim()] = kv[1].trim();
      });
    }
    else if (a === '--conditional') {
      // --conditional "status=refunded:refund_amount.not_null"
      var cond = String(argv[++i]);
      var cp = cond.split(':');
      if (cp.length === 2) {
        var whenParts = cp[0].split('='), thenParts = cp[1].split('.');
        var whenSpec = { column: whenParts[0] };
        if (whenParts[1]) {
          if (whenParts[1].indexOf('|') >= 0) whenSpec.in = whenParts[1].split('|');
          else whenSpec.equals = whenParts[1];
        } else whenSpec.not_null = true;
        var thenSpec = { column: thenParts[0] };
        if (thenParts[1] === 'not_null') thenSpec.not_null = true;
        else if (thenParts[1]) {
          if (thenParts[1].indexOf('|') >= 0) thenSpec.in = thenParts[1].split('|');
          else thenSpec.equals = thenParts[1];
        }
        o.declared.rules.conditional = o.declared.rules.conditional || [];
        o.declared.rules.conditional.push({ when: whenSpec, then: thenSpec });
      }
    }
    else if (a === '--quarantine') o.quarantine = argv[++i];
    else if (a === '--pass-out') o.passOut = argv[++i];
    else if (a === '--webhook') o.webhook = argv[++i];
    else if (a === '--webhook-key') o.webhookKey = argv[++i];
    else if (a === '--alert-on') o.alertOn = argv[++i];
    else if (a === '--alert-always') o.alertAlways = true;
    else if (a === '--exit-zero') o.exitZero = true;
    else if (a === '--tolerance') o.tolerance = +argv[++i];
    else if (a === '--row-tolerance') o.rowTolerance = +argv[++i];
    else if (a === '--min-rows') o.declared.rules.min_rows = +argv[++i];
    else if (a === '--unique-together') {
      // repeatable: --unique-together "order_id,region" --unique-together "user_id,day"
      var cols = String(argv[++i]).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (cols.length > 1) {
        o.declared.rules.unique_together = o.declared.rules.unique_together || [];
        o.declared.rules.unique_together.push(cols);
      }
    }
    else if (a === '--allow-empty') o.declared.rules.allow_empty = true;
    else if (a === '--deviation-tolerance') o.declared.rules.value_deviation_pct = +argv[++i];
    else if (a === '--deviation') {
      // --deviation "amount=30,quantity=50"
      String(argv[++i]).split(',').forEach(function (pair) {
        var kv = pair.split('='); if (kv.length === 2) mark(kv[0], 'max_mean_deviation_pct', +kv[1]);
      });
    }
    else if (a === '--strict-columns') o.strictColumns = true;
    else if (a === '--required') mark(argv[++i], 'required', true);
    else if (a === '--optional') mark(argv[++i], 'required', false);
    else if (a === '--unique') mark(argv[++i], 'unique', true);
    else if (a === '--not-unique') mark(argv[++i], 'unique', false);
    else if (a === '--require-all') o.declared.defaults.required = 'all';
    else if (a === '--require-none') o.declared.defaults.required = 'none';
    else if (a === '--max-null') {
      String(argv[++i]).split(',').forEach(function (pair) {
        var kv = pair.split('='); if (kv.length === 2) mark(kv[0], 'max_null_pct', +kv[1]);
      });
    }
    else if (a === '--allowed') {
      var raw = String(argv[++i]), ix = raw.indexOf('=');
      if (ix > 0) mark(raw.slice(0, ix), 'allowed_values', raw.slice(ix + 1).split('|'));
    }
    else if (a === '--range') {
      var r = String(argv[++i]), rix = r.indexOf('=');
      if (rix > 0) {
        var col = r.slice(0, rix), b = r.slice(rix + 1).split(':');
        if (b[0] !== '') mark(col, 'min', +b[0]);
        if (b[1] !== undefined && b[1] !== '') mark(col, 'max', +b[1]);
      }
    }
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '--no-color') { Object.keys(C).forEach(function (k) { C[k] = ''; }); }
    else if (a[0] === '-' && a !== '-') { console.error('Unknown option: ' + a); process.exit(2); }
    else o._.push(a);
  }
  return o;
}

function collectDeclared(o) {
  var merged = { columns: {}, rules: {}, defaults: {} };
  function absorb(src) {
    if (!src) return;
    if (src.defaults) Object.keys(src.defaults).forEach(function (k) { merged.defaults[k] = src.defaults[k]; });
    if (src.rules) Object.keys(src.rules).forEach(function (k) { merged.rules[k] = src.rules[k]; });
    var cols = src.columns || {};
    Object.keys(cols).forEach(function (n) {
      merged.columns[n] = merged.columns[n] || {};
      Object.keys(cols[n]).forEach(function (k) { merged.columns[n][k] = cols[n][k]; });
    });
  }
  if (o.rules) {
    var rf;
    try { rf = JSON.parse(fs.readFileSync(o.rules, 'utf8')); }
    catch (e) { die('Cannot read rules file: ' + e.message); }
    delete rf._README; absorb(rf);
  }
  if (o.carry) absorb(o.carry);
  absorb(o.declared);
  return merged;
}

function die(msg) { console.error(msg); process.exit(2); }

/* ================= column filtering ================= */
function globRe(pattern) {
  return new RegExp('^' + String(pattern).trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
function filterFields(fields, o) {
  var out = fields;
  if (o.only) {
    var only = o.only.map(globRe);
    out = out.filter(function (f) { return only.some(function (r) { return r.test(f); }); });
  }
  if (o.ignore) {
    var ig = o.ignore.map(globRe);
    out = out.filter(function (f) { return !ig.some(function (r) { return r.test(f); }); });
  }
  return out.length ? out : fields;
}

/* ================= streaming profile ================= */
function profileFile(file, o, done) {
  var acc = null, err = null, stat = null;
  try { if (file !== '-') stat = fs.statSync(file); } catch (e) { return done(e); }
  var estTotal = stat ? Math.max(1, Math.round(stat.size / 120)) : 10000;

  reader.readRows(file, o.read || {}, {
    onHeader: function (f) {
      acc = new pipe.Accumulator(filterFields(f, o), {
        compositeKeys: o.compositeKeys || [],
        conditionalRules: o.conditionalRules || []
      });
      acc.estTotal = estTotal;
    },
    onRow: function (row, i) { acc.push(row, i); },
    onEnd: function (meta) {
      if (err) return;
      if (!acc) return done(new Error('no rows found'));
      var p = acc.finalize();
      p.meta = meta; p.file = file;
      p.mtime = stat ? stat.mtime : null;
      p.size = stat ? stat.size : 0;
      done(null, p);
    },
    onError: function (e) { if (!err) { err = e; done(e); } }
  });
}

function profileEach(files, o, each, finish) {
  var i = 0;
  (function next() {
    if (i >= files.length) return finish();
    var f = files[i++];
    profileFile(f, o, function (e, p) { each(f, e, p, next); });
  })();
}

function resolveFiles(patterns) {
  if (patterns.length === 1 && patterns[0] === '-') return ['-'];
  var files = reader.expandAll(patterns);
  if (!files.length) die('No files matched: ' + patterns.join(', '));
  return files;
}

/* ================= commands ================= */
function cmdProfile(o) {
  if (!o._.length) usage(2);
  var files = resolveFiles(o._), results = [];
  profileEach(files, o, function (f, e, p, next) {
    if (e) { console.error(C.red + 'error' + C.off + ' ' + f + ': ' + e.message); return next(); }
    var list = core.issues(p), sc = core.score(list);
    results.push({ file: f, p: p, list: list, score: sc });
    if (o.format === 'human') printProfile(f, p, list, sc);
    next();
  }, function () {
    if (o.format === 'json') {
      out(o, JSON.stringify(results.map(function (r) {
        return {
          file: path.basename(r.file), rows: r.p.rows, columns: r.p.cols.length,
          duplicate_rows: r.p.dup, duplicates_approximate: !!r.p.dup_approximate,
          score: r.score, verdict: core.grade(r.score),
          findings: r.list.map(function (i) {
            return { severity: i.severity, title: i.title, detail: i.detail, hours: i.hours };
          }),
          personal_data: r.p.pii,
          column_detail: r.p.cols.map(function (c) {
            return {
              name: c.name, type: c.type, null_pct: +c.nullPct.toFixed(2),
              distinct: c.distinct, is_key: !!c.isKey, min: c.min, max: c.max
            };
          })
        };
      }), null, 2));
    }
    if (results.length > 1 && o.format === 'human') {
      var avg = Math.round(results.reduce(function (a, r) { return a + r.score; }, 0) / results.length);
      console.log('  ' + C.dim + results.length + ' files · average score ' + avg + '/100' + C.off + '\n');
    }
  });
}

function printProfile(file, p, list, sc) {
  var col = sc >= 75 ? C.grn : sc >= 45 ? C.yel : C.red;
  console.log('');
  console.log('  ' + C.bold + path.basename(file) + C.off + C.dim + '  ' +
    p.rows.toLocaleString() + ' rows · ' + p.cols.length + ' columns · ' + fmtBytes(p.size) + C.off);
  console.log('  ' + col + C.bold + sc + '/100' + C.off + '  ' + core.grade(sc));
  console.log('');
  if (!list.length) console.log('  ' + C.grn + 'No structural issues found.' + C.off);
  list.forEach(function (i) {
    var c = i.severity === 'critical' ? C.red : i.severity === 'warning' ? C.yel : C.blu;
    console.log('  ' + c + pad(i.severity, 9) + C.off + ' ' + i.title);
    if (i.detail) console.log('  ' + C.dim + '          ' + trunc(i.detail, 76) + C.off);
  });
  if (p.dup_approximate)
    console.log('  ' + C.dim + '          (duplicate count stopped at the dedupe limit)' + C.off);
  var lo = list.reduce(function (a, i) { return a + i.hours[0]; }, 0);
  var hi = list.reduce(function (a, i) { return a + i.hours[1]; }, 0);
  if (list.length) console.log('\n  ' + C.dim + 'Estimated remediation: ' + lo + '–' + hi + ' hours' + C.off);
  console.log('');
}

function cmdContract(o) {
  var file = o._[0];
  if (!file) usage(2);

  // Read any existing contract FIRST — its declared rules (including
  // unique_together) must be known before profiling starts, because
  // composite-key tracking has to be told which column combinations to
  // watch while the file streams past, not after.
  if (o.contract) {
    try {
      var prev = JSON.parse(fs.readFileSync(o.contract, 'utf8'));
      o.carry = prev.declared || null;
    } catch (e2) { die('Cannot read existing contract: ' + e2.message); }
  }
  var declaredSoFar = collectDeclared(o);
  o.compositeKeys = (declaredSoFar.rules && declaredSoFar.rules.unique_together) || [];

  profileFile(file, o, function (e, p) {
    if (e) die('Cannot read ' + file + ': ' + e.message);
    if (o.emitRules) {
      fs.writeFileSync(o.emitRules, JSON.stringify(core.emitRulesTemplate(p), null, 2));
      if (!o.quiet) {
        console.log('Wrote ' + o.emitRules);
        console.log(C.dim + '  Edit it, then: sift contract ' + path.basename(file) +
          ' -r ' + o.emitRules + ' -o contract.json' + C.off);
      }
      return;
    }
    if (o.contract && !o.quiet && o.carry && o.carry.columns)
      console.log(C.dim + '  Carrying forward ' + Object.keys(o.carry.columns).length +
        ' declared column rule(s) from ' + path.basename(o.contract) + C.off);

    var c = core.buildContract(p, {
      source: path.basename(file), tolerance: o.tolerance, rowTolerance: o.rowTolerance,
      strictColumns: o.strictColumns, declared: declaredSoFar
    });
    out(o, JSON.stringify(c, null, 2));
    if (o.out && !o.quiet) {
      console.log(C.dim + '  ' + c.columns.length + ' columns · ' +
        c.columns.filter(function (x) { return x.required; }).length + ' required · ' +
        c.columns.filter(function (x) { return x.unique; }).length + ' unique · ' +
        c.columns.filter(function (x) { return x.pii; }).length + ' personal data · ' +
        c.columns.filter(function (x) { return x.declared; }).length + ' with declared rules' +
        (c.rules.unique_together && c.rules.unique_together.length
          ? ' · ' + c.rules.unique_together.length + ' composite key(s)' : '') + C.off);
    }
  });
}

function loadContract(p) {
  var c;
  try { c = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die('Cannot read contract: ' + e.message); }
  if (!c.sift_contract) die('Not a Sift contract file: ' + p);
  return c;
}

function cmdCheck(o, silentFinish) {
  if (!o._.length || !o.contract) usage(2);
  var contract = loadContract(o.contract);
  var files = resolveFiles(o._);
  var all = [];
  o.compositeKeys = (contract.rules && contract.rules.unique_together) || [];
  o.conditionalRules = (contract.rules && contract.rules.conditional) || [];

  profileEach(files, o, function (f, e, p, next) {
    if (e) {
      all.push({ file: f, passed: false, breached: 1, violations: [
        { severity: 'critical', code: 'unreadable', message: e.message, origin: 'inferred' }] });
      return next();
    }
    // Merge CLI-specified gates into the contract (CLI wins over contract)
    var cliGates = (o.declared && o.declared.rules && o.declared.rules.gates) || {};
    if (Object.keys(cliGates).length) {
      contract.rules = contract.rules || {};
      contract.rules.gates = contract.rules.gates || {};
      Object.keys(cliGates).forEach(function (k) { contract.rules.gates[k] = cliGates[k]; });
    }
    var v = core.checkContract(contract, p);
    var rec_score = null;

    if (o.maxAge && p.mtime) {
      var ms = pipe.parseDuration(o.maxAge);
      if (ms == null) die('Bad --max-age value: ' + o.maxAge);
      var age = Date.now() - p.mtime.getTime();
      if (age > ms) v.unshift({
        severity: 'critical', code: 'stale_file', origin: 'declared', column: null,
        message: 'File is ' + fmtAge(age) + ' old, beyond the ' + o.maxAge + ' freshness window.'
      });
    }

    // Row-count deviation against rolling history
    var rowDevTol = o.rowDeviation || (contract.rules && contract.rules.row_deviation_pct);
    if (rowDevTol && o.track) {
      var hist = pipe.loadHistory(o.track);
      var devV = pipe.checkRowDeviation(p.rows, hist, rowDevTol);
      if (devV) v.push(devV);
    }

    // SLA check
    var slaSpec = o.sla || (contract.rules && contract.rules.sla);
    if (slaSpec && p.mtime) {
      var slaV = pipe.checkSLA(p.mtime, slaSpec);
      if (slaV) v.push(slaV);
    }

    // No-regression gate — score must be >= last passing run's score
    var noReg = o.noRegression || (contract.rules && contract.rules.no_regression);
    if (noReg && o.track) {
      var list = core.issues(p), sc = core.score(list);
      var regV = pipe.checkRegression(sc, pipe.loadHistory(o.track));
      if (regV) v.push(regV);
      rec_score = sc; // save for history
    }

    var threshold = o.failOn === 'none' ? 99 : SEV_RANK[o.failOn];
    if (threshold === undefined) die('Bad --fail-on value.');
    var breached = v.filter(function (x) { return SEV_RANK[x.severity] >= threshold; });
    var rec = { file: f, passed: breached.length === 0, violations: v,
                breached: breached.length, rows: p.rows, columns: p.cols.length };

    // Append to history AFTER the pass/fail decision, so this run's
    // count doesn't contaminate its own baseline
    if (o.track) {
      pipe.appendHistory(o.track, {
        date: new Date().toISOString().slice(0, 10),
        file: path.basename(f),
        rows: p.rows,
        passed: rec.passed,
        score: rec_score
      });
    }

    if (o.quarantine || o.passOut) {
      splitRows(f, o, contract, function (err, counts) {
        if (!err) rec.split = counts;
        all.push(rec); next();
      });
    } else { all.push(rec); next(); }
  }, function () { finishCheck(o, all, silentFinish); });
}

function finishCheck(o, all, silentFinish) {
  var passed = all.every(function (r) { return r.passed; });

  if (o.format === 'json') {
    out(o, JSON.stringify({
      contract: path.basename(o.contract), passed: passed,
      files: all.map(function (r) {
        return { file: path.basename(r.file), passed: r.passed, rows: r.rows,
                 violations: r.violations, quarantine: r.split || null };
      })
    }, null, 2));
  } else if (o.format === 'junit') out(o, junit(all));
  else if (o.format === 'markdown') out(o, markdown(all, passed));
  else if (!o.quiet || !passed) {
    all.forEach(function (r) {
      console.log('');
      console.log('  ' + C.bold + path.basename(r.file) + C.off + C.dim +
        ' vs ' + path.basename(o.contract) + C.off);
      if (!r.violations.length) console.log('  ' + C.grn + 'PASS' + C.off + '  contract satisfied.');
      else {
        r.violations.forEach(function (x) {
          var c = x.severity === 'critical' ? C.red : x.severity === 'warning' ? C.yel : C.blu;
          var tag = x.origin === 'declared' ? C.dim + ' [declared rule]' + C.off : '';
          if (x.gated) tag += C.dim + ' [gated]' + C.off;
          console.log('  ' + c + pad(x.severity, 9) + C.off + ' ' + x.message + tag);
        });
        console.log('');
        console.log(r.passed
          ? '  ' + C.yel + 'PASS' + C.off + '  ' + r.violations.length + ' finding(s) below the threshold.'
          : '  ' + C.red + 'FAIL' + C.off + '  ' + r.breached + ' violation(s) at or above ' + o.failOn + '.');
      }
      if (r.split)
        console.log('  ' + C.dim + r.split.passed.toLocaleString() + ' rows passed · ' +
          r.split.quarantined.toLocaleString() + ' quarantined' + C.off);
    });
    if (all.length > 1)
      console.log('\n  ' + (passed ? C.grn + 'ALL PASSED' : C.red + 'FAILED') + C.off + '  ' +
        all.filter(function (r) { return r.passed; }).length + '/' + all.length + ' files\n');
    else console.log('');
  }

  var code = (passed || o.exitZero) ? 0 : 1;
  if (o.webhook) {
    var alertThreshold = SEV_RANK[o.alertOn || o.failOn];
    var alertHit = alertThreshold === undefined ? !passed : all.some(function (r) {
      return r.violations.some(function (v) { return SEV_RANK[v.severity] >= alertThreshold; });
    });
    if (alertHit || (passed && o.alertAlways)) {
      postWebhook(o.webhook, {
        contract: path.basename(o.contract), passed: passed, alerted: alertHit,
        files: all
      }, o, function () { silentFinish ? silentFinish(code, all) : process.exit(code); });
    } else if (silentFinish) silentFinish(code, all);
    else process.exit(code);
  } else if (silentFinish) silentFinish(code, all);
  else process.exit(code);
}

/* ---- row-level split ---- */
function splitRows(file, o, contract, done) {
  var validate = pipe.rowValidator(contract);
  var fields = null, qStream = null, pStream = null;
  var counts = { passed: 0, quarantined: 0 };

  reader.readRows(file, o.read || {}, {
    onHeader: function (f) {
      fields = f;
      if (o.quarantine) {
        ensureDir(o.quarantine);
        qStream = fs.createWriteStream(o.quarantine);
        qStream.write(csvLine(fields.concat(['_sift_row', '_sift_errors'])));
      }
      if (o.passOut) {
        ensureDir(o.passOut);
        pStream = fs.createWriteStream(o.passOut);
        pStream.write(csvLine(fields));
      }
    },
    onRow: function (row, i) {
      var errs = validate(row);
      if (errs) {
        counts.quarantined++;
        if (qStream) qStream.write(csvLine(
          fields.map(function (f) { return row[f]; }).concat([String(i + 2), errs.join('; ')])));
      } else {
        counts.passed++;
        if (pStream) pStream.write(csvLine(fields.map(function (f) { return row[f]; })));
      }
    },
    onEnd: function () {
      var pending = 0;
      if (qStream) { pending++; qStream.end(fin); }
      if (pStream) { pending++; pStream.end(fin); }
      if (!pending) done(null, counts);
      function fin() { if (--pending <= 0) done(null, counts); }
    },
    onError: function (e) { done(e); }
  });
}

function csvLine(vals) {
  return vals.map(function (v) {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(',') + '\n';
}

/* ---- diff ---- */
function cmdDiff(o) {
  if (o._.length < 2) usage(2);
  profileFile(o._[0], o, function (e1, a) {
    if (e1) die('Cannot read ' + o._[0] + ': ' + e1.message);
    profileFile(o._[1], o, function (e2, b) {
      if (e2) die('Cannot read ' + o._[1] + ': ' + e2.message);
      var d = diffProfiles(a, b);
      if (o.format === 'json') { out(o, JSON.stringify(d, null, 2)); return; }
      console.log('');
      console.log('  ' + C.bold + path.basename(o._[0]) + C.off + C.dim + '  →  ' + C.off +
        C.bold + path.basename(o._[1]) + C.off);
      console.log('  ' + C.dim + a.rows.toLocaleString() + ' → ' + b.rows.toLocaleString() +
        ' rows (' + (d.row_delta >= 0 ? '+' : '') + d.row_delta.toLocaleString() + ')' + C.off);
      console.log('');
      if (!d.added.length && !d.removed.length && !d.changed.length)
        console.log('  ' + C.grn + 'No schema drift.' + C.off);
      d.removed.forEach(function (n) { console.log('  ' + C.red + pad('removed', 9) + C.off + ' ' + n); });
      d.added.forEach(function (n) { console.log('  ' + C.yel + pad('added', 9) + C.off + ' ' + n); });
      d.changed.forEach(function (c) {
        var bits = [];
        if (c.type_shift) bits.push(c.type_from + ' → ' + c.type_to);
        if (c.null_shift) bits.push('null ' + c.null_from.toFixed(1) + '% → ' + c.null_to.toFixed(1) + '%');
        console.log('  ' + (c.type_shift ? C.red : C.yel) + pad(c.type_shift ? 'type' : 'nulls', 9) +
          C.off + ' ' + c.name + C.dim + '  ' + bits.join(' · ') + C.off);
      });
      console.log('');
      var drifted = d.added.length + d.removed.length + d.changed.length;
      process.exit(drifted && !o.exitZero ? 1 : 0);
    });
  });
}

function diffProfiles(a, b) {
  var an = a.cols.map(function (c) { return c.name; });
  var bn = b.cols.map(function (c) { return c.name; });
  var changed = [];
  an.forEach(function (n) {
    if (bn.indexOf(n) < 0) return;
    var ca = a.cols[an.indexOf(n)], cb = b.cols[bn.indexOf(n)];
    var ts = ca.type !== cb.type, ns = Math.abs(ca.nullPct - cb.nullPct) >= 5;
    if (ts || ns) changed.push({
      name: n, type_shift: ts, type_from: ca.type, type_to: cb.type,
      null_shift: ns, null_from: ca.nullPct, null_to: cb.nullPct
    });
  });
  return {
    rows_from: a.rows, rows_to: b.rows, row_delta: b.rows - a.rows,
    added: bn.filter(function (x) { return an.indexOf(x) < 0; }),
    removed: an.filter(function (x) { return bn.indexOf(x) < 0; }),
    changed: changed
  };
}

/* ---- config-driven run ---- */
function cmdInit(o) {
  var p = o.out || 'sift.config.json';
  if (fs.existsSync(p)) die(p + ' already exists.');
  fs.writeFileSync(p, JSON.stringify({
    _README: 'Run every check with: sift run',
    failOn: 'critical',
    checks: [{
      name: 'orders',
      files: 'data/orders*.csv',
      contract: 'contracts/orders.json',
      maxAge: '24h',
      quarantine: 'quarantine/orders_rejects.csv'
    }]
  }, null, 2));
  console.log('Wrote ' + p);
  console.log(C.dim + '  Generate a contract:  sift contract data/orders.csv -o contracts/orders.json' + C.off);
  console.log(C.dim + '  Then run everything:  sift run' + C.off);
}

function cmdRun(o) {
  var cfgPath = o.config || 'sift.config.json';
  var cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { die('Cannot read ' + cfgPath + ': ' + e.message + '\nRun `sift init` to create one.'); }
  var checks = cfg.checks || [];
  if (!checks.length) die('No checks defined in ' + cfgPath);

  // paths inside a config are relative to the config file, not the shell's cwd,
  // so `sift run -C configs/prod.json` works from anywhere in the repo
  var base = path.dirname(path.resolve(cfgPath));
  function rel(p) {
    if (!p) return p;
    return path.isAbsolute(p) ? p : path.join(base, p);
  }

  var worst = 0, summary = [], i = 0;
  (function next() {
    if (i >= checks.length) {
      if (!o.quiet) {
        console.log('');
        summary.forEach(function (s) {
          console.log('  ' + (s.ok ? C.grn + 'PASS' : C.red + 'FAIL') + C.off + '  ' +
            pad(s.name, 20) + C.dim + s.detail + C.off);
        });
        console.log('');
      }
      process.exit(o.exitZero ? 0 : worst);
    }
    var chk = checks[i++];
    var sub = args([]);
    sub.format = o.format;
    sub.quiet = o.quiet;
    sub._ = (Array.isArray(chk.files) ? chk.files : [chk.files]).map(rel);
    sub.contract = rel(chk.contract);
    sub.failOn = chk.failOn || cfg.failOn || 'critical';
    sub.maxAge = chk.maxAge;
    sub.quarantine = rel(chk.quarantine);
    sub.passOut = rel(chk.passOut);
    sub.track = rel(chk.track || cfg.track);
    sub.rowDeviation = chk.rowDeviation || cfg.rowDeviation;
    sub.sla = chk.sla || cfg.sla;
    sub.noRegression = chk.noRegression || chk.no_regression || cfg.noRegression || cfg.no_regression;
    sub.webhook = chk.webhook || cfg.webhook;
    sub.webhookKey = chk.webhookKey || cfg.webhookKey;
    sub.alertOn = chk.alertOn || cfg.alertOn;
    sub.alertAlways = chk.alertAlways || cfg.alertAlways;
    sub.read = chk.read || {};
    sub.ignore = chk.ignore;
    sub.only = chk.only;
    if (!o.quiet && o.format === 'human') console.log('\n' + C.dim + '-- ' + (chk.name || chk.files) + C.off);
    cmdCheck(sub, function (code, all) {
      if (code > worst) worst = code;
      summary.push({
        name: chk.name || path.basename(String(chk.files)),
        ok: code === 0,
        detail: all.filter(function (r) { return r.passed; }).length + '/' + all.length + ' files'
      });
      next();
    });
  })();
}

/* ================= output formats ================= */
function junit(all) {
  var total = 0, failures = 0;
  all.forEach(function (r) {
    total += Math.max(1, r.violations.length);
    failures += r.violations.filter(function (x) { return x.severity !== 'info'; }).length;
  });
  var x = '<?xml version="1.0" encoding="UTF-8"?>\n';
  x += '<testsuites name="sift" tests="' + total + '" failures="' + failures + '">\n';
  all.forEach(function (r) {
    var f = r.violations.filter(function (v) { return v.severity !== 'info'; }).length;
    x += '  <testsuite name="' + esc(path.basename(r.file)) + '" tests="' +
      Math.max(1, r.violations.length) + '" failures="' + f + '">\n';
    if (!r.violations.length) x += '    <testcase name="contract satisfied" classname="sift" />\n';
    r.violations.forEach(function (v, ix) {
      x += '    <testcase name="' + esc(v.code) + '-' + ix + '" classname="sift.' + esc(v.severity) + '">';
      if (v.severity === 'info') x += '</testcase>\n';
      else x += '\n      <failure message="' + esc(v.message) + '" type="' + esc(v.code) + '" />\n    </testcase>\n';
    });
    x += '  </testsuite>\n';
  });
  return x + '</testsuites>\n';
}

function markdown(all, passed) {
  var m = '### Sift data check\n\n' + (passed ? '**Passed**' : '**Failed**') + ' - ' +
    all.filter(function (r) { return r.passed; }).length + '/' + all.length + ' files\n\n';
  all.forEach(function (r) {
    m += '#### `' + path.basename(r.file) + '` — ' + (r.passed ? 'passed' : 'failed') +
      ' · ' + (r.rows || 0).toLocaleString() + ' rows\n\n';
    if (!r.violations.length) { m += 'Contract satisfied.\n\n'; return; }
    m += '| Severity | Check | Rule | Detail |\n|---|---|---|---|\n';
    r.violations.forEach(function (v) {
      m += '| ' + v.severity + ' | `' + v.code + '` | ' + (v.origin || 'inferred') +
        ' | ' + v.message.replace(/\|/g, '\\|') + ' |\n';
    });
    if (r.split) m += '\n' + r.split.passed.toLocaleString() + ' rows passed, ' +
      r.split.quarantined.toLocaleString() + ' quarantined.\n';
    m += '\n';
  });
  return m;
}

function postWebhook(url, payload, o, done) {
  if (typeof fetch !== 'function') { console.error('Webhooks need Node 18+.'); return done(); }
  var key = o.webhookKey || process.env.SIFT_WEBHOOK_KEY || '';
  var status = payload.passed ? 'PASS' : 'FAIL';
  var summary = payload.files.map(function (f) {
    return (f.passed ? 'PASS' : 'FAIL') + ' ' + path.basename(f.file) +
      (f.violations && f.violations.length ? ' — ' + f.violations[0].message : '');
  }).join('\n');
  var title = 'Sift: ' + status + ' — ' + payload.contract;

  var body, headers = { 'content-type': 'application/json' };

  if (/hooks\.slack\.com/.test(url)) {
    // Slack incoming webhook — structured blocks
    body = JSON.stringify({
      text: title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title } },
        { type: 'section', text: { type: 'mrkdwn', text: '```\n' + summary + '\n```' } }
      ]
    });
  } else if (/webhook\.office\.com|\.webhook\.office365\.com/.test(url)) {
    // Microsoft Teams
    body = JSON.stringify({
      '@type': 'MessageCard', summary: title,
      themeColor: payload.passed ? '2E7D6E' : '9B2C1E',
      title: title, text: summary.replace(/\n/g, '<br/>')
    });
  } else if (/discord\.com\/api\/webhooks|discordapp\.com\/api\/webhooks/.test(url)) {
    // Discord
    body = JSON.stringify({
      embeds: [{
        title: title,
        description: '```\n' + summary + '\n```',
        color: payload.passed ? 0x2E7D6E : 0x9B2C1E
      }]
    });
  } else if (/events\.pagerduty\.com/.test(url)) {
    // PagerDuty Events API v2
    body = JSON.stringify({
      routing_key: key,
      event_action: payload.passed ? 'resolve' : 'trigger',
      payload: {
        summary: title + '\n' + summary,
        source: 'sift-data',
        severity: payload.passed ? 'info' : 'critical',
        custom_details: payload
      }
    });
  } else {
    // Generic — full JSON payload
    body = JSON.stringify(payload);
  }

  fetch(url, { method: 'POST', headers: headers, body: body })
    .then(function (r) {
      if (!r.ok) console.error('Webhook returned HTTP ' + r.status);
      done();
    }, function (e) {
      console.error('Webhook failed: ' + e.message); done();
    });
}

/* ================= helpers ================= */
function ensureDir(p) {
  var dir = path.dirname(p);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function out(o, text) {
  if (o.out) { ensureDir(o.out); fs.writeFileSync(o.out, text); if (!o.quiet) console.log('Wrote ' + o.out); }
  else console.log(text);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
  });
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function fmtBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtAge(ms) {
  var h = ms / 36e5;
  return h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd';
}

/* ================= dispatch ================= */
var argv = process.argv.slice(2);
if (!argv.length) usage(0);
var cmd = argv[0];
var o = args(argv.slice(1));
if (cmd === 'profile') cmdProfile(o);
else if (cmd === 'contract') cmdContract(o);
else if (cmd === 'check') cmdCheck(o);
else if (cmd === 'diff') cmdDiff(o);
else if (cmd === 'run') cmdRun(o);
else if (cmd === 'init') cmdInit(o);
else if (cmd === '-h' || cmd === '--help') usage(0);
else if (cmd === '-v' || cmd === '--version') { console.log(VERSION); process.exit(0); }
else { console.error('Unknown command: ' + cmd); usage(2); }
