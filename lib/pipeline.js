'use strict';

var core = require('./core.js');

var BUCKETS = 40;

/* ------------------------------------------------------------------ *
 * HashBag — a growable Float64Array of 53-bit hashes.
 *
 * Uniqueness and duplicate detection only need to know whether a value
 * was seen before, never the value itself. Keeping the strings costs
 * ~80 bytes each; a hash costs 8. At 2M rows across a few unique
 * columns that is the difference between 1.4 GB and about 100 MB.
 *
 * 53 bits gives roughly a 1-in-4500 chance of a single false collision
 * at 2M values, and a collision can only ever under-report uniqueness,
 * never invent a key that isn't there.
 * ------------------------------------------------------------------ */
function HashBag(cap) {
  this.a = new Float64Array(1024);
  this.n = 0;
  this.cap = cap || 20000000;
  this.full = false;
}
HashBag.prototype.add = function (h) {
  if (this.full) return false;
  if (this.n >= this.cap) { this.full = true; this.a = null; return false; }
  if (this.n === this.a.length) {
    var bigger = new Float64Array(this.a.length * 2);
    bigger.set(this.a);
    this.a = bigger;
  }
  this.a[this.n++] = h;
  return true;
};
/* returns the number of values that repeated at least once */
HashBag.prototype.countRepeats = function () {
  if (this.full || !this.a) return -1;
  var v = this.a.subarray(0, this.n);
  var sorted = Float64Array.from(v).sort();
  var dups = 0;
  for (var i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) dups++;
  return dups;
};
HashBag.prototype.distinct = function () {
  var r = this.countRepeats();
  return r < 0 ? -1 : this.n - r;
};
HashBag.prototype.free = function () { this.a = null; };

/* FNV-1a twice, folded into one 53-bit safe integer */
function hash53(s) {
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 ^= c; h1 = (h1 * 0x01000193) >>> 0;
    h2 = ((h2 ^ c) * 0x85ebca6b) >>> 0;
  }
  return h1 * 2097152 + (h2 & 0x1FFFFF);
}

/* ------------------------------------------------------------------ *
 * Accumulator — same statistics as core.profile(), fed one row at a
 * time so a 4 GB file costs the same memory as a 4 MB one.
 *
 * Row position buckets need a total up front. When it isn't known we
 * bucket by a growing estimate and rescale at the end, which keeps the
 * completeness strip meaningful without buffering rows.
 * ------------------------------------------------------------------ */
function Accumulator(fields, opts) {
  opts = opts || {};
  this.fields = fields;
  this.n = 0;
  this.dup = 0;
  this.dupLimit = opts.dupLimit == null ? 20000000 : opts.dupLimit;
  this.dupTruncated = false;
  this.rowBag = new HashBag(this.dupLimit);
  this.uniqLimit = opts.uniqLimit == null ? 60000 : opts.uniqLimit;
  this.cols = fields.map(function (name) {
    return {
      name: name, nulls: 0, ws: 0, tc: {}, uniq: Object.create(null), distinct: 0,
      nums: [], lens: 0, maxLen: 0, minLen: Infinity,
      b: new Array(BUCKETS).fill(0), bn: new Array(BUCKETS).fill(0),
      numCount: 0, numSum: 0, numMin: Infinity, numMax: -Infinity,
      // Uniqueness is tracked separately from the value map, because the value
      // map is capped for memory and would otherwise make every large column
      // look non-unique. The trick: the moment a repeat appears the column
      // cannot be a key, so we drop the set and stop paying for it. Only
      // genuinely-unique columns keep growing, and there are rarely many.
      keyCandidate: true, keyBag: new HashBag(), keyUnknown: false, repeats: 0
    };
  });
  this.keyLimit = opts.keyLimit == null ? 8000000 : opts.keyLimit;
  this.sampleCap = opts.numericSample == null ? 200000 : opts.numericSample;
}

Accumulator.prototype.push = function (row, index) {
  var i = index == null ? this.n : index;
  this.n++;
  // provisional bucket; rescaled in finalize()
  var bi = Math.min(BUCKETS - 1, Math.floor(i / Math.max(1, this.estTotal || this.n) * BUCKETS));
  if (!isFinite(bi) || bi < 0) bi = 0;

  for (var ci = 0; ci < this.cols.length; ci++) {
    var c = this.cols[ci], raw = row[c.name];
    c.bn[bi]++;
    if (core.isNull(raw)) { c.nulls++; continue; }
    c.b[bi]++;
    var s = String(raw);
    if (s !== s.trim()) c.ws++;
    var t = s.trim(), k = core.classify(t);
    c.tc[k] = (c.tc[k] || 0) + 1;
    if (c.distinct < this.uniqLimit && c.uniq[t] === undefined) { c.uniq[t] = 0; c.distinct++; }
    if (c.uniq[t] !== undefined) c.uniq[t]++;
    if (c.keyCandidate && !c.keyBag.add(hash53(t))) { c.keyUnknown = true; c.keyCandidate = false; }
    if (t.length > c.maxLen) c.maxLen = t.length;
    if (t.length < c.minLen) c.minLen = t.length;
    if (k === 'integer' || k === 'decimal') {
      var f = parseFloat(t);
      if (isFinite(f)) {
        c.numCount++; c.numSum += f;
        if (f < c.numMin) c.numMin = f;
        if (f > c.numMax) c.numMax = f;
        if (c.nums.length < this.sampleCap) c.nums.push(f);
      }
    }
  }

  var sig = '';
  for (var j = 0; j < this.fields.length; j++) sig += row[this.fields[j]] + '\u241F';
  if (!this.rowBag.add(hash53(sig))) this.dupTruncated = true;
};

Accumulator.prototype.finalize = function () {
  var n = this.n, self = this;
  var rowDups = this.rowBag.countRepeats();
  this.dup = rowDups < 0 ? 0 : rowDups;
  this.dupTruncated = rowDups < 0;
  this.rowBag.free();

  this.cols.forEach(function (c) {
    c.rows = n; c.nonNull = n - c.nulls; c.nullPct = n ? c.nulls / n * 100 : 0;
    c.type = resolveTypes(c.tc);
    c.mixed = Object.keys(c.tc).length > 1 && c.type === 'string';
    if (c.minLen === Infinity) c.minLen = 0;
    if (c.numCount) {
      c.min = c.numMin; c.max = c.numMax; c.mean = c.numSum / c.numCount;
      var s = c.nums.slice().sort(function (a, b) { return a - b; });
      var q1 = quantile(s, .25), q3 = quantile(s, .75), iqr = q3 - q1;
      c.outliers = iqr > 0
        ? Math.round(s.filter(function (v) { return v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr; }).length
            * (c.numCount / s.length))
        : 0;
    }
    c.distinctApprox = c.distinct >= self.uniqLimit;
    if (c.keyCandidate) {
      var d = c.keyBag.distinct();
      if (d >= 0) {
        c.distinct = d; c.distinctApprox = false;
        c.keyCandidate = (d === c.nonNull);
      }
    }
    if (c.keyBag) { c.keyBag.free(); c.keyBag = null; }
    c.isKey = c.keyCandidate && c.nonNull === n && n > 0;
    c.keyUnknown = !!c.keyUnknown;
    c.isConst = c.distinct === 1 && c.nonNull > 0;
    c.truncated = sum(c.bn.slice(-5)) > 0 && c.nonNull > 0 && sum(c.b.slice(-5)) === 0 && c.nullPct < 90;
  });

  var p = { rows: n, cols: this.cols, dup: this.dup, dup_approximate: this.dupTruncated };
  p.pii = scanPII(this.cols);
  return p;
};

function resolveTypes(counts) {
  var k = Object.keys(counts);
  if (!k.length) return 'empty';
  if (k.length === 1) return k[0];
  if (k.length === 2 && counts.integer && counts.decimal) return 'decimal';
  if (k.length === 2 && counts.date && counts.timestamp) return 'timestamp';
  return 'string';
}
function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
function quantile(s, q) {
  if (!s.length) return 0;
  var p = (s.length - 1) * q, b = Math.floor(p), r = p - b;
  return s[b + 1] !== undefined ? s[b] + r * (s[b + 1] - s[b]) : s[b];
}

/* reuse the PII scanner shape from core by rebuilding the expected input */
function scanPII(cols) {
  var shim = cols.map(function (c) {
    return { name: c.name, uniq: c.uniq, distinct: c.distinct, nonNull: c.nonNull, type: c.type };
  });
  return corePII(shim);
}

/* core.js keeps scanPII private, so mirror the calls it exposes */
var RE_EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/,
    RE_PHONE_IN = /^(\+?91[-\s]?)?[6-9]\d{9}$/,
    RE_PHONE_GEN = /^\+?\d[\d\s\-().]{8,17}\d$/,
    RE_CARDISH = /^\d[\d\s-]{12,21}\d$/,
    RE_IP = /^(\d{1,3}\.){3}\d{1,3}$/,
    RE_AADHAARISH = /^\d{4}\s?\d{4}\s?\d{4}$/,
    RE_PANISH = /^[A-Z]{5}\d{4}[A-Z]$/,
    NAME_HINT = /(email|e_mail|mail|phone|mobile|contact|address|addr|dob|birth|passport|aadhaar|aadhar|pan|ssn|card|account|acct|salary|postcode|zip|pincode|name)/i;

function corePII(cols) {
  var hits = [];
  cols.forEach(function (c) {
    var vals = Object.keys(c.uniq).slice(0, 400);
    if (!vals.length) return;
    function share(fn) {
      var m = 0; vals.forEach(function (v) { if (fn(v)) m++; });
      return m / vals.length;
    }
    var kind = null, conf = 0;
    var e = share(function (v) { return RE_EMAIL.test(v); }),
        pIN = share(function (v) { return RE_PHONE_IN.test(v.replace(/[\s-]/g, '')); }),
        pG = share(function (v) { return RE_PHONE_GEN.test(v); }),
        cd = share(function (v) { return RE_CARDISH.test(v) && core.luhn(v); }),
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
 * Row-level validation.
 *
 * Contract checks answer "is this dataset acceptable". This answers
 * "which rows are the problem", so a pipeline can quarantine the bad
 * ones and carry on with the good ones instead of failing wholesale.
 * ------------------------------------------------------------------ */
function rowValidator(contract) {
  var specs = (contract.columns || []).filter(function (s) {
    return s.required || s.allowed_values || s.min != null || s.max != null ||
           (s.type && s.type !== 'string' && s.type !== 'empty');
  });
  var allowedSets = {};
  specs.forEach(function (s) {
    if (s.allowed_values) {
      var m = Object.create(null);
      s.allowed_values.forEach(function (v) { m[String(v)] = 1; });
      allowedSets[s.name] = m;
    }
  });

  return function (row) {
    var errs = null;
    for (var i = 0; i < specs.length; i++) {
      var s = specs[i], raw = row[s.name];
      if (raw === undefined) continue;
      var blank = core.isNull(raw);

      if (s.required && blank) { errs = errs || []; errs.push(s.name + ': required but empty'); continue; }
      if (blank) continue;

      var t = String(raw).trim();

      if (s.type && s.type !== 'string' && s.type !== 'empty') {
        if (!core.typeCompatible(s.type, core.classify(t))) {
          errs = errs || []; errs.push(s.name + ': expected ' + s.type + ', got "' + trunc(t) + '"');
          continue;
        }
      }
      if (allowedSets[s.name] && !allowedSets[s.name][t]) {
        errs = errs || []; errs.push(s.name + ': "' + trunc(t) + '" not in allowed values');
        continue;
      }
      if (s.min != null || s.max != null) {
        var f = parseFloat(t);
        if (isFinite(f)) {
          if (s.min != null && f < s.min) { errs = errs || []; errs.push(s.name + ': ' + f + ' below min ' + s.min); }
          if (s.max != null && f > s.max) { errs = errs || []; errs.push(s.name + ': ' + f + ' above max ' + s.max); }
        }
      }
    }
    return errs;
  };
}

function trunc(s) { return s.length > 24 ? s.slice(0, 24) + '…' : s; }

/* ------------------------------------------------------------------ *
 * Freshness
 * ------------------------------------------------------------------ */
function parseDuration(str) {
  var m = String(str).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i);
  if (!m) return null;
  var n = parseFloat(m[1]), unit = (m[2] || 'h').toLowerCase();
  var mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[unit];
  return n * mult;
}

module.exports = {
  Accumulator: Accumulator, rowValidator: rowValidator, parseDuration: parseDuration
};
