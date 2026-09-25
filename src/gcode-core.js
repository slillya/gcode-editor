/*!
 * FeedFix core: G-code parsing, move classification and byte-exact feed editing.
 * No DOM access. Loads in the browser as window.GCodeCore and in Node via require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCodeCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Move kinds
  var KIND_RAPID = 0, KIND_LINE = 1, KIND_CW = 2, KIND_CCW = 3;
  // Move classes (drawing colours and feed rules)
  var CLS_RAPID = 0, CLS_AIR = 1, CLS_RETRACT = 2, CLS_PLUNGE = 3, CLS_CUT = 4;
  // Move flags
  var FLAG_CYCLE = 1, FLAG_HOME = 2, FLAG_SKIP = 4, FLAG_PROBE = 8, FLAG_GUESS = 16;
  // How a block uses the modal feed
  var USE_NONE = 0, USE_FEED = 1, USE_CYCLE = 2;

  var TAU = Math.PI * 2;
  var TOL = 1e-6;
  // Word letter indices (A = 0)
  var LF = 5, LI = 8, LJ = 9, LK = 10, LP = 15, LQ = 16, LR = 17, LS = 18, LT = 19, LX = 23, LY = 24, LZ = 25;

  // ---------------------------------------------------------------------------
  // Growable column store backed by typed arrays

  function Store(fields, cap) {
    this.n = 0;
    this.cap = Math.max(cap | 0, 16);
    this._fields = fields;
    for (var k in fields) this[k] = new fields[k](this.cap);
  }
  Store.prototype.reserve = function (extra) {
    var need = this.n + extra;
    if (need <= this.cap) return;
    var cap = Math.max(need, this.cap * 2);
    for (var k in this._fields) {
      var a = new this._fields[k](cap);
      a.set(this[k]);
      this[k] = a;
    }
    this.cap = cap;
  };
  Store.prototype.trim = function () {
    for (var k in this._fields) this[k] = this[k].slice(0, this.n);
    this.cap = this.n;
  };

  var MOVE_FIELDS = {
    line: Int32Array, kind: Uint8Array, flags: Uint8Array,
    x0: Float64Array, y0: Float64Array, z0: Float64Array,
    x1: Float64Array, y1: Float64Array, z1: Float64Array,
    feed: Float64Array, fmode: Uint8Array, inch: Uint8Array, spin: Float64Array,
    arc: Int32Array, extra: Float64Array, epoch: Int32Array,
    len: Float64Array, zmin: Float64Array, zmax: Float64Array
  };
  var ARC_FIELDS = {
    ca: Float64Array, cb: Float64Array, r0: Float64Array, r1: Float64Array,
    t0: Float64Array, sweep: Float64Array, plane: Uint8Array
  };

  // ---------------------------------------------------------------------------
  // Numbers

  var RN_END = -1, RN_NUM = -1;

  // Reads a decimal number from bytes[p..end). Sets RN_NUM (first byte of the
  // number, sign included) and RN_END (one past the last byte, -1 if none).
  function readNum(b, p, end) {
    while (p < end && (b[p] === 32 || b[p] === 9)) p++;
    RN_NUM = p;
    var neg = false;
    if (p < end && (b[p] === 45 || b[p] === 43)) { neg = b[p] === 45; p++; }
    var start = p, ip = 0, fr = 0, sc = 1, digits = 0, dot = false;
    for (; p < end; p++) {
      var c = b[p];
      if (c >= 48 && c <= 57) {
        digits++;
        if (dot) { fr = fr * 10 + (c - 48); sc *= 10; } else ip = ip * 10 + (c - 48);
      } else if (c === 46 && !dot) {
        dot = true;
      } else break;
    }
    if (digits === 0) { RN_END = -1; return NaN; }
    RN_END = p;
    var v;
    // One correctly rounded division equals parseFloat for up to 15 digits.
    if (digits <= 15) v = (ip * sc + fr) / sc;
    else {
      var s = '';
      for (var i = start; i < p; i++) s += String.fromCharCode(b[i]);
      v = parseFloat(s);
    }
    return neg ? -v : v;
  }

  function asciiBytes(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  // Parses a formatted number exactly the way parse() reads it back.
  function asciiNum(s) {
    var b = asciiBytes(s);
    return readNum(b, 0, b.length);
  }

  function sameNum(a, b) {
    if (a !== a) return b !== b;
    if (b !== b) return false;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  }

  function numStyle(b, a, e) {
    var dotAt = -1;
    for (var i = a; i < e; i++) if (b[i] === 46) { dotAt = i; break; }
    if (dotAt < 0) return { dec: 0, dot: false, noLead: false };
    var first = a;
    if (b[first] === 45 || b[first] === 43) first++;
    return { dec: e - dotAt - 1, dot: true, noLead: dotAt === first };
  }

  // Formats a feed value in a given token style, with enough decimals to read
  // back as exactly the same number.
  function formatNum(v, st) {
    st = st || { dec: 0, dot: false, noLead: false };
    var d = st.dec, s;
    for (;;) {
      s = v.toFixed(d);
      if (d >= 6 || asciiNum(s) === v) break;
      d++;
    }
    if (st.dot && s.indexOf('.') < 0) s += '.';
    if (st.noLead && s.charAt(0) === '0' && s.charAt(1) === '.') s = s.slice(1);
    return s;
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof input === 'string') {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input);
      return asciiBytes(input);
    }
    throw new TypeError('Expected bytes or a string');
  }

  // ---------------------------------------------------------------------------
  // Parser

  function parse(input, opts) {
    opts = opts || {};
    var bytes = toBytes(input);
    var n = bytes.length, i, c;

    // Line table: \n, \r\n and lone \r all end a line.
    var lc = 0;
    for (i = 0; i < n; i++) {
      c = bytes[i];
      if (c === 10 || (c === 13 && bytes[i + 1] !== 10)) lc++;
    }
    if (n && bytes[n - 1] !== 10 && bytes[n - 1] !== 13) lc++;
    var lineStart = new Int32Array(lc), lineEnd = new Int32Array(lc);
    var li = 0, s0 = 0;
    for (i = 0; i < n; i++) {
      c = bytes[i];
      if (c === 10 || c === 13) {
        lineStart[li] = s0; lineEnd[li] = i; li++;
        if (c === 13 && bytes[i + 1] === 10) i++;
        s0 = i + 1;
      }
    }
    if (s0 < n) { lineStart[li] = s0; lineEnd[li] = n; li++; }

    var lineF = new Int32Array(lc).fill(-1);   // byte offset of the F letter
    var lineFNum = new Int32Array(lc);         // first byte of the F number
    var lineFEnd = new Int32Array(lc);         // one past the F number
    var lineFVal = new Float64Array(lc);
    var lineCodeEnd = new Int32Array(lc);      // insertion point after the last word
    var lineUse = new Uint8Array(lc);
    var lineFMode = new Uint8Array(lc);
    var lineInch = new Uint8Array(lc);
    var lineSpace = new Uint8Array(lc);
    var lineMove = new Int32Array(lc + 1);

    var mv = new Store(MOVE_FIELDS, lc + 16);
    var arcs = new Store(ARC_FIELDS, 64);

    // Modal state
    var motion = 0, cycle = 0, plane = 17, absMode = true, arcAbs = false, units = 21;
    var dispInch = opts.inch === undefined ? undefined : !!opts.inch;
    var feedMode = 94, modalF = NaN, spindle = 0, retMode = 98;
    var px = NaN, py = NaN, pz = NaN, ox = 0, oy = 0, oz = 0;
    var cycR = NaN, cycZ = NaN, cycQ = NaN, cycInit = NaN;
    var ended = false, pendingTool = NaN, epoch = 0, curWcs = 540;

    var warnings = [], warnIdx = {};
    function warn(code, line, text) {
      var w = warnIdx[code];
      if (w) { w.count++; return; }
      warnIdx[code] = w = { code: code, line: line, text: text, count: 1 };
      warnings.push(w);
    }
    var tools = [], toolSeen = {}, wcs = {}, wcsCount = 0;
    var fStyles = {}, fCount = 0, spindleMax = 0;

    var has = new Uint8Array(26), val = new Float64Array(26);
    var gl = [], ml = [];

    function addMove(kind, flags, line, ax, ay, az, bx, by, bz, arcIdx, feed) {
      mv.reserve(1);
      var k = mv.n++;
      mv.line[k] = line; mv.kind[k] = kind; mv.flags[k] = flags;
      mv.x0[k] = ax; mv.y0[k] = ay; mv.z0[k] = az;
      mv.x1[k] = bx; mv.y1[k] = by; mv.z1[k] = bz;
      mv.feed[k] = feed; mv.fmode[k] = feedMode; mv.inch[k] = units === 20 ? 1 : 0;
      mv.spin[k] = spindle; mv.arc[k] = arcIdx; mv.extra[k] = 0; mv.epoch[k] = epoch;
      return k;
    }

    for (li = 0; li < lc; li++) {
      lineMove[li] = mv.n;
      var ls = lineStart[li], le = lineEnd[li];
      for (var q = 0; q < 26; q++) has[q] = 0;
      gl.length = 0; ml.length = 0;
      var fLetter = -1, fNum = -1, fEnd = -1, codeEnd = ls, spaced = 0, words = 0, bad = 0;
      var p = ls;
      while (p < le) {
        c = bytes[p];
        if (c === 32 || c === 9) { p++; continue; }
        if (c === 40) { // ( comment )
          var qq = p + 1;
          while (qq < le && bytes[qq] !== 41) qq++;
          p = qq < le ? qq + 1 : le;
          continue;
        }
        if (c === 59) break;                       // ; comment
        if (c === 37) { p++; continue; }           // % tape marks
        if (c === 47 && words === 0) { p++; continue; } // block delete
        var up = c & 0xdf;
        if (up >= 65 && up <= 90) {
          var v = readNum(bytes, p + 1, le);
          if (RN_END < 0) { bad = 1; p++; continue; }
          if (words > 0 && (bytes[p - 1] === 32 || bytes[p - 1] === 9)) spaced = 1;
          var L = up - 65;
          if (L === 6) gl.push(Math.round(v * 10));
          else if (L === 12) ml.push(Math.round(v * 10));
          else {
            has[L] = 1; val[L] = v;
            if (L === LF) { fLetter = p; fNum = RN_NUM; fEnd = RN_END; }
          }
          words++;
          p = RN_END;
          codeEnd = p;
          continue;
        }
        bad = 1; p++;
      }
      lineCodeEnd[li] = codeEnd;
      lineSpace[li] = spaced;
      lineFMode[li] = feedMode;
      lineInch[li] = units === 20 ? 1 : 0;
      if (bad) warn('syntax', li, 'Unsupported syntax (macro variables, expressions or checksums) was skipped.');
      if (!words) continue;

      var nonModal = 0, newMotion = -1, newCycle = -1, g;
      for (var gi = 0; gi < gl.length; gi++) {
        g = gl[gi];
        switch (g) {
          case 0: case 10: case 20: case 30: newMotion = g; newCycle = 0; break;
          case 382: case 383: case 384: case 385: newMotion = g; newCycle = 0; break;
          case 800: newCycle = 0; break;
          case 730: case 810: case 820: case 830: case 840: case 850:
          case 860: case 870: case 880: case 890: newCycle = g; break;
          case 170: case 180: case 190: plane = g / 10; break;
          case 200: units = 20; if (dispInch === undefined) dispInch = true; break;
          case 210: units = 21; if (dispInch === undefined) dispInch = false; break;
          case 900: absMode = true; break;
          case 910: absMode = false; break;
          case 901: arcAbs = true; break;
          case 911: arcAbs = false; break;
          case 930: case 940: case 950: feedMode = g / 10; break;
          case 980: case 990: retMode = g / 10; break;
          case 400: break;
          case 410: case 420:
            warn('comp', li, 'Cutter compensation (G41/G42) is on. The plot shows the programmed path, not the compensated one.');
            break;
          case 40: case 100: case 280: case 281: case 300: case 301:
          case 520: case 530: case 920: case 921: case 922: case 923:
            nonModal = g; break;
          case 540: case 541: case 550: case 560: case 570: case 580: case 590:
          case 591: case 592: case 593:
            if (g !== curWcs) { curWcs = g; epoch++; }
            if (!wcs[g]) { wcs[g] = 1; wcsCount++; }
            if (wcsCount > 1) warn('wcs', li, 'More than one work offset is used. All of them are drawn in the same coordinate space.');
            break;
          case 680: case 681: case 510: case 511: case 160:
            warn('xform', li, 'Coordinate rotation, scaling or polar mode (G68/G51/G16) is not applied in the plot.');
            break;
          case 90: case 150: case 430: case 431: case 440: case 490: case 500: case 690:
          case 610: case 611: case 640: case 960: case 970: case 1030: case 1870: case 5: case 50:
            break;
          default:
            warn('g' + g, li, 'G' + (g / 10) + ' is not supported and was ignored.');
        }
      }
      lineFMode[li] = feedMode;
      lineInch[li] = units === 20 ? 1 : 0;
      if (newMotion >= 0) motion = newMotion;
      if (newCycle >= 0 && newCycle !== cycle) { cycle = newCycle; cycInit = NaN; }

      var axisWords = has[LX] || has[LY] || has[LZ];
      if (dispInch === undefined && axisWords) dispInch = units === 20;
      var k = (dispInch === undefined || (units === 20) === dispInch) ? 1 : (units === 20 ? 25.4 : 1 / 25.4);

      if (has[LF]) {
        if (feedMode !== 93) modalF = val[LF];
        lineF[li] = fLetter; lineFNum[li] = fNum; lineFEnd[li] = fEnd; lineFVal[li] = val[LF];
        var st = numStyle(bytes, fNum, fEnd);
        var sk = st.dec + (st.dot ? 'd' : '') + (st.noLead ? 'n' : '');
        fStyles[sk] = (fStyles[sk] || 0) + 1;
        fCount++;
      }
      var blockF = feedMode === 93 ? (has[LF] ? val[LF] : NaN) : modalF;
      if (has[LS]) { spindle = val[LS]; if (spindle > spindleMax) spindleMax = spindle; }
      if (has[LT]) {
        if (val[LT] !== pendingTool) epoch++;
        pendingTool = val[LT];
        if (!toolSeen[pendingTool]) { toolSeen[pendingTool] = 1; tools.push({ t: pendingTool, line: li }); }
      }
      if (has[0] || has[1] || has[2]) warn('rotary', li, 'Rotary axis words (A/B/C) are ignored in the plot.');
      var endAfter = false;
      for (var mi = 0; mi < ml.length; mi++) {
        var m = ml[mi];
        if (m === 20 || m === 300) endAfter = true;
        else if (m === 60) epoch++;
        else if (m === 980) warn('sub', li, 'Subprogram calls (M98) are not expanded. The plot follows the file top to bottom.');
      }

      var use = USE_NONE, tx, ty, tz;
      if (nonModal) {
        if (nonModal === 920 || nonModal === 921 || nonModal === 922 || nonModal === 520) epoch++;
        if (nonModal === 920) {
          if (has[LX] && px === px) ox = px - val[LX] * k;
          if (has[LY] && py === py) oy = py - val[LY] * k;
          if (has[LZ] && pz === pz) oz = pz - val[LZ] * k;
        } else if (nonModal === 921 || nonModal === 922) {
          ox = oy = oz = 0;
        } else if (nonModal === 520) {
          if (has[LX]) ox = val[LX] * k;
          if (has[LY]) oy = val[LY] * k;
          if (has[LZ]) oz = val[LZ] * k;
        } else if (nonModal === 280 || nonModal === 300) {
          if (axisWords) {
            tx = has[LX] ? (absMode ? val[LX] * k + ox : px + val[LX] * k) : px;
            ty = has[LY] ? (absMode ? val[LY] * k + oy : py + val[LY] * k) : py;
            tz = has[LZ] ? (absMode ? val[LZ] * k + oz : pz + val[LZ] * k) : pz;
            addMove(KIND_RAPID, FLAG_HOME, li, px, py, pz, tx, ty, tz, -1, blockF);
            px = has[LX] ? NaN : tx; py = has[LY] ? NaN : ty; pz = has[LZ] ? NaN : tz;
          } else {
            px = py = pz = NaN;
          }
        } else if (nonModal === 530) {
          if (has[LX]) px = NaN;
          if (has[LY]) py = NaN;
          if (has[LZ]) pz = NaN;
          warn('g53', li, 'Machine-coordinate moves (G53) are not drawn. The path picks up again at the next known position.');
        }
      } else if (!ended) {
        if (cycle) {
          if (axisWords || has[LR]) {
            if (cycInit !== cycInit) cycInit = pz;
            if (has[LR]) cycR = absMode ? val[LR] * k + oz : cycInit + val[LR] * k;
            if (has[LZ]) cycZ = absMode ? val[LZ] * k + oz : cycR + val[LZ] * k;
            if (has[LQ]) cycQ = Math.abs(val[LQ] * k);
            tx = has[LX] ? (absMode ? val[LX] * k + ox : px + val[LX] * k) : px;
            ty = has[LY] ? (absMode ? val[LY] * k + oy : py + val[LY] * k) : py;
            if (cycR !== cycR || cycZ !== cycZ) {
              warn('cycle', li, 'A canned cycle is missing its R or Z value and was skipped.');
            } else {
              var z = pz;
              if (!(z >= cycR)) { addMove(KIND_RAPID, FLAG_CYCLE, li, px, py, z, px, py, cycR, -1, blockF); z = cycR; }
              addMove(KIND_RAPID, FLAG_CYCLE, li, px, py, z, tx, ty, z, -1, blockF);
              if (z > cycR) addMove(KIND_RAPID, FLAG_CYCLE, li, tx, ty, z, tx, ty, cycR, -1, blockF);
              var fm = addMove(KIND_LINE, FLAG_CYCLE, li, tx, ty, cycR, tx, ty, cycZ, -1, blockF);
              if (cycle === 830 && cycQ > 0) {
                var np = Math.ceil((cycR - cycZ) / cycQ - 1e-9);
                if (np > 1) mv.extra[fm] = cycQ * np * (np - 1);
              }
              var feedOut = cycle === 840 || cycle === 850 || cycle === 890;
              addMove(feedOut ? KIND_LINE : KIND_RAPID, FLAG_CYCLE, li, tx, ty, cycZ, tx, ty, cycR, -1, blockF);
              var endZ = cycR;
              if (retMode === 98 && cycInit > cycR) {
                addMove(KIND_RAPID, FLAG_CYCLE, li, tx, ty, cycR, tx, ty, cycInit, -1, blockF);
                endZ = cycInit;
              }
              px = tx; py = ty; pz = endZ;
              use = USE_CYCLE;
            }
          }
        } else if (motion === 0 || motion === 10 || motion >= 382) {
          if (axisWords) {
            tx = has[LX] ? (absMode ? val[LX] * k + ox : px + val[LX] * k) : px;
            ty = has[LY] ? (absMode ? val[LY] * k + oy : py + val[LY] * k) : py;
            tz = has[LZ] ? (absMode ? val[LZ] * k + oz : pz + val[LZ] * k) : pz;
            var probe = motion >= 382;
            if (probe) warn('probe', li, 'Probing moves (G38) are drawn to their programmed end point and are never sped up.');
            addMove(motion === 0 ? KIND_RAPID : KIND_LINE, probe ? FLAG_PROBE : 0, li, px, py, pz, tx, ty, tz, -1, blockF);
            px = tx; py = ty; pz = tz;
            use = motion === 0 ? USE_NONE : USE_FEED;
          }
        } else if (motion === 20 || motion === 30) {
          if (axisWords || has[LI] || has[LJ] || has[LK] || has[LR]) {
            tx = has[LX] ? (absMode ? val[LX] * k + ox : px + val[LX] * k) : px;
            ty = has[LY] ? (absMode ? val[LY] * k + oy : py + val[LY] * k) : py;
            tz = has[LZ] ? (absMode ? val[LZ] * k + oz : pz + val[LZ] * k) : pz;
            var ai = arcCenter(motion === 20, li, px, py, pz, tx, ty, tz, k);
            addMove(ai >= 0 ? (motion === 20 ? KIND_CW : KIND_CCW) : KIND_LINE, 0, li, px, py, pz, tx, ty, tz, ai, blockF);
            px = tx; py = ty; pz = tz;
            use = USE_FEED;
          }
        }
      }
      lineUse[li] = use;
      if (endAfter) ended = true;
    }
    lineMove[lc] = mv.n;

    // Arc geometry in the active plane. Returns the arc index, or -1 when the
    // start is unknown and the move has to be drawn as a straight line.
    function arcCenter(cw, line, sx, sy, sz, ex, ey, ez, k) {
      var s = [sx, sy, sz], e = [ex, ey, ez], off = [ox, oy, oz];
      var A, B, oA, oB;
      if (plane === 18) { A = 2; B = 0; oA = LK; oB = LI; }
      else if (plane === 19) { A = 1; B = 2; oA = LJ; oB = LK; }
      else { A = 0; B = 1; oA = LI; oB = LJ; }
      var sa = s[A], sb = s[B], ea = e[A], eb = e[B];
      if (sa !== sa || sb !== sb || ea !== ea || eb !== eb) {
        warn('arcstart', line, 'An arc starts from an unknown position and is drawn as a straight line.');
        return -1;
      }
      var ca, cb;
      if (has[LR] && !has[oA] && !has[oB]) {
        var r = val[LR] * k, dx = ea - sa, dy = eb - sb, d = Math.sqrt(dx * dx + dy * dy);
        if (d < TOL) {
          warn('arcR0', line, 'An R-format arc has the same start and end point and is drawn as a point.');
          return -1;
        }
        var h2 = r * r - d * d / 4;
        if (h2 < 0) {
          if (h2 < -1e-4 * r * r) warn('arcR', line, 'An R-format arc radius is smaller than half the chord; its center was placed on the chord.');
          h2 = 0;
        }
        var h = Math.sqrt(h2), nx = -dy / d, ny = dx / d;
        var side = ((!cw) === (r > 0)) ? 1 : -1;
        ca = (sa + ea) / 2 + side * h * nx;
        cb = (sb + eb) / 2 + side * h * ny;
      } else {
        var ia = has[oA] ? val[oA] * k : 0, ib = has[oB] ? val[oB] * k : 0;
        if (arcAbs) { ca = ia + off[A]; cb = ib + off[B]; }
        else { ca = sa + ia; cb = sb + ib; }
      }
      var r0 = Math.sqrt((sa - ca) * (sa - ca) + (sb - cb) * (sb - cb));
      var r1 = Math.sqrt((ea - ca) * (ea - ca) + (eb - cb) * (eb - cb));
      var t0 = Math.atan2(sb - cb, sa - ca), t1 = Math.atan2(eb - cb, ea - ca);
      var sw = t1 - t0;
      var same = Math.abs(ea - sa) <= TOL && Math.abs(eb - sb) <= TOL;
      if (same) sw = cw ? -TAU : TAU;
      else if (cw) { if (sw >= 0) sw -= TAU; }
      else if (sw <= 0) sw += TAU;
      if (has[LP] && val[LP] > 1) sw += (cw ? -TAU : TAU) * (Math.round(val[LP]) - 1);
      if (Math.abs(r0 - r1) > Math.max(0.002 * (dispInch ? 1 / 25.4 : 1), 0.001 * r0)) {
        warn('arcRadius', line, 'Some arcs have a start and end radius that differ; they are drawn as spirals.');
      }
      arcs.reserve(1);
      var ai = arcs.n++;
      arcs.ca[ai] = ca; arcs.cb[ai] = cb; arcs.r0[ai] = r0; arcs.r1[ai] = r1;
      arcs.t0[ai] = t0; arcs.sweep[ai] = sw; arcs.plane[ai] = plane;
      return ai;
    }

    mv.trim();
    arcs.trim();

    // Unknown start positions (program start, after homing or G53) are filled
    // from the next known position so the plot starts where the path starts.
    fillAxis(mv.x0, mv.x1, mv.n, mv.flags);
    fillAxis(mv.y0, mv.y1, mv.n, mv.flags);
    fillAxis(mv.z0, mv.z1, mv.n, mv.flags);

    var P = {
      bytes: bytes,
      lineCount: lc, lineStart: lineStart, lineEnd: lineEnd,
      lineF: lineF, lineFNum: lineFNum, lineFEnd: lineFEnd, lineFVal: lineFVal,
      lineCodeEnd: lineCodeEnd, lineUse: lineUse, lineFMode: lineFMode, lineInch: lineInch,
      lineSpace: lineSpace, lineMove: lineMove,
      moves: mv, arcs: arcs,
      inch: !!dispInch,
      warnings: warnings, tools: tools, spindleMax: spindleMax,
      fStyle: dominantStyle(fStyles), fCount: fCount
    };
    measure(P);
    return P;
  }

  // Moves with a filled-in coordinate are flagged: they are drawn, but never
  // sped up and never trusted as a place the tool has been.
  function fillAxis(s, e, n, flags) {
    var i, next = NaN, prev = NaN;
    for (i = 0; i < n; i++) if (e[i] !== e[i] || s[i] !== s[i]) flags[i] |= FLAG_GUESS;
    for (i = n - 1; i >= 0; i--) { if (e[i] === e[i]) next = e[i]; else e[i] = next; }
    for (i = 0; i < n; i++) { if (e[i] === e[i]) prev = e[i]; else e[i] = prev; }
    for (i = 0; i < n; i++) {
      if (e[i] !== e[i]) e[i] = 0;
      if (s[i] !== s[i]) s[i] = e[i];
    }
  }

  function dominantStyle(counts) {
    var best = null, bestN = -1;
    for (var key in counts) if (counts[key] > bestN) { bestN = counts[key]; best = key; }
    if (!best) return { dec: 0, dot: false, noLead: false };
    return { dec: parseInt(best, 10), dot: best.indexOf('d') >= 0, noLead: best.indexOf('n') >= 0 };
  }

  // ---------------------------------------------------------------------------
  // Geometry

  // Maps plane coordinates (a, b, normal) back to x, y, z.
  function planeToXYZ(plane, a, b, nrm, out) {
    if (plane === 18) { out[0] = b; out[1] = nrm; out[2] = a; }
    else if (plane === 19) { out[0] = nrm; out[1] = a; out[2] = b; }
    else { out[0] = a; out[1] = b; out[2] = nrm; }
    return out;
  }

  function arcNormal(plane) { return plane === 18 ? 1 : plane === 19 ? 0 : 2; }

  // Point at parameter t (0..1) along move m, written into out.
  function pointAt(P, m, t, out) {
    out = out || [0, 0, 0];
    var mv = P.moves, ai = mv.arc[m];
    if (ai < 0 || t <= 0 || t >= 1) {
      if (t >= 1) { out[0] = mv.x1[m]; out[1] = mv.y1[m]; out[2] = mv.z1[m]; }
      else if (t <= 0) { out[0] = mv.x0[m]; out[1] = mv.y0[m]; out[2] = mv.z0[m]; }
      else {
        out[0] = mv.x0[m] + (mv.x1[m] - mv.x0[m]) * t;
        out[1] = mv.y0[m] + (mv.y1[m] - mv.y0[m]) * t;
        out[2] = mv.z0[m] + (mv.z1[m] - mv.z0[m]) * t;
      }
      return out;
    }
    var A = P.arcs, pl = A.plane[ai], th = A.t0[ai] + A.sweep[ai] * t;
    var r = A.r0[ai] + (A.r1[ai] - A.r0[ai]) * t;
    var nIdx = arcNormal(pl);
    var s = nIdx === 0 ? mv.x0[m] : nIdx === 1 ? mv.y0[m] : mv.z0[m];
    var e = nIdx === 0 ? mv.x1[m] : nIdx === 1 ? mv.y1[m] : mv.z1[m];
    return planeToXYZ(pl, A.ca[ai] + r * Math.cos(th), A.cb[ai] + r * Math.sin(th), s + (e - s) * t, out);
  }

  function arcSegments(P, m) {
    var ai = P.moves.arc[m], A = P.arcs;
    var rMax = Math.max(A.r0[ai], A.r1[ai]);
    var tol = P.inch ? 0.0004 : 0.01;
    var step = rMax > tol ? 2 * Math.acos(1 - tol / rMax) : Math.PI / 2;
    step = Math.min(step, Math.PI / 12);
    return Math.max(1, Math.min(1440, Math.ceil(Math.abs(A.sweep[ai]) / step)));
  }

  // Lengths, Z range and bounding box of every move.
  function measure(P) {
    var mv = P.moves, n = mv.n, A = P.arcs;
    var bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    var pt = [0, 0, 0];
    function grow(x, y, z) {
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
      if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
    }
    for (var i = 0; i < n; i++) {
      var dx = mv.x1[i] - mv.x0[i], dy = mv.y1[i] - mv.y0[i], dz = mv.z1[i] - mv.z0[i];
      var zmin = Math.min(mv.z0[i], mv.z1[i]), zmax = Math.max(mv.z0[i], mv.z1[i]);
      var ai = mv.arc[i], len;
      if (ai < 0) {
        len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      } else {
        var pl = A.plane[ai], nIdx = arcNormal(pl);
        var dn = nIdx === 0 ? dx : nIdx === 1 ? dy : dz;
        var arcLen = Math.abs(A.sweep[ai]) * (A.r0[ai] + A.r1[ai]) / 2;
        len = Math.sqrt(arcLen * arcLen + dn * dn);
        // Quadrant points inside the sweep bound the arc exactly.
        var ta = A.t0[ai], tb = ta + A.sweep[ai];
        var lo = Math.min(ta, tb), hi = Math.max(ta, tb);
        for (var qk = Math.ceil(lo / (Math.PI / 2)); qk * (Math.PI / 2) <= hi; qk++) {
          var t = (qk * (Math.PI / 2) - ta) / A.sweep[ai];
          if (t <= 0 || t >= 1) continue;
          pointAt(P, i, t, pt);
          if (pt[2] < zmin) zmin = pt[2];
          if (pt[2] > zmax) zmax = pt[2];
          if (!(mv.flags[i] & FLAG_SKIP)) grow(pt[0], pt[1], pt[2]);
        }
      }
      mv.len[i] = len; mv.zmin[i] = zmin; mv.zmax[i] = zmax;
      if (len < 1e-9 && mv.extra[i] === 0) mv.flags[i] |= FLAG_SKIP;
      if (!(mv.flags[i] & FLAG_SKIP)) {
        grow(mv.x0[i], mv.y0[i], mv.z0[i]);
        grow(mv.x1[i], mv.y1[i], mv.z1[i]);
      }
    }
    if (bb[0] === Infinity) bb = [0, 0, 0, 0, 0, 0];
    P.bbox = { minX: bb[0], minY: bb[1], minZ: bb[2], maxX: bb[3], maxY: bb[4], maxZ: bb[5] };
  }

  // Line segments for drawing: positions relative to the bbox centre (Float32),
  // the owning move of each segment, and distance along the move (for dashes).
  function buildSegments(P) {
    var mv = P.moves, n = mv.n, i, total = 0;
    var counts = new Int32Array(n);
    for (i = 0; i < n; i++) {
      if (mv.flags[i] & FLAG_SKIP) continue;
      counts[i] = mv.arc[i] >= 0 ? arcSegments(P, i) : 1;
      total += counts[i];
    }
    var b = P.bbox;
    var ox = (b.minX + b.maxX) / 2, oy = (b.minY + b.maxY) / 2, oz = (b.minZ + b.maxZ) / 2;
    var pos = new Float32Array(total * 6), move = new Int32Array(total), dist = new Float32Array(total * 2);
    var w = 0, a = [0, 0, 0], c = [0, 0, 0];
    for (i = 0; i < n; i++) {
      var cnt = counts[i];
      if (!cnt) continue;
      a[0] = mv.x0[i]; a[1] = mv.y0[i]; a[2] = mv.z0[i];
      var d = 0;
      for (var s = 1; s <= cnt; s++) {
        pointAt(P, i, s === cnt ? 1 : s / cnt, c);
        var j = w * 6;
        pos[j] = a[0] - ox; pos[j + 1] = a[1] - oy; pos[j + 2] = a[2] - oz;
        pos[j + 3] = c[0] - ox; pos[j + 4] = c[1] - oy; pos[j + 5] = c[2] - oz;
        var sl = Math.sqrt((c[0] - a[0]) * (c[0] - a[0]) + (c[1] - a[1]) * (c[1] - a[1]) + (c[2] - a[2]) * (c[2] - a[2]));
        dist[w * 2] = d; dist[w * 2 + 1] = d + sl; d += sl;
        move[w] = i;
        w++;
        a[0] = c[0]; a[1] = c[1]; a[2] = c[2];
      }
    }
    return { count: total, pos: pos, move: move, dist: dist, origin: [ox, oy, oz] };
  }

  // Polyline of one move in world coordinates, up to parameter tEnd.
  function movePolyline(P, m, tEnd) {
    if (tEnd === undefined) tEnd = 1;
    var cnt = P.moves.arc[m] >= 0 ? arcSegments(P, m) : 1;
    var pts = [], pt;
    for (var s = 0; s <= cnt; s++) {
      var t = s / cnt;
      if (t > tEnd) { pts.push(pointAt(P, m, tEnd, [0, 0, 0])); break; }
      pt = pointAt(P, m, s === cnt ? 1 : t, [0, 0, 0]);
      pts.push(pt);
    }
    return pts;
  }

  // ---------------------------------------------------------------------------
  // Classification

  function isVertical(mv, i) {
    var dx = mv.x1[i] - mv.x0[i], dy = mv.y1[i] - mv.y0[i], dz = mv.z1[i] - mv.z0[i];
    return mv.arc[i] < 0 && Math.abs(dz) > TOL && Math.sqrt(dx * dx + dy * dy) <= Math.max(TOL, 0.01 * Math.abs(dz));
  }

  // Colour and feed class of every move for a given safe height.
  // Air moves are completely at or above the safe height, or drop straight back
  // down a column the same tool has already been to at that exact XY (peck
  // re-entries, going back into a pocket). Nothing can be in the way of those.
  function classify(P, safeZ, out) {
    var mv = P.moves, n = mv.n, cls = out && out.length === n ? out : new Uint8Array(n);
    var zs = safeZ === null || safeZ === undefined || safeZ !== safeZ ? Infinity : safeZ;
    var q = P.inch ? 1e5 : 1e4;
    var deepest = new Map(), epoch = -1;
    for (var i = 0; i < n; i++) {
      var kind = mv.kind[i], f = mv.flags[i];
      if (mv.epoch[i] !== epoch) { deepest.clear(); epoch = mv.epoch[i]; }
      var key = (Math.round(mv.x1[i] * q) + 33554432) * 67108864 + (Math.round(mv.y1[i] * q) + 33554432);
      var c;
      if (kind === KIND_RAPID) c = CLS_RAPID;
      else if (f & FLAG_CYCLE) c = CLS_PLUNGE;
      else if (mv.zmin[i] >= zs - TOL) c = CLS_AIR;
      else if (isVertical(mv, i)) {
        var dz = mv.z1[i] - mv.z0[i];
        if (dz > 0) c = mv.z1[i] >= zs - TOL ? CLS_RETRACT : CLS_CUT;
        else {
          var been = deepest.get(key);
          c = been !== undefined && mv.z1[i] >= been - TOL && mv.x1[i] === mv.x0[i] && mv.y1[i] === mv.y0[i] ? CLS_AIR : CLS_PLUNGE;
        }
      } else c = CLS_CUT;
      cls[i] = c;
      if (!(f & FLAG_GUESS)) {
        var d = deepest.get(key);
        if (d === undefined || mv.z1[i] < d) deepest.set(key, mv.z1[i]);
      }
    }
    return cls;
  }

  // Finds the lowest height that is safely above every cutting move.
  // Air heights are only trusted top-down. The clearance height the program
  // retracts to seeds the set (G0 levels do not: lasers and plasmas rapid at
  // their cutting height). Every approach that descends in stages from a known
  // air height then adds its stops (retract and feed heights). A horizontal run
  // only counts as a traverse when it follows a retract at a known air height,
  // so tab crossings never qualify. Everything else is cutting evidence, with
  // plunges counted at their bottom, and the answer is the lowest air height
  // above all of it.
  function detectSafeZ(P) {
    var mv = P.moves, n = mv.n, i, s, m;
    var sig = [];
    for (i = 0; i < n; i++) if (!(mv.flags[i] & (FLAG_SKIP | FLAG_CYCLE | FLAG_HOME | FLAG_GUESS))) sig.push(i);
    function vert(j) {
      var dx = mv.x1[j] - mv.x0[j], dy = mv.y1[j] - mv.y0[j];
      return mv.arc[j] < 0 && Math.abs(mv.z1[j] - mv.z0[j]) > TOL && Math.sqrt(dx * dx + dy * dy) <= TOL;
    }
    function down(j) { return vert(j) && mv.z1[j] < mv.z0[j]; }
    function up(j) { return vert(j) && mv.z1[j] > mv.z0[j]; }
    function horiz(j) { return mv.arc[j] < 0 && Math.abs(mv.z1[j] - mv.z0[j]) <= TOL; }
    function joined(a, b) {
      return Math.abs(mv.x1[a] - mv.x0[b]) <= TOL && Math.abs(mv.y1[a] - mv.y0[b]) <= TOL && Math.abs(mv.z1[a] - mv.z0[b]) <= TOL;
    }
    var air = new Map();
    function key(z) { return Math.round(z * 1e5); }
    function add(z) { var k = key(z); if (air.has(k)) return false; air.set(k, z); return true; }
    function isAir(z) { return air.has(key(z)); }

    var maxZ = -Infinity;
    for (s = 0; s < sig.length; s++) {
      m = sig[s];
      if (mv.z0[m] > maxZ) maxZ = mv.z0[m];
      if (mv.z1[m] > maxZ) maxZ = mv.z1[m];
    }
    for (s = 0; s < sig.length; s++) {
      m = sig[s];
      if (up(m) && Math.abs(mv.z1[m] - maxZ) <= TOL) { add(maxZ); break; }
    }

    var inRun = new Uint8Array(n), approach = new Uint8Array(n);
    // Follows a staged descent starting at sig[c]; its stops are air heights.
    function chain(c) {
      var grew = false, first = c;
      while (c < sig.length && down(sig[c]) && (c === first || joined(sig[c - 1], sig[c]))) {
        if (add(mv.z0[sig[c]])) grew = true;
        if (c + 1 < sig.length && down(sig[c + 1]) && joined(sig[c], sig[c + 1])) approach[sig[c]] = 1;
        c++;
      }
      return grew;
    }
    for (var pass = 0; pass < 32; pass++) {
      var grew = false;
      for (s = 0; s < sig.length; s++) {
        m = sig[s];
        var prev = s > 0 ? sig[s - 1] : -1;
        var fresh = prev < 0 || !joined(prev, m);
        if (horiz(m) && isAir(mv.z0[m]) && (fresh || up(prev) || mv.kind[m] === KIND_RAPID)) {
          var e = s;
          while (e + 1 < sig.length && horiz(sig[e + 1]) && joined(sig[e], sig[e + 1])) e++;
          for (var q = s; q <= e; q++) inRun[sig[q]] = 1;
          if (chain(e + 1)) grew = true;
          s = e;
        } else if (fresh && down(m) && isAir(mv.z0[m])) {
          if (chain(s)) grew = true;
        }
      }
      if (!grew) break;
    }

    var maxCut = -Infinity;
    for (s = 0; s < sig.length; s++) {
      m = sig[s];
      if (mv.kind[m] === KIND_RAPID || inRun[m] || approach[m] || up(m)) continue;
      var zc = down(m) ? mv.z1[m] : mv.zmax[m];
      if (zc > maxCut) maxCut = zc;
    }
    var best = Infinity, levels = [];
    air.forEach(function (z) {
      levels.push(z);
      if (z > maxCut + TOL && z < best) best = z;
    });
    levels.sort(function (a, b) { return b - a; });
    return {
      z: best === Infinity ? null : best,
      maxCutZ: maxCut === -Infinity ? null : maxCut,
      levels: levels
    };
  }

  // ---------------------------------------------------------------------------
  // Feed planning and output

  function feedKey(v, mode, inch) { return mode + ':' + (inch ? 'in' : 'mm') + ':' + v; }

  function isSpedUp(P, cls, m, includeRetracts) {
    var c = cls[m];
    if (P.moves.flags[m] & (FLAG_PROBE | FLAG_CYCLE | FLAG_GUESS)) return false;
    return c === CLS_AIR || (includeRetracts && c === CLS_RETRACT);
  }

  // Works out which F words to change or add so that every move runs at its
  // wanted feed, while touching nothing else in the file.
  //   opts.airFeed          new feed for air moves, display units/min (0/NaN = unchanged)
  //   opts.includeRetracts  also speed up straight-up retracts out of the cut
  //   opts.feedMap          { feedKey: newValue } per programmed feed value
  function planEdits(P, cls, opts) {
    opts = opts || {};
    var mv = P.moves, lc = P.lineCount, map = opts.feedMap || {};
    var air = opts.airFeed > 0 ? opts.airFeed : 0;
    var edits = [], moveFeed = new Float64Array(mv.n);
    var outModal = NaN, origModal = NaN;
    var bytes = P.bytes;

    function mapped(v, mode, inch) {
      if (v !== v) return v;
      var t = map[feedKey(v, mode, inch)];
      return t > 0 ? t : v;
    }
    function wantedValue(v, style) {
      var txt = formatNum(v, style);
      return { text: txt, val: asciiNum(txt) };
    }

    for (var li = 0; li < lc; li++) {
      var m0 = P.lineMove[li], m1 = P.lineMove[li + 1], m;
      var mode = P.lineFMode[li], inch = P.lineInch[li];
      var hasF = P.lineF[li] >= 0, fv = P.lineFVal[li];
      if (mode === 93) {
        for (m = m0; m < m1; m++) moveFeed[m] = mv.feed[m];
        outModal = NaN; origModal = NaN;
        continue;
      }
      if (hasF) origModal = fv;
      var use = P.lineUse[li], want = NaN;
      if (use !== USE_NONE) {
        var fm = m0;
        while (fm < m1 && mv.kind[fm] === KIND_RAPID) fm++;
        if (use === USE_FEED && air && mode === 94 && fm < m1 && isSpedUp(P, cls, fm, opts.includeRetracts)) {
          var k = inch === (P.inch ? 1 : 0) ? 1 : (inch ? 1 / 25.4 : 25.4);
          want = Math.round(air * k * 1e4) / 1e4;
        } else {
          want = mapped(origModal, mode, inch);
        }
      }
      if (hasF) {
        var target = use !== USE_NONE ? want : mapped(fv, mode, inch);
        if (target === target && !sameNum(target, fv)) {
          var w1 = wantedValue(target, numStyle(bytes, P.lineFNum[li], P.lineFEnd[li]));
          edits.push({ line: li, pos: P.lineFNum[li], end: P.lineFEnd[li], text: w1.text, from: fv, to: w1.val, insert: false });
          outModal = w1.val;
        } else {
          outModal = fv;
        }
      } else if (use !== USE_NONE && want === want && !sameNum(want, outModal)) {
        var w2 = wantedValue(want, P.fStyle);
        edits.push({ line: li, pos: P.lineCodeEnd[li], end: P.lineCodeEnd[li], text: (P.lineSpace[li] ? ' F' : 'F') + w2.text, from: outModal, to: w2.val, insert: true });
        outModal = w2.val;
      }
      for (m = m0; m < m1; m++) moveFeed[m] = outModal;
    }
    return { edits: edits, moveFeed: moveFeed };
  }

  function buildOutput(bytes, edits) {
    var extra = 0, i, e;
    for (i = 0; i < edits.length; i++) extra += edits[i].text.length - (edits[i].end - edits[i].pos);
    var out = new Uint8Array(bytes.length + extra);
    var r = 0, w = 0;
    for (i = 0; i < edits.length; i++) {
      e = edits[i];
      out.set(bytes.subarray(r, e.pos), w); w += e.pos - r;
      for (var j = 0; j < e.text.length; j++) out[w++] = e.text.charCodeAt(j);
      r = e.end;
    }
    out.set(bytes.subarray(r), w);
    return out;
  }

  var GEOM_KEYS = ['kind', 'flags', 'line', 'x0', 'y0', 'z0', 'x1', 'y1', 'z1', 'arc', 'fmode', 'inch'];
  var ARC_KEYS = ['ca', 'cb', 'r0', 'r1', 't0', 'sweep', 'plane'];

  // Re-parses the edited program and proves the toolpath is identical and every
  // move runs at the planned feed.
  function verify(P, out, plan) {
    var Q = parse(out, { inch: P.inch });
    var res = { ok: true, moves: P.moves.n, lines: P.lineCount, geometry: 0, feeds: 0, bytes: 0, changedLines: 0, first: null };
    function fail(kind, m) {
      res.ok = false;
      res[kind]++;
      if (!res.first) res.first = { kind: kind, move: m, line: m >= 0 ? P.moves.line[m] : -1 };
    }
    if (Q.lineCount !== P.lineCount || Q.moves.n !== P.moves.n || Q.arcs.n !== P.arcs.n) {
      fail('geometry', -1);
      return res;
    }
    var a = P.moves, b = Q.moves, i, k;
    for (i = 0; i < a.n; i++) {
      for (k = 0; k < GEOM_KEYS.length; k++) {
        var key = GEOM_KEYS[k];
        if (!Object.is(a[key][i], b[key][i])) { fail('geometry', i); break; }
      }
      var fa = plan.moveFeed[i], fb = b.feed[i];
      if (!(a.kind[i] === KIND_RAPID && !(a.flags[i] & FLAG_CYCLE)) && !sameNum(fa, fb)) fail('feeds', i);
    }
    for (i = 0; i < P.arcs.n; i++) {
      for (k = 0; k < ARC_KEYS.length; k++) {
        if (!Object.is(P.arcs[ARC_KEYS[k]][i], Q.arcs[ARC_KEYS[k]][i])) { fail('geometry', -1); break; }
      }
    }
    // Every byte outside the edited F words must be untouched.
    var src = P.bytes, r = 0, w = 0, e, j, lastLine = -1;
    for (i = 0; i <= plan.edits.length; i++) {
      e = plan.edits[i];
      var stop = e ? e.pos : src.length;
      for (j = r; j < stop; j++) if (src[j] !== out[w + j - r]) { fail('bytes', -1); break; }
      w += stop - r;
      if (!e) break;
      w += e.text.length;
      r = e.end;
      if (e.line !== lastLine) { res.changedLines++; lastLine = e.line; }
    }
    if (w !== out.length) fail('bytes', -1);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Time and summaries

  // Minutes per move. feedArr overrides programmed feeds (for the edited file).
  function moveTimes(P, feedArr, maxRate) {
    var mv = P.moves, n = mv.n, t = new Float64Array(n);
    var rate = maxRate > 0 ? maxRate : Infinity;
    for (var i = 0; i < n; i++) {
      var len = mv.len[i], ex = mv.extra[i];
      if (len === 0 && ex === 0) continue;
      if (mv.kind[i] === KIND_RAPID) { t[i] = (len + ex) / rate; continue; }
      var raw = feedArr ? feedArr[i] : mv.feed[i], mode = mv.fmode[i];
      if (mode === 93) { t[i] = raw > 0 ? 1 / raw : len / rate; continue; }
      var k = (mv.inch[i] === 1) === P.inch ? 1 : (mv.inch[i] ? 25.4 : 1 / 25.4);
      var f = mode === 95 ? raw * mv.spin[i] * k : raw * k;
      var eff = f > 0 ? Math.min(f, rate) : rate;
      t[i] = len / eff + ex / rate;
    }
    return t;
  }

  function summarize(P, cls, tA, tB) {
    var mv = P.moves, out = [];
    for (var c = 0; c < 5; c++) out.push({ count: 0, len: 0, tA: 0, tB: 0 });
    var totalA = 0, totalB = 0;
    for (var i = 0; i < mv.n; i++) {
      var o = out[cls[i]];
      if (!(mv.flags[i] & FLAG_SKIP)) { o.count++; o.len += mv.len[i]; }
      o.tA += tA[i]; o.tB += tB[i];
      totalA += tA[i]; totalB += tB[i];
    }
    return { byClass: out, totalA: totalA, totalB: totalB };
  }

  // One row per programmed feed value, with how the moves at that feed are used.
  function feedTable(P, cls, tA) {
    var mv = P.moves, rows = {}, list = [];
    for (var i = 0; i < mv.n; i++) {
      if (mv.kind[i] === KIND_RAPID) continue;
      var v = mv.feed[i];
      if (v !== v) continue;
      var key = feedKey(v, mv.fmode[i], mv.inch[i]);
      var r = rows[key];
      if (!r) {
        rows[key] = r = { key: key, value: v, mode: mv.fmode[i], inch: !!mv.inch[i], moves: 0, len: 0, time: 0, byClass: [0, 0, 0, 0, 0], firstLine: mv.line[i] };
        list.push(r);
      }
      if (mv.flags[i] & FLAG_SKIP) continue;
      r.moves++; r.len += mv.len[i]; r.time += tA[i]; r.byClass[cls[i]]++;
    }
    list.sort(function (a, b) { return a.mode - b.mode || a.value - b.value; });
    return list;
  }

  return {
    KIND: { RAPID: KIND_RAPID, LINE: KIND_LINE, CW: KIND_CW, CCW: KIND_CCW },
    CLS: { RAPID: CLS_RAPID, AIR: CLS_AIR, RETRACT: CLS_RETRACT, PLUNGE: CLS_PLUNGE, CUT: CLS_CUT },
    FLAG: { CYCLE: FLAG_CYCLE, HOME: FLAG_HOME, SKIP: FLAG_SKIP, PROBE: FLAG_PROBE, GUESS: FLAG_GUESS },
    USE: { NONE: USE_NONE, FEED: USE_FEED, CYCLE: USE_CYCLE },
    parse: parse,
    classify: classify,
    detectSafeZ: detectSafeZ,
    planEdits: planEdits,
    buildOutput: buildOutput,
    verify: verify,
    moveTimes: moveTimes,
    summarize: summarize,
    feedTable: feedTable,
    feedKey: feedKey,
    isSpedUp: isSpedUp,
    buildSegments: buildSegments,
    movePolyline: movePolyline,
    pointAt: pointAt,
    formatNum: formatNum,
    asciiNum: asciiNum
  };
}));
