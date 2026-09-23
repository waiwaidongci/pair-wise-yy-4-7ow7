/*
 * survey-rules.js —— 业务判定（纯函数，无持久化、无 DOM 依赖）
 * 负责：测线几何、相邻测线覆盖率、航向交替、拼图准入判定、数据指纹、表单校验。
 */
(function (global) {
  "use strict";

  // 准入阈值：相邻测线覆盖率闭区间 [30%, 50%] 才合格；航向相差约 180° 视为交替
  var LIMITS = {
    MIN_OVERLAP: 0.30,
    MAX_OVERLAP: 0.50,
    HEADING_TOL: 25, // 与 180° 的允许偏差（度）
    SITE_E: 100,     // 场地东向跨度（米）
    MAX_WIDTH: 100,
    MAX_INTERVAL: 600
  };

  // 修改这些字段会让相关拼图立即失效（潜水员变更不影响拼图判定）
  var INVALIDATING_FIELDS = ["start", "end", "heading", "width", "interval"];

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function normHeading(h) {
    h = num(h);
    if (!isFinite(h)) return NaN;
    var r = ((h % 360) + 360) % 360;
    return r === 360 ? 0 : r;
  }

  // 两航向间的最小夹角（0~180）
  function angleBetween(a, b) {
    var d = Math.abs(normHeading(a) - normHeading(b));
    if (isNaN(d)) return NaN;
    return d > 180 ? 360 - d : d;
  }

  // 由起止坐标推算几何信息：长度（米）、几何航向（度，0=北，顺时针）、中点
  function geometry(l) {
    var de = l.end.e - l.start.e;
    var dn = l.end.n - l.start.n;
    var len = Math.hypot(de, dn);
    var bearing = len > 0 ? normHeading(Math.atan2(de, dn) * 180 / Math.PI) : NaN;
    return {
      de: de, dn: dn, len: len, bearing: bearing,
      mid: { e: (l.start.e + l.end.e) / 2, n: (l.start.n + l.end.n) / 2 }
    };
  }

  // 相邻测线中心线间距：b 中点到 a 所在直线的垂直距离（米）
  function spacing(a, b) {
    var ga = geometry(a);
    var gb = geometry(b);
    if (!(ga.len > 0)) return NaN;
    var ue = ga.de / ga.len;
    var un = ga.dn / ga.len;
    var dx = gb.mid.e - ga.mid.e;
    var dy = gb.mid.n - ga.mid.n;
    return Math.abs(ue * dy - un * dx);
  }

  // 覆盖率 = 1 - 中心线间距 / 平均测宽，钳制在 0~100%
  function overlapRate(a, b) {
    var d = spacing(a, b);
    var w = (num(a.width) + num(b.width)) / 2;
    if (isNaN(d) || !(w > 0)) return NaN;
    return clamp(1 - d / w, 0, 1);
  }

  // 相邻测线航向必须反向交替（相差约 180°）
  function headingsAlternate(a, b) {
    var d = angleBetween(a.heading, b.heading);
    return isNaN(d) ? false : d >= 180 - LIMITS.HEADING_TOL;
  }

  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function fmtHeading(h) { return String(Math.round(normHeading(h))); }

  // 测线编号按其中的数字序排列（L-01、L-02 ……），编号即布线顺序
  function codeSeq(code) {
    var m = String(code || "").match(/\d+/);
    return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
  }
  function sortLines(lines) {
    return clone(lines).sort(function (a, b) {
      var d = codeSeq(a.code) - codeSeq(b.code);
      return d !== 0 ? d : (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    });
  }

  function nextCode(lines) {
    var max = 0;
    lines.forEach(function (l) { max = Math.max(max, codeSeq(l.code) || 0); });
    return "L-" + String(max + 1).padStart(2, "0");
  }

  // 单对相邻测线的准入判定
  function evaluatePair(a, b) {
    var label = a.code + " ↔ " + b.code;
    var ga = geometry(a);
    var gb = geometry(b);
    var base = {
      aId: a.id, bId: b.id, aCode: a.code, bCode: b.code, label: label,
      rate: null, rateText: "—", spacing: null, alternate: false,
      pass: false, reasons: [],
      at: { e: (ga.mid.e + gb.mid.e) / 2, n: (ga.mid.n + gb.mid.n) / 2 }
    };
    if (!(ga.len > 0) || !(gb.len > 0)) {
      base.reasons.push(label + "：存在起止坐标重合的零长度测线");
      return base;
    }
    var rate = overlapRate(a, b);
    base.rate = rate;
    base.rateText = pct(rate);
    base.spacing = round2(spacing(a, b));
    if (rate < LIMITS.MIN_OVERLAP) {
      base.reasons.push(label + "：覆盖率 " + pct(rate) + " 低于三成下限，需补测");
    }
    if (rate > LIMITS.MAX_OVERLAP) {
      base.reasons.push(label + "：覆盖率 " + pct(rate) + " 高于五成上限，需拉开测线");
    }
    base.alternate = headingsAlternate(a, b);
    if (!base.alternate) {
      base.reasons.push(label + "：航向 " + fmtHeading(a.heading) + "°→" +
        fmtHeading(b.heading) + "° 未交替（相邻测线应相差约 180°）");
    }
    base.pass = base.reasons.length === 0;
    return base;
  }

  // 整张拼图的准入判定：任一相邻对不合格 => 拼图只进入待补测
  function evaluate(lines) {
    var sorted = sortLines(lines);
    var pairs = [];
    var reasons = [];
    if (sorted.length < 2) {
      return {
        status: "waiting", ready: false, lines: sorted, pairs: pairs, reasons: [
          "至少需要 2 条测线才能拼图（当前 " + sorted.length + " 条）"
        ]
      };
    }
    for (var i = 0; i < sorted.length - 1; i++) {
      var p = evaluatePair(sorted[i], sorted[i + 1]);
      pairs.push(p);
      p.reasons.forEach(function (r) { reasons.push(r); });
    }
    return {
      status: reasons.length ? "waiting" : "ready",
      ready: reasons.length === 0,
      lines: sorted, pairs: pairs, reasons: reasons
    };
  }

  // 数据指纹：仅覆盖准入相关字段；同指纹的重复/并发提交沿用首次结果
  function fingerprint(lines) {
    return sortLines(lines).map(function (l) {
      return [
        l.code,
        round2(num(l.start.e)) + "," + round2(num(l.start.n)),
        round2(num(l.end.e)) + "," + round2(num(l.end.n)),
        "h" + Math.round(normHeading(l.heading)),
        "w" + round2(num(l.width)),
        "t" + round2(num(l.interval))
      ].join("|");
    }).join(";");
  }

  // 登记表单校验，返回 { errors:[], value:归一化测线 }
  function validateLine(raw, opts) {
    opts = opts || {};
    var bounds = opts.bounds || { e: LIMITS.SITE_E, n: LIMITS.SITE_E };
    var usedCodes = opts.usedCodes || [];
    var errors = [];
    var code = String(raw.code == null ? "" : raw.code).trim().toUpperCase();
    var diver = String(raw.diver == null ? "" : raw.diver).trim();
    var se = num(raw.start && raw.start.e), sn = num(raw.start && raw.start.n);
    var ee = num(raw.end && raw.end.e), en = num(raw.end && raw.end.n);
    var heading = normHeading(raw.heading);
    var width = num(raw.width);
    var interval = num(raw.interval);

    if (!code) errors.push("测线编号不能为空");
    else if (!/^[A-Z0-9][A-Z0-9\-]{0,11}$/.test(code)) errors.push("测线编号格式不合法（字母数字与连字符，最多 12 位）");
    else if (usedCodes.indexOf(code) >= 0) errors.push("测线编号 " + code + " 已存在，每个潜次按测线编号唯一");
    if (!diver) errors.push("潜水员不能为空");

    [[se, "起点东距"], [sn, "起点北距"], [ee, "终点东距"], [en, "终点北距"]].forEach(function (t) {
      if (!isFinite(t[0])) errors.push(t[1] + " 必须是数字");
      else if (t[0] < 0 || t[0] > (t[1].indexOf("东") >= 0 ? bounds.e : bounds.n)) {
        errors.push(t[1] + " 超出场地范围（0~" + (t[1].indexOf("东") >= 0 ? bounds.e : bounds.n).toFixed(0) + " 米）");
      }
    });
    if (isNaN(heading)) errors.push("航向必须是 0~359 度");
    if (!(width > 0) || width > LIMITS.MAX_WIDTH) errors.push("测宽必须是 0~" + LIMITS.MAX_WIDTH + " 米之间的正数");
    if (!(interval > 0) || interval > LIMITS.MAX_INTERVAL) errors.push("拍照间隔必须是 0~" + LIMITS.MAX_INTERVAL + " 秒之间的正数");
    if (!errors.some(function (m) { return m.indexOf("坐标") >= 0 || m.indexOf("范围") >= 0; }) &&
        isFinite(se) && isFinite(sn) && isFinite(ee) && isFinite(en) &&
        se === ee && sn === en) {
      errors.push("起点与终点重合，测线长度不能为 0");
    }

    return {
      errors: errors,
      value: {
        code: code, diver: diver,
        start: { e: round2(se), n: round2(sn) },
        end: { e: round2(ee), n: round2(en) },
        heading: isNaN(heading) ? 0 : Math.round(heading),
        width: round2(width), interval: round2(interval)
      }
    };
  }

  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    function p(x) { return String(x).padStart(2, "0"); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  global.SurveyRules = {
    LIMITS: LIMITS,
    INVALIDATING_FIELDS: INVALIDATING_FIELDS,
    normHeading: normHeading,
    angleBetween: angleBetween,
    geometry: geometry,
    spacing: spacing,
    overlapRate: overlapRate,
    headingsAlternate: headingsAlternate,
    codeSeq: codeSeq,
    sortLines: sortLines,
    nextCode: nextCode,
    evaluatePair: evaluatePair,
    evaluate: evaluate,
    fingerprint: fingerprint,
    validateLine: validateLine,
    formatDateTime: formatDateTime,
    round2: round2
  };
})(window);
