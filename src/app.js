/*!
 * FeedFix app: connects the parser, feed editor and backplot to the page.
 */
(function () {
  'use strict';

  var Core = window.GCodeCore, Sample = window.FeedFixSample, CLS = Core.CLS;
  var CLASSES = [
    { key: 'rapid', label: 'Rapid', title: 'G0 rapid moves' },
    { key: 'air', label: 'Air move', title: 'Feed moves with nothing to cut: completely above the safe height, or dropping straight back to a depth the tool already reached at that spot' },
    { key: 'retract', label: 'Retract', title: 'Straight-up feed moves from the cut to the safe height' },
    { key: 'plunge', label: 'Plunge', title: 'Straight-down feed moves into material' },
    { key: 'cut', label: 'Cut', title: 'All other feed moves' }
  ];
  var ROW_H = 22, MAX_SPACER = 8e6, SPEEDS = [1, 5, 20, 100, 500];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function num(v) { return (Math.round(v * 10000) / 10000).toString(); }
  function debounce(fn, ms) {
    var t = 0;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  var S = {
    name: '', bytes: null, P: null, segs: null, cls: null, sample: false,
    safeZ: null, auto: null, incRetract: true, airFeed: 5000, maxRate: 5000, feedMap: {},
    plan: null, tA: null, tB: null, cumB: null, sum: null, editAt: null,
    curMove: -1, frac: 1, curLine: -1, playing: false, simT: 0, speed: 20,
    decoder: null, verify: null, metric: false
  };
  try { S.metric = localStorage.getItem('feedfix.units') === 'metric'; } catch (e) { S.metric = false; }

  var viewer = new window.Backplot($('plot'), {
    labels: [$('axX'), $('axY'), $('axZ')],
    onPick: function (m) { if (m >= 0) jumpToMove(m); }
  });
  if (!viewer.ok) $('noGl').hidden = false;

  // ---- settings remembered per unit system ---------------------------------

  function loadSettings(inch) {
    var d = inch ? { airFeed: 200, maxRate: 200 } : { airFeed: 5000, maxRate: 5000 };
    try {
      var s = JSON.parse(localStorage.getItem('feedfix.' + (inch ? 'in' : 'mm')) || 'null');
      if (s && s.airFeed > 0) d.airFeed = s.airFeed;
      if (s && s.maxRate > 0) d.maxRate = s.maxRate;
    } catch (e) { /* storage unavailable */ }
    return d;
  }
  function saveSettings() {
    try {
      localStorage.setItem('feedfix.' + (S.P && S.P.inch ? 'in' : 'mm'), JSON.stringify({ airFeed: S.airFeed, maxRate: S.maxRate }));
    } catch (e) { /* storage unavailable */ }
  }

  // ---- theme ---------------------------------------------------------------

  function parseColor(v) {
    v = v.trim();
    if (v.charAt(0) === '#') {
      if (v.length === 4) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      var n = parseInt(v.slice(1, 7), 16);
      return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }
    var m = v.match(/[\d.]+/g) || [0, 0, 0];
    return [m[0] / 255, m[1] / 255, m[2] / 255];
  }
  function applyTheme() {
    var cs = getComputedStyle(document.documentElement);
    function c(name) { return parseColor(cs.getPropertyValue(name) || '#888'); }
    viewer.setTheme({
      bg: c('--vp-bg'), grid: c('--vp-grid'), gridMajor: c('--vp-grid-major'),
      paths: [c('--p-rapid'), c('--p-air'), c('--p-retract'), c('--p-plunge'), c('--p-cut')],
      hl: c('--p-hl'), tool: c('--accent'), safe: c('--p-air'),
      ax: [c('--ax-x'), c('--ax-y'), c('--ax-z')]
    });
  }
  applyTheme();
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  }
  if (window.MutationObserver) {
    new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  }

  // ---- formatting ------------------------------------------------------------

  function unitLen() { return S.P && S.P.inch ? 'in' : 'mm'; }
  function fmtZ(v) { return v === null || v === undefined ? '—' : v.toFixed(S.P && S.P.inch ? 4 : 3); }
  function fmtLen(v) {
    if (S.P && S.P.inch) return (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1)) + ' in';
    return v >= 10000 ? (v / 1000).toFixed(2) + ' m' : Math.round(v).toLocaleString() + ' mm';
  }
  function fmtTime(min) {
    if (!(min >= 0) || !isFinite(min)) return '—';
    var s = Math.round(min * 60), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
  }
  function feedUnit(mode, inch) {
    if (mode === 93) return 'inverse time';
    if (mode === 95) return inch ? 'in/rev' : 'mm/rev';
    return inch ? 'in/min' : 'mm/min';
  }

  // ---- loading ---------------------------------------------------------------

  function looksBinary(bytes) {
    var n = Math.min(bytes.length, 8192), bad = 0;
    for (var i = 0; i < n; i++) if (bytes[i] === 0) bad++;
    return bad > n * 0.01;
  }

  // keep: settings to carry over when the same file is re-read in other units.
  function load(name, bytes, isSample, keep) {
    if (looksBinary(bytes)) { toast('That file is not plain-text G-code.', 'bad'); return; }
    stop();
    $('busy').hidden = false;
    setTimeout(function () {
      try {
        var P = Core.parse(bytes, { inch: !S.metric });
        S.P = P; S.bytes = P.bytes; S.name = name; S.sample = !!isSample;
        S.curMove = -1; S.frac = 1; S.curLine = -1;
        S.segs = Core.buildSegments(P);
        S.auto = Core.detectSafeZ(P);
        S.safeZ = S.auto.z;
        S.feedMap = {};
        if (keep) {
          S.feedMap = keep.feedMap;
          if (keep.safeZ === null) S.safeZ = keep.autoZ === null ? S.auto.z : null;
          else if (keep.safeZ !== keep.autoZ) S.safeZ = Math.round(keep.safeZ * (P.inch ? 1 / 25.4 : 25.4) * 1e4) / 1e4;
        }
        S.cls = null;
        var st = loadSettings(P.inch);
        S.airFeed = st.airFeed; S.maxRate = st.maxRate;
        try { new TextDecoder('utf-8', { fatal: true }).decode(P.bytes); S.decoder = new TextDecoder('utf-8'); }
        catch (e) { S.decoder = new TextDecoder('windows-1252'); }
        viewer.setProgram(S.segs, P.bbox);
        $('fileName').textContent = name;
        $('fileName').title = name;
        $('sampleBadge').hidden = !isSample;
        $('sampleBtn').hidden = !!isSample;
        var u = unitLen();
        $('safeUnit').textContent = u;
        $('airUnit').textContent = u + '/min';
        $('maxRateUnit').textContent = u + '/min';
        $('airFeed').value = S.airFeed;
        $('maxRate').value = S.maxRate;
        $('safeZ').value = S.safeZ === null ? '' : fmtZ(S.safeZ);
        $('incRetract').checked = S.incRetract;
        $('scrub').max = P.moves.n;
        $('codeBody').scrollTop = 0;
        recompute(true);
        buildFeedRows();
        renderInfo();
        setView('iso');
        setPosition(P.moves.n - 1, 1, true);
      } catch (err) {
        if (window.console) console.error(err);
        toast('Could not read this file: ' + err.message, 'bad');
      }
      $('busy').hidden = true;
    }, 30);
  }

  function loadSample() {
    load(Sample.name, new TextEncoder().encode(Sample.make({ inch: !S.metric })), true);
  }

  // Feeds in the file are in the file's units; this converts them for display.
  function toDisplayFeed(value, fileInch) {
    var k = (fileInch ? 1 : 0) === (S.P.inch ? 1 : 0) ? 1 : (fileInch ? 25.4 : 1 / 25.4);
    var v = value * k;
    return S.P.inch ? Math.round(v * 10) / 10 : Math.round(v);
  }

  function renderUnitsItem() {
    $('unitsItem').textContent = S.metric ? 'Change to imperial' : 'Change to metric';
  }

  function setUnits(metric) {
    S.metric = metric;
    try { localStorage.setItem('feedfix.units', metric ? 'metric' : 'imperial'); } catch (e) { /* not remembered */ }
    renderUnitsItem();
    toast(metric ? 'Showing metric: mm and mm/min.' : 'Showing imperial: inches and in/min.');
    if (!S.P) return;
    if (S.sample) loadSample();
    else load(S.name, S.bytes, false, { feedMap: S.feedMap, safeZ: S.safeZ, autoZ: S.auto ? S.auto.z : null });
  }

  // ---- analysis --------------------------------------------------------------

  function recompute(fresh) {
    var P = S.P;
    if (!P) return;
    S.cls = Core.classify(P, S.safeZ, S.cls);
    viewer.setClasses(S.cls);
    viewer.setSafeZ(S.safeZ);
    S.plan = Core.planEdits(P, S.cls, { airFeed: S.airFeed, includeRetracts: S.incRetract, feedMap: S.feedMap });
    S.tA = Core.moveTimes(P, null, S.maxRate);
    S.tB = Core.moveTimes(P, S.plan.moveFeed, S.maxRate);
    var n = P.moves.n, cum = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) cum[i + 1] = cum[i] + S.tB[i];
    S.cumB = cum;
    S.sum = Core.summarize(P, S.cls, S.tA, S.tB);
    var at = new Int32Array(P.lineCount).fill(-1);
    S.plan.edits.forEach(function (e, k) { at[e.line] = k; });
    S.editAt = at;
    S.verify = null;
    renderLegend();
    renderTimes();
    renderAir();
    if (!fresh) renderFeedUsage();
    renderVerify();
    renderCode();
    renderDro();
    verifySoon();
  }

  var verifySoon = debounce(function () {
    if (!S.P) return;
    var out = Core.buildOutput(S.bytes, S.plan.edits);
    S.verify = Core.verify(S.P, out, S.plan);
    renderVerify();
  }, 350);

  // ---- legend ----------------------------------------------------------------

  var legendBuilt = false;
  function renderLegend() {
    var box = $('legend'), bc = S.sum.byClass;
    if (!legendBuilt) {
      box.innerHTML = CLASSES.map(function (c, i) {
        return '<button type="button" class="lg on" data-cls="' + i + '" aria-pressed="true" title="' + esc(c.title) + '">' +
          '<span class="sw sw-' + c.key + '"></span><span class="lg-name">' + c.label + '</span><span class="lg-n" id="lgn' + i + '"></span></button>';
      }).join('');
      box.addEventListener('click', function (e) {
        var b = e.target.closest('.lg');
        if (!b) return;
        var i = +b.getAttribute('data-cls'), on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('on', on);
        viewer.setVisible(i, on);
      });
      legendBuilt = true;
    }
    for (var i = 0; i < 5; i++) {
      $('lgn' + i).textContent = bc[i].count.toLocaleString();
      box.children[i].classList.toggle('empty', bc[i].count === 0);
    }
  }

  // ---- cycle time ------------------------------------------------------------

  function renderTimes() {
    var sum = S.sum, a = sum.totalA, b = sum.totalB;
    $('tOrig').textContent = fmtTime(a);
    $('tNew').textContent = fmtTime(b);
    var pct = a > 0 ? Math.round((1 - b / a) * 100) : 0;
    var save = $('tSave');
    save.textContent = pct > 0 ? '−' + pct + '%' : pct < 0 ? '+' + (-pct) + '%' : 'no change';
    save.className = 'save' + (pct > 0 ? ' good' : pct < 0 ? ' worse' : '');
    function stack(key) {
      return sum.byClass.map(function (c, i) {
        var w = a > 0 ? c[key] / a * 100 : 0;
        if (w <= 0) return '';
        return '<span class="st st-' + CLASSES[i].key + '" style="width:' + w.toFixed(3) + '%" title="' + CLASSES[i].label + ': ' + fmtTime(c[key]) + '"></span>';
      }).join('');
    }
    $('barA').innerHTML = stack('tA');
    $('barB').innerHTML = stack('tB');
    $('barAT').textContent = fmtTime(a);
    $('barBT').textContent = fmtTime(b);
  }

  // ---- air moves ---------------------------------------------------------------

  function renderAir() {
    var P = S.P, mv = P.moves, cls = S.cls, feeds = {}, count = 0, len = 0, arcs = 0;
    for (var i = 0; i < mv.n; i++) {
      if (!Core.isSpedUp(P, cls, i, S.incRetract) || (mv.flags[i] & Core.FLAG.SKIP) || mv.fmode[i] !== 94) continue;
      count++; len += mv.len[i];
      if (mv.arc[i] >= 0) arcs++;
      var f = mv.feed[i];
      if (f === f) feeds[toDisplayFeed(f, mv.inch[i])] = 1;
    }
    var list = Object.keys(feeds).map(Number).sort(function (x, y) { return x - y; });
    $('airPill').textContent = count.toLocaleString() + (count === 1 ? ' move' : ' moves');
    $('airCur').innerHTML = list.length ? list.slice(0, 6).map(function (v) { return '<span>' + num(v) + '</span>'; }).join(' <span class="sep">·</span> ') +
      (list.length > 6 ? ' <span>+' + (list.length - 6) + ' more</span>' : '') + ' <span class="fu-inline">' + unitLen() + '/min</span>' : '—';
    $('airLen').textContent = count ? fmtLen(len) + ' of travel' : 'No air moves found';

    var hint, a = S.auto;
    if (a.z === null) hint = 'No safe height found automatically. Enter a height just above the top of your stock.';
    else hint = 'Auto: Z ' + fmtZ(a.z) + (a.maxCutZ !== null ? ', the lowest approach height above the highest cutting move (Z ' + fmtZ(a.maxCutZ) + ').' : '.');
    $('safeHint').textContent = hint;

    var warn = [];
    if (S.safeZ !== null && a.maxCutZ !== null && S.safeZ <= a.maxCutZ + 1e-9) {
      warn.push('This is at or below the highest cutting move (Z ' + fmtZ(a.maxCutZ) + '). Cutting moves above it would be sped up.');
    }
    if (arcs) warn.push(arcs + (arcs === 1 ? ' arc is' : ' arcs are') + ' above the safe height and will be sped up. Make sure they are not cutting.');
    var w = $('airWarn');
    w.hidden = !warn.length;
    w.textContent = warn.join(' ');
    $('safeAuto').disabled = a.z === null || S.safeZ === a.z;
  }

  // ---- programmed feeds table -----------------------------------------------

  var feedRows = [];
  function buildFeedRows() {
    feedRows = Core.feedTable(S.P, S.cls, S.tA);
    var body = $('feedRows');
    if (!feedRows.length) {
      body.innerHTML = '<tr><td colspan="3" class="fine">No feed moves in this program.</td></tr>';
      return;
    }
    body.innerHTML = feedRows.map(function (r, i) {
      var locked = r.mode === 93;
      return '<tr>' +
        '<th scope="row"><span class="fv">F' + num(r.value) + '</span><span class="fu">' + feedUnit(r.mode, r.inch) + '</span>' +
        (r.mode === 94 && r.inch !== S.P.inch ? '<span class="fu">≈ ' + num(toDisplayFeed(r.value, r.inch)) + ' ' + unitLen() + '/min</span>' : '') + '</th>' +
        '<td class="use" id="use' + i + '"></td>' +
        '<td class="nf"><input type="number" min="0" step="any" inputmode="decimal" id="feedIn' + i + '" data-row="' + i + '"' +
        ' placeholder="' + num(r.value) + '" aria-label="New feed for F' + num(r.value) + '"' +
        (S.feedMap[r.key] > 0 ? ' value="' + num(S.feedMap[r.key]) + '"' : '') +
        (locked ? ' disabled title="Inverse-time feeds are left as they are"' : '') + '></td>' +
        '</tr>';
    }).join('');
    renderFeedUsage();
  }

  function renderFeedUsage() {
    var rows = Core.feedTable(S.P, S.cls, S.tA);
    rows.forEach(function (r, i) {
      var cell = $('use' + i);
      if (!cell) return;
      var parts = [];
      for (var c = 4; c >= 1; c--) {
        if (!r.byClass[c]) continue;
        parts.push('<span class="u"><span class="dot dot-' + CLASSES[c].key + '"></span>' + r.byClass[c] + ' ' + CLASSES[c].label.toLowerCase() + '</span>');
      }
      cell.innerHTML = '<span class="parts">' + (parts.join('') || '<span class="u">unused</span>') + '</span>' +
        '<span class="fine">' + fmtLen(r.len) + ' · ' + fmtTime(r.time) + '</span>';
    });
  }

  $('feedRows').addEventListener('input', debounce(function () {
    var map = {};
    feedRows.forEach(function (r, i) {
      var el = $('feedIn' + i);
      var v = el ? parseFloat(el.value) : NaN;
      if (v > 0 && Math.abs(v - r.value) > 1e-9) map[r.key] = v;
    });
    S.feedMap = map;
    recompute();
  }, 250));

  // ---- output check ------------------------------------------------------------

  function renderVerify() {
    var box = $('verify'), v = S.verify, edits = S.plan.edits;
    var nIns = 0;
    edits.forEach(function (e) { if (e.insert) nIns++; });
    var lines = S.plan.edits.length;
    $('changedCount').textContent = lines.toLocaleString() + (lines === 1 ? ' line changed' : ' lines changed');
    $('changedCount').classList.toggle('none', lines === 0);
    var name = outName(S.name);
    $('downloadBtn').title = 'Download ' + name;
    $('dlName').textContent = name;
    if (!v) {
      box.className = 'verify pending';
      box.innerHTML = '<strong>Checking the edited file…</strong>';
      return;
    }
    if (v.ok) {
      box.className = 'verify ok';
      box.innerHTML = '<strong>Toolpath verified identical</strong>' +
        '<span>' + v.moves.toLocaleString() + ' moves re-read from the new file match the original exactly. ' +
        (lines ? (lines - nIns) + (lines - nIns === 1 ? ' F value' : ' F values') + ' changed and ' + nIns + ' added, on ' +
          v.changedLines.toLocaleString() + (v.changedLines === 1 ? ' line' : ' lines') + '. Every other byte is untouched.' :
          'No feeds are changed yet.') + '</span>';
    } else {
      box.className = 'verify bad';
      box.innerHTML = '<strong>Check failed. Download is blocked.</strong><span>The edited file did not re-read identically' +
        (v.first && v.first.line >= 0 ? ' (line ' + (v.first.line + 1) + ')' : '') + '. Please report this file.</span>';
    }
  }

  function outName(name) {
    var m = /^(.*?)(\.[A-Za-z0-9]{1,6})?$/.exec(name || 'program.nc');
    return (m[1] || 'program') + '_fast' + (m[2] || '.nc');
  }

  var dlCap = window.claude && typeof window.claude.use === 'function' ? window.claude.use('downloads') : null;
  if (dlCap) dlCap.then(function (d) { if (d) $('previewNote').hidden = false; }, function () {});

  function download() {
    if (!S.P) return;
    var out = Core.buildOutput(S.bytes, S.plan.edits);
    S.verify = Core.verify(S.P, out, S.plan);
    renderVerify();
    if (!S.verify.ok) { toast('The edited file did not verify, so nothing was downloaded.', 'bad'); return; }
    var name = outName(S.name);
    var direct = function () {
      var url = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('Downloaded ' + name);
    };
    if (!dlCap) return direct();
    dlCap.then(function (d) {
      if (!d) return direct();
      d.save({ filename: name + '.txt', data: new Blob([out], { type: 'text/plain' }) }).then(function () {
        toast('Saved ' + name + '.txt. Rename it to ' + name + '.');
      }, function (e) {
        if (!e || e.code !== 'declined') toast('Download failed: ' + ((e && (e.message || e.code)) || 'unknown error'), 'bad');
      });
    }, direct);
  }

  // ---- program info ----------------------------------------------------------

  function renderInfo() {
    var P = S.P, b = P.bbox, u = unitLen();
    function rng(a, c) { return fmtZ(a) + ' to ' + fmtZ(c) + ' <span class="fine">(' + fmtZ(c - a) + ')</span>'; }
    var rows = [
      ['File', esc(S.name) + ' <span class="fine">' + (P.bytes.length / 1024).toFixed(1) + ' KB</span>'],
      ['Lines', P.lineCount.toLocaleString() + ' <span class="fine">' + P.moves.n.toLocaleString() + ' moves</span>'],
      ['Units', ({ inch: 'Inch (G20)', mm: 'Millimetre (G21)', mixed: 'Mixed G20 and G21' }[P.fileUnits] || 'Not stated, read as mm') +
        (P.fileUnits !== (P.inch ? 'inch' : 'mm') ? ' <span class="fine">shown in ' + (P.inch ? 'inches' : 'millimetres') + '</span>' : '')],
      ['X', rng(b.minX, b.maxX)], ['Y', rng(b.minY, b.maxY)], ['Z', rng(b.minZ, b.maxZ)],
      ['Tools', P.tools.length ? P.tools.map(function (t) { return 'T' + num(t.t); }).join(', ') : '—'],
      ['Spindle', P.spindleMax ? 'up to S' + num(P.spindleMax) : '—']
    ];
    $('info').innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('');
    $('info').setAttribute('data-units', u);
    var notes = $('notes');
    notes.innerHTML = P.warnings.map(function (w) {
      return '<li><button type="button" class="linklike" data-line="' + w.line + '">Line ' + (w.line + 1) + '</button> ' + esc(w.text) +
        (w.count > 1 ? ' <span class="fine">(' + w.count + ' lines)</span>' : '') + '</li>';
    }).join('');
    notes.hidden = !P.warnings.length;
  }
  $('notes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-line]');
    if (b) selectLine(+b.getAttribute('data-line'));
  });

  // ---- code panel -----------------------------------------------------------

  var codeBody = $('codeBody'), codeRows = $('codeRows'), codeSpacer = $('codeSpacer');
  var TOKEN = /(\([^)]*\)?|;.*$)|([A-Za-z])(\s*[-+]?(?:\d+\.?\d*|\.\d+))?/g;

  function hl(s) {
    var out = '', last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[1]) out += '<span class="k-c">' + esc(m[1]) + '</span>';
      else {
        var L = m[2].toUpperCase();
        var k = L === 'G' || L === 'M' ? 'g' : L === 'F' ? 'f' : 'XYZ'.indexOf(L) >= 0 ? 'a' : 'IJKR'.indexOf(L) >= 0 ? 'i' : L === 'N' || L === 'O' ? 'n' : 'o';
        out += '<span class="k-' + k + '">' + esc(m[0]) + '</span>';
      }
      last = TOKEN.lastIndex;
      if (!m[0].length) TOKEN.lastIndex++;
    }
    return out + esc(s.slice(last));
  }

  function dec(a, b) { return b > a ? S.decoder.decode(S.bytes.subarray(a, b)) : ''; }

  function lineHtml(i) {
    var P = S.P, a = P.lineStart[i], b = P.lineEnd[i], k = S.editAt[i];
    if (k < 0) return hl(dec(a, b));
    var e = S.plan.edits[k];
    if (e.insert) return hl(dec(a, e.pos)) + '<ins class="fnew" title="Added. Was running at F' + num(e.from) + '">' + esc(e.text) + '</ins>' + hl(dec(e.pos, b));
    var fl = P.lineF[i];
    return hl(dec(a, fl)) + '<span class="fnew" title="Was F' + num(e.from) + '">' + esc(dec(fl, e.pos) + e.text) + '</span>' + hl(dec(e.end, b));
  }

  function codeWindow() {
    var n = S.P.lineCount, vh = codeBody.clientHeight, total = n * ROW_H;
    var spacer = Math.min(total, MAX_SPACER), st = codeBody.scrollTop, first, offset;
    if (total <= MAX_SPACER) { first = Math.floor(st / ROW_H); offset = first * ROW_H; }
    else {
      var frac = st / Math.max(1, spacer - vh);
      first = Math.floor(frac * Math.max(0, n - vh / ROW_H));
      offset = st;
    }
    return { first: Math.max(0, first), offset: offset, count: Math.ceil(vh / ROW_H) + 2, spacer: spacer, total: total, vh: vh };
  }

  function renderCode() {
    if (!S.P) return;
    var w = codeWindow(), n = S.P.lineCount, html = '';
    codeSpacer.style.height = w.spacer + 'px';
    for (var i = w.first; i < Math.min(n, w.first + w.count); i++) {
      var c = 'row' + (i === S.curLine ? ' cur' : '') + (S.editAt[i] >= 0 ? ' changed' : '');
      html += '<div class="' + c + '" data-line="' + i + '"><span class="ln">' + (i + 1) + '</span><span class="tx">' + (lineHtml(i) || ' ') + '</span></div>';
    }
    codeRows.style.transform = 'translateY(' + w.offset + 'px)';
    codeRows.innerHTML = html;
    $('codeInfo').textContent = n.toLocaleString() + ' lines';
  }

  function scrollToLine(li, force) {
    var n = S.P.lineCount, vh = codeBody.clientHeight, total = n * ROW_H;
    if (total <= MAX_SPACER) {
      var top = li * ROW_H;
      if (!force && top >= codeBody.scrollTop && top + ROW_H <= codeBody.scrollTop + vh) return;
      codeBody.scrollTop = Math.max(0, top - vh / 2 + ROW_H / 2);
    } else {
      codeBody.scrollTop = li / Math.max(1, n - vh / ROW_H) * (MAX_SPACER - vh);
    }
    renderCode();
  }

  var codeRaf = 0;
  codeBody.addEventListener('scroll', function () {
    if (codeRaf) return;
    codeRaf = requestAnimationFrame(function () { codeRaf = 0; renderCode(); });
  });
  codeRows.addEventListener('click', function (e) {
    var r = e.target.closest('.row');
    if (r) selectLine(+r.getAttribute('data-line'), true);
  });
  codeBody.addEventListener('keydown', function (e) {
    if (!S.P) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectLine(Math.max(0, Math.min(S.P.lineCount - 1, (S.curLine < 0 ? 0 : S.curLine) + (e.key === 'ArrowDown' ? 1 : -1))));
    }
  });

  function jumpChange(dir) {
    var edits = S.plan.edits;
    if (!edits.length) return;
    var cur = S.curLine, lo = 0, hi = edits.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (edits[mid].line <= cur) lo = mid + 1; else hi = mid; }
    var k = dir > 0 ? lo : lo - 1;
    if (dir < 0 && k >= 0 && edits[k].line === cur) k--;
    if (k < 0) k = edits.length - 1;
    if (k >= edits.length) k = 0;
    selectLine(edits[k].line);
  }
  $('prevChange').addEventListener('click', function () { jumpChange(-1); });
  $('nextChange').addEventListener('click', function () { jumpChange(1); });

  // ---- position, DRO, playback --------------------------------------------------

  function setPosition(m, frac, keepScroll) {
    var P = S.P, n = P.moves.n;
    S.curMove = m; S.frac = frac;
    if (!n) { viewer.setProgress(Infinity, null, null); renderDro(); return; }
    var tool, trail = null, cut;
    if (m < 0) { cut = 0; tool = Core.pointAt(P, 0, 0); }
    else {
      cut = frac >= 1 ? m + 1 : m;
      tool = Core.pointAt(P, m, frac);
      if (!(P.moves.flags[m] & Core.FLAG.SKIP)) trail = Core.movePolyline(P, m, frac);
    }
    var atEnd = m >= n - 1 && frac >= 1;
    viewer.setProgress(atEnd && !S.playing ? Infinity : cut, tool, trail);
    $('scrub').value = frac >= 1 ? m + 1 : Math.max(0, m);
    var line = m >= 0 ? P.moves.line[m] : (n ? P.moves.line[0] : -1);
    if (line !== S.curLine) {
      S.curLine = line;
      if (!keepScroll && line >= 0) scrollToLine(line); else renderCode();
    }
    renderDro(tool);
  }

  function renderDro(tool) {
    var P = S.P;
    if (!P) return;
    var mv = P.moves, m = Math.min(S.curMove, mv.n - 1);
    tool = tool || (P.moves.n ? Core.pointAt(P, Math.max(0, m), m < 0 ? 0 : S.frac) : [0, 0, 0]);
    $('droX').textContent = fmtZ(tool[0]);
    $('droY').textContent = fmtZ(tool[1]);
    $('droZ').textContent = fmtZ(tool[2]);
    var fTxt = '—', feedCls = '';
    if (m >= 0 && m < mv.n) {
      if (mv.kind[m] === Core.KIND.RAPID) fTxt = 'Rapid';
      else {
        var f = S.plan.moveFeed[m];
        fTxt = f === f ? num(f) : '—';
        if (f === f && Math.abs(f - mv.feed[m]) > 1e-9) feedCls = 'changed';
      }
    }
    $('droF').textContent = fTxt;
    $('droF').className = feedCls;
    $('droN').textContent = S.curLine >= 0 ? (S.curLine + 1).toLocaleString() : '—';
    var el = m < 0 ? 0 : S.cumB[m] + S.tB[m] * Math.min(1, S.frac);
    $('droT').textContent = fmtTime(el) + ' / ' + fmtTime(S.cumB[mv.n]);
  }

  function selectLine(li, keepScroll) {
    var P = S.P;
    if (!P) return;
    stop();
    li = Math.max(0, Math.min(P.lineCount - 1, li));
    var m0 = P.lineMove[li], m1 = P.lineMove[li + 1];
    S.curLine = li;
    if (m1 > m0) setPosition(m1 - 1, 1, true);
    else setPosition(m0 - 1, 1, true);
    S.curLine = li;
    if (!keepScroll) scrollToLine(li); else renderCode();
    renderDro();
  }

  function jumpToMove(m) {
    stop();
    setPosition(m, 1, false);
  }

  $('scrub').addEventListener('input', function () {
    stop();
    var v = +this.value;
    if (v <= 0) setPosition(-1, 1); else setPosition(v - 1, 1);
  });

  function upper(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  var last = 0;
  function tick(now) {
    if (!S.playing) return;
    var n = S.P.moves.n, dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    S.simT += dt / 60 * S.speed;
    var total = S.cumB[n];
    if (S.simT >= total) { stop(); setPosition(n - 1, 1); return; }
    var m = Math.min(n - 1, Math.max(0, upper(S.cumB, S.simT) - 1));
    var frac = S.tB[m] > 0 ? (S.simT - S.cumB[m]) / S.tB[m] : 1;
    setPosition(m, Math.max(0, Math.min(1, frac)));
    requestAnimationFrame(tick);
  }

  function play() {
    if (!S.P || !S.P.moves.n) return;
    if (S.playing) return stop();
    var n = S.P.moves.n;
    if (S.curMove >= n - 1 && S.frac >= 1) S.simT = 0;
    else S.simT = S.curMove < 0 ? 0 : S.cumB[S.curMove] + S.tB[S.curMove] * Math.min(1, S.frac);
    S.playing = true;
    $('playBtn').classList.add('playing');
    $('playBtn').setAttribute('aria-label', 'Pause simulation');
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function stop() {
    if (!S.playing) return;
    S.playing = false;
    $('playBtn').classList.remove('playing');
    $('playBtn').setAttribute('aria-label', 'Play simulation');
    if (S.P) setPosition(S.curMove, S.frac, true);
  }

  $('playBtn').addEventListener('click', play);
  $('speedSel').innerHTML = SPEEDS.map(function (s) { return '<option value="' + s + '"' + (s === S.speed ? ' selected' : '') + '>' + s + '×</option>'; }).join('');
  $('speedSel').addEventListener('change', function () { S.speed = +this.value; });
  document.addEventListener('keydown', function (e) {
    if (e.key !== ' ' || e.target.closest('input, select, textarea, button, [contenteditable]')) return;
    e.preventDefault();
    play();
  });

  // ---- view buttons ------------------------------------------------------------

  function setView(v) {
    if (v === 'fit') viewer.fit(); else viewer.view(v);
    Array.prototype.forEach.call(document.querySelectorAll('.views button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-view') === v ? 'true' : 'false');
    });
  }
  document.querySelector('.views').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) setView(b.getAttribute('data-view'));
  });
  $('safeShow').addEventListener('change', function () { viewer.setSafeZ(S.safeZ, this.checked); });

  // ---- inputs --------------------------------------------------------------------

  $('safeZ').addEventListener('input', debounce(function () {
    var v = parseFloat($('safeZ').value);
    S.safeZ = v === v ? v : null;
    recompute();
  }, 250));
  $('safeAuto').addEventListener('click', function () {
    S.safeZ = S.auto.z;
    $('safeZ').value = S.safeZ === null ? '' : fmtZ(S.safeZ);
    recompute();
  });
  $('incRetract').addEventListener('change', function () { S.incRetract = this.checked; recompute(); });
  $('airFeed').addEventListener('input', debounce(function () {
    var v = parseFloat($('airFeed').value);
    S.airFeed = v > 0 ? v : 0;
    saveSettings();
    recompute();
  }, 250));
  $('maxRate').addEventListener('input', debounce(function () {
    var v = parseFloat($('maxRate').value);
    S.maxRate = v > 0 ? v : 0;
    saveSettings();
    recompute();
  }, 250));

  // ---- files -------------------------------------------------------------------

  function openFile(file) {
    if (!file) return;
    if (file.size > 300 * 1024 * 1024) { toast('That file is over 300 MB, which is too large to open here.', 'bad'); return; }
    file.arrayBuffer().then(function (buf) { load(file.name, new Uint8Array(buf), false); },
      function () { toast('Could not read that file.', 'bad'); });
  }
  $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function () { openFile(this.files[0]); this.value = ''; });
  $('sampleBtn').addEventListener('click', loadSample);
  $('downloadBtn').addEventListener('click', download);
  $('downloadBtn2').addEventListener('click', download);

  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('drop').hidden = false; });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('drop').hidden = true;
    openFile(e.dataTransfer.files[0]);
  });

  // ---- toast --------------------------------------------------------------------

  var toastTimer = 0;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 4200);
  }

  // ---- help menu, how-it-works and reports ------------------------------------------

  var APP_VERSION = '1.0.0';
  var REPORT_URL = new URL('api/reports', location.href).toString();
  var ATTACH_LIMIT = 512 * 1024;
  var helpBtn = $('helpBtn'), helpMenu = $('helpMenu');

  function menuItems() { return Array.prototype.slice.call(helpMenu.querySelectorAll('[role="menuitem"]')); }
  function setMenu(open, focusFirst) {
    helpMenu.hidden = !open;
    helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && focusFirst) menuItems()[0].focus();
  }
  helpBtn.addEventListener('click', function () { setMenu(helpMenu.hidden, false); });
  helpBtn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setMenu(true, true); }
  });
  helpMenu.addEventListener('keydown', function (e) {
    var items = menuItems(), i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setMenu(false); helpBtn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') setMenu(false);
  });
  document.addEventListener('click', function (e) {
    if (!helpMenu.hidden && !e.target.closest('.menu-wrap')) setMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !helpMenu.hidden) { setMenu(false); helpBtn.focus(); }
  });
  helpMenu.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    setMenu(false);
    var act = b.getAttribute('data-act');
    if (act === 'how') openDialog($('howDlg'));
    else if (act === 'units') setUnits(!S.metric);
    else openReport(act);
  });

  function openDialog(d) {
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.dlg'), function (d) {
    d.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]') || e.target === d) closeDialog(d);
    });
  });

  function reportKind() { return $('kindFeature').checked ? 'feature' : 'bug'; }

  function syncReportKind() {
    var bug = reportKind() === 'bug';
    $('reportH').textContent = bug ? 'Report a bug' : 'Request a feature';
    $('rDetailsLabel').textContent = bug ? 'What happened? What did you expect instead?' : 'What would you like FeedFix to do?';
    $('rDetails').placeholder = bug ? 'Steps, the line number or the move that looks wrong, and what you expected.' : 'Describe the feature and how you would use it.';
    $('rTitle').placeholder = bug ? 'e.g. Arcs in the contour are drawn the wrong way' : 'e.g. Show the stock outline';
    $('rSend').textContent = bug ? 'Send bug report' : 'Send request';
    var canAttach = bug && S.P && !S.sample;
    $('rAttachRow').hidden = !canAttach;
    if (canAttach) {
      var big = S.bytes.length > ATTACH_LIMIT;
      $('rAttach').disabled = big;
      if (big) $('rAttach').checked = false;
      $('rAttachInfo').textContent = '(' + S.name + ', ' + (S.bytes.length / 1024).toFixed(1) + ' KB' + (big ? ', too large to attach' : '') + ')';
    }
    $('rCtx').textContent = JSON.stringify(reportContext(), null, 2);
  }
  $('kindBug').addEventListener('change', syncReportKind);
  $('kindFeature').addEventListener('change', syncReportKind);

  function reportContext() {
    var P = S.P, ctx = {
      app: 'FeedFix ' + APP_VERSION,
      page: location.origin + location.pathname,
      browser: navigator.userAgent,
      screen: window.innerWidth + 'x' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x',
      webgl: !!viewer.ok,
      display: S.metric ? 'metric' : 'imperial'
    };
    if (P) {
      ctx.program = {
        name: S.sample ? 'sample (' + S.name + ')' : S.name,
        bytes: P.bytes.length, lines: P.lineCount, moves: P.moves.n,
        units: P.fileUnits || 'not stated',
        notes: P.warnings.map(function (w) { return w.code + '@' + (w.line + 1); })
      };
      ctx.settings = {
        safeZ: S.safeZ, autoSafeZ: S.auto ? S.auto.z : null, highestCutZ: S.auto ? S.auto.maxCutZ : null,
        airFeed: S.airFeed, maxRate: S.maxRate, retracts: S.incRetract, feedChanges: S.feedMap
      };
      ctx.result = {
        linesChanged: S.plan ? S.plan.edits.length : 0,
        verified: S.verify ? S.verify.ok : null,
        minutes: S.sum ? [Math.round(S.sum.totalA * 100) / 100, Math.round(S.sum.totalB * 100) / 100] : null,
        line: S.curLine + 1
      };
    }
    return ctx;
  }

  function openReport(kind) {
    $('reportForm').reset();
    (kind === 'feature' ? $('kindFeature') : $('kindBug')).checked = true;
    $('reportForm').hidden = false;
    $('reportDone').hidden = true;
    $('rError').hidden = true;
    $('rCopy').hidden = true;
    $('rSend').disabled = false;
    syncReportKind();
    openDialog($('reportDlg'));
    $('rTitle').focus();
  }

  function reportText() {
    var lines = [
      (reportKind() === 'bug' ? 'Bug: ' : 'Feature request: ') + $('rTitle').value.trim(),
      '',
      $('rDetails').value.trim()
    ];
    if ($('rContact').value.trim()) lines.push('', 'From: ' + $('rContact').value.trim());
    lines.push('', JSON.stringify(reportContext(), null, 2));
    return lines.join('\n');
  }

  function reportFailed(msg) {
    $('rError').textContent = msg + ' You can copy the report and send it another way.';
    $('rError').hidden = false;
    $('rCopy').hidden = false;
    $('rSend').disabled = false;
    syncReportKind();
  }

  $('reportForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = $('rTitle').value.trim(), details = $('rDetails').value.trim();
    if (!title || !details) {
      $('rError').textContent = !title ? 'Add a short summary first.' : 'Add a few details first.';
      $('rError').hidden = false;
      (!title ? $('rTitle') : $('rDetails')).focus();
      return;
    }
    var body = {
      kind: reportKind(), title: title, details: details,
      contact: $('rContact').value.trim(), website: $('rWebsite').value,
      context: reportContext(), attachment: null
    };
    if (!$('rAttachRow').hidden && $('rAttach').checked) body.attachment = { name: S.name, text: S.decoder.decode(S.bytes) };
    $('rError').hidden = true;
    $('rSend').disabled = true;
    $('rSend').textContent = 'Sending…';
    fetch(REPORT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; });
      })
      .then(function (res) {
        if (res.r.ok && res.j.ok) {
          $('reportForm').hidden = true;
          $('reportDone').hidden = false;
          $('reportDoneText').textContent = (body.kind === 'bug' ? 'Bug report' : 'Feature request') +
            (res.j.id ? ' #' + res.j.id : '') + ' is in the inbox. Thanks for helping make FeedFix better.';
          $('reportDone').querySelector('[data-close]').focus();
        } else {
          reportFailed(res.j.error || 'The report inbox answered with an error (' + res.r.status + ').');
        }
      }, function () {
        reportFailed('The report inbox could not be reached from this page.');
      });
  });

  $('rCopy').addEventListener('click', function () {
    var text = reportText();
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      $('reportForm').appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      toast(ok ? 'Report copied.' : 'Copy was blocked. Select the text in the details box and copy it by hand.', ok ? '' : 'bad');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Report copied.'); }, fallback);
    } else fallback();
  });

  window.addEventListener('resize', debounce(renderCode, 100));
  renderUnitsItem();
  loadSample();
}());
