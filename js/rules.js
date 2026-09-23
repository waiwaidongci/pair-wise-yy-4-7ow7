/*
 * rules.js —— 业务判定层（纯函数，不碰 DOM、不碰存储）
 *
 * 准入规则：
 *  1. 相邻测线按测线编号自然排序后逐对判定；
 *  2. 条带覆盖率必须落在 [30%, 50%]：低于三成、超过五成都不通过；
 *  3. 相邻测线航向必须交替（方向近似相反，差约 180°）；
 *  4. 任一相邻对不通过，整个拼图只进入“待补测”，不生成成果、不导出、不占用成果版本号。
 */
(function (global) {
  "use strict";

  var LIMITS = {
    MIN_COVERAGE: 0.30,        // 三成（含）
    MAX_COVERAGE: 0.50,        // 五成（含）
    HEADING_TOLERANCE: 15,     // 航向交替容差（度）
    SITE_SIZE: 100             // 平面图为 100m × 100m，坐标单位即米
  };

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function round(n, digits) {
    var p = Math.pow(10, digits || 0);
    return Math.round(n * p) / p;
  }

  // 两航向间的最小夹角（0~180）
  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // 由起、止点推算罗盘方位角（0~360，正北为 0，顺时针）
  function bearing(start, end) {
    return (Math.atan2(end.x - start.x, -(end.y - start.y)) * 180 / Math.PI + 360) % 360;
  }

  // 测线编号自然排序：L-2 排在 L-10 前
  function naturalValue(code) {
    var m = String(code || "").match(/(\d+)(?!.*\d)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  function orderLines(lines) {
    return lines.slice().sort(function (a, b) {
      var na = naturalValue(a.code), nb = naturalValue(b.code);
      if (na !== nb) return na - nb;
      return String(a.code).localeCompare(String(b.code));
    });
  }

  function dot(ax, ay, bx, by) { return ax * bx + ay * by; }

  /*
   * 相邻两条测线的搭接判定。
   * 条带半宽 = 测宽/2；两平行测线中心线的垂直距离 d、平均测宽 w：
   *   覆盖率 = (w - d) / w
   * 同时要求测线在纵向上有搭接投影。
   */
  function pairReport(a, b) {
    var s = a.start, e = a.end;
    var dx = e.x - s.x, dy = e.y - s.y;
    var lengthA = Math.hypot(dx, dy) || 1;
    var ux = dx / lengthA, uy = dy / lengthA;

    var mb = { x: (b.start.x + b.end.x) / 2, y: (b.start.y + b.end.y) / 2 };
    var wx = mb.x - s.x, wy = mb.y - s.y;
    var distance = Math.abs(wy * ux - wx * uy); // 中线垂直距离

    var widthAvg = (a.width + b.width) / 2;
    var coverageRaw = (widthAvg - distance) / widthAvg;

    // 纵向搭接：B 的起止点投影到 A 方向后，与 [0, lengthA] 是否有交集
    var p1 = dot(b.start.x - s.x, b.start.y - s.y, ux, uy);
    var p2 = dot(b.end.x - s.x, b.end.y - s.y, ux, uy);
    var pLo = Math.min(p1, p2), pHi = Math.max(p1, p2);
    var along = Math.max(0, Math.min(lengthA, pHi) - Math.max(0, pLo));
    var alongOk = along > 0.001;

    var coverageOk = alongOk && coverageRaw >= LIMITS.MIN_COVERAGE && coverageRaw <= LIMITS.MAX_COVERAGE;
    var headingGap = angleDiff(a.heading, b.heading);
    var headingOk = headingGap >= 180 - LIMITS.HEADING_TOLERANCE;

    var fragments = [];
    if (!alongOk) {
      fragments.push("测线纵向未搭接");
    } else if (coverageRaw < LIMITS.MIN_COVERAGE) {
      fragments.push("覆盖率 " + formatPct(coverageRaw) + "（低于三成）");
    } else if (coverageRaw > LIMITS.MAX_COVERAGE) {
      fragments.push("覆盖率 " + formatPct(coverageRaw) + "（超过五成）");
    }
    if (!headingOk) {
      fragments.push("航向未交替（" + round(a.heading, 1) + "° → " + round(b.heading, 1) + "°）");
    }

    return {
      aId: a.id, bId: b.id,
      aCode: a.code, bCode: b.code,
      distance: round(distance, 2),
      coverageRaw: round(coverageRaw, 4),
      coveragePct: clamp(round(coverageRaw * 100, 1), 0, 100),
      alongOk: alongOk,
      headingGap: round(headingGap, 1),
      coverageOk: coverageOk,
      headingOk: headingOk,
      ok: coverageOk && headingOk,
      fragments: fragments
    };
  }

  function formatPct(ratio) {
    return clamp(round(ratio * 100, 1), 0, 100).toFixed(1) + "%";
  }

  // 对当前全部测线重算拼图准入结论
  function evaluate(lines) {
    var ordered = orderLines(lines);
    var pairs = [];
    for (var i = 0; i + 1 < ordered.length; i++) {
      pairs.push(pairReport(ordered[i], ordered[i + 1]));
    }
    var eligible = ordered.length >= 2 && pairs.every(function (p) { return p.ok; });

    var reasons = [];
    if (ordered.length < 2) reasons.push("至少需要 2 条相邻测线才能拼接拼图");
    pairs.forEach(function (p) {
      if (!p.ok) reasons.push(p.aCode + " ↔ " + p.bCode + "：" + p.fragments.join("，"));
    });

    return { ordered: ordered, pairs: pairs, eligible: eligible, reasons: reasons };
  }

  /*
   * 成果指纹：只取影响拼图几何/准入的字段。
   * 坐标、航向、测宽、拍照间隔（及决定相邻关系的编号）一变，指纹即变，
   * 旧成果立即与当前数据脱钩，只能作为只读历史。
   */
  function fingerprint(lines) {
    var basis = orderLines(lines).map(function (l) {
      return [
        l.code,
        round(l.start.x, 2), round(l.start.y, 2),
        round(l.end.x, 2), round(l.end.y, 2),
        round(l.heading, 1), round(l.width, 2), round(l.interval, 2)
      ];
    });
    return JSON.stringify(basis);
  }

  function num(v) {
    if (v === null || v === undefined || String(v).trim() === "") return NaN;
    return Number(v);
  }

  // 登记表单校验 + 规范化；ignoreId 用于编辑时排除自身的编号唯一性检查
  function validateLine(raw, allLines, ignoreId) {
    var errors = [];
    var code = String(raw.code || "").trim();
    var diver = String(raw.diver || "").trim();
    var sx = num(raw.sx), sy = num(raw.sy), ex = num(raw.ex), ey = num(raw.ey);
    var heading = num(raw.heading), width = num(raw.width), interval = num(raw.interval);

    if (!code) errors.push("测线编号必填");
    if (!diver) errors.push("潜水员必填");
    [["起点X", sx], ["起点Y", sy], ["终点X", ex], ["终点Y", ey]].forEach(function (f) {
      if (!isFinite(f[1]) || f[1] < 0 || f[1] > LIMITS.SITE_SIZE) errors.push(f[0] + " 需为 0~100 的数字");
    });
    if (isFinite(sx) && isFinite(sy) && isFinite(ex) && isFinite(ey)) {
      if (Math.hypot(ex - sx, ey - sy) < 1) errors.push("起止点距离过近，无法构成测线");
    }
    if (!isFinite(heading) || heading < 0 || heading > 360) errors.push("航向需为 0~360 度");
    if (!isFinite(width) || width <= 0 || width > 60) errors.push("测宽需为 0~60 米的正数");
    if (!isFinite(interval) || interval <= 0 || interval > 600) errors.push("拍照间隔需为正数（秒）");
    if (code && allLines.some(function (l) { return l.id !== ignoreId && l.code === code; })) {
      errors.push("测线编号 " + code + " 已存在，每个潜次按测线编号唯一");
    }

    if (errors.length) return { errors: errors, value: null };
    return {
      errors: [],
      value: {
        id: ignoreId || undefined,
        code: code,
        diver: diver,
        start: { x: round(sx, 2), y: round(sy, 2) },
        end: { x: round(ex, 2), y: round(ey, 2) },
        heading: round(heading === 360 ? 0 : heading, 1),
        width: round(width, 2),
        interval: round(interval, 2)
      }
    };
  }

  function suggestCode(lines) {
    var max = 0;
    lines.forEach(function (l) {
      var m = String(l.code || "").match(/^L-?(\d+)$/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return "L-" + String(max + 1).padStart(2, "0");
  }

  global.Rules = {
    LIMITS: LIMITS,
    clamp: clamp,
    round: round,
    angleDiff: angleDiff,
    bearing: bearing,
    orderLines: orderLines,
    evaluate: evaluate,
    fingerprint: fingerprint,
    validateLine: validateLine,
    suggestCode: suggestCode,
    formatPct: formatPct
  };
})(window);
