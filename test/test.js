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

/* ---------------- go ---------------- */
console.log('sift test suite\n');
makeFixtures();
testParsing();
testInference();
testDuplicates();
testContracts();
testEnforcement();
testDurations();
testCLI();
testStreamingParity(function () {
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
