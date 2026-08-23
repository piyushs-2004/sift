'use strict';

var fs = require('fs');
var zlib = require('zlib');
var path = require('path');

/* ------------------------------------------------------------------ *
 * Incremental CSV state machine.
 *
 * The whole-file parser in core.js is fine for a 10 MB export and
 * useless for a 4 GB one. This one carries quote state across chunk
 * boundaries so memory stays flat regardless of file size.
 * ------------------------------------------------------------------ */
function CsvMachine(delim) {
  this.delim = delim;
  this.field = '';
  this.row = [];
  this.inQuotes = false;
  this.justClosedQuote = false;
  this.fieldWasQuoted = false;
}

CsvMachine.prototype.push = function (chunk, onRow) {
  for (var i = 0; i < chunk.length; i++) {
    var ch = chunk[i];

    if (this.inQuotes) {
      if (ch === '"') {
        if (chunk[i + 1] === '"') { this.field += '"'; i++; continue; }
        if (i === chunk.length - 1) { this.justClosedQuote = true; this.inQuotes = false; continue; }
        this.inQuotes = false; continue;
      }
      this.field += ch;
      continue;
    }

    // a quote that opens immediately after a previous close means an escaped quote
    // split across a chunk boundary
    if (this.justClosedQuote) {
      this.justClosedQuote = false;
      if (ch === '"') { this.field += '"'; this.inQuotes = true; continue; }
    }

    if (ch === '"' && this.field === '' && !this.fieldWasQuoted) {
      this.inQuotes = true; this.fieldWasQuoted = true; continue;
    }
    if (ch === this.delim) {
      this.row.push(this.field); this.field = ''; this.fieldWasQuoted = false; continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      this.row.push(this.field);
      var r = this.row;
      this.row = []; this.field = ''; this.fieldWasQuoted = false;
      if (r.length > 1 || r[0] !== '') onRow(r);
      continue;
    }
    this.field += ch;
  }
};

CsvMachine.prototype.end = function (onRow) {
  if (this.field !== '' || this.row.length) {
    this.row.push(this.field);
    onRow(this.row);
    this.row = []; this.field = '';
  }
};

function detectDelimiter(head, override) {
  if (override) return override === '\\t' ? '\t' : override;
  var cands = [',', '\t', ';', '|'], best = ',', bestScore = -1;
  var lines = head.split('\n').slice(0, 5).filter(Boolean);
  cands.forEach(function (d) {
    if (!lines.length) return;
    var counts = lines.map(function (l) { return l.split(d).length; });
    if (counts[0] < 2) return;
    var consistent = counts.every(function (c) { return c === counts[0]; });
    var score = (consistent ? 1000 : 0) + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  });
  return best;
}

function inputStream(file, opts) {
  var s = file === '-' ? process.stdin : fs.createReadStream(file);
  if (/\.gz$/i.test(file)) s = s.pipe(zlib.createGunzip());
  s.setEncoding ? s.setEncoding(opts.encoding || 'utf8') : null;
  return s;
}

function formatOf(file, override) {
  if (override) return override;
  var f = file.replace(/\.gz$/i, '').toLowerCase();
  if (/\.(ndjson|jsonl)$/.test(f)) return 'ndjson';
  if (/\.json$/.test(f)) return 'json';
  return 'csv';
}

/* ------------------------------------------------------------------ *
 * readRows(file, opts, handlers)
 *
 * handlers.onHeader(fields)
 * handlers.onRow(rowObject, index)   return false to stop early
 * handlers.onEnd(meta) / handlers.onError(err)
 * ------------------------------------------------------------------ */
function readRows(file, opts, h) {
  opts = opts || {};
  var fmt = formatOf(file, opts.format);
  var limit = opts.maxRows || Infinity;
  var count = 0, stopped = false;

  if (fmt === 'json') {
    // a JSON array has to be materialised; that's inherent to the format
    var raw = '';
    var js = inputStream(file, opts);
    js.on('data', function (c) { raw += c; });
    js.on('error', h.onError);
    js.on('end', function () {
      var arr;
      try { arr = JSON.parse(raw); } catch (e) { return h.onError(new Error('invalid JSON: ' + e.message)); }
      if (!Array.isArray(arr)) return h.onError(new Error('JSON input must be an array of objects'));
      if (!arr.length) return h.onError(new Error('JSON array is empty'));
      var fields = unionKeys(arr);
      h.onHeader(fields);
      for (var i = 0; i < arr.length && count < limit; i++) {
        var o = {};
        fields.forEach(function (f) { o[f] = arr[i][f] == null ? '' : String(arr[i][f]); });
        if (h.onRow(o, count++) === false) break;
      }
      h.onEnd({ format: 'json', rows: count });
    });
    return;
  }

  if (fmt === 'ndjson') {
    var buf = '', fields = null, sniff = [];
    var ns = inputStream(file, opts);
    ns.on('error', h.onError);
    ns.on('data', function (chunk) {
      if (stopped) return;
      buf += chunk;
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length && !stopped; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (!fields) {
          sniff.push(obj);
          if (sniff.length < 50) continue;
          fields = unionKeys(sniff); h.onHeader(fields);
          sniff.forEach(function (o) {
            if (count < limit && !stopped) emit(o);
          });
          sniff = [];
          continue;
        }
        if (count >= limit) { stopped = true; break; }
        emit(obj);
      }
    });
    ns.on('end', function () {
      if (!fields && sniff.length) {
        fields = unionKeys(sniff); h.onHeader(fields);
        sniff.forEach(function (o) { if (count < limit && !stopped) emit(o); });
      }
      if (buf.trim() && fields && count < limit) {
        try { emit(JSON.parse(buf.trim())); } catch (e) { /* trailing junk */ }
      }
      if (!fields) return h.onError(new Error('no parsable JSON lines found'));
      h.onEnd({ format: 'ndjson', rows: count });
    });
    function emit(obj) {
      var o = {};
      fields.forEach(function (f) { o[f] = obj[f] == null ? '' : String(obj[f]); });
      if (h.onRow(o, count++) === false) stopped = true;
    }
    return;
  }

  // ---- CSV / TSV, streamed ----
  var machine = null, header = null, headSniff = '', sniffing = true;
  var cs = inputStream(file, opts);
  cs.on('error', h.onError);

  cs.on('data', function (chunk) {
    if (stopped) return;
    if (sniffing) {
      headSniff += chunk;
      if (headSniff.length < 8192 && headSniff.indexOf('\n') < 0) return;
      sniffing = false;
      var delim = detectDelimiter(headSniff.slice(0, 8192), opts.delimiter);
      machine = new CsvMachine(delim);
      var toFeed = headSniff;
      headSniff = '';
      feed(toFeed);
      return;
    }
    feed(chunk);
  });

  cs.on('end', function () {
    if (sniffing && headSniff) {
      var delim = detectDelimiter(headSniff, opts.delimiter);
      machine = new CsvMachine(delim);
      feed(headSniff);
    }
    if (machine) machine.end(handleRow);
    if (!header) return h.onError(new Error('no header row detected'));
    h.onEnd({ format: 'csv', rows: count, delimiter: machine ? machine.delim : ',' });
  });

  function feed(chunk) {
    if (chunk.charCodeAt && chunk.charCodeAt(0) === 0xFEFF) chunk = chunk.slice(1);
    machine.push(String(chunk), handleRow);
  }

  function handleRow(arr) {
    if (stopped) return;
    if (!header) {
      header = dedupeHeader(arr.map(function (x, i) {
        var s = String(x == null ? '' : x).trim();
        return s || 'column_' + (i + 1);
      }));
      h.onHeader(header);
      return;
    }
    if (count >= limit) { stopped = true; cs.destroy && cs.destroy(); return; }
    var o = {};
    for (var i = 0; i < header.length; i++) o[header[i]] = arr[i] == null ? '' : arr[i];
    if (h.onRow(o, count++) === false) { stopped = true; cs.destroy && cs.destroy(); }
  }
}

function unionKeys(objs) {
  var seen = [], has = Object.create(null);
  objs.forEach(function (o) {
    Object.keys(o || {}).forEach(function (k) {
      if (!has[k]) { has[k] = 1; seen.push(k); }
    });
  });
  return seen;
}

function dedupeHeader(h) {
  var seen = Object.create(null);
  return h.map(function (x) {
    if (seen[x]) { seen[x]++; return x + '_' + seen[x]; }
    seen[x] = 1; return x;
  });
}

/* ------------------------------------------------------------------ *
 * Glob expansion — no dependency, supports * ? and **
 * ------------------------------------------------------------------ */
function expandGlob(pattern) {
  if (!/[*?]/.test(pattern)) return [pattern];
  var drive = pattern.match(/^([a-zA-Z]:)[\\/]/);
  var start, parts;
  if (drive) {
    start = drive[1] + path.sep;
    parts = pattern.slice(drive[0].length).split(/[\\/]/).filter(Boolean);
  } else if (path.isAbsolute(pattern)) {
    start = path.sep;
    parts = pattern.split(/[\\/]/).filter(function (p, i) { return !(i === 0 && p === ''); });
  } else {
    start = '.';
    parts = pattern.split(/[\\/]/).filter(Boolean);
  }

  /* Resolve the literal (non-wildcard) prefix to its real path so a short
   * 8.3 Windows alias in the input (e.g. RUNNER~1 for runneradmin, as
   * TEMP is reported on GitHub's Windows runners) still matches the long
   * names readdirSync returns. */
  var firstGlobIx = parts.length;
  for (var gi = 0; gi < parts.length; gi++) {
    if (/[*?]/.test(parts[gi])) { firstGlobIx = gi; break; }
  }
  if (firstGlobIx > 0) {
    var literalPrefix = path.join.apply(null, [start].concat(parts.slice(0, firstGlobIx)));
    try {
      start = fs.realpathSync(literalPrefix);
      parts = parts.slice(firstGlobIx);
    } catch (e) { return []; }
  }

  var results = walk(start, parts, 0);
  return results.sort();

  function walk(dir, segs, ix) {
    if (ix >= segs.length) return [];
    var seg = segs[ix], last = ix === segs.length - 1;
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return []; }

    if (seg === '**') {
      var out = walk(dir, segs, ix + 1);
      entries.forEach(function (e) {
        if (isDirEntry(e, path.join(dir, e.name))) out = out.concat(walk(path.join(dir, e.name), segs, ix));
      });
      return out;
    }

    var re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.') + '$');
    var acc = [];
    entries.forEach(function (e) {
      if (!re.test(e.name)) return;
      var full = path.join(dir, e.name);
      if (last && isFileEntry(e, full)) acc.push(full);
      else if (!last && isDirEntry(e, full)) acc = acc.concat(walk(full, segs, ix + 1));
    });
    return acc;
  }
}

/* Dirent.isDirectory()/isFile() reflect the entry itself, not what a
 * symlink points to — resolve symlinks (e.g. macOS /var -> /private/var)
 * so glob patterns still walk through them. */
function isDirEntry(e, full) {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try { return fs.statSync(full).isDirectory(); } catch (err) { return false; }
}
function isFileEntry(e, full) {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try { return fs.statSync(full).isFile(); } catch (err) { return false; }
}

function expandAll(patterns) {
  var out = [], seen = Object.create(null);
  patterns.forEach(function (p) {
    expandGlob(p).forEach(function (f) {
      if (!seen[f]) { seen[f] = 1; out.push(f); }
    });
  });
  return out;
}

module.exports = {
  readRows: readRows, expandGlob: expandGlob, expandAll: expandAll,
  formatOf: formatOf, CsvMachine: CsvMachine, detectDelimiter: detectDelimiter
};
