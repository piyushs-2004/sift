'use strict';

/* ------------------------------------------------------------------ *
 * RFC 4180 CSV parser. No dependencies — handles quoted fields,
 * embedded delimiters, embedded newlines and doubled quotes.
 * ------------------------------------------------------------------ */
function detectDelimiter(head) {
  var cands = [',', '\t', ';', '|'];
  var best = ',', bestScore = -1;
  cands.forEach(function (d) {
    var lines = head.split('\n').slice(0, 5).filter(Boolean);
    if (!lines.length) return;
    var counts = lines.map(function (l) { return l.split(d).length; });
    var first = counts[0];
    if (first < 2) return;
    var consistent = counts.every(function (c) { return c === first; });
    var score = (consistent ? 1000 : 0) + first;
    if (score > bestScore) { bestScore = score; best = d; }
  });
  return best;
}

function parseCSV(text, opts) {
  opts = opts || {};
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var delim = opts.delimiter || detectDelimiter(text.slice(0, 8192));
  var maxRows = opts.maxRows || Infinity;

  var rows = [], field = '', row = [], inQuotes = false, i = 0, n = text.length;

  while (i < n) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length > maxRows) break;
      i++; continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) throw new Error('file is empty');

  var header = rows[0].map(function (h, ix) {
    var s = String(h == null ? '' : h).trim();
    return s || 'column_' + (ix + 1);
  });
  var seen = {};
  header = header.map(function (h) {
    if (seen[h]) { seen[h]++; return h + '_' + seen[h]; }
    seen[h] = 1; return h;
  });

  var data = [];
  for (var r = 1; r < rows.length && data.length < maxRows; r++) {
    var raw = rows[r], o = {};
    for (var c = 0; c < header.length; c++) o[header[c]] = raw[c] == null ? '' : raw[c];
    data.push(o);
  }
  return { fields: header, rows: data, delimiter: delim };
}

/* ------------------------------------------------------------------ *
 * Type inference
 * ------------------------------------------------------------------ */
var RE_INT = /^-?\d{1,18}$/,
    RE_DEC = /^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/,
    RE_BOOL = /^(true|false|t|f|yes|no|y|n)$/i,
    RE_DATE = /^\d{4}-\d{2}-\d{2}$/,
    RE_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
    RE_US = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
    RE_EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

var NULLISH = {
  '': 1, 'null': 1, 'NULL': 1, 'na': 1, 'NA': 1, 'n/a': 1, 'N/A': 1,
  'nan': 1, 'NaN': 1, 'none': 1, 'None': 1, '-': 1, '--': 1, '#N/A': 1
};

function isNull(v) { return v == null || NULLISH[v] === 1 || String(v).trim() === ''; }

function classify(v) {
  if (RE_INT.test(v)) return 'integer';
  if (RE_DEC.test(v)) return 'decimal';
  if (RE_TS.test(v)) return 'timestamp';
  if (RE_DATE.test(v) || RE_US.test(v)) return 'date';
  if (RE_BOOL.test(v)) return 'boolean';
  if (RE_EMAIL.test(v)) return 'email';
  return 'string';
}

function resolve(counts) {
  var k = Object.keys(counts);
  if (!k.length) return 'empty';
  if (k.length === 1) return k[0];
  if (k.length === 2 && counts.integer && counts.decimal) return 'decimal';
  if (k.length === 2 && counts.date && counts.timestamp) return 'timestamp';
  return 'string';
}

/* type widening: is `found` acceptable where `expected` was promised? */
var WIDENS = {
  integer: ['integer'],
  decimal: ['integer', 'decimal'],
  timestamp: ['date', 'timestamp'],
  date: ['date'],
  boolean: ['boolean'],
  email: ['email'],
  string: ['integer', 'decimal', 'date', 'timestamp', 'boolean', 'email', 'string', 'empty'],
  empty: ['empty']
};
function typeCompatible(expected, found) {
  if (found === 'empty') return true;
  var ok = WIDENS[expected] || [expected];
  return ok.indexOf(found) >= 0;
}

/* ------------------------------------------------------------------ *
 * PII detection
 * ------------------------------------------------------------------ */
var RE_PHONE_IN = /^(\+?91[-\s]?)?[6-9]\d{9}$/,
    RE_PHONE_GEN = /^\+?\d[\d\s\-().]{8,17}\d$/,
    RE_CARDISH = /^\d[\d\s-]{12,21}\d$/,
    RE_IP = /^(\d{1,3}\.){3}\d{1,3}$/,
    RE_AADHAARISH = /^\d{4}\s?\d{4}\s?\d{4}$/,
    RE_PANISH = /^[A-Z]{5}\d{4}[A-Z]$/,
    NAME_HINT = /(email|e_mail|mail|phone|mobile|contact|address|addr|dob|birth|passport|aadhaar|aadhar|pan|ssn|card|account|acct|salary|postcode|zip|pincode|name)/i;

function luhn(s) {
  var d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  var sum = 0, alt = false;
  for (var i = d.length - 1; i >= 0; i--) {
    var n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function scanPII(cols) {
  var hits = [];
  cols.forEach(function (c) {
    var vals = Object.keys(c.uniq).slice(0, 400);
    if (!vals.length) return;
    function share(fn) {
      var m = 0;
      vals.forEach(function (v) { if (fn(v)) m++; });
      return m / vals.length;
    }
    var kind = null, conf = 0;
    var e = share(function (v) { return RE_EMAIL.test(v); }),
        pIN = share(function (v) { return RE_PHONE_IN.test(v.replace(/[\s-]/g, '')); }),
        pG = share(function (v) { return RE_PHONE_GEN.test(v); }),
        cd = share(function (v) { return RE_CARDISH.test(v) && luhn(v); }),
        ad = share(function (v) { return RE_AADHAARISH.test(v); }),
        pan = share(function (v) { return RE_PANISH.test(v); }),
        ip = share(function (v) { return RE_IP.test(v); });

    if (e > .6) { kind = 'email'; conf = e; }
    else if (cd > .6) { kind = 'payment_card'; conf = cd; }
    else if (pan > .6) { kind = 'tax_id'; conf = pan; }
    else if (ad > .6 && c.type !== 'integer') { kind = 'government_id'; conf = ad; }
    else if (pIN > .6) { kind = 'mobile_number'; conf = pIN; }
    else if (pG > .7 && c.type === 'string') { kind = 'phone_number'; conf = pG; }
    else if (ip > .6) { kind = 'ip_address'; conf = ip; }
    else if (NAME_HINT.test(c.name) && c.distinct > Math.max(3, c.nonNull * .4)) {
      kind = 'likely_personal_by_name'; conf = .5;
    }
    if (kind) hits.push({ column: c.name, kind: kind, confidence: +conf.toFixed(2) });
  });
  return hits;
}

/* ------------------------------------------------------------------ *
 * Profiling
 * ------------------------------------------------------------------ */
var BUCKETS = 40;

function profile(rows, fields) {
  if (!fields.length) throw new Error('no header row detected');
  var n = rows.length;
  var cols = fields.map(function (name) {
    return {
      name: name, nulls: 0, ws: 0, tc: {}, uniq: Object.create(null), distinct: 0,
      nums: [], lens: [], b: new Array(BUCKETS).fill(0), bn: new Array(BUCKETS).fill(0)
    };
  });
  var seen = Object.create(null), dup = 0;

  for (var i = 0; i < n; i++) {
    var row = rows[i], bi = n ? Math.min(BUCKETS - 1, Math.floor(i / n * BUCKETS)) : 0;
    for (var ci = 0; ci < cols.length; ci++) {
      var c = cols[ci], raw = row[c.name];
      c.bn[bi]++;
      if (isNull(raw)) { c.nulls++; continue; }
      c.b[bi]++;
      var s = String(raw);
      if (s !== s.trim()) c.ws++;
      var t = s.trim(), k = classify(t);
      c.tc[k] = (c.tc[k] || 0) + 1;
      if (c.distinct < 60000 && c.uniq[t] === undefined) { c.uniq[t] = 0; c.distinct++; }
      if (c.uniq[t] !== undefined) c.uniq[t]++;
      c.lens.push(t.length);
      if (k === 'integer' || k === 'decimal') {
        var f = parseFloat(t);
        if (isFinite(f) && c.nums.length < 200000) c.nums.push(f);
      }
    }
    var sig = fields.map(function (f) { return row[f]; }).join('\u241F');
    if (seen[sig]) dup++; else seen[sig] = 1;
  }

  cols.forEach(function (c) {
    c.rows = n; c.nonNull = n - c.nulls; c.nullPct = n ? c.nulls / n * 100 : 0;
    c.type = resolve(c.tc);
    c.mixed = Object.keys(c.tc).length > 1 && c.type === 'string';
    if (c.lens.length) c.maxLen = Math.max.apply(null, c.lens);
    if (c.nums.length) {
      var s = c.nums.slice().sort(function (a, b) { return a - b; });
      var q1 = qt(s, .25), q3 = qt(s, .75), iqr = q3 - q1;
      c.min = s[0]; c.max = s[s.length - 1];
      c.outliers = iqr > 0 ? s.filter(function (v) { return v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr; }).length : 0;
    }
    c.isKey = c.nonNull === n && n > 0 && c.distinct === n;
    c.isConst = c.distinct === 1 && c.nonNull > 0;
    c.truncated = sum(c.bn.slice(-5)) > 0 && c.nonNull > 0 && sum(c.b.slice(-5)) === 0 && c.nullPct < 90;
  });

  var p = { rows: n, cols: cols, dup: dup };
  p.pii = scanPII(cols);
  return p;
}

function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
function qt(s, q) {
  var p = (s.length - 1) * q, b = Math.floor(p), r = p - b;
  return s[b + 1] !== undefined ? s[b] + r * (s[b + 1] - s[b]) : s[b];
}

/* ------------------------------------------------------------------ *
 * Findings + score (same model as the web app)
 * ------------------------------------------------------------------ */
function issues(p) {
  var o = [];
  function add(sev, w, h, t, d) { o.push({ severity: sev, weight: w, hours: h, title: t, detail: d }); }
  var nm = function (a) { return a.map(function (c) { return c.name; }).join(', '); };

  if (p.dup > 0) {
    var dp = p.dup / p.rows * 100;
    add(dp > 5 ? 'critical' : 'warning', dp > 5 ? 18 : 9, dp > 5 ? [3, 6] : [1, 3],
      'Deduplicate ' + p.dup + ' repeated rows',
      p.dup + ' rows (' + dp.toFixed(1) + '%) are exact duplicates.');
  }
  var keyUnknown = p.cols.some(function (c) { return c.keyUnknown; });
  if (!p.cols.some(function (c) { return c.isKey; }) && p.rows > 0 && !keyUnknown)
    add('critical', 20, [2, 5], 'Establish a primary key',
      'No single column uniquely identifies a row.');

  var tr = p.cols.filter(function (c) { return c.truncated; });
  if (tr.length) add('critical', 22, [2, 4], 'Investigate a likely truncated export',
    nm(tr) + ' stop carrying values partway through the file.');

  var em = p.cols.filter(function (c) { return c.type === 'empty'; });
  if (em.length) add('warning', 6, [.5, 1], 'Drop ' + em.length + ' empty column(s)', nm(em));

  var bn = p.cols.filter(function (c) { return c.nullPct >= 50 && c.type !== 'empty'; });
  if (bn.length) add('critical', 14, [2, 4], 'Resolve ' + bn.length + ' mostly-empty column(s)', nm(bn));

  var mn = p.cols.filter(function (c) { return c.nullPct >= 15 && c.nullPct < 50; });
  if (mn.length) add('warning', 7, [1, 2], 'Define null handling for ' + mn.length + ' column(s)', nm(mn));

  var mx = p.cols.filter(function (c) { return c.mixed; });
  if (mx.length) add('critical', 16, [2, 5], 'Normalise ' + mx.length + ' mixed-format column(s)', nm(mx));

  var ws = p.cols.filter(function (c) { return c.ws > 0; });
  if (ws.length) add('warning', 10, [.5, 2], 'Trim whitespace in ' + ws.length + ' column(s)', nm(ws));

  var cn = p.cols.filter(function (c) { return c.isConst; });
  if (cn.length) add('info', 3, [.5, 1], 'Review ' + cn.length + ' single-value column(s)', nm(cn));

  var ol = p.cols.filter(function (c) { return c.outliers > 0 && c.outliers / c.nonNull > .02; });
  if (ol.length) add('info', 4, [1, 3], 'Check outliers in ' + ol.length + ' numeric column(s)', nm(ol));

  if (p.pii.length) add('critical', 12, [1, 3], 'Handle ' + p.pii.length + ' column(s) of personal data',
    p.pii.map(function (h) { return h.column + ' (' + h.kind + ')'; }).join(', '));

  var ord = { critical: 0, warning: 1, info: 2 };
  o.sort(function (a, b) { return ord[a.severity] - ord[b.severity] || b.weight - a.weight; });
  return o;
}

function score(list) {
  return Math.max(4, Math.min(100, Math.round(100 - list.reduce(function (a, i) { return a + i.weight; }, 0))));
}
function grade(v) {
  if (v >= 90) return 'production ready';
  if (v >= 75) return 'minor cleanup';
  if (v >= 55) return 'needs work';
  if (v >= 35) return 'high risk';
  return 'do not load';
}

/* ------------------------------------------------------------------ *
 * Contracts
 *
 * Two layers:
 *   inferred  — what the sample file demonstrates
 *   declared  — what a human decided matters, which always wins and
 *               survives regeneration against a new sample
 * ------------------------------------------------------------------ */

var COLUMN_RULES = ['required', 'unique', 'max_null_pct', 'type', 'pii', 'description',
                    'allowed_values', 'min', 'max'];
var GLOBAL_RULES = ['allow_new_columns', 'allow_missing_columns', 'max_row_drop_pct',
                    'max_duplicate_pct', 'null_tolerance_pp', 'min_rows'];

function normaliseDeclared(declared) {
  var out = { columns: {}, rules: {}, defaults: {} };
  if (!declared) return out;
  if (declared.columns) out.columns = declared.columns;
  else {
    // allow a flat shape: { "order_id": { required: true } }
    Object.keys(declared).forEach(function (k) {
      if (k !== 'rules' && k !== 'defaults' && declared[k] && typeof declared[k] === 'object')
        out.columns[k] = declared[k];
    });
  }
  if (declared.rules) out.rules = declared.rules;
  if (declared.defaults) out.defaults = declared.defaults;

  // "infer" (or null) hands a key back to inference, so a generated template
  // can list every knob without silently pinning all of them
  var clean = {};
  Object.keys(out.columns).forEach(function (name) {
    var src = out.columns[name] || {}, dst = {};
    Object.keys(src).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      if (src[k] === 'infer' || src[k] === null) return;
      dst[k] = src[k];
    });
    if (Object.keys(dst).length) clean[name] = dst;
  });
  out.columns = clean;

  Object.keys(out.defaults).forEach(function (k) {
    if (out.defaults[k] === 'infer' || out.defaults[k] === null) delete out.defaults[k];
  });
  Object.keys(out.rules).forEach(function (k) {
    if (out.rules[k] === 'infer' || out.rules[k] === null) delete out.rules[k];
  });
  return out;
}

function buildContract(p, opts) {
  opts = opts || {};
  var d = normaliseDeclared(opts.declared);
  var def = d.defaults || {};

  var tol = pick(def.null_tolerance_pp, opts.tolerance, 5);
  var rowTol = pick(def.max_row_drop_pct, opts.rowTolerance, 30);

  // policy for `required` when a human hasn't said: infer | all | none
  var reqPolicy = def.required || opts.requiredPolicy || 'infer';

  var globals = {
    allow_new_columns: opts.strictColumns ? false : true,
    allow_missing_columns: false,
    max_row_drop_pct: rowTol,
    max_duplicate_pct: p.rows ? Math.max(1, +(p.dup / p.rows * 100 + 1).toFixed(2)) : 1,
    null_tolerance_pp: tol
  };
  GLOBAL_RULES.forEach(function (k) {
    if (d.rules[k] !== undefined) globals[k] = d.rules[k];
  });

  var declaredOut = {};

  var columns = p.cols.map(function (c) {
    var dec = d.columns[c.name] || {};
    var inferred = {
      type: c.type,
      required: reqPolicy === 'all' ? true : reqPolicy === 'none' ? false : c.nulls === 0,
      unique: !!c.isKey,
      max_null_pct: +Math.min(100, c.nullPct + tol).toFixed(2),
      pii: (p.pii.filter(function (h) { return h.column === c.name; })[0] || {}).kind || null
    };

    var spec = { name: c.name }, declaredKeys = [];
    COLUMN_RULES.forEach(function (k) {
      if (dec[k] !== undefined) { spec[k] = dec[k]; declaredKeys.push(k); }
      else if (inferred[k] !== undefined) spec[k] = inferred[k];
    });
    // a declared `required: true` implies zero null tolerance unless stated
    if (dec.required === true && dec.max_null_pct === undefined) spec.max_null_pct = 0;
    if (declaredKeys.length) {
      spec.declared = declaredKeys;
      declaredOut[c.name] = {};
      declaredKeys.forEach(function (k) { declaredOut[c.name][k] = dec[k]; });
    }
    return spec;
  });

  // keep declared rules for columns absent from this sample — the human
  // asked for them, so a regeneration must not quietly forget them
  Object.keys(d.columns).forEach(function (name) {
    if (!declaredOut[name] && !columns.some(function (c) { return c.name === name; })) {
      declaredOut[name] = d.columns[name];
      var spec = { name: name, declared: Object.keys(d.columns[name]) };
      COLUMN_RULES.forEach(function (k) {
        if (d.columns[name][k] !== undefined) spec[k] = d.columns[name][k];
      });
      if (spec.type === undefined) spec.type = 'string';
      columns.push(spec);
    }
  });

  var out = {
    sift_contract: 1,
    generated: new Date().toISOString(),
    source: opts.source || null,
    baseline: { rows: p.rows, columns: p.cols.length },
    rules: globals,
    columns: columns
  };
  if (Object.keys(declaredOut).length || Object.keys(d.rules).length || Object.keys(def).length) {
    out.declared = {};
    if (Object.keys(def).length) out.declared.defaults = def;
    if (Object.keys(d.rules).length) out.declared.rules = d.rules;
    if (Object.keys(declaredOut).length) out.declared.columns = declaredOut;
  }
  return out;
}

function pick() {
  for (var i = 0; i < arguments.length; i++)
    if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
}

/* Produce a starter rules file a client can edit by hand.
   Every knob is listed as "infer" so the template changes nothing until
   a human replaces a value. The _inferred line shows what Sift saw. */
function emitRulesTemplate(p) {
  var cols = {};
  p.cols.forEach(function (c) {
    cols[c.name] = {
      _inferred: c.type + ', ' + c.nullPct.toFixed(1) + '% null, ' +
                 c.distinct + ' distinct' + (c.isKey ? ', unique' : ''),
      required: 'infer',
      unique: 'infer',
      max_null_pct: 'infer'
    };
  });
  return {
    _README: [
      'Replace "infer" with a value to pin a rule. Leave it to let Sift decide from the data.',
      'These settings override inference and survive regeneration against a new sample file.',
      'Column keys: required, unique, max_null_pct, type, allowed_values, min, max, description, pii.',
      'defaults.required accepts: infer | all | none.',
      'Apply with:  sift contract <file> -r <this file> -o contract.json'
    ],
    defaults: { required: 'infer', null_tolerance_pp: 5, max_row_drop_pct: 30 },
    rules: { allow_new_columns: true, allow_missing_columns: false },
    columns: cols
  };
}

function checkContract(contract, p) {
  var v = [];
  function fail(sev, code, msg, spec, rule) {
    var declared = spec && spec.declared && spec.declared.indexOf(rule) >= 0;
    v.push({
      severity: sev, code: code, message: msg,
      origin: declared ? 'declared' : 'inferred',
      column: spec ? spec.name : null
    });
  }

  var byName = {};
  p.cols.forEach(function (c) { byName[c.name] = c; });
  var expected = {};
  contract.columns.forEach(function (c) { expected[c.name] = c; });
  var rules = contract.rules || {};

  contract.columns.forEach(function (spec) {
    var got = byName[spec.name];
    if (!got) {
      if (rules.allow_missing_columns)
        fail('warning', 'column_missing', 'Column "' + spec.name + '" is absent.', spec, 'name');
      else
        fail('critical', 'column_missing', 'Column "' + spec.name + '" is missing from the file.', spec, 'name');
      return;
    }
    if (spec.type && !typeCompatible(spec.type, got.type))
      fail('critical', 'type_changed',
        'Column "' + spec.name + '" was ' + spec.type + ', is now ' + got.type + '.', spec, 'type');

    if (spec.required && got.nulls > 0)
      fail('critical', 'null_in_required',
        'Column "' + spec.name + '" is required but has ' + got.nulls + ' null value(s).', spec, 'required');

    if (spec.max_null_pct != null && got.nullPct > spec.max_null_pct + 1e-9)
      fail('warning', 'null_rate_exceeded',
        'Column "' + spec.name + '" is ' + got.nullPct.toFixed(1) +
        '% null, above the ceiling of ' + spec.max_null_pct + '%.', spec, 'max_null_pct');

    if (spec.unique && !got.isKey) {
      if (got.distinct < got.nonNull)
        fail('critical', 'uniqueness_lost',
          'Column "' + spec.name + '" is no longer unique — ' +
          (got.nonNull - got.distinct) + ' repeated value(s) across ' + got.nonNull + '.', spec, 'unique');
      else if (got.nulls > 0 && !spec.required)
        fail('critical', 'uniqueness_lost',
          'Column "' + spec.name + '" can no longer serve as a key: values are still distinct but ' +
          got.nulls + ' row(s) are null.', spec, 'unique');
    }

    if (spec.allowed_values && spec.allowed_values.length) {
      var allowed = {};
      spec.allowed_values.forEach(function (x) { allowed[String(x)] = 1; });
      var bad = Object.keys(got.uniq).filter(function (x) { return !allowed[x]; });
      if (bad.length)
        fail('critical', 'value_not_allowed',
          'Column "' + spec.name + '" contains ' + bad.length + ' value(s) outside the allowed set: ' +
          bad.slice(0, 5).map(function (x) { return '"' + x + '"'; }).join(', ') +
          (bad.length > 5 ? '…' : '') + '.', spec, 'allowed_values');
    }

    if (spec.min != null && got.min != null && got.min < spec.min)
      fail('critical', 'below_min',
        'Column "' + spec.name + '" has a minimum of ' + got.min + ', below the agreed ' + spec.min + '.',
        spec, 'min');
    if (spec.max != null && got.max != null && got.max > spec.max)
      fail('critical', 'above_max',
        'Column "' + spec.name + '" has a maximum of ' + got.max + ', above the agreed ' + spec.max + '.',
        spec, 'max');
  });

  p.cols.forEach(function (c) {
    if (!expected[c.name]) {
      if (rules.allow_new_columns)
        fail('info', 'column_added', 'New column "' + c.name + '" is not in the contract.');
      else
        fail('warning', 'column_added', 'Unexpected new column "' + c.name + '".');
    }
  });

  var base = (contract.baseline || {}).rows || 0;
  if (rules.min_rows != null && p.rows < rules.min_rows)
    fail('critical', 'below_min_rows',
      'File has ' + p.rows + ' rows, below the agreed floor of ' + rules.min_rows + '.');
  else if (base > 0 && rules.max_row_drop_pct != null) {
    var drop = (base - p.rows) / base * 100;
    if (drop > rules.max_row_drop_pct)
      fail('critical', 'row_count_drop',
        'Row count fell ' + drop.toFixed(1) + '% (from ' + base + ' to ' + p.rows +
        '), beyond the ' + rules.max_row_drop_pct + '% allowance.');
  }
  if (rules.max_duplicate_pct != null && p.rows > 0) {
    var dp = p.dup / p.rows * 100;
    if (dp > rules.max_duplicate_pct)
      fail('warning', 'duplicates_exceeded',
        dp.toFixed(1) + '% of rows are duplicates, above the ' + rules.max_duplicate_pct + '% allowance.');
  }

  p.pii.forEach(function (h) {
    var spec = expected[h.column];
    if (spec && !spec.pii)
      fail('critical', 'unexpected_pii',
        'Column "' + h.column + '" now looks like personal data (' + h.kind +
        ') and was not declared as such.', spec, 'pii');
  });

  return v;
}

module.exports = {
  parseCSV: parseCSV, profile: profile, issues: issues, score: score, grade: grade,
  buildContract: buildContract, checkContract: checkContract, emitRulesTemplate: emitRulesTemplate,
  classify: classify, typeCompatible: typeCompatible, isNull: isNull, luhn: luhn
};
