/*
 * store.js —— 持久化 + 提交层
 *
 *  - 全部数据落 localStorage，刷新后状态一致；
 *  - 测线按 code 唯一：重复或并发提交沿用首次结果（同一 in-flight Promise，先到先得）；
 *  - 修改坐标/航向/测宽/拍照间隔后即时重算准入结论；
 *  - 只有准入通过才生成成果版本；待补测绝不占用通过版本号；
 *  - 成果是冻结快照，修改数据后旧成果只读保留。
 */
(function (global) {
  "use strict";

  var KEY = "zfl30Survey.v1";
  var state = null;
  var lineInflight = Object.create(null); // 并发登记：按 code 合并
  var resultInflight = false;            // 并发成果生成：沿用首次

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  function deepFreeze(v) {
    if (v && typeof v === "object") {
      Object.getOwnPropertyNames(v).forEach(function (k) { deepFreeze(v[k]); });
      Object.freeze(v);
    }
    return v;
  }

  function stamp() { return new Date().toISOString(); }

  function seed() {
    // 三条示例测线：覆盖率 40%（落在 30~50%），航向 0/180/0 交替，首次即可通过
    return {
      lines: [
        { id: uid(), code: "L-01", diver: "陈屿", start: { x: 20, y: 24 }, end: { x: 20, y: 76 }, heading: 180, width: 10, interval: 4, createdAt: stamp() },
        { id: uid(), code: "L-02", diver: "林潮", start: { x: 26, y: 76 }, end: { x: 26, y: 24 }, heading: 0, width: 10, interval: 4, createdAt: stamp() },
        { id: uid(), code: "L-03", diver: "苏潜", start: { x: 32, y: 24 }, end: { x: 32, y: 76 }, heading: 180, width: 10, interval: 4, createdAt: stamp() }
      ],
      results: [] // 首次打开无历史成果，由“生成成果”产生 V1
    };
  }

  function load() {
    if (state) return state;
    try {
      var raw = localStorage.getItem(KEY);
      state = raw ? JSON.parse(raw) : seed();
    } catch (e) {
      state = seed();
    }
    if (!state.lines) state.lines = [];
    if (!state.results) state.results = [];
    return state;
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function recompute() {
    state.assessment = Rules.evaluate(state.lines);
    state.fingerprint = Rules.fingerprint(state.lines);
  }

  function init() { load(); recompute(); }

  function publicLine(l) {
    return {
      id: l.id, code: l.code, diver: l.diver,
      start: deepClone(l.start), end: deepClone(l.end),
      heading: l.heading, width: l.width, interval: l.interval,
      createdAt: l.createdAt, updatedAt: l.updatedAt
    };
  }

  function getLines() { return Rules.orderLines(state.lines).map(publicLine); }

  function getAssessment() {
    return {
      eligible: state.assessment.eligible,
      reasons: state.assessment.reasons.slice(),
      pairs: state.assessment.pairs.map(deepClone),
      fingerprint: state.fingerprint
    };
  }

  function findByCode(code) {
    return state.lines.filter(function (l) { return l.code === code; })[0] || null;
  }

  function findById(id) {
    return state.lines.filter(function (l) { return l.id === id; })[0] || null;
  }

  /*
   * 登记 / 修改测线。
   * data.id 存在 = 修改已有测线；否则按 code 新建。
   * 同一 code 的重复提交（含并发）直接沿用首次那次的 Promise 与结果。
   */
  function submitLine(data) {
    var target = data.id ? findById(data.id) : null;
    var lockCode = target ? target.code : data.code;

    if (lineInflight[lockCode]) {
      // 并发提交：直接沿用首次那次的结果
      return lineInflight[lockCode].then(function (first) {
        return { status: "deduplicated", line: first.line };
      });
    }

    var p = new Promise(function (resolve) {
      // 模拟网络/计算窗口：并发提交会落在同一个 Promise 上
      setTimeout(function () {
        var s = load();
        if (target) {
          target.diver = data.diver;
          target.start = deepClone(data.start);
          target.end = deepClone(data.end);
          target.heading = data.heading;
          target.width = data.width;
          target.interval = data.interval;
          target.updatedAt = stamp();
          persist(); recompute();
          resolve({ status: "ok", line: publicLine(target) });
        } else {
          var first = findByCode(data.code);
          if (first) {
            resolve({ status: "deduplicated", line: publicLine(first) }); // 重复提交：沿用首次结果
          } else {
            var line = {
              id: uid(), code: data.code, diver: data.diver,
              start: deepClone(data.start), end: deepClone(data.end),
              heading: data.heading, width: data.width, interval: data.interval,
              createdAt: stamp()
            };
            s.lines.push(line);
            persist(); recompute();
            resolve({ status: "ok", line: publicLine(line) });
          }
        }
      }, 120);
    });

    lineInflight[lockCode] = p;
    p.then(function () { delete lineInflight[lockCode]; });
    return p;
  }

  function deleteLine(id) {
    var s = load();
    s.lines = s.lines.filter(function (l) { return l.id !== id; });
    persist(); recompute();
  }

  function nextVersion() {
    var max = 0;
    state.results.forEach(function (r) { if (r.version > max) max = r.version; });
    return max + 1;
  }

  function publicResult(r) {
    return deepFreeze(deepClone(r));
  }

  function getResults() {
    return state.results.map(publicResult).sort(function (a, b) { return b.version - a.version; });
  }

  /*
   * 生成拼图成果。
   *  - 准入不通过 → 返回“待补测”，不落库、不生成成果、不占用版本号；
   *  - 当前指纹已有通过成果 → 沿用首次成果（重复/并发同理），不重复占版本；
   *  - 通过 → 生成冻结的只读成果快照 V1/V2/…。
   */
  function generateResult() {
    if (resultInflight) return resultInflight;

    resultInflight = new Promise(function (resolve) {
      setTimeout(function () {
        var s = load();
        var existing = s.results.filter(function (r) { return r.fingerprint === state.fingerprint; })[0];
        if (existing) {
          resultInflight = false;
          resolve({ status: "deduplicated", result: publicResult(existing) });
          return;
        }
        if (!state.assessment.eligible) {
          resultInflight = false;
          resolve({ status: "pending-survey", reasons: state.assessment.reasons.slice() });
          return;
        }
        var result = deepFreeze({
          version: nextVersion(),
          createdAt: stamp(),
          fingerprint: state.fingerprint,
          eligibility: {
            minCoverage: Rules.LIMITS.MIN_COVERAGE,
            maxCoverage: Rules.LIMITS.MAX_COVERAGE,
            headingTolerance: Rules.LIMITS.HEADING_TOLERANCE
          },
          lines: Rules.orderLines(state.lines).map(publicLine),
          pairs: state.assessment.pairs.map(deepClone)
        });
        s.results.push(deepClone(result));
        persist();
        resultInflight = false;
        resolve({ status: "approved", result: publicResult(result) });
      }, 160);
    });

    return resultInflight;
  }

  global.Store = {
    init: init,
    getLines: getLines,
    getAssessment: getAssessment,
    getResults: getResults,
    submitLine: submitLine,
    deleteLine: deleteLine,
    generateResult: generateResult
  };
})(window);
