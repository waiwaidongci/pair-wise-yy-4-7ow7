/*
 * survey-map.js —— 地图交互
 * 负责：测线平面图绘制（测宽带、中心线、航向箭头、相邻对覆盖率标注）、
 *       点击登记起止坐标、拖拽端点改坐标、测线选中。业务判定与持久化均不在此文件。
 */
(function (global) {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function attach(container, handlers) {
    handlers = handlers || {};
    var state = { lines: [], pairs: [], selectedId: null, buffer: null };
    var bounds = { e: 100, n: 100 };
    var scale = 1, ox = 0, oy = 0, cssW = 0, cssH = 0;
    var draft = []; // 两击布点过程中的临时点（米坐标）
    var drag = null; // {which:'start'|'end'|'draft', index}

    var svg = el("svg", { class: "survey-svg" });
    container.appendChild(svg);
    var gGrid = el("g", { class: "g-grid" });
    var gBand = el("g", { class: "g-band" });
    var gLine = el("g", { class: "g-line" });
    var gPair = el("g", { class: "g-pair" });
    var gDraft = el("g", { class: "g-draft" });
    var gHandle = el("g", { class: "g-handle" });
    [gGrid, gBand, gLine, gPair, gDraft, gHandle].forEach(function (g) { svg.appendChild(g); });

    // 比例尺
    var bar = document.createElement("div");
    bar.className = "scalebar";
    container.appendChild(bar);

    var hint = document.createElement("div");
    hint.className = "maphint";
    container.appendChild(hint);

    function resize() {
      var rect = container.getBoundingClientRect();
      cssW = rect.width; cssH = rect.height;
      scale = Math.min(cssW / bounds.e, cssH / bounds.n);
      // 米制等比：以东西向铺满，按容器比例反推可见的南北跨度
      bounds.e = Math.max(1, Math.round(cssW / scale));
      bounds.n = Math.max(1, Math.round(cssH / scale));
      scale = cssW / bounds.e;
      ox = 0; oy = 0;
      svg.setAttribute("viewBox", "0 0 " + cssW + " " + cssH);
      svg.setAttribute("width", cssW);
      svg.setAttribute("height", cssH);
      if (handlers.onBounds) handlers.onBounds({ e: bounds.e, n: bounds.n });
      draw();
    }

    function project(p) {
      return { x: ox + p.e * scale, y: oy + (bounds.n - p.n) * scale };
    }
    function unproject(x, y) {
      return {
        e: Math.round(((x - ox) / scale) * 10) / 10,
        n: Math.round((bounds.n - (y - oy) / scale) * 10) / 10
      };
    }
    function eventPoint(event) {
      var rect = container.getBoundingClientRect();
      return unproject(event.clientX - rect.left, event.clientY - rect.top);
    }

    function swathCorners(l) {
      var de = l.end.e - l.start.e, dn = l.end.n - l.start.n;
      var len = Math.hypot(de, dn);
      if (!(len > 0)) return null;
      var pe = dn / len, pn = -de / len, hw = Number(l.width) / 2;
      return [
        { e: l.start.e + pe * hw, n: l.start.n + pn * hw },
        { e: l.end.e + pe * hw, n: l.end.n + pn * hw },
        { e: l.end.e - pe * hw, n: l.end.n - pn * hw },
        { e: l.start.e - pe * hw, n: l.start.n - pn * hw }
      ];
    }

    function pairKey(p) { return p.aId + "|" + p.bId; }
    var pairById = {};

    function lineClass(line) {
      var involved = Object.keys(pairById).some(function (k) {
        var ids = k.split("|");
        return (ids[0] === line.id || ids[1] === line.id) && !pairById[k].pass;
      });
      return involved ? "bad" : "ok";
    }

    function pointsAttr(poly) {
      return poly.map(function (p) {
        var q = project(p);
        return q.x.toFixed(1) + "," + q.y.toFixed(1);
      }).join(" ");
    }

    function drawGrid() {
      while (gGrid.firstChild) gGrid.removeChild(gGrid.firstChild);
      for (var e = 0; e <= bounds.e; e += 10) {
        var a = project({ e: e, n: 0 }), b = project({ e: e, n: bounds.n });
        gGrid.appendChild(el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "grid" + (e === 0 ? " edge" : "") }));
        if (e > 0) gGrid.appendChild(textAt(e, -4, e + "E", "gridlabel"));
      }
      for (var n = 0; n <= bounds.n; n += 10) {
        var c = project({ e: 0, n: n }), d = project({ e: bounds.e, n: n });
        gGrid.appendChild(el("line", { x1: c.x, y1: c.y, x2: d.x, y2: d.y, class: "grid" + (n === 0 ? " edge" : "") }));
        if (n > 0 && n < bounds.n) gGrid.appendChild(textAtX(-4, n, n + "N", "gridlabel"));
      }
      // 比例尺 20m
      bar.style.width = (20 * scale) + "px";
      bar.innerHTML = "<span>20m</span>";
    }

    function textAt(e, n, txt, cls) {
      var p = project({ e: e, n: n });
      var t = el("text", { x: p.x, y: p.y, class: cls || "maplabel", "text-anchor": "middle" });
      t.textContent = txt;
      return t;
    }
    function textAtX(e, n, txt, cls) {
      var p = project({ e: e, n: n });
      var t = el("text", { x: p.x, y: p.y, class: cls || "maplabel", "text-anchor": "end" });
      t.textContent = txt;
      return t;
    }

    function drawLines() {
      while (gBand.firstChild) gBand.removeChild(gBand.firstChild);
      while (gLine.firstChild) gLine.removeChild(gLine.firstChild);
      state.lines.forEach(function (l) {
        var cls = lineClass(l);
        var selected = l.id === state.selectedId;
        var corners = swathCorners(l);
        if (corners) {
          var poly = el("polygon", {
            points: pointsAttr(corners),
            class: "swath " + cls + (selected ? " selected" : "")
          });
          poly.addEventListener("click", function (ev) {
            ev.stopPropagation();
            if (handlers.onSelect) handlers.onSelect(l.id);
          });
          gBand.appendChild(poly);
        }
        var s = project(l.start), en = project(l.end);
        var hit = el("line", { x1: s.x, y1: s.y, x2: en.x, y2: en.y, class: "line-hit" });
        hit.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (handlers.onSelect) handlers.onSelect(l.id);
        });
        gLine.appendChild(hit);
        gLine.appendChild(el("line", {
          x1: s.x, y1: s.y, x2: en.x, y2: en.y,
          class: "cline " + cls + (selected ? " selected" : "")
        }));
        // 航向箭头（按登记航向，北为 0、顺时针）
        var h = Number(l.heading) * Math.PI / 180;
        var mid = { e: (l.start.e + l.end.e) / 2, n: (l.start.n + l.end.n) / 2 };
        var tip = { e: mid.e + Math.sin(h) * 3.2, n: mid.n + Math.cos(h) * 3.2 };
        var tail = { e: mid.e - Math.sin(h) * 3.2, n: mid.n - Math.cos(h) * 3.2 };
        var tp = project(tip), t0 = project(tail);
        gLine.appendChild(el("line", { x1: t0.x, y1: t0.y, x2: tp.x, y2: tp.y, class: "heading" }));
        var ang = Math.atan2(tp.y - t0.y, tp.x - t0.x) * 180 / Math.PI;
        gLine.appendChild(el("polygon", {
          points: "0,0 -9,-4 -9,4",
          class: "heading",
          transform: "translate(" + tp.x + "," + tp.y + ") rotate(" + ang + ")"
        }));
        var lp = project(mid);
        var label = el("text", { x: lp.x, y: lp.y - 10, class: "codelabel", "text-anchor": "middle" });
        label.textContent = l.code + " · " + Math.round(l.heading) + "° · w" + l.width;
        label.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (handlers.onSelect) handlers.onSelect(l.id);
        });
        gLine.appendChild(label);
      });
    }

    function drawPairs() {
      while (gPair.firstChild) gPair.removeChild(gPair.firstChild);
      pairById = {};
      state.pairs.forEach(function (p) {
        pairById[pairKey(p)] = p;
        var c = project(p.at);
        var g = el("g", { class: "pairmark" });
        g.appendChild(el("circle", { cx: c.x, cy: c.y, r: 15, class: "pair " + (p.pass ? "ok" : "bad") }));
        var t = el("text", { x: c.x, y: c.y + 4, class: "pairlabel", "text-anchor": "middle" });
        t.textContent = Math.round(p.rate * 100) + "%";
        g.appendChild(t);
        var title = el("title");
        title.textContent = p.label + "：覆盖率 " + p.rateText + (p.alternate ? "，航向已交替" : "，航向未交替");
        g.appendChild(title);
        gPair.appendChild(g);
      });
    }

    function handle(pt, cls, onDown) {
      var p = project(pt);
      var c = el("circle", { cx: p.x, cy: p.y, r: 7, class: "handle " + cls });
      c.addEventListener("pointerdown", onDown);
      return c;
    }

    function drawDraftAndHandles() {
      while (gDraft.firstChild) gDraft.removeChild(gDraft.firstChild);
      while (gHandle.firstChild) gHandle.removeChild(gHandle.firstChild);

      // 编辑中的未保存测线（虚线预览）
      var buf = state.buffer;
      if (buf && buf.start && buf.end) {
        var s = project(buf.start), e = project(buf.end);
        gDraft.appendChild(el("line", { x1: s.x, y1: s.y, x2: e.x, y2: e.y, class: "bufferline" }));
      }

      // 已选中测线的端点可拖拽
      var sel = state.lines.find(function (l) { return l.id === state.selectedId; }) || null;
      var target = buf || sel;
      if (target) {
        ["start", "end"].forEach(function (which) {
          gHandle.appendChild(handle(target[which], buf ? "buffering" : "saved", function (ev) {
            ev.stopPropagation();
            beginDrag(which, ev);
          }));
        });
      }

      // 两击布点的临时点
      draft.forEach(function (pt, i) {
        gHandle.appendChild(handle(pt, "draft", function (ev) {
          ev.stopPropagation();
          beginDraftDrag(i, ev);
        }));
      });
      if (draft.length === 1) {
        var p = project(draft[0]);
        gDraft.appendChild(el("circle", { cx: p.x, cy: p.y, r: 12, class: "draftpulse" }));
      }
    }

    function beginDrag(which, ev) {
      drag = { kind: "buffer", which: which };
      svg.setPointerCapture && svg.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
    function beginDraftDrag(i, ev) {
      drag = { kind: "draft", index: i };
      ev.preventDefault();
    }

    function onPointerMove(ev) {
      if (!drag) return;
      var pt = eventPoint(ev);
      if (drag.kind === "draft") {
        draft[drag.index] = pt;
        if (handlers.onPick) handlers.onPick(pt);
        drawDraftAndHandles();
      } else if (drag.kind === "buffer") {
        if (!state.buffer) {
          var sel = state.lines.find(function (l) { return l.id === state.selectedId; });
          if (!sel) return;
          state.buffer = JSON.parse(JSON.stringify(sel));
          if (handlers.onEditBuffer) handlers.onEditBuffer(JSON.parse(JSON.stringify(state.buffer)));
        }
        state.buffer[drag.which] = pt;
        if (handlers.onEditBuffer) handlers.onEditBuffer(JSON.parse(JSON.stringify(state.buffer)));
        drawDraftAndHandles();
        var b = state.buffer;
        drawBufferLineOnly(b);
      }
    }

    function drawBufferLineOnly(b) {
      // 拖拽时只需更新虚线（端点 handle 已重建）
      var lines = gDraft.querySelectorAll(".bufferline");
      if (!b || !b.start || !b.end) return;
      var s = project(b.start), e = project(b.end);
      if (lines.length) {
        lines[0].setAttribute("x1", s.x);
        lines[0].setAttribute("y1", s.y);
        lines[0].setAttribute("x2", e.x);
        lines[0].setAttribute("y2", e.y);
      }
    }

    function onPointerUp() { drag = null; }

    function onMapClick(ev) {
      if (drag) return;
      var pt = eventPoint(ev);
      if (draft.length === 0) {
        draft = [pt];
        if (handlers.onPick) handlers.onPick(pt);
        updateHint();
        drawDraftAndHandles();
      } else {
        draft.push(pt);
        var points = { start: draft[0], end: draft[1] };
        draft = [];
        updateHint();
        drawDraftAndHandles();
        if (handlers.onDraftComplete) handlers.onDraftComplete(points);
      }
    }

    function updateHint() {
      hint.textContent = draft.length === 0
        ? "点击平面图：第一次落点为起点，第二次为终点"
        : "再点一次确定终点（Esc 取消）";
    }

    svg.addEventListener("click", onMapClick);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);

    function onKey(ev) {
      if (ev.key === "Escape" && draft.length) {
        draft = [];
        updateHint();
        drawDraftAndHandles();
      }
    }
    document.addEventListener("keydown", onKey);

    function draw() {
      drawGrid();
      drawLines();
      drawPairs();
      drawDraftAndHandles();
    }

    var ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();
    updateHint();

    return {
      setState: function (next) {
        state = Object.assign(state, next);
        draw();
      },
      startDraft: function (points) {
        draft = points ? [points.start, points.end] : [];
        drawDraftAndHandles();
      },
      clearDraft: function () {
        draft = [];
        updateHint();
        drawDraftAndHandles();
      },
      setBuffer: function (buf) {
        state.buffer = buf;
        drawDraftAndHandles();
      },
      getBounds: function () { return { e: bounds.e, n: bounds.n }; },
      destroy: function () {
        ro.disconnect();
        document.removeEventListener("keydown", onKey);
        svg.removeEventListener("click", onMapClick);
        svg.removeEventListener("pointermove", onPointerMove);
        svg.removeEventListener("pointerup", onPointerUp);
        svg.remove();
        bar.remove();
        hint.remove();
      }
    };
  }

  global.SurveyMap = { attach: attach };
})(window);
