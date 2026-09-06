'use strict';
/*
 * Dashboard rendering for tracked check history.
 *
 * Two audiences, one page: a plain-language verdict and trend charts for
 * whoever owns the data, and the per-run detail an engineer needs to find
 * the run that broke. No chart library — the whole page is inlined SVG so
 * it works as a static file emailed to someone with nothing installed.
 */

var fs = require('fs');
var path = require('path');

/* ---------------- data ---------------- */

/**
 * Read a history file into a dataset. A missing or unreadable file becomes
 * an empty dataset rather than an error — a dashboard for a check that
 * hasn't run yet is a legitimate thing to show.
 */
function loadDataset(histPath) {
  var runs = [];
  try {
    var h = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    if (Array.isArray(h.runs)) runs = h.runs;
  } catch (e) { /* unreadable — leave empty */ }
  return {
    name: path.basename(histPath).replace(/\.json$/i, ''),
    path: histPath,
    runs: runs
  };
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function sev(r, k) { return num(r[k]) || 0; }
function sevTotal(r) { return sev(r, 'critical') + sev(r, 'warning') + sev(r, 'info'); }

/**
 * Roll a run list up into the numbers the page displays. Everything here
 * tolerates the older history format (date/file/rows/passed/score), which
 * carries no severity breakdown — hasSeverity comes back false and the
 * caller hides the section that needs it.
 */
function summarise(runs) {
  var n = runs.length;
  var s = {
    runs: n,
    latest: n ? runs[n - 1] : null,
    passRate: null,
    latestScore: null,
    scoreDelta: null,
    meanRows: null,
    rowDelta: null,
    hasSeverity: false,
    critical: 0, warning: 0, info: 0,
    streak: 0
  };
  if (!n) return s;

  var passes = 0, rowVals = [];
  runs.forEach(function (r) {
    if (r.passed) passes++;
    var rw = num(r.rows); if (rw !== null) rowVals.push(rw);
    if (num(r.critical) !== null || num(r.warning) !== null || num(r.info) !== null) {
      s.hasSeverity = true;
      s.critical += sev(r, 'critical');
      s.warning += sev(r, 'warning');
      s.info += sev(r, 'info');
    }
  });

  s.passRate = Math.round(passes / n * 100);
  s.latestScore = num(s.latest.score);

  // score movement against the most recent earlier run that recorded one
  for (var i = n - 2; i >= 0; i--) {
    var prev = num(runs[i].score);
    if (prev !== null) {
      if (s.latestScore !== null) s.scoreDelta = s.latestScore - prev;
      break;
    }
  }

  if (rowVals.length) {
    s.meanRows = Math.round(rowVals.reduce(function (a, v) { return a + v; }, 0) / rowVals.length);
    var lastRows = num(s.latest.rows);
    if (lastRows !== null && s.meanRows) {
      s.rowDelta = Math.round((lastRows - s.meanRows) / s.meanRows * 100);
    }
  }

  // consecutive runs at the tail sharing the latest run's outcome
  var want = !!s.latest.passed;
  for (var j = n - 1; j >= 0; j--) {
    if (!!runs[j].passed !== want) break;
    s.streak++;
  }
  return s;
}

/**
 * The one line a non-engineer reads. Outcome first, then the only context
 * that changes what they would do about it.
 */
function verdict(s) {
  if (!s.runs) {
    return { tone: 'idle', head: 'No checks recorded yet',
      sub: 'Run a check with --track to start building history here.' };
  }
  var last = s.latest;
  var when = last.ts ? String(last.ts).replace('T', ' ').slice(0, 16) : (last.date || 'unknown date');

  if (last.passed) {
    var sub = s.streak > 1
      ? 'Passing for the last ' + s.streak + ' runs.'
      : 'The run before this one failed.';
    if (s.scoreDelta !== null && s.scoreDelta < 0) {
      sub += ' Quality score is down ' + Math.abs(s.scoreDelta) + ' since the previous run.';
    }
    return { tone: 'ok', head: 'Latest check passed', sub: sub + ' Last run ' + when + '.' };
  }

  var crit = sev(last, 'critical');
  var what = crit ? crit + ' critical issue' + (crit === 1 ? '' : 's') : 'the contract was breached';
  return {
    tone: 'bad',
    head: 'Latest check failed',
    sub: 'Last run ' + when + ' — ' + what + '. ' +
         (s.streak > 1 ? 'Failing for ' + s.streak + ' runs in a row.' : 'The run before it passed.')
  };
}

/* ---------------- svg charts ---------------- */

var W = 720, H = 190, PAD_L = 44, PAD_R = 10, PAD_T = 14, PAD_B = 26;

function plotX(i, n) {
  if (n <= 1) return PAD_L + (W - PAD_L - PAD_R) / 2;
  return PAD_L + (W - PAD_L - PAD_R) * (i / (n - 1));
}
function plotY(v, min, max) {
  if (max === min) return PAD_T + (H - PAD_T - PAD_B) / 2;
  return PAD_T + (H - PAD_T - PAD_B) * (1 - (v - min) / (max - min));
}

function compact(v) {
  var a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

function gridLines(min, max, fmt) {
  var out = '', steps = 4;
  for (var i = 0; i <= steps; i++) {
    var v = min + (max - min) * (i / steps);
    var y = plotY(v, min, max);
    out += '<line x1="' + PAD_L + '" y1="' + y.toFixed(1) + '" x2="' + (W - PAD_R) +
           '" y2="' + y.toFixed(1) + '" class="grid" />' +
           '<text x="' + (PAD_L - 7) + '" y="' + (y + 3.5).toFixed(1) +
           '" class="axis" text-anchor="end">' + esc(fmt(v)) + '</text>';
  }
  return out;
}

function xLabels(runs) {
  var n = runs.length, out = '';
  if (!n) return out;
  var idxs = n <= 6
    ? runs.map(function (_, i) { return i; })
    : [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1];
  idxs.forEach(function (i) {
    var lbl = String(runs[i].date || '').slice(5); // MM-DD
    out += '<text x="' + plotX(i, n).toFixed(1) + '" y="' + (H - 8) +
           '" class="axis" text-anchor="middle">' + esc(lbl) + '</text>';
  });
  return out;
}

/** Line chart with a filled area beneath and a dot per run. */
function lineChart(runs, key, opts) {
  opts = opts || {};
  var pts = [];
  runs.forEach(function (r, i) {
    var v = num(r[key]);
    if (v !== null) pts.push({ i: i, v: v, run: r });
  });
  if (!pts.length) return emptyChart('Nothing recorded yet.');

  var vals = pts.map(function (p) { return p.v; });
  var min = opts.min !== undefined ? opts.min : Math.min.apply(null, vals);
  var max = opts.max !== undefined ? opts.max : Math.max.apply(null, vals);
  if (opts.padPct) {
    var span = (max - min) * opts.padPct;
    min = Math.max(0, min - span); max = max + span;
  }
  if (min === max) { min = Math.max(0, min - 1); max = max + 1; }

  var n = runs.length;
  var fmt = opts.fmt || compact;

  var line = pts.map(function (p, k) {
    return (k ? 'L' : 'M') + plotX(p.i, n).toFixed(1) + ' ' + plotY(p.v, min, max).toFixed(1);
  }).join(' ');
  var area = line +
    ' L' + plotX(pts[pts.length - 1].i, n).toFixed(1) + ' ' + (H - PAD_B) +
    ' L' + plotX(pts[0].i, n).toFixed(1) + ' ' + (H - PAD_B) + ' Z';

  var dots = pts.map(function (p) {
    return '<circle cx="' + plotX(p.i, n).toFixed(1) + '" cy="' + plotY(p.v, min, max).toFixed(1) +
      '" r="3" class="dot' + (p.run.passed === false ? ' bad' : '') + '"><title>' +
      esc(String(p.run.date || '') + ' · ' + fmt(p.v) + (p.run.passed === false ? ' · failed' : '')) +
      '</title></circle>';
  }).join('');

  return svg('<path d="' + area + '" class="area" />' +
    gridLines(min, max, fmt) +
    '<path d="' + line + '" class="line" />' + dots + xLabels(runs));
}

/** Stacked bars: critical / warning / info per run. */
function severityChart(runs) {
  var totals = runs.map(sevTotal);
  var peak = Math.max.apply(null, totals.concat([0]));
  if (!peak) return emptyChart('No violations recorded in this window.');

  var n = runs.length;
  var bw = Math.max(3, Math.min(22, (W - PAD_L - PAD_R) / Math.max(n, 1) * 0.55));
  var floor = H - PAD_B;

  var bars = runs.map(function (r, i) {
    var x = (plotX(i, n) - bw / 2).toFixed(1);
    var y = floor, out = '';
    // stack least severe at the base so critical reads along the top edge
    [['info', 'info'], ['warning', 'warn'], ['critical', 'crit']].forEach(function (pair) {
      var v = sev(r, pair[0]);
      if (!v) return;
      var h = (v / peak) * (floor - PAD_T);
      y -= h;
      out += '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + h.toFixed(1) + '" class="bar ' + pair[1] + '"><title>' +
        esc(String(r.date || '') + ' · ' + v + ' ' + pair[0]) + '</title></rect>';
    });
    return out;
  }).join('');

  return svg(gridLines(0, peak, function (v) { return String(Math.round(v)); }) +
    bars + xLabels(runs));
}

function emptyChart(msg) { return '<p class="empty">' + esc(msg) + '</p>'; }

function svg(inner) {
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img">' + inner + '</svg>';
}

/* ---------------- html ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function tile(label, value, note, tone) {
  return '<div class="tile">' +
    '<div class="k">' + esc(label) + '</div>' +
    '<div class="v' + (tone ? ' ' + tone : '') + '">' + esc(value) + '</div>' +
    (note ? '<div class="n">' + esc(note) + '</div>' : '') +
    '</div>';
}

function runsTable(runs) {
  if (!runs.length) return '<p class="empty">No runs yet.</p>';
  var rows = runs.slice().reverse().slice(0, 40).map(function (r) {
    var codes = Array.isArray(r.codes) && r.codes.length ? r.codes.join(', ') : '';
    return '<tr>' +
      '<td class="mono">' + esc(r.ts ? String(r.ts).replace('T', ' ').slice(0, 16) : (r.date || '')) + '</td>' +
      '<td class="mono">' + esc(r.file || '') + '</td>' +
      '<td><span class="pill ' + (r.passed ? 'ok' : 'crit') + '">' +
        (r.passed ? 'PASS' : 'FAIL') + '</span></td>' +
      '<td class="mono num">' + esc(num(r.score) === null ? '—' : r.score) + '</td>' +
      '<td class="mono num">' + esc(num(r.rows) === null ? '—' : Number(r.rows).toLocaleString()) + '</td>' +
      '<td class="mono num">' + (sevTotal(r) ? esc(sevTotal(r)) : '—') + '</td>' +
      '<td class="mono codes">' + esc(codes || '—') + '</td>' +
      '</tr>';
  }).join('');
  return '<table><thead><tr>' +
    '<th>Run</th><th>File</th><th>Result</th><th class="num">Score</th>' +
    '<th class="num">Rows</th><th class="num">Issues</th><th>Checks that fired</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderDataset(ds) {
  var s = summarise(ds.runs);
  var v = verdict(s);
  var runs = ds.runs;

  var scoreNote = s.scoreDelta === null ? '' :
    (s.scoreDelta > 0 ? '+' + s.scoreDelta + ' vs previous'
      : s.scoreDelta < 0 ? s.scoreDelta + ' vs previous' : 'unchanged');
  var rowsNote = s.rowDelta === null ? '' :
    (s.rowDelta === 0 ? 'on the average' :
      (s.rowDelta > 0 ? '+' : '') + s.rowDelta + '% vs average');

  return '<section class="ds">' +
    '<div class="dshead"><h2>' + esc(ds.name) + '</h2>' +
      '<span class="src mono">' + esc(ds.path) + '</span></div>' +

    '<div class="verdict ' + v.tone + '">' +
      '<div class="vh">' + esc(v.head) + '</div>' +
      '<div class="vs">' + esc(v.sub) + '</div>' +
    '</div>' +

    '<div class="tiles">' +
      tile('Quality score', s.latestScore === null ? '—' : s.latestScore, scoreNote,
        s.latestScore === null ? '' : (s.latestScore >= 90 ? 'good' : s.latestScore >= 70 ? 'warn' : 'bad')) +
      tile('Pass rate', s.passRate === null ? '—' : s.passRate + '%',
        s.runs + ' run' + (s.runs === 1 ? '' : 's') + ' tracked') +
      tile('Rows last run', s.latest && num(s.latest.rows) !== null
        ? Number(s.latest.rows).toLocaleString() : '—', rowsNote) +
      tile('Open issues', s.hasSeverity ? String(sevTotal(s.latest || {})) : '—',
        s.hasSeverity ? s.critical + ' critical across window' : 'not recorded') +
    '</div>' +

    '<div class="charts">' +
      '<div class="card"><h3>Quality score</h3>' +
        lineChart(runs, 'score', { min: 0, max: 100 }) + '</div>' +
      '<div class="card"><h3>Row count</h3>' +
        lineChart(runs, 'rows', { padPct: 0.15 }) + '</div>' +
      '<div class="card wide"><h3>Violations by severity' +
        '<span class="legend">' +
          '<i class="sw crit"></i>critical<i class="sw warn"></i>warning<i class="sw info"></i>info' +
        '</span></h3>' +
        (s.hasSeverity ? severityChart(runs)
          : emptyChart('This history predates severity tracking. New runs will populate it.')) +
      '</div>' +
    '</div>' +

    '<div class="card wide"><h3>Runs</h3>' + runsTable(runs) + '</div>' +
  '</section>';
}

var STYLE = [
  ':root{--ink:#16222E;--ink-2:#43535F;--ink-3:#6C7C88;--paper:#EDF0F3;--card:#FFFFFF;',
  '--rule:#C6D0D8;--rule-soft:#DEE5EA;--crit:#9B2C1E;--crit-bg:#F7E4E0;--warn:#B07A16;',
  '--warn-bg:#F8EFDC;--ok:#2E7D6E;--ok-bg:#E2F0EC;--measure:#2C6E9B;--measure-bg:#E4EDF3;--r:3px;}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--paper);color:var(--ink);',
  "font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5}",
  ".mono{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace}",
  '.wrap{max-width:1080px;margin:0 auto;padding:28px 22px 56px}',
  '.masthead{display:flex;justify-content:space-between;align-items:flex-start;',
  'border-bottom:1px solid var(--rule);padding-bottom:14px;margin-bottom:22px}',
  ".masthead h1{font-family:'IBM Plex Sans Condensed',sans-serif;font-weight:700;font-size:34px;",
  'line-height:1;letter-spacing:-.02em;margin:0}',
  '.masthead h1 em{font-style:normal;color:var(--measure)}',
  '.masthead p{margin:6px 0 0;color:var(--ink-2);font-size:13.5px}',
  ".stamp{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;",
  'text-transform:uppercase;color:var(--ink-3);text-align:right;line-height:1.8}',
  '.live{color:var(--ok);font-weight:500}',
  '.live b{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);',
  'margin-right:5px;animation:p 2s ease-in-out infinite}',
  '@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}',
  '.ds{margin-bottom:38px}',
  '.dshead{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}',
  ".dshead h2{font-family:'IBM Plex Sans Condensed',sans-serif;font-size:21px;margin:0;font-weight:700}",
  '.src{font-size:11px;color:var(--ink-3)}',
  '.verdict{border:1px solid var(--rule);border-left-width:3px;border-radius:var(--r);',
  'background:var(--card);padding:14px 16px;margin-bottom:16px}',
  '.verdict.ok{border-left-color:var(--ok)}.verdict.bad{border-left-color:var(--crit)}',
  '.verdict.idle{border-left-color:var(--ink-3)}',
  ".vh{font-family:'IBM Plex Sans Condensed',sans-serif;font-size:19px;font-weight:700}",
  '.verdict.ok .vh{color:var(--ok)}.verdict.bad .vh{color:var(--crit)}',
  '.vs{color:var(--ink-2);font-size:13.5px;margin-top:2px}',
  '.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--rule);',
  'border:1px solid var(--rule);border-radius:var(--r);overflow:hidden;margin-bottom:18px}',
  '.tile{background:var(--card);padding:13px 15px}',
  ".tile .k{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.13em;",
  'text-transform:uppercase;color:var(--ink-3)}',
  ".tile .v{font-family:'IBM Plex Sans Condensed',sans-serif;font-size:26px;font-weight:700;line-height:1.3}",
  '.tile .v.good{color:var(--ok)}.tile .v.warn{color:var(--warn)}.tile .v.bad{color:var(--crit)}',
  '.tile .n{font-size:11.5px;color:var(--ink-3)}',
  '.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}',
  '.card{background:var(--card);border:1px solid var(--rule);border-radius:var(--r);padding:14px 16px}',
  '.card.wide{grid-column:1/-1}',
  ".card h3{font-family:'IBM Plex Sans Condensed',sans-serif;font-size:14px;margin:0 0 10px;",
  'font-weight:700;display:flex;justify-content:space-between;align-items:center}',
  '.legend{font-family:\'IBM Plex Mono\',monospace;font-size:9.5px;letter-spacing:.08em;',
  'text-transform:uppercase;color:var(--ink-3);font-weight:400;display:flex;align-items:center;gap:4px}',
  '.sw{width:8px;height:8px;border-radius:2px;display:inline-block;margin-left:8px}',
  '.sw.crit{background:var(--crit)}.sw.warn{background:var(--warn)}.sw.info{background:var(--measure)}',
  '.chart{width:100%;height:auto;display:block;overflow:visible}',
  '.grid{stroke:var(--rule-soft);stroke-width:1}',
  ".axis{font-family:'IBM Plex Mono',monospace;font-size:9px;fill:var(--ink-3)}",
  '.line{fill:none;stroke:var(--measure);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}',
  '.area{fill:var(--measure-bg);stroke:none}',
  '.dot{fill:var(--card);stroke:var(--measure);stroke-width:2}',
  '.dot.bad{fill:var(--crit);stroke:var(--crit)}',
  '.bar.crit{fill:var(--crit)}.bar.warn{fill:var(--warn)}.bar.info{fill:var(--measure)}',
  '.empty{color:var(--ink-3);font-size:13px;margin:18px 0;text-align:center}',
  'table{width:100%;border-collapse:collapse;font-size:12.5px}',
  "th{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;",
  'color:var(--ink-3);text-align:left;font-weight:500;border-bottom:1px solid var(--rule);padding:0 8px 6px}',
  'td{padding:6px 8px;border-bottom:1px solid var(--rule-soft)}',
  'tbody tr:last-child td{border-bottom:none}',
  '.num{text-align:right}',
  '.codes{color:var(--ink-2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ".pill{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.08em;",
  'padding:2px 6px;border-radius:2px}',
  '.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.crit{background:var(--crit-bg);color:var(--crit)}',
  '@media (max-width:760px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}',
  '.charts{grid-template-columns:1fr}.masthead{flex-direction:column;gap:10px}.stamp{text-align:left}}'
].join('');

/**
 * Full page. `live` adds the poll loop that repaints when a new run lands;
 * a static export omits it so the file works with no server behind it.
 */
function renderHTML(datasets, opts) {
  opts = opts || {};
  var generated = new Date().toISOString().replace('T', ' ').slice(0, 16);
  var body = datasets.map(renderDataset).join('');

  var script = opts.live ? [
    '<script>',
    'var last=' + JSON.stringify(JSON.stringify(datasets)) + ';',
    'setInterval(function(){',
    ' fetch("data.json",{cache:"no-store"}).then(function(r){return r.text()}).then(function(t){',
    '  if(t!==last){last=t;location.reload()}',
    ' }).catch(function(){});',
    '},' + (opts.pollMs || 4000) + ');',
    '</script>'
  ].join('') : '';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Sift — ' + esc(datasets.length === 1 ? datasets[0].name : 'data quality') + '</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&' +
      'family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600;700&display=swap" ' +
      'rel="stylesheet">' +
    '<style>' + STYLE + '</style></head><body><div class="wrap">' +
    '<div class="masthead"><div>' +
      '<h1>sift-data<em>.</em></h1>' +
      '<p>Data quality over time — every tracked run, newest last.</p>' +
    '</div><div class="stamp">' +
      (opts.live ? '<div class="live"><b></b>live</div>' : '<div>static export</div>') +
      '<div>generated ' + esc(generated) + '</div>' +
    '</div></div>' +
    body +
    '</div>' + script + '</body></html>';
}

module.exports = {
  loadDataset: loadDataset,
  summarise: summarise,
  verdict: verdict,
  renderHTML: renderHTML,
  esc: esc
};
