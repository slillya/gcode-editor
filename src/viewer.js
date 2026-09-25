/*!
 * FeedFix backplot: WebGL line renderer with orbit, pan, zoom and picking.
 * Z is up. Orthographic camera, so the top view reads true dimensions.
 */
(function (root) {
  'use strict';

  var PATH_VS = [
    'attribute vec3 aPos;',
    'attribute float aIdx;',
    'attribute float aCls;',
    'attribute float aDist;',
    'uniform mat4 uMVP;',
    'uniform float uCut;',
    'uniform float uDone;',
    'uniform vec3 uCol0; uniform vec3 uCol1; uniform vec3 uCol2; uniform vec3 uCol3; uniform vec3 uCol4;',
    'uniform vec4 uVis0; uniform float uVis4;',
    'varying vec3 vCol;',
    'varying float vDist;',
    'varying float vDash;',
    'void main() {',
    '  float c = floor(aCls + 0.5);',
    '  vec3 col = uCol4; float vis = uVis4;',
    '  if (c < 0.5) { col = uCol0; vis = uVis0.x; }',
    '  else if (c < 1.5) { col = uCol1; vis = uVis0.y; }',
    '  else if (c < 2.5) { col = uCol2; vis = uVis0.z; }',
    '  else if (c < 3.5) { col = uCol3; vis = uVis0.w; }',
    '  float done = aIdx < uCut ? 1.0 : 0.0;',
    '  float keep = vis * (uDone > 0.5 ? done : 1.0 - done);',
    '  vCol = col; vDist = aDist; vDash = c < 0.5 ? 1.0 : 0.0;',
    '  gl_Position = keep > 0.5 ? uMVP * vec4(aPos, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);',
    '}'
  ].join('\n');

  var PATH_FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform float uAlpha;',
    'uniform float uDashK;',
    'varying vec3 vCol;',
    'varying float vDist;',
    'varying float vDash;',
    'void main() {',
    '  if (vDash > 0.5 && fract(vDist * uDashK) > 0.55) discard;',
    '  gl_FragColor = vec4(vCol, uAlpha);',
    '}'
  ].join('\n');

  var FLAT_VS = [
    'attribute vec3 aPos;',
    'uniform mat4 uMVP;',
    'uniform float uPt;',
    'void main() { gl_Position = uMVP * vec4(aPos, 1.0); gl_PointSize = uPt; }'
  ].join('\n');

  var FLAT_FS = [
    'precision mediump float;',
    'uniform vec4 uColor;',
    'void main() { gl_FragColor = uColor; }'
  ].join('\n');

  var IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  function shader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function program(gl, vs, fs, attribs, uniforms) {
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var o = { p: p, a: {}, u: {} };
    attribs.forEach(function (n) { o.a[n] = gl.getAttribLocation(p, n); });
    uniforms.forEach(function (n) { o.u[n] = gl.getUniformLocation(p, n); });
    return o;
  }

  function niceStep(span) {
    var raw = span / 8, pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var m = raw / pow;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function Backplot(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.labels = opts.labels || null;
    this.onPick = opts.onPick || null;
    this.ok = false;
    var gl = null;
    try {
      gl = canvas.getContext('webgl', { antialias: true, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false }) ||
        canvas.getContext('experimental-webgl');
    } catch (e) { gl = null; }
    if (!gl) return;
    this.gl = gl;
    try {
      this.pp = program(gl, PATH_VS, PATH_FS, ['aPos', 'aIdx', 'aCls', 'aDist'],
        ['uMVP', 'uCut', 'uDone', 'uCol0', 'uCol1', 'uCol2', 'uCol3', 'uCol4', 'uVis0', 'uVis4', 'uAlpha', 'uDashK']);
      this.fp = program(gl, FLAT_VS, FLAT_FS, ['aPos'], ['uMVP', 'uPt', 'uColor']);
    } catch (e) {
      if (root.console) root.console.error(e);
      return;
    }
    this.ok = true;
    this.bPos = gl.createBuffer(); this.bIdx = gl.createBuffer();
    this.bCls = gl.createBuffer(); this.bDist = gl.createBuffer();
    this.bGrid = gl.createBuffer(); this.bAxes = gl.createBuffer(); this.bTmp = gl.createBuffer();
    this.segCount = 0; this.gridMinor = 0; this.gridMajor = 0;
    this.origin = [0, 0, 0];
    this.box = { minX: -50, minY: -50, minZ: -10, maxX: 50, maxY: 50, maxZ: 10 };
    this.gridExt = [-50, -50, 50, 50];
    this.cam = { yaw: -Math.PI / 4, pitch: Math.atan(1 / Math.SQRT2), zoom: 60, t: [0, 0, 0] };
    this.vis = [1, 1, 1, 1, 1];
    this.cut = Infinity;
    this.tool = null;
    this.trail = null;
    this.safeZ = null;
    this.showSafe = true;
    this.theme = {
      bg: [0.95, 0.96, 0.97], grid: [0.85, 0.87, 0.89], gridMajor: [0.74, 0.78, 0.8],
      paths: [[0.5, 0.54, 0.58], [0.91, 0.35, 0.05], [0.18, 0.62, 0.36], [0.76, 0.09, 0.36], [0.11, 0.39, 0.79]],
      hl: [0.07, 0.07, 0.07], tool: [0.85, 0.28, 0.06], safe: [0.91, 0.35, 0.05],
      ax: [[0.85, 0.2, 0.2], [0.2, 0.65, 0.3], [0.2, 0.4, 0.9]]
    };
    this._pending = false;
    this._events();
    var self = this;
    if (root.ResizeObserver) {
      this._ro = new root.ResizeObserver(function () { self.requestRender(); });
      this._ro.observe(canvas);
    } else {
      root.addEventListener('resize', function () { self.requestRender(); });
    }
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); self.ok = false; });
  }

  Backplot.prototype.setTheme = function (theme) {
    for (var k in theme) this.theme[k] = theme[k];
    this.requestRender();
  };

  // segs: output of GCodeCore.buildSegments. box: program bounding box.
  Backplot.prototype.setProgram = function (segs, box) {
    if (!this.ok) return;
    var gl = this.gl;
    this.segs = segs;
    this.segCount = segs.count;
    this.origin = segs.origin;
    this.box = box;
    var nv = segs.count * 2;
    var idx = new Float32Array(nv);
    for (var s = 0; s < segs.count; s++) { idx[2 * s] = segs.move[s]; idx[2 * s + 1] = segs.move[s]; }
    this.clsArr = new Uint8Array(nv);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferData(gl.ARRAY_BUFFER, segs.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bIdx); gl.bufferData(gl.ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bDist); gl.bufferData(gl.ARRAY_BUFFER, segs.dist, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCls); gl.bufferData(gl.ARRAY_BUFFER, this.clsArr, gl.DYNAMIC_DRAW);
    this._buildGrid();
    this.cut = Infinity;
    this.tool = null; this.trail = null;
    this.requestRender();
  };

  Backplot.prototype.setClasses = function (cls) {
    if (!this.ok || !this.segs) return;
    var mv = this.segs.move, a = this.clsArr;
    for (var s = 0; s < this.segCount; s++) { var c = cls[mv[s]]; a[2 * s] = c; a[2 * s + 1] = c; }
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCls);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW);
    this.requestRender();
  };

  Backplot.prototype.setVisible = function (i, on) { this.vis[i] = on ? 1 : 0; this.requestRender(); };
  Backplot.prototype.setSafeZ = function (z, show) { this.safeZ = z; this.showSafe = show !== false; this.requestRender(); };

  // cut: moves with index < cut are drawn solid, the rest faint.
  // tool: [x,y,z] world position or null. trail: world points of the current move.
  Backplot.prototype.setProgress = function (cut, tool, trail) {
    this.cut = cut; this.tool = tool; this.trail = trail;
    this.requestRender();
  };

  Backplot.prototype._buildGrid = function () {
    var gl = this.gl, b = this.box, o = this.origin;
    var span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
    var step = niceStep(span);
    var x0 = Math.floor(Math.min(b.minX, 0) / step - 1) * step, x1 = Math.ceil(Math.max(b.maxX, 0) / step + 1) * step;
    var y0 = Math.floor(Math.min(b.minY, 0) / step - 1) * step, y1 = Math.ceil(Math.max(b.maxY, 0) / step + 1) * step;
    this.gridExt = [x0, y0, x1, y1];
    this.step = step;
    var minor = [], major = [], v, list;
    for (v = x0; v <= x1 + step * 0.5; v += step) {
      list = Math.abs(Math.round(v / step) % 5) === 0 ? major : minor;
      list.push(v - o[0], y0 - o[1], -o[2], v - o[0], y1 - o[1], -o[2]);
    }
    for (v = y0; v <= y1 + step * 0.5; v += step) {
      list = Math.abs(Math.round(v / step) % 5) === 0 ? major : minor;
      list.push(x0 - o[0], v - o[1], -o[2], x1 - o[0], v - o[1], -o[2]);
    }
    this.gridMinor = minor.length / 3;
    this.gridMajor = major.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGrid);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(minor.concat(major)), gl.STATIC_DRAW);
    var L = step * 1.5;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bAxes);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -o[0], -o[1], -o[2], L - o[0], -o[1], -o[2],
      -o[0], -o[1], -o[2], -o[0], L - o[1], -o[2],
      -o[0], -o[1], -o[2], -o[0], -o[1], L - o[2]
    ]), gl.STATIC_DRAW);
  };

  Backplot.prototype._size = function () {
    var c = this.canvas, dpr = Math.min(root.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.dpr = dpr;
    return [w, h];
  };

  Backplot.prototype._basis = function () {
    var cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    var cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    var d = [cp * cy, cp * sy, sp], r = [-sy, cy, 0];
    var u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
    return { d: d, r: r, u: u };
  };

  // World -> clip matrix (column major) for positions relative to this.origin.
  Backplot.prototype._mvp = function (w, h) {
    var B = this._basis(), hh = this.cam.zoom, hw = hh * w / h, o = this.origin;
    var t = [this.cam.t[0] - o[0], this.cam.t[1] - o[1], this.cam.t[2] - o[2]];
    var b = this.box;
    var D = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 1) * 50;
    var r = B.r, u = B.u, d = B.d;
    var rt = r[0] * t[0] + r[1] * t[1] + r[2] * t[2];
    var ut = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
    var dt = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
    return new Float32Array([
      r[0] / hw, u[0] / hh, d[0] / D, 0,
      r[1] / hw, u[1] / hh, d[1] / D, 0,
      r[2] / hw, u[2] / hh, d[2] / D, 0,
      -rt / hw, -ut / hh, -dt / D, 1
    ]);
  };

  Backplot.prototype.requestRender = function () {
    if (this._pending || !this.ok) return;
    this._pending = true;
    var self = this;
    (root.requestAnimationFrame || setTimeout)(function () { self._pending = false; self.render(); });
  };

  Backplot.prototype._flat = function (mvp, data, mode, count, color, alpha, pt) {
    var gl = this.gl, f = this.fp;
    gl.useProgram(f.p);
    gl.uniformMatrix4fv(f.u.uMVP, false, mvp);
    gl.uniform4f(f.u.uColor, color[0], color[1], color[2], alpha);
    gl.uniform1f(f.u.uPt, pt || 1);
    if (data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bTmp);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    }
    gl.enableVertexAttribArray(f.a.aPos);
    gl.vertexAttribPointer(f.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(mode, 0, count);
  };

  Backplot.prototype.render = function () {
    if (!this.ok) return;
    var gl = this.gl, sz = this._size(), w = sz[0], h = sz[1], th = this.theme;
    gl.viewport(0, 0, w, h);
    gl.clearColor(th.bg[0], th.bg[1], th.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    var mvp = this._mvp(w, h), f = this.fp, o = this.origin;

    // Grid on Z0
    gl.useProgram(f.p);
    gl.uniformMatrix4fv(f.u.uMVP, false, mvp);
    gl.uniform1f(f.u.uPt, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bGrid);
    gl.enableVertexAttribArray(f.a.aPos);
    gl.vertexAttribPointer(f.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4f(f.u.uColor, th.grid[0], th.grid[1], th.grid[2], 1);
    gl.drawArrays(gl.LINES, 0, this.gridMinor);
    gl.uniform4f(f.u.uColor, th.gridMajor[0], th.gridMajor[1], th.gridMajor[2], 1);
    gl.drawArrays(gl.LINES, this.gridMinor, this.gridMajor);

    // Safe height plane
    if (this.safeZ !== null && this.safeZ === this.safeZ && this.showSafe) {
      var e = this.gridExt, z = this.safeZ - o[2];
      var x0 = e[0] - o[0], y0 = e[1] - o[1], x1 = e[2] - o[0], y1 = e[3] - o[1];
      this._flat(mvp, new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z]), gl.TRIANGLES, 6, th.safe, 0.07);
      this._flat(mvp, new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]), gl.LINE_LOOP, 4, th.safe, 0.55);
    }

    // Toolpath: remaining moves faint, completed moves solid
    if (this.segCount) {
      var p = this.pp;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.uMVP, false, mvp);
      gl.uniform1f(p.u.uCut, this.cut === Infinity ? 3.0e38 : this.cut);
      var P = th.paths;
      gl.uniform3fv(p.u.uCol0, P[0]); gl.uniform3fv(p.u.uCol1, P[1]); gl.uniform3fv(p.u.uCol2, P[2]);
      gl.uniform3fv(p.u.uCol3, P[3]); gl.uniform3fv(p.u.uCol4, P[4]);
      gl.uniform4f(p.u.uVis0, this.vis[0], this.vis[1], this.vis[2], this.vis[3]);
      gl.uniform1f(p.u.uVis4, this.vis[4]);
      var pxPerUnit = h / (2 * this.cam.zoom);
      gl.uniform1f(p.u.uDashK, pxPerUnit / (9 * this.dpr));
      bind(gl, this.bPos, p.a.aPos, 3, gl.FLOAT);
      bind(gl, this.bIdx, p.a.aIdx, 1, gl.FLOAT);
      bind(gl, this.bCls, p.a.aCls, 1, gl.UNSIGNED_BYTE);
      bind(gl, this.bDist, p.a.aDist, 1, gl.FLOAT);
      if (this.cut !== Infinity) {
        gl.uniform1f(p.u.uDone, 0);
        gl.uniform1f(p.u.uAlpha, 0.2);
        gl.drawArrays(gl.LINES, 0, this.segCount * 2);
      }
      gl.uniform1f(p.u.uDone, 1);
      gl.uniform1f(p.u.uAlpha, 1);
      gl.drawArrays(gl.LINES, 0, this.segCount * 2);
      for (var ai = 1; ai < 4; ai++) gl.disableVertexAttribArray(p.a[['aPos', 'aIdx', 'aCls', 'aDist'][ai]]);
    }

    gl.useProgram(f.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bAxes);
    gl.enableVertexAttribArray(f.a.aPos);
    gl.vertexAttribPointer(f.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(f.u.uMVP, false, mvp);
    for (var k = 0; k < 3; k++) {
      gl.uniform4f(f.u.uColor, th.ax[k][0], th.ax[k][1], th.ax[k][2], 0.9);
      gl.drawArrays(gl.LINES, k * 2, 2);
    }

    // Current move, drawn thick on top, and the tool
    var px = 2 / w, py = 2 / h, dpr = this.dpr;
    if (this.trail && this.trail.length > 1) {
      var ndc = this.trail.map(function (q) { return project(mvp, q[0] - o[0], q[1] - o[1], q[2] - o[2]); });
      this._flat(IDENT, thickLine(ndc, 2.2 * dpr, px, py), gl.TRIANGLES, (ndc.length - 1) * 6, th.hl, 0.95);
    }
    if (this.tool) {
      var tip = project(mvp, this.tool[0] - o[0], this.tool[1] - o[1], this.tool[2] - o[2]);
      var up = project(mvp, this.tool[0] - o[0], this.tool[1] - o[1], this.tool[2] - o[2] + this.cam.zoom * 0.22);
      this._flat(IDENT, thickLine([tip, up], 5 * dpr, px, py), gl.TRIANGLES, 6, th.tool, 0.85);
      this._flat(IDENT, disc(tip, 6.5 * dpr, px, py), gl.TRIANGLES, 48, th.bg, 1);
      this._flat(IDENT, disc(tip, 4.5 * dpr, px, py), gl.TRIANGLES, 48, th.tool, 1);
    }

    // Orientation triad, bottom left
    var B = this._basis(), cxp = -1 + 44 * dpr * px, cyp = -1 + 44 * dpr * py, len = 26 * dpr;
    var dirs = [[B.r[0], B.u[0]], [B.r[1], B.u[1]], [B.r[2], B.u[2]]];
    for (var a = 0; a < 3; a++) {
      var tipx = cxp + dirs[a][0] * len * px, tipy = cyp + dirs[a][1] * len * py;
      this._flat(IDENT, thickLine([[cxp, cyp], [tipx, tipy]], 2 * dpr, px, py), gl.TRIANGLES, 6, th.ax[a], 1);
      if (this.labels) {
        var el = this.labels[a];
        el.style.transform = 'translate(' + ((tipx + 1) / 2 * w / dpr + dirs[a][0] * 9 - 5).toFixed(1) + 'px,' +
          ((1 - tipy) / 2 * h / dpr - dirs[a][1] * 9 - 8).toFixed(1) + 'px)';
      }
    }
  };

  function bind(gl, buf, loc, size, type) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, false, 0, 0);
  }

  function project(m, x, y, z) {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13]];
  }

  // Screen-space quads for a polyline of NDC points, width in device pixels.
  function thickLine(pts, width, px, py) {
    var out = new Float32Array((pts.length - 1) * 18), w = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var dx = (b[0] - a[0]) / px, dy = (b[1] - a[1]) / py, l = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / l * width / 2 * px, ny = dx / l * width / 2 * py;
      var q = [a[0] + nx, a[1] + ny, a[0] - nx, a[1] - ny, b[0] + nx, b[1] + ny, b[0] - nx, b[1] - ny];
      var order = [0, 1, 2, 2, 1, 3];
      for (var k = 0; k < 6; k++) { out[w++] = q[order[k] * 2]; out[w++] = q[order[k] * 2 + 1]; out[w++] = 0; }
    }
    return out;
  }

  function disc(c, r, px, py) {
    var out = new Float32Array(48 * 3), w = 0;
    for (var i = 0; i < 16; i++) {
      var a0 = i / 16 * Math.PI * 2, a1 = (i + 1) / 16 * Math.PI * 2;
      out[w++] = c[0]; out[w++] = c[1]; out[w++] = 0;
      out[w++] = c[0] + Math.cos(a0) * r * px; out[w++] = c[1] + Math.sin(a0) * r * py; out[w++] = 0;
      out[w++] = c[0] + Math.cos(a1) * r * px; out[w++] = c[1] + Math.sin(a1) * r * py; out[w++] = 0;
    }
    return out;
  }

  // ---- camera -------------------------------------------------------------

  Backplot.prototype.view = function (name) {
    var v = {
      top: [-Math.PI / 2, Math.PI / 2], front: [-Math.PI / 2, 0], right: [0, 0],
      iso: [-Math.PI / 4, Math.atan(1 / Math.SQRT2)]
    }[name];
    if (!v) return;
    this.cam.yaw = v[0]; this.cam.pitch = v[1];
    this.fit();
  };

  Backplot.prototype.fit = function () {
    var b = this.box, B = this._basis(), c = this.canvas;
    var t = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
    var er = 0, eu = 0;
    for (var i = 0; i < 8; i++) {
      var p = [i & 1 ? b.maxX : b.minX, i & 2 ? b.maxY : b.minY, i & 4 ? b.maxZ : b.minZ];
      var q = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
      er = Math.max(er, Math.abs(B.r[0] * q[0] + B.r[1] * q[1] + B.r[2] * q[2]));
      eu = Math.max(eu, Math.abs(B.u[0] * q[0] + B.u[1] * q[1] + B.u[2] * q[2]));
    }
    var aspect = Math.max(c.clientWidth, 1) / Math.max(c.clientHeight, 1);
    this.cam.t = t;
    this.cam.zoom = Math.max(eu, er / aspect, 0.5) * 1.15;
    this.requestRender();
  };

  Backplot.prototype._pan = function (dx, dy) {
    var B = this._basis(), wpp = 2 * this.cam.zoom / Math.max(this.canvas.clientHeight, 1), t = this.cam.t;
    for (var k = 0; k < 3; k++) t[k] += -B.r[k] * dx * wpp + B.u[k] * dy * wpp;
  };

  Backplot.prototype._zoomAt = function (cssX, cssY, factor) {
    var c = this.canvas, w = Math.max(c.clientWidth, 1), h = Math.max(c.clientHeight, 1);
    var b = this.box, span = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 1);
    var nz = clamp(this.cam.zoom * factor, span * 1e-4, span * 20);
    var nx = cssX / w * 2 - 1, ny = 1 - cssY / h * 2, a = w / h;
    var B = this._basis(), dz = this.cam.zoom - nz, t = this.cam.t;
    for (var k = 0; k < 3; k++) t[k] += B.r[k] * nx * dz * a + B.u[k] * ny * dz;
    this.cam.zoom = nz;
    this.requestRender();
  };

  // Nearest drawn segment to a point in CSS pixels. Returns a move index or -1.
  Backplot.prototype.pick = function (cssX, cssY) {
    if (!this.segs || !this.ok) return -1;
    var c = this.canvas, w = Math.max(c.clientWidth, 1), h = Math.max(c.clientHeight, 1);
    var m = this._mvp(w, h), pos = this.segs.pos, cls = this.clsArr, vis = this.vis;
    var best = -1, bestD = 100;
    for (var s = 0; s < this.segCount; s++) {
      if (!vis[cls[2 * s]]) continue;
      var j = s * 6;
      var ax = (m[0] * pos[j] + m[4] * pos[j + 1] + m[8] * pos[j + 2] + m[12] + 1) * 0.5 * w;
      var ay = (1 - (m[1] * pos[j] + m[5] * pos[j + 1] + m[9] * pos[j + 2] + m[13])) * 0.5 * h;
      var bx = (m[0] * pos[j + 3] + m[4] * pos[j + 4] + m[8] * pos[j + 5] + m[12] + 1) * 0.5 * w;
      var by = (1 - (m[1] * pos[j + 3] + m[5] * pos[j + 4] + m[9] * pos[j + 5] + m[13])) * 0.5 * h;
      var vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
      var t = l2 > 0 ? clamp(((cssX - ax) * vx + (cssY - ay) * vy) / l2, 0, 1) : 0;
      var ex = ax + vx * t - cssX, ey = ay + vy * t - cssY, d = ex * ex + ey * ey;
      if (d <= bestD) { bestD = d; best = s; }
    }
    return best < 0 ? -1 : this.segs.move[best];
  };

  Backplot.prototype._events = function () {
    var self = this, c = this.canvas, pts = {}, drag = null;
    function count() { return Object.keys(pts).length; }
    function pinchState() {
      var k = Object.keys(pts), a = pts[k[0]], b = pts[k[1]];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    c.addEventListener('pointerdown', function (e) {
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (count() === 1) {
        drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now(), moved: 0,
          mode: (e.button === 1 || e.button === 2 || e.shiftKey || e.ctrlKey) ? 'pan' : 'orbit' };
      } else if (count() === 2) {
        drag = { mode: 'pinch', p: pinchState(), moved: 99 };
      }
    });
    c.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId] || !drag) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (drag.mode === 'pinch') {
        if (count() < 2) return;
        var np = pinchState(), r = c.getBoundingClientRect();
        self._pan(np.x - drag.p.x, np.y - drag.p.y);
        self._zoomAt(np.x - r.left, np.y - r.top, drag.p.d / np.d);
        drag.p = np;
        return;
      }
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.mode === 'orbit') {
        self.cam.yaw -= dx * 0.008;
        self.cam.pitch = clamp(self.cam.pitch + dy * 0.008, -Math.PI / 2, Math.PI / 2);
      } else {
        self._pan(dx, dy);
      }
      self.requestRender();
    });
    function end(e) {
      if (!pts[e.pointerId]) return;
      delete pts[e.pointerId];
      if (drag && drag.mode !== 'pinch' && drag.moved < 5 && Date.now() - drag.t < 600 && e.type === 'pointerup' && e.button === 0) {
        var r = c.getBoundingClientRect();
        var m = self.pick(e.clientX - r.left, e.clientY - r.top);
        if (self.onPick) self.onPick(m);
      }
      if (count() === 1) {
        var k = Object.keys(pts)[0];
        drag = { x: pts[k].x, y: pts[k].y, t: 0, moved: 99, mode: 'orbit' };
      } else if (count() === 0) drag = null;
    }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = c.getBoundingClientRect();
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      self._zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(clamp(dy, -200, 200) * 0.0015));
    }, { passive: false });
    c.addEventListener('dblclick', function () { self.fit(); });
  };

  root.Backplot = Backplot;
}(typeof self !== 'undefined' ? self : this));
