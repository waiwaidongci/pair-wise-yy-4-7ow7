/*
 * map.js —— 地图交互层
 *
 * 只负责：
 *  - 按 Store 提供的测线与 Rules 的相邻对结论绘制测线、测宽条带、起止点、覆盖率徽标；
 *  - “登记测线”模式下两次点击取起止点（实时虚线预览）；
 *  - 点击测线/起止点选中并回调。
 * 不在这里做准入判定，也不读写存储。
 */
(function (global) {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var root = null, svg = null;
  var handlers = {};
  var view = {
    lines: [], pairs: [], selectedId: null,
    armed: false, phase: 0, draftStart: null, cursor: null
  };

  function el(name, attrs) {
    var node = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function init(rootEl, h) {
    root = rootEl;
    handlers = h || {};
    svg = el("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "xMidYMid meet" });
    svg.classList.add("survey-svg");
    root.appendChild(svg);

    svg.addEventListener("click", function (e) {
      var p = toSite(e);
      var node = e.target;
      var markerRef = node && node.closest ? node.closest("[data-line-id]") : null;
      if (!view.armed && markerRef) {
        handlers.onSelect && handlers.onSelect(markerRef.getAttribute("data-line-id"));
        return;
      }
      if (view.armed) {
        if (view.phase === 0) {
          view.phase = 1;
          view.draftStart = p;
        } else {
          var start = view.draftStart, end = p;
          disarm();
          handlers.onPickLine && handlers.onPickLine(start, end);
          return;
        }
        draw();
      } else {
        handlers.onSelect && handlers.onSelect(null);
      }
    });

    svg.addEventListener("mousemove", function (e) {
      if (!view.armed) return;
      view.cursor = toSite(e);
      drawDraft();
    });

    svg.addEventListener("mouseleave", function () { view.cursor = null; drawDraft(); });
  }

  function toSite(e) {
    var r = svg.getBoundingClientRect();
    var clamp = function (n) { return Math.max(0, Math.min(100, n)); };
    return {
      x: Number(clamp((e.clientX - r.left) / r.width * 100).toFixed(2)),
      y: Number(clamp((e.clientY - r.top) / r.height * 100).toFixed(2))
    };
  }

  // 条带四角：沿测线法向各偏移 halfWidth
  function swathPoints(line) {
    var s = line.start, e = line.end;
    var dx = e.x - s.x, dy = e.y - s.y;
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var h = line.width / 2;
    return [
      [s.x + nx * h, s.y + ny * h],
      [e.x + nx * h, e.y + ny * h],
      [e.x - nx * h, e.y - ny * h],
      [s.x - nx * h, s.y - ny * h]
    ];
  }

  function arrowHead(line) {
    var s = line.start, e = line.end;
    var dx = e.x - s.x, dy = e.y - s.y;
    var ang = Math.atan2(dy, dx);
    var size = 2.2, spread = Math.PI / 7;
    var b1 = { x: e.x - size * Math.cos(ang - spread), y: e.y - size * Math.sin(ang - spread) };
    var b2 = { x: e.x - size * Math.cos(ang + spread), y: e.y - size * Math.sin(ang + spread) };
    return el("polygon", {
      points: e.x + "," + e.y + " " + b1.x + "," + b1.y + " " + b2.x + "," + b2.y,
      fill: "#183035"
    });
  }

  function statusOfPair(p) {
    if (!p.coverageOk) return p.alongOk ? (p.coverageRaw < Rules.LIMITS.MIN_COVERAGE ? "low" : "high") : "gap";
    if (!p.headingOk) return "heading";
    return "ok";
  }

  var BADGE = {
    ok: { fill: "#1d6c78", text: function (p) { return p.coveragePct.toFixed(1) + "% ✓"; } },
    low: { fill: "#c0453a", text: function (p) { return p.coveragePct.toFixed(1) + "% 低"; } },
    high: { fill: "#c0453a", text: function (p) { return p.coveragePct.toFixed(1) + "% 高"; } },
    gap: { fill: "#c0453a", text: function () { return "未搭接"; } },
    heading: { fill: "#b56c38", text: function (p) { return p.coveragePct.toFixed(1) + "% 航向"; } }
  };

  function drawBadge(pair, lineById) {
    var a = lineById[pair.aId], b = lineById[pair.bId];
    if (!a || !b) return null;
    var ma = { x: (a.start.x + a.end.x) / 2, y: (a.start.y + a.end.y) / 2 };
    var mb = { x: (b.start.x + b.end.x) / 2, y: (b.start.y + b.end.y) / 2 };
    var cx = (ma.x + mb.x) / 2, cy = (ma.y + mb.y) / 2;
    var key = statusOfPair(pair);
    var spec = BADGE[key];
    var label = spec.text(pair);
    var w = label.length * 2.5 + 3, h = 4.2;
    var g = el("g", { class: "badge" });
    g.appendChild(el("rect", { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: 1.2, fill: spec.fill }));
    var t = el("text", {
      x: cx, y: cy + 1.35, "text-anchor": "middle",
      "font-size": 2.6, "font-weight": "700", fill: "#fff", text: label
    });
    g.appendChild(t);
    g.appendChild(el("title", { text: pair.aCode + " ↔ " + pair.bCode + (pair.ok ? "：准入通过" : "：" + pair.fragments.join("，")) }));
    return g;
  }

  function drawLine(line, pairByLine) {
    var g = el("g", { "data-line-id": line.id, class: "line-group" + (line.id === view.selectedId ? " selected" : "") });
    var failed = pairByLine[line.id] === false;

    g.appendChild(el("polygon", {
      points: swathPoints(line).map(function (p) { return p[0] + "," + p[1]; }).join(" "),
      class: "swath " + (failed ? "swath-bad" : "swath-ok")
    }));

    // 加大的透明命中区
    g.appendChild(el("line", {
      x1: line.start.x, y1: line.start.y, x2: line.end.x, y2: line.end.y,
      stroke: "transparent", "stroke-width": 5
    }));
    g.appendChild(el("line", {
      x1: line.start.x, y1: line.start.y, x2: line.end.x, y2: line.end.y,
      class: "track"
    }));
    g.appendChild(arrowHead(line));

    var mx = (line.start.x + line.end.x) / 2, my = (line.start.y + line.end.y) / 2;
    var label = line.code + " · " + line.width + "m · " + line.heading + "°";
    var lw = label.length * 1.55 + 2.4;
    g.appendChild(el("rect", { x: mx - lw / 2, y: my - 2.6, width: lw, height: 3.6, rx: 1, class: "code-bg" }));
    g.appendChild(el("text", { x: mx, y: my, "text-anchor": "middle", "font-size": 2.3, class: "code-text", text: label }));

    g.appendChild(el("circle", { cx: line.start.x, cy: line.start.y, r: 1.5, class: "endpoint start" }));
    g.appendChild(el("text", { x: line.start.x, y: line.start.y - 2.4, "text-anchor": "middle", "font-size": 2.4, class: "ep-text", text: "起" }));
    g.appendChild(el("circle", { cx: line.end.x, cy: line.end.y, r: 1.5, class: "endpoint end" }));
    g.appendChild(el("text", { x: line.end.x, y: line.end.y + 4.4, "text-anchor": "middle", "font-size": 2.4, class: "ep-text", text: "终" }));
    g.appendChild(el("title", { text: line.code + " 潜水员：" + line.diver + " 拍照间隔：" + line.interval + "s" }));
    return g;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function draw() {
    clear(svg);
    var lineById = {};
    view.lines.forEach(function (l) { lineById[l.id] = l; });
    var pairByLine = {};
    view.lines.forEach(function (l) { pairByLine[l.id] = true; });
    view.pairs.forEach(function (p) {
      if (!p.ok) { pairByLine[p.aId] = false; pairByLine[p.bId] = false; }
    });

    view.lines.forEach(function (l) { svg.appendChild(drawLine(l, pairByLine)); });
    view.pairs.forEach(function (p) {
      var b = drawBadge(p, lineById);
      if (b) svg.appendChild(b);
    });
    drawDraft();
  }

  function drawDraft() {
    var old = svg.querySelector(".draft");
    if (old) old.remove();
    if (!view.armed) return;
    var g = el("g", { class: "draft" });
    if (view.phase === 0) {
      if (view.cursor) {
        g.appendChild(el("circle", { cx: view.cursor.x, cy: view.cursor.y, r: 1.4, class: "draft-point" }));
      }
    } else if (view.draftStart) {
      g.appendChild(el("circle", { cx: view.draftStart.x, cy: view.draftStart.y, r: 1.4, class: "draft-point" }));
      if (view.cursor) {
        g.appendChild(el("line", {
          x1: view.draftStart.x, y1: view.draftStart.y, x2: view.cursor.x, y2: view.cursor.y,
          class: "draft-line"
        }));
        g.appendChild(el("circle", { cx: view.cursor.x, cy: view.cursor.y, r: 1.4, class: "draft-point" }));
      }
    }
    svg.appendChild(g);
  }

  function render(state) {
    view.lines = state.lines || [];
    view.pairs = state.pairs || [];
    view.selectedId = state.selectedId || null;
    draw();
  }

  function arm() {
    view.armed = true;
    view.phase = 0;
    view.draftStart = null;
    view.cursor = null;
    root.classList.add("armed");
    handlers.onArmedChange && handlers.onArmedChange(true);
    draw();
  }
  function disarm() {
    view.armed = false; view.phase = 0; view.draftStart = null; view.cursor = null;
    root.classList.remove("armed");
    handlers.onArmedChange && handlers.onArmedChange(false);
    draw();
  }
  function isArmed() { return view.armed; }

  global.MapView = {
    init: init, render: render, arm: arm, disarm: disarm, isArmed: isArmed
  };
})(window);
