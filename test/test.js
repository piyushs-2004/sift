#!/usr/bin/env node
/* Sift test suite. No framework — run with: npm test */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var CLI = path.join(ROOT, 'bin', 'sift.js');
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-test-'));

var core = require(path.join(ROOT, 'lib', 'core.js'));
var reader = require(path.join(ROOT, 'lib', 'reader.js'));
var pipeline = require(path.join(ROOT, 'lib', 'pipeline.js'));

var passed = 0, failed = 0, failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; process.stdout.write('.'); }
  else {
    failed++; process.stdout.write('F');
    failures.push(name + (detail ? '\n      ' + detail : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    'got ' + JSON.stringify(actual) + ', wanted ' + JSON.stringify(expected));
}
function sift(args) {
  var r = cp.spawnSync(process.execPath, [CLI].concat(args),
    { encoding: 'utf8', env: Object.assign({}, process.env, { NO_COLOR: '1' }) });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function f(name) { return path.join(TMP, name); }

/* ---------------- fixtures ---------------- */
function makeFixtures() {
  var head = 'order_id,customer_email,amount,status,region,ordered_at\n';
  var good = head, i;
  for (i = 0; i < 400; i++) {
    good += [1000 + i, 'user' + i + '@shop.com', (i * 3.7).toFixed(2),
      ['paid', 'pending', 'refunded'][i % 3], ['north', 'south', 'east'][i % 3],
      '2026-08-' + String((i % 20) + 1).padStart(2, '0')].join(',') + '\n';
  }
  fs.writeFileSync(f('good.csv'), good);

  // broken: repeated keys, nulls, type break, dropped column, new column, fewer rows
  var bad = 'order_id,customer_email,amount,status,ordered_at,coupon\n';
  for (i = 0; i < 200; i++) {
    bad += [1000 + (i % 120), i % 9 ? 'user' + i + '@shop.com' : '',
      i % 4 === 0 ? 'INR ' + (i * 2) : (i * 2.5).toFixed(2),
      ['paid', 'pending'][i % 2],
      '2026-08-' + String((i % 20) + 1).padStart(2, '0'),
      i % 3 ? 'SAVE10' : ''].join(',') + '\n';
  }
  // a handful of rows carry a status outside the agreed domain, and one
  // amount far out of range, so the domain rules have something to catch
  bad += '9001,late@shop.com,50.00,CANCELLED_X,2026-08-05,\n';
  bad += '9002,huge@shop.com,999999.00,paid,2026-08-06,\n';
  fs.writeFileSync(f('bad.csv'), bad);

  fs.writeFileSync(f('nasty.csv'),
    'id,note,amt\n1,"has, comma",10\n2,"line\nbreak",20\n3,"say ""hi""",30\n4,plain,40\n');

  fs.writeFileSync(f('dupes.csv'), 'a,b\n1,x\n1,x\n1,x\n2,y\n');

  var rows = [];
  for (i = 0; i < 50; i++) rows.push({ id: i, name: 'n' + i, amt: i * 2 });
  fs.writeFileSync(f('data.ndjson'), rows.map(JSON.stringify).join('\n'));
  fs.writeFileSync(f('data.json'), JSON.stringify(rows));

  fs.writeFileSync(f('tabbed.tsv'), 'a\tb\tc\n1\t2\t3\n4\t5\t6\n');
}

/* ---------------- unit: parsing ---------------- */
function testParsing() {
  var d = core.parseCSV(fs.readFileSync(f('nasty.csv'), 'utf8'));
  eq('quoted comma', d.rows[0].note, 'has, comma');
  eq('embedded newline', d.rows[1].note, 'line\nbreak');
  eq('doubled quote', d.rows[2].note, 'say "hi"');
  eq('plain field', d.rows[3].note, 'plain');

  var t = core.parseCSV(fs.readFileSync(f('tabbed.tsv'), 'utf8'));
  eq('tab autodetect', t.fields, ['a', 'b', 'c']);

  var dup = core.parseCSV('a,a,b\n1,2,3\n');
  eq('duplicate headers renamed', dup.fields, ['a', 'a_2', 'b']);

  // the streaming state machine must survive 1-byte chunks
  var text = fs.readFileSync(f('nasty.csv'), 'utf8');
  var m = new reader.CsvMachine(','), got = [];
  for (var i = 0; i < text.length; i++) m.push(text[i], function (r) { got.push(r); });
  m.end(function (r) { got.push(r); });
  eq('byte-by-byte quoted comma', got[1][1], 'has, comma');
  eq('byte-by-byte doubled quote', got[3][1], 'say "hi"');
  eq('byte-by-byte row count', got.length, 5);
}

/* ---------------- unit: inference ---------------- */
function testInference() {
  eq('int', core.classify('42'), 'integer');
  eq('negative int', core.classify('-7'), 'integer');
  eq('decimal', core.classify('3.14'), 'decimal');
  eq('date', core.classify('2026-08-23'), 'date');
  eq('timestamp', core.classify('2026-08-23T10:30'), 'timestamp');
  eq('bool', core.classify('true'), 'boolean');
  eq('email', core.classify('a@b.co'), 'email');
  eq('string', core.classify('INR 400'), 'string');

  ok('decimal accepts integer', core.typeCompatible('decimal', 'integer'));
  ok('integer rejects string', !core.typeCompatible('integer', 'string'));
  ok('anything accepts empty', core.typeCompatible('integer', 'empty'));
  ok('string accepts all', core.typeCompatible('string', 'integer'));

  ok('luhn valid', core.luhn('4539578763621486'));
  ok('luhn invalid', !core.luhn('1234567890123'));
}

/* ---------------- unit: streaming parity ---------------- */
function testStreamingParity(done) {
  var whole = core.parseCSV(fs.readFileSync(f('good.csv'), 'utf8'));
  var wp = core.profile(whole.rows, whole.fields);
  var acc;
  reader.readRows(f('good.csv'), {}, {
    onHeader: function (fields) { acc = new pipeline.Accumulator(fields); acc.estTotal = 400; },
    onRow: function (row, i) { acc.push(row, i); },
    onEnd: function () {
      var sp = acc.finalize();
      eq('stream row count', sp.rows, wp.rows);
      eq('stream types', sp.cols.map(function (c) { return c.type; }),
        wp.cols.map(function (c) { return c.type; }));
      eq('stream distinct', sp.cols.map(function (c) { return c.distinct; }),
        wp.cols.map(function (c) { return c.distinct; }));
      eq('stream isKey', sp.cols.map(function (c) { return !!c.isKey; }),
        wp.cols.map(function (c) { return !!c.isKey; }));
      eq('stream pii', sp.pii.length, wp.pii.length);
      done();
    },
    onError: function (e) { ok('streaming parity', false, e.message); done(); }
  });
}

/* ---------------- unit: duplicates and keys ---------------- */
function testDuplicates() {
  var d = core.parseCSV(fs.readFileSync(f('dupes.csv'), 'utf8'));
  var p = core.profile(d.rows, d.fields);
  eq('exact duplicate rows', p.dup, 2);
  ok('no false key', !p.cols[0].isKey);

  var g = core.parseCSV(fs.readFileSync(f('good.csv'), 'utf8'));
  var gp = core.profile(g.rows, g.fields);
  ok('finds real key', gp.cols[0].isKey === true);
  eq('no duplicates in clean file', gp.dup, 0);
}

/* ---------------- unit: contracts ---------------- */
function testContracts() {
  var g = core.parseCSV(fs.readFileSync(f('good.csv'), 'utf8'));
  var gp = core.profile(g.rows, g.fields);

  var plain = core.buildContract(gp, { source: 'good.csv' });
  ok('contract has columns', plain.columns.length === 6);
  ok('key inferred unique', plain.columns[0].unique === true);

  // an unedited template must be a no-op
  var tpl = core.emitRulesTemplate(gp);
  var fromTpl = core.buildContract(gp, { source: 'good.csv', declared: tpl });
  var a = JSON.parse(JSON.stringify(plain)), b = JSON.parse(JSON.stringify(fromTpl));
  delete a.generated; delete b.generated; delete a.declared; delete b.declared;
  eq('unedited rules template is a no-op', b, a);

  // declared rules win over inference
  var declared = { columns: { customer_email: { required: false }, region: { unique: true } } };
  var tuned = core.buildContract(gp, { source: 'good.csv', declared: declared });
  var email = tuned.columns.filter(function (c) { return c.name === 'customer_email'; })[0];
  var region = tuned.columns.filter(function (c) { return c.name === 'region'; })[0];
  eq('declared required wins', email.required, false);
  eq('declared unique wins', region.unique, true);
  ok('declared keys recorded', email.declared.indexOf('required') >= 0);

  // required implies zero null tolerance
  var req = core.buildContract(gp, { declared: { columns: { region: { required: true } } } });
  var r = req.columns.filter(function (c) { return c.name === 'region'; })[0];
  eq('required implies zero null ceiling', r.max_null_pct, 0);

  // regeneration must not launder a breakage
  var bd = core.parseCSV(fs.readFileSync(f('bad.csv'), 'utf8'));
  var bp = core.profile(bd.rows, bd.fields);
  var regen = core.buildContract(bp, { declared: tuned.declared });
  var keptRegion = regen.columns.filter(function (c) { return c.name === 'region'; })[0];
  ok('declared rule survives a missing column', keptRegion && keptRegion.unique === true);
}

/* ---------------- unit: enforcement ---------------- */
function testEnforcement() {
  var g = core.parseCSV(fs.readFileSync(f('good.csv'), 'utf8'));
  var gp = core.profile(g.rows, g.fields);
  var contract = core.buildContract(gp, { source: 'good.csv' });

  eq('clean file passes its own contract', core.checkContract(contract, gp).length, 0);

  var bd = core.parseCSV(fs.readFileSync(f('bad.csv'), 'utf8'));
  var bp = core.profile(bd.rows, bd.fields);
  var v = core.checkContract(contract, bp);
  var codes = v.map(function (x) { return x.code; });

  ok('detects missing column', codes.indexOf('column_missing') >= 0);
  ok('detects new column', codes.indexOf('column_added') >= 0);
  ok('detects type change', codes.indexOf('type_changed') >= 0);
  ok('detects lost uniqueness', codes.indexOf('uniqueness_lost') >= 0);
  ok('detects row drop', codes.indexOf('row_count_drop') >= 0);
  ok('violations carry origin', v.every(function (x) { return x.origin; }));

  // domain rules
  var dom = core.buildContract(gp, {
    declared: { columns: {
      status: { allowed_values: ['paid', 'pending', 'refunded'] },
      amount: { min: 0, max: 1000 }
    } }
  });
  var dv = core.checkContract(dom, bp).map(function (x) { return x.code; });
  ok('detects disallowed value', dv.indexOf('value_not_allowed') >= 0);
  ok('detects out-of-range number', dv.indexOf('above_max') >= 0);

  // row-level validation
  var validate = pipeline.rowValidator(dom);
  ok('row validator passes a good row',
    validate({ order_id: '1', status: 'paid', amount: '50' }) === null);
  ok('row validator catches a bad value',
    (validate({ order_id: '1', status: 'nope', amount: '50' }) || []).length === 1);
  ok('row validator catches an out-of-range number',
    (validate({ order_id: '1', status: 'paid', amount: '99999' }) || []).length === 1);
}

/* ---------------- unit: durations ---------------- */
function testDurations() {
  eq('30m', pipeline.parseDuration('30m'), 1800000);
  eq('6h', pipeline.parseDuration('6h'), 21600000);
  eq('2d', pipeline.parseDuration('2d'), 172800000);
  eq('bare number defaults to hours', pipeline.parseDuration('12'), 43200000);
  eq('rejects nonsense', pipeline.parseDuration('soon'), null);
}

/* ---------------- integration: the CLI ---------------- */
function testCLI() {
  eq('profile exits 0', sift(['profile', f('good.csv')]).code, 0);
  eq('profile ndjson', sift(['profile', f('data.ndjson')]).code, 0);
  eq('profile json', sift(['profile', f('data.json')]).code, 0);
  eq('profile glob', sift(['profile', path.join(TMP, '*.csv')]).code, 0);
  eq('version', sift(['--version']).code, 0);
  eq('unknown flag exits 2', sift(['profile', '--nope']).code, 2);
  eq('no match exits 2', sift(['profile', path.join(TMP, 'zzz*.csv')]).code, 2);

  var c = f('contract.json');
  eq('contract writes', sift(['contract', f('good.csv'), '-o', c, '-q']).code, 0);
  ok('contract file exists', fs.existsSync(c));

  eq('check passes on clean', sift(['check', f('good.csv'), '-c', c, '-q']).code, 0);
  eq('check fails on broken', sift(['check', f('bad.csv'), '-c', c, '-q']).code, 1);
  eq('exit-zero suppresses failure',
    sift(['check', f('bad.csv'), '-c', c, '-q', '--exit-zero']).code, 0);
  eq('fail-on none passes',
    sift(['check', f('bad.csv'), '-c', c, '-q', '--fail-on', 'none']).code, 0);

  var j = sift(['check', f('bad.csv'), '-c', c, '-f', 'json', '--exit-zero']);
  var parsed = JSON.parse(j.out);
  ok('json output parses', parsed.passed === false);
  ok('json lists violations', parsed.files[0].violations.length > 0);

  var x = sift(['check', f('bad.csv'), '-c', c, '-f', 'junit', '--exit-zero']);
  ok('junit is well-formed', /^<\?xml/.test(x.out.trim()) && /<\/testsuites>/.test(x.out));

  var md = sift(['check', f('bad.csv'), '-c', c, '-f', 'markdown', '--exit-zero']);
  ok('markdown has a table', md.out.indexOf('| Severity |') >= 0);

  eq('diff detects drift', sift(['diff', f('good.csv'), f('bad.csv')]).code, 1);
  eq('diff on identical files', sift(['diff', f('good.csv'), f('good.csv')]).code, 0);

  // declared rules through CLI flags
  var tc = f('tuned.json');
  sift(['contract', f('good.csv'), '--required', 'order_id', '--optional', 'customer_email',
    '--allowed', 'status=paid|pending|refunded', '--range', 'amount=0:1000', '-o', tc, '-q']);
  var tuned = JSON.parse(fs.readFileSync(tc, 'utf8'));
  var oid = tuned.columns.filter(function (x) { return x.name === 'order_id'; })[0];
  ok('flag sets declared rule', oid.declared && oid.declared.indexOf('required') >= 0);

  // quarantine
  var q = f('rejects.csv'), pOut = f('clean.csv');
  sift(['check', f('bad.csv'), '-c', tc, '--quarantine', q, '--pass-out', pOut, '-q', '--exit-zero']);
  ok('quarantine written', fs.existsSync(q));
  ok('pass-out written', fs.existsSync(pOut));
  var qh = fs.readFileSync(q, 'utf8').split('\n')[0];
  ok('quarantine has reason columns',
    qh.indexOf('_sift_row') >= 0 && qh.indexOf('_sift_errors') >= 0);

  // freshness
  var old = f('old.csv');
  fs.copyFileSync(f('good.csv'), old);
  var past = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(old, past, past);
  eq('stale file fails', sift(['check', old, '-c', c, '-q', '--max-age', '24h']).code, 1);
  eq('fresh window passes', sift(['check', old, '-c', c, '-q', '--max-age', '7d']).code, 0);

  // column filters
  var only = JSON.parse(sift(['profile', f('good.csv'), '--only', 'order_id,amount', '-f', 'json']).out);
  eq('--only filters columns', only[0].column_detail.length, 2);
  var ig = JSON.parse(sift(['profile', f('good.csv'), '--ignore', 'customer_*', '-f', 'json']).out);
  eq('--ignore filters columns', ig[0].column_detail.length, 5);

  // config-driven run, with paths relative to the config
  var cfgDir = path.join(TMP, 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'sift.config.json'), JSON.stringify({
    failOn: 'critical',
    checks: [
      { name: 'clean', files: '../good.csv', contract: '../contract.json' },
      { name: 'broken', files: '../bad.csv', contract: '../contract.json' }
    ]
  }));
  eq('run fails when any check fails',
    sift(['run', '-C', path.join(cfgDir, 'sift.config.json'), '-q']).code, 1);
}

/* ---------------- unit: empty files ---------------- */
function testEmptyFile() {
  fs.writeFileSync(f('empty.csv'), 'a,b,c\n');
  var d = core.parseCSV(fs.readFileSync(f('empty.csv'), 'utf8'));
  var p = core.profile(d.rows, d.fields);
  ok('empty profile flag', p.empty === true);
  eq('empty profile rows', p.rows, 0);

  var list = core.issues(p);
  eq('empty file has exactly one finding', list.length, 1);
  eq('empty file finding is critical', list[0].severity, 'critical');
  ok('empty file finding mentions zero rows', list[0].title.indexOf('no data rows') >= 0);

  var g = core.parseCSV(fs.readFileSync(f('good.csv'), 'utf8'));
  var contract = core.buildContract(core.profile(g.rows, g.fields), {});
  var v = core.checkContract(contract, p);
  eq('empty file fails contract', v[0].code, 'empty_file');
  eq('empty file short-circuits (only 1 violation)', v.length, 1);

  var lenient = core.buildContract(core.profile(g.rows, g.fields),
    { declared: { rules: { allow_empty: true } } });
  var v2 = core.checkContract(lenient, p);
  eq('allow_empty downgrades to info', v2[0].severity, 'info');
}

/* ---------------- unit: composite uniqueness ---------------- */
function testCompositeUniqueness() {
  var rows = [
    { id: '1', region: 'north', val: '10' },
    { id: '1', region: 'south', val: '20' },
    { id: '2', region: 'north', val: '30' },
    { id: '1', region: 'north', val: '40' }  // duplicates (1, north)
  ];
  var p = core.profile(rows, ['id', 'region', 'val'], { compositeKeys: [['id', 'region']] });
  eq('composite key detected repeats', p.compositeKeys[0].repeats, 1);
  ok('composite key not unique', p.compositeKeys[0].unique === false);

  var clean = rows.slice(0, 3);
  var pc = core.profile(clean, ['id', 'region', 'val'], { compositeKeys: [['id', 'region']] });
  ok('clean composite is unique', pc.compositeKeys[0].unique === true);

  // contract enforcement
  var contract = core.buildContract(pc, {
    declared: { rules: { unique_together: [['id', 'region']] } }
  });
  ok('contract has unique_together',
    contract.rules.unique_together && contract.rules.unique_together.length === 1);

  var v1 = core.checkContract(contract, pc);
  eq('clean composite passes', v1.filter(function (x) { return x.code === 'composite_uniqueness_lost'; }).length, 0);

  var v2 = core.checkContract(contract, p);
  eq('broken composite fails', v2.filter(function (x) { return x.code === 'composite_uniqueness_lost'; }).length, 1);
  ok('composite failure is declared', v2.filter(function (x) { return x.code === 'composite_uniqueness_lost'; })[0].origin === 'declared');
}

/* ---------------- unit: composite uniqueness in streaming path ---------------- */
function testCompositeStreaming(done) {
  var rows = [
    { id: '1', region: 'north', val: '10' },
    { id: '1', region: 'south', val: '20' },
    { id: '2', region: 'north', val: '30' },
    { id: '1', region: 'north', val: '40' }  // duplicate
  ];
  var acc = new pipeline.Accumulator(['id', 'region', 'val'], { compositeKeys: [['id', 'region']] });
  rows.forEach(function (r, i) { acc.push(r, i); });
  var p = acc.finalize();
  eq('streaming composite repeats', p.compositeKeys[0].repeats, 1);
  ok('streaming composite not unique', p.compositeKeys[0].unique === false);
  done();
}

/* ---------------- unit: value deviation ---------------- */
function testDeviation() {
  var base = [];
  for (var i = 0; i < 100; i++) base.push({ id: '' + i, amount: '' + (50 + i % 10) });
  var bp = core.profile(base, ['id', 'amount']);
  var contract = core.buildContract(bp, {
    declared: { rules: { value_deviation_pct: 30 } }
  });
  ok('contract has baseline stats', contract.columns.filter(function (c) { return c.name === 'amount'; })[0].stats != null);

  // same data should pass
  var v1 = core.checkContract(contract, bp);
  eq('no deviation on same data', v1.filter(function (x) { return x.code === 'value_deviation'; }).length, 0);

  // 50x shift should fail
  var shifted = base.map(function (r) { return { id: r.id, amount: '' + (r.amount * 50) }; });
  var sp = core.profile(shifted, ['id', 'amount']);
  var v2 = core.checkContract(contract, sp);
  eq('50x shift fires deviation', v2.filter(function (x) { return x.code === 'value_deviation'; }).length, 1);
  ok('large deviation is critical', v2.filter(function (x) { return x.code === 'value_deviation'; })[0].severity === 'critical');

  // small shift within tolerance should pass
  var nudged = base.map(function (r) { return { id: r.id, amount: '' + (parseFloat(r.amount) * 1.1) }; });
  var np = core.profile(nudged, ['id', 'amount']);
  var v3 = core.checkContract(contract, np);
  eq('10% shift within 30% tolerance passes', v3.filter(function (x) { return x.code === 'value_deviation'; }).length, 0);

  // per-column override
  var perCol = core.buildContract(bp, {
    declared: { columns: { amount: { max_mean_deviation_pct: 5 } } }
  });
  var v4 = core.checkContract(perCol, np);
  eq('10% shift with 5% per-column tolerance fails', v4.filter(function (x) { return x.code === 'value_deviation'; }).length, 1);
}

/* ---------------- unit: stddev in profile ---------------- */
function testStddev() {
  var rows = [{ v: '10' }, { v: '20' }, { v: '30' }];
  var p = core.profile(rows, ['v']);
  var c = p.cols[0];
  ok('mean calculated', Math.abs(c.mean - 20) < 0.01);
  ok('stddev calculated', c.stddev > 0);
  ok('stddev is correct', Math.abs(c.stddev - 8.165) < 0.01); // sqrt(200/3)
}

/* ---------------- integration: new CLI flags ---------------- */
function testNewCLIFlags() {
  // empty file via CLI
  fs.writeFileSync(f('empty2.csv'), 'x,y\n');
  var c = f('contract2.json');
  sift(['contract', f('good.csv'), '-o', c, '-q']);
  eq('empty file check exits 1', sift(['check', f('empty2.csv'), '-c', c, '-q']).code, 1);
  var ejson = JSON.parse(sift(['check', f('empty2.csv'), '-c', c, '-f', 'json', '--exit-zero']).out);
  eq('json reports empty_file', ejson.files[0].violations[0].code, 'empty_file');

  // allow-empty
  var ac = f('allowempty.json');
  sift(['contract', f('good.csv'), '--allow-empty', '-o', ac, '-q']);
  eq('allow-empty passes empty file', sift(['check', f('empty2.csv'), '-c', ac, '-q']).code, 0);

  // composite uniqueness via CLI
  var cc = f('composite.json');
  sift(['contract', f('good.csv'), '--unique-together', 'order_id,region', '-o', cc, '-q']);
  var cjson = JSON.parse(fs.readFileSync(cc, 'utf8'));
  ok('CLI sets unique_together', cjson.rules.unique_together && cjson.rules.unique_together[0][0] === 'order_id');

  // deviation via CLI
  var dc = f('deviation.json');
  sift(['contract', f('good.csv'), '--deviation-tolerance', '20', '-o', dc, '-q']);
  var djson = JSON.parse(fs.readFileSync(dc, 'utf8'));
  eq('CLI sets deviation tolerance', djson.rules.value_deviation_pct, 20);

  // per-column deviation
  var dc2 = f('deviation2.json');
  sift(['contract', f('good.csv'), '--deviation', 'amount=10', '-o', dc2, '-q']);
  var djson2 = JSON.parse(fs.readFileSync(dc2, 'utf8'));
  var amtCol = djson2.columns.filter(function (x) { return x.name === 'amount'; })[0];
  eq('CLI sets per-column deviation', amtCol.max_mean_deviation_pct, 10);
}

/* ---------------- unit: row-count deviation ---------------- */
function testRowDeviation() {
  var hf = f('hist.json');
  for (var i = 0; i < 10; i++) {
    pipeline.appendHistory(hf, {
      date: '2026-08-' + String(i + 10).padStart(2, '0'),
      rows: 490 + i, passed: true
    });
  }
  var h = pipeline.loadHistory(hf);
  eq('history accumulates', h.runs.length, 10);
  var stats = pipeline.rowCountStats(h);
  ok('stats have a mean', stats.mean > 0);

  eq('normal count passes', pipeline.checkRowDeviation(500, h, 30), null);

  var v2 = pipeline.checkRowDeviation(50, h, 30);
  ok('huge drop fires', v2 !== null);
  eq('drop code', v2.code, 'row_count_deviation');
  ok('drop says below', v2.message.indexOf('below') >= 0);

  var v3 = pipeline.checkRowDeviation(5000, h, 30);
  ok('huge spike fires', v3 !== null);
  eq('huge spike is critical', v3.severity, 'critical');

  eq('within tolerance passes', pipeline.checkRowDeviation(380, h, 30), null);

  var hf2 = f('hist2.json');
  pipeline.appendHistory(hf2, { date: '2026-08-20', rows: 500, passed: true });
  pipeline.appendHistory(hf2, { date: '2026-08-21', rows: 510, passed: true });
  eq('too few runs returns null', pipeline.checkRowDeviation(50, pipeline.loadHistory(hf2), 30), null);

  var hf3 = f('hist3.json');
  for (var j = 0; j < 100; j++)
    pipeline.appendHistory(hf3, { date: '2026-01-01', rows: j, passed: true }, 20);
  eq('history capped', pipeline.loadHistory(hf3).runs.length, 20);
}

function testRowDeviationCLI() {
  var norm = 'id,v\n';
  for (var i = 0; i < 300; i++) norm += i + ',' + i * 2 + '\n';
  fs.writeFileSync(f('norm.csv'), norm);
  var tiny = 'id,v\n';
  for (var j = 0; j < 30; j++) tiny += j + ',' + j * 2 + '\n';
  fs.writeFileSync(f('tiny.csv'), tiny);

  var cc = f('rc.json'), hh = f('rchist.json');
  sift(['contract', f('norm.csv'), '-o', cc, '-q']);
  for (var k = 0; k < 5; k++)
    sift(['check', f('norm.csv'), '-c', cc, '-q', '--track', hh, '--row-deviation', '30', '--exit-zero']);

  var hist = JSON.parse(fs.readFileSync(hh, 'utf8'));
  eq('CLI builds history', hist.runs.length, 5);

  var r = sift(['check', f('tiny.csv'), '-c', cc, '--track', hh, '--row-deviation', '30',
    '-f', 'json', '--exit-zero']);
  var out = JSON.parse(r.out);
  var devV = out.files[0].violations.filter(function (v) { return v.code === 'row_count_deviation'; });
  eq('CLI detects row deviation', devV.length, 1);
  ok('CLI deviation says below', devV[0].message.indexOf('below') >= 0);

  eq('history grew', JSON.parse(fs.readFileSync(hh, 'utf8')).runs.length, 6);
}

/* ---------------- unit: SLA ---------------- */
function testSLA() {
  // on time
  var t1 = new Date('2026-08-24T05:30:00Z');
  var v1 = pipeline.checkSLA(t1, { by: '06:00' });
  eq('on time passes', v1, null);

  // late
  var t2 = new Date('2026-08-24T08:15:00Z');
  var v2 = pipeline.checkSLA(t2, { by: '06:00' });
  ok('late fires', v2 !== null);
  eq('late code', v2.code, 'sla_breach');
  ok('late message mentions past', v2.message.indexOf('past') >= 0);

  // with timezone offset (IST +05:30)
  var t3 = new Date('2026-08-24T01:00:00Z'); // 06:30 IST — late
  var v3 = pipeline.checkSLA(t3, { by: '06:00', timezone: '+05:30' });
  ok('IST late fires', v3 !== null);

  var t4 = new Date('2026-08-23T23:00:00Z'); // 04:30 IST — on time
  var v4 = pipeline.checkSLA(t4, { by: '06:00', timezone: '+05:30' });
  eq('IST on time passes', v4, null);

  // very late = critical
  var t5 = new Date('2026-08-24T12:00:00Z');
  var v5 = pipeline.checkSLA(t5, { by: '06:00' });
  eq('very late is critical', v5.severity, 'critical');

  // null mtime
  eq('null mtime returns null', pipeline.checkSLA(null, { by: '06:00' }), null);
}

/* ---------------- unit: conditional rules ---------------- */
function testConditionalRules() {
  var rules = [
    { when: { column: 'status', equals: 'refunded' },
      then: { column: 'refund_amount', not_null: true } },
    { when: { column: 'country', in: ['IN', 'NP'] },
      then: { column: 'currency', equals: 'INR' } }
  ];

  // evalCondition basics
  ok('equals match', pipeline.evalCondition({ status: 'refunded' }, { column: 'status', equals: 'refunded' }));
  ok('equals miss', !pipeline.evalCondition({ status: 'paid' }, { column: 'status', equals: 'refunded' }));
  ok('in match', pipeline.evalCondition({ country: 'IN' }, { column: 'country', in: ['IN', 'NP'] }));
  ok('in miss', !pipeline.evalCondition({ country: 'US' }, { column: 'country', in: ['IN', 'NP'] }));
  ok('not_null on value', pipeline.evalCondition({ x: '5' }, { column: 'x', not_null: true }));
  ok('not_null on empty', !pipeline.evalCondition({ x: '' }, { column: 'x', not_null: true }));

  // ConditionalTracker
  var tracker = new pipeline.ConditionalTracker(rules);
  tracker.push({ status: 'refunded', refund_amount: '50', country: 'IN', currency: 'INR' }); // all good
  tracker.push({ status: 'refunded', refund_amount: '', country: 'IN', currency: 'INR' });   // rule 1 violated
  tracker.push({ status: 'paid', refund_amount: '', country: 'IN', currency: 'USD' });        // rule 2 violated
  tracker.push({ status: 'paid', refund_amount: '', country: 'US', currency: 'USD' });        // neither applies

  var results = tracker.results();
  eq('rule 1: 2 matched, 1 violated', results[0].matched, 2);
  eq('rule 1: 1 violation', results[0].violated, 1);
  eq('rule 2: 3 matched', results[1].matched, 3);
  eq('rule 2: 1 violation', results[1].violated, 1);

  // streaming accumulator integration
  var rows = [
    { status: 'refunded', refund_amount: '50', country: 'IN', currency: 'INR' },
    { status: 'refunded', refund_amount: '', country: 'IN', currency: 'INR' },
    { status: 'paid', refund_amount: '', country: 'IN', currency: 'USD' }
  ];
  var acc = new pipeline.Accumulator(['status', 'refund_amount', 'country', 'currency'],
    { conditionalRules: rules });
  rows.forEach(function (r, i) { acc.push(r, i); });
  var p = acc.finalize();
  ok('profile has conditionalResults', p.conditionalResults && p.conditionalResults.length === 2);
  eq('streaming rule 1 violated', p.conditionalResults[0].violated, 1);

  // contract-level enforcement
  var baseRows = [
    { status: 'paid', refund_amount: '', country: 'IN', currency: 'INR' },
    { status: 'paid', refund_amount: '', country: 'US', currency: 'USD' }
  ];
  var bp = core.profile(baseRows, ['status', 'refund_amount', 'country', 'currency']);
  var contract = core.buildContract(bp, { declared: { rules: { conditional: rules } } });
  var v = core.checkContract(contract, p);
  var condV = v.filter(function (x) { return x.code === 'conditional_rule_violated'; });
  eq('contract catches conditional violations', condV.length, 2);
  ok('conditional violations are declared', condV[0].origin === 'declared');

  // row-level quarantine includes conditional errors
  var validate = pipeline.rowValidator(contract);
  var errs1 = validate({ status: 'refunded', refund_amount: '', country: 'IN', currency: 'INR' });
  ok('quarantine catches conditional', errs1 && errs1.length >= 1);
  var errs2 = validate({ status: 'paid', refund_amount: '', country: 'US', currency: 'USD' });
  eq('clean row passes conditional', errs2, null);
}

/* ---------------- unit: no-regression gate ---------------- */
function testNoRegression() {
  // no history — should pass
  eq('no history returns null', pipeline.checkRegression(80, { runs: [] }), null);

  // history with passing runs
  var h = { runs: [
    { date: '2026-08-20', passed: true, score: 85 },
    { date: '2026-08-21', passed: false, score: 40 },
    { date: '2026-08-22', passed: true, score: 90 }
  ] };

  // improvement — should pass
  eq('improvement passes', pipeline.checkRegression(95, h), null);

  // same score — should pass
  eq('same score passes', pipeline.checkRegression(90, h), null);

  // small drop — warning
  var v1 = pipeline.checkRegression(85, h);
  ok('small drop fires', v1 !== null);
  eq('small drop is warning', v1.severity, 'warning');
  eq('regression code', v1.code, 'quality_regression');

  // large drop — critical
  var v2 = pipeline.checkRegression(60, h);
  ok('large drop fires', v2 !== null);
  eq('large drop is critical', v2.severity, 'critical');
  ok('regression message mentions score', v2.message.indexOf('90') >= 0 && v2.message.indexOf('60') >= 0);

  // compares against last PASSING, not last run
  var h2 = { runs: [
    { date: '2026-08-20', passed: true, score: 80 },
    { date: '2026-08-21', passed: false, score: 30 }
  ] };
  eq('compares vs last passing (80), not last run (30)',
    pipeline.checkRegression(75, h2).message.indexOf('80') >= 0, true);

  // all failing runs — no passing baseline, should pass
  var h3 = { runs: [
    { date: '2026-08-20', passed: false, score: 30 },
    { date: '2026-08-21', passed: false, score: 25 }
  ] };
  eq('no passing baseline returns null', pipeline.checkRegression(20, h3), null);
}

/* ---------------- integration: new CLI flags (SLA, conditional, regression) ---------------- */
function testNewCLIIntegration() {
  // conditional via CLI flag
  var cc = f('cond.json');
  sift(['contract', f('good.csv'),
    '--conditional', 'status=paid:region.not_null',
    '-o', cc, '-q']);
  var cjson = JSON.parse(fs.readFileSync(cc, 'utf8'));
  ok('CLI sets conditional rule', cjson.rules.conditional && cjson.rules.conditional.length === 1);
  eq('conditional when column', cjson.rules.conditional[0].when.column, 'status');
  eq('conditional then column', cjson.rules.conditional[0].then.column, 'region');

  // no-regression via CLI — build history with score, then check a worse file
  var rcc = f('reg.json'), rhh = f('reghist.json');
  sift(['contract', f('good.csv'), '-o', rcc, '-q']);
  // 3 passing runs to build a baseline
  for (var k = 0; k < 3; k++)
    sift(['check', f('good.csv'), '-c', rcc, '-q', '--track', rhh, '--no-regression', '--exit-zero']);

  var hist = JSON.parse(fs.readFileSync(rhh, 'utf8'));
  ok('history records scores', hist.runs[0].score != null);

  // bad file should trigger regression
  var r = sift(['check', f('bad.csv'), '-c', rcc, '--track', rhh, '--no-regression',
    '-f', 'json', '--exit-zero']);
  var out = JSON.parse(r.out);
  var regV = out.files[0].violations.filter(function (v) { return v.code === 'quality_regression'; });
  eq('CLI catches regression', regV.length, 1);
}

/* ---------------- unit: gates (per-check severity override) ---------------- */
function testGates() {
  // set up a contract and a bad file
  var clean = [];
  for (var i = 0; i < 100; i++) clean.push({ id: '' + i, amount: '' + (50 + i), status: 'paid' });
  var cp = core.profile(clean, ['id', 'amount', 'status']);
  var contract = core.buildContract(cp, {
    declared: { columns: { status: { allowed_values: ['paid', 'pending', 'refunded'] } },
                rules: { value_deviation_pct: 20 } }
  });

  var bad = [];
  for (var j = 0; j < 60; j++) bad.push({ id: '' + j, amount: '' + (5000 + j), status: j % 3 ? 'paid' : 'INVALID' });
  var bp = core.profile(bad, ['id', 'amount', 'status']);

  // no gates: violations fire at original severity
  var v1 = core.checkContract(contract, bp);
  var crits1 = v1.filter(function (v) { return v.severity === 'critical'; });
  ok('without gates has criticals', crits1.length > 0);

  // gate to downgrade
  contract.rules.gates = {
    value_not_allowed: 'warning',
    value_deviation: 'info',
    row_count_drop: 'off'
  };
  var v2 = core.checkContract(contract, bp);
  var crits2 = v2.filter(function (v) { return v.severity === 'critical'; });
  eq('gated: no criticals remain', crits2.length, 0);
  ok('gated: findings still present', v2.length > 0);
  ok('gated: tag applied', v2.some(function (v) { return v.gated; }));

  // verify row_count_drop is suppressed
  eq('off suppresses entirely', v2.filter(function (v) { return v.code === 'row_count_drop'; }).length, 0);

  // gate to escalate: warning -> critical
  contract.rules.gates = { value_deviation: 'critical' };
  var v3 = core.checkContract(contract, bp);
  var devs = v3.filter(function (v) { return v.code === 'value_deviation'; });
  ok('escalated to critical', devs.every(function (v) { return v.severity === 'critical'; }));

  // CLI flag test
  fs.writeFileSync(f('gate_clean.csv'), 'id,status\n1,paid\n2,paid\n');
  fs.writeFileSync(f('gate_bad.csv'), 'id,status\n1,NOPE\n');
  var gc = f('gate_c.json');
  sift(['contract', f('gate_clean.csv'), '--allowed', 'status=paid|pending', '-o', gc, '-q']);
  eq('ungated fails', sift(['check', f('gate_bad.csv'), '-c', gc, '-q']).code, 1);
  eq('gated to info passes',
    sift(['check', f('gate_bad.csv'), '-c', gc, '-q', '--gate', 'value_not_allowed=info,row_count_drop=off']).code, 0);
  eq('gated to off passes',
    sift(['check', f('gate_bad.csv'), '-c', gc, '-q', '--gate', 'value_not_allowed=off,row_count_drop=off']).code, 0);

  // contract-level gates
  var cj = JSON.parse(fs.readFileSync(gc, 'utf8'));
  cj.rules.gates = { value_not_allowed: 'info', row_count_drop: 'off' };
  fs.writeFileSync(gc, JSON.stringify(cj));
  eq('contract-level gate passes', sift(['check', f('gate_bad.csv'), '-c', gc, '-q']).code, 0);
}

console.log('sift test suite\n');
makeFixtures();
testParsing();
testInference();
testDuplicates();
testContracts();
testEnforcement();
testDurations();
testCLI();
testEmptyFile();
testCompositeUniqueness();
testDeviation();
testStddev();
testNewCLIFlags();
testRowDeviation();
testRowDeviationCLI();
testSLA();
testConditionalRules();
testNoRegression();
testNewCLIIntegration();
testGates();
testStreamingParity(function () {
  testCompositeStreaming(function () {
    console.log('\n');
    if (failures.length) {
      console.log('Failures:');
      failures.forEach(function (x) { console.log('  - ' + x); });
      console.log('');
    }
    console.log(passed + ' passed, ' + failed + ' failed');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(failed ? 1 : 0);
  });
});
