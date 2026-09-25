/*!
 * FeedFix sample program: a demo plate job written the way CAM output looks
 * when rapids are replaced by G1 moves at each operation's cutting feed.
 * make({ inch: true }) writes the same job in inches (G20) with inch feeds.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FeedFixSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Geometry below is laid out in millimetres. The inch job scales it by 1/25,
  // which gives tidy inch sizes (a 4.8 x 3.2 in plate, 0.6 in clearance).
  var FEEDS = {
    mm: { face: 1500, facePlunge: 500, pocket: 1200, ramp: 400, contour: 1000, contourPlunge: 300, drill: 250 },
    inch: { face: 60, facePlunge: 20, pocket: 48, ramp: 16, contour: 40, contourPlunge: 12, drill: 10 }
  };

  function makeSample(opts) {
    var inch = !!(opts && opts.inch);
    var S = inch ? 1 / 25 : 1, DEC = inch ? 4 : 3, P10 = Math.pow(10, DEC);
    var FD = inch ? FEEDS.inch : FEEDS.mm;
    var out = [];
    var st = { x: NaN, y: NaN, z: NaN, f: NaN };
    function rd(v) { return Math.round(v * P10) / P10; }
    function num(v) {
      var s = rd(v).toFixed(DEC).replace(/0+$/, '').replace(/\.$/, '');
      return s === '-0' ? '0' : s;
    }
    function emit(s) { out.push(s); }
    // Adds an axis word when the (scaled) value differs from the modal one.
    function axis(letter, key, v) {
      if (v === undefined) return '';
      var w = rd(v * S);
      if (w === st[key]) return '';
      st[key] = w;
      return ' ' + letter + num(w);
    }
    function feed(f) {
      if (f === undefined || rd(f) === st.f) return '';
      st.f = rd(f);
      return ' F' + num(f);
    }
    function g1(x, y, z, f) {
      var s = 'G1' + axis('X', 'x', x) + axis('Y', 'y', y) + axis('Z', 'z', z) + feed(f);
      if (s !== 'G1') emit(s);
    }
    // i, j: arc centre relative to the start point
    function arc(g, x, y, z, i, j, f) {
      emit(g + axis('X', 'x', x) + axis('Y', 'y', y) + axis('Z', 'z', z) + ' I' + num(i * S) + ' J' + num(j * S) + feed(f));
    }

    var CLEAR = 15, RETRACT = 5, FEEDH = 2;
    var cx = 60, cy = 40;

    emit('%');
    emit('(DEMO FILE - NOT FOR MACHINING)');
    emit(inch ? '(MOTOR PLATE 4.8 X 3.2 X 0.48 IN - Z0 AT STOCK TOP)' : '(MOTOR PLATE 120 X 80 X 12 MM - Z0 AT STOCK TOP)');
    emit('(RAPIDS IN THIS FILE WERE WRITTEN AS G1 AT EACH CUTTING FEED)');
    emit(inch ? '(T1 D=0.24 CR=0 - ZMIN=-0.5 - FLAT END MILL)' : '(T1 D=6 CR=0 - ZMIN=-12.5 - FLAT END MILL)');
    emit('G90 G94');
    emit('G17');
    emit(inch ? 'G20' : 'G21');

    // Facing: zigzag at Z-0.5, entering from outside the stock
    emit('');
    emit('(FACE1)');
    emit('T1');
    emit('S16000 M3');
    emit('G54');
    var FF = FD.face, FP = FD.facePlunge;
    g1(-8, -1, undefined, FF);
    g1(undefined, undefined, CLEAR);
    g1(undefined, undefined, RETRACT);
    g1(undefined, undefined, FEEDH);
    g1(undefined, undefined, -0.5, FP);
    for (var pass = 0, y = -1; y <= 81; pass++, y += 4.8) {
      if (pass > 0) g1(undefined, y, undefined, FF);
      g1(pass % 2 === 0 ? 128 : -8, undefined, undefined, FF);
    }
    g1(undefined, undefined, CLEAR);

    // Pocket: helical entry, offset loops from the inside out, three depths
    emit('');
    emit('(POCKET1)');
    var PF = FD.pocket, PR = FD.ramp, hr = 1.5;
    var depths = [-2, -4, -6];
    g1(cx + hr, cy, undefined, PF);
    g1(undefined, undefined, RETRACT);
    for (var d = 0; d < depths.length; d++) {
      var zStart = d === 0 ? 1 : depths[d - 1] + 1;
      g1(undefined, undefined, zStart);
      var z = zStart;
      while (z - 1 > depths[d] + 1e-9) { z -= 1; arc('G3', undefined, undefined, z, -hr, 0, PR); }
      arc('G3', undefined, undefined, depths[d], -hr, 0, PR);
      arc('G3', undefined, undefined, undefined, -hr, 0);
      g1(cx - 13, cy, undefined, PF);
      g1(cx + 13, cy);
      for (var k = 4; k >= 0; k--) {
        var hw = 25 - 2.4 * k, hh = 12 - 2.4 * k, r = Math.max(0, 3 - 2.4 * k);
        pocketLoop(hw, hh, r);
      }
      g1(undefined, undefined, RETRACT);
      if (d < depths.length - 1) g1(cx + hr, cy);
    }
    g1(undefined, undefined, CLEAR);

    function pocketLoop(hw, hh, r) {
      var x1 = cx + hw, x0 = cx - hw, y1 = cy + hh, y0 = cy - hh;
      g1(x1, cy);
      g1(x1, y1 - r);
      if (r > 0) arc('G3', x1 - r, y1, undefined, -r, 0);
      g1(x0 + r, y1);
      if (r > 0) arc('G3', x0, y1 - r, undefined, 0, -r);
      g1(x0, y0 + r);
      if (r > 0) arc('G3', x0 + r, y0, undefined, r, 0);
      g1(x1 - r, y0);
      if (r > 0) arc('G3', x1, y0 + r, undefined, 0, r);
      g1(x1, cy);
    }

    // Outside contour: arc lead-in and lead-out, three depths, tabs on the last pass
    emit('');
    emit('(CONTOUR1)');
    var CF = FD.contour, CP = FD.contourPlunge;
    var chw = 58, chh = 38, cr = 9, lx = cx + chw + 3;
    var cdepths = [-4, -8, -12.5];
    g1(lx, cy + 3, undefined, CF);
    g1(undefined, undefined, RETRACT);
    for (var cd = 0; cd < cdepths.length; cd++) {
      var zc = cdepths[cd], tabs = cd === cdepths.length - 1;
      g1(undefined, undefined, FEEDH);
      g1(undefined, undefined, zc, CP);
      arc('G3', cx + chw, cy, undefined, 0, -3, CF);
      contourLoop(chw, chh, cr, zc, tabs);
      arc('G3', lx, cy - 3, undefined, 3, 0);
      g1(undefined, undefined, RETRACT);
      if (cd < cdepths.length - 1) g1(lx, cy + 3);
    }
    g1(undefined, undefined, CLEAR);

    function contourLoop(hw, hh, r, zc, tabs) {
      var x1 = cx + hw, x0 = cx - hw, y1 = cy + hh, y0 = cy - hh, zt = zc + 2;
      g1(x1, y0 + r);
      arc('G2', x1 - r, y0, undefined, -r, 0);
      if (tabs) { g1(cx + 14, y0); g1(undefined, undefined, zt); g1(cx + 4, y0); g1(undefined, undefined, zc); }
      g1(x0 + r, y0);
      arc('G2', x0, y0 + r, undefined, 0, r);
      g1(x0, y1 - r);
      arc('G2', x0 + r, y1, undefined, r, 0);
      if (tabs) { g1(cx - 14, y1); g1(undefined, undefined, zt); g1(cx - 4, y1); g1(undefined, undefined, zc); }
      g1(x1 - r, y1);
      arc('G2', x1, y1 - r, undefined, 0, -r);
      g1(x1, cy);
    }

    // Peck drilling written out as G1 moves (no canned cycle)
    emit('');
    emit('(DRILL1)');
    var DF = FD.drill, Q = 4, bottom = -12.5;
    var holes = [[15, 15], [105, 15], [105, 65], [15, 65]];
    for (var h = 0; h < holes.length; h++) {
      g1(holes[h][0], holes[h][1], undefined, DF);
      if (h === 0) g1(undefined, undefined, RETRACT);
      var cur = 0, first = true;
      while (cur > bottom + 1e-9) {
        var next = Math.max(cur - Q, bottom);
        if (!first) g1(undefined, undefined, cur + 0.5);
        g1(undefined, undefined, next);
        g1(undefined, undefined, RETRACT);
        cur = next; first = false;
      }
    }
    g1(undefined, undefined, CLEAR);

    emit('');
    emit('M5');
    emit('G28 G91 Z0');
    emit('G90');
    emit('M30');
    emit('%');
    return out.join('\n') + '\n';
  }

  return { name: 'demo-plate.nc', make: makeSample };
}));
