/*
 * survey-store.js —— 持久化与提交幂等
 * 负责：测线登记/修改/删除、localStorage 持久化、拼图成果版本归档、
 *       旧成果只读保留、同指纹重复/并发提交沿用首次结果。
 */
(function (global) {
  "use strict";

  var Rules = global.SurveyRules;
  var KEY = "zfl30SurveyConsole.v1";
  var SUBMIT_DELAY = 600; // 模拟拼图服务的处理耗时，用于体现并发合并

  // file:// 等场景 localStorage 可能被禁用，用内存兜底保证列表/地图/刷新状态仍一致
  var memoryFallback = {};
  var storageOK = (function () {
    try {
      var k = "__zfl30test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();
  function storage() { return storageOK ? localStorage : {
    getItem: function (k) { return k in memoryFallback ? memoryFallback[k] : null; },
    setItem: function (k, v) { memoryFallback[k] = String(v); },
    removeItem: function (k) { delete memoryFallback[k]; }
  }; }

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") return global.crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function seedLines() {
    // 4 条南北向测线：间距 20m、测宽 40m => 覆盖率 50%（处于合格闭区间），航向 90/270 交替
    return [
      { id: uuid(), code: "L-01", diver: "林启", start: { e: 20, n: 6 }, end: { e: 20, n: 82 }, heading: 0, width: 40, interval: 3 },
      { id: uuid(), code: "L-02", diver: "周澜", start: { e: 40, n: 82 }, end: { e: 40, n: 6 }, heading: 180, width: 40, interval: 3 },
      { id: uuid(), code: "L-03", diver: "林启", start: { e: 60, n: 6 }, end: { e: 60, n: 82 }, heading: 0, width: 40, interval: 3 },
      { id: uuid(), code: "L-04", diver: "陈屿", start: { e: 80, n: 82 }, end: { e: 80, n: 6 }, heading: 180, width: 40, interval: 3 }
    ];
  }

  // 初始归档一个已通过的旧版本（旧测宽 32m，指纹与现状不同），演示"旧成果只读"
  function seedResult(lines) {
    var oldLines = lines.map(function (l) {
      var c = JSON.parse(JSON.stringify(l));
      c.width = 32;
      return c;
    });
    var ev = Rules.evaluate(oldLines);
    return {
      version: 1,
      status: "passed",
      createdAt: "2026-09-15T09:12:00",
      fp: Rules.fingerprint(oldLines),
      lines: oldLines,
      pairs: ev.pairs,
      reasons: ev.reasons,
      readOnly: true
    };
  }

  function defaultState() {
    var lines = seedLines();
    return {
      lines: lines,
      results: [seedResult(lines)],
      attempts: {}, // 指纹 -> 首次提交结果（含待补测），重复提交沿用
      nextVersion: 2,
      bounds: { e: 100, n: 100 }
    };
  }

  function load() {
    try {
      var raw = storage().getItem(KEY);
      if (raw) {
        var st = JSON.parse(raw);
        if (st && Array.isArray(st.lines) && Array.isArray(st.results)) {
          st.attempts = st.attempts || {};
          st.nextVersion = st.nextVersion || (st.results.length + 1);
          st.bounds = st.bounds || { e: 100, n: 100 };
          return st;
        }
      }
    } catch (e) { /* 数据损坏则重建 */ }
    var fresh = defaultState();
    persist(fresh);
    return fresh;
  }

  function persist(state) {
    storage().setItem(KEY, JSON.stringify(state));
  }

  var state = load();

  // 轻量发布订阅：列表、测线图、状态面板刷新后保持一致
  var listeners = [];
  function emit(type) {
    var snapshot = exportJSON();
    listeners.forEach(function (fn) { fn(type, snapshot); });
  }

  function normalize(raw) {
    return {
      id: raw.id || uuid(),
      code: String(raw.code).trim().toUpperCase(),
      diver: String(raw.diver || "").trim(),
      start: { e: Number(raw.start.e), n: Number(raw.start.n) },
      end: { e: Number(raw.end.e), n: Number(raw.end.n) },
      heading: Rules.normHeading(raw.heading),
      width: Number(raw.width),
      interval: Number(raw.interval)
    };
  }

  function findIndex(id) {
    for (var i = 0; i < state.lines.length; i++) if (state.lines[i].id === id) return i;
    return -1;
  }
  function findLine(id) {
    var i = findIndex(id);
    return i >= 0 ? state.lines[i] : null;
  }

  function addLine(raw) {
    var used = state.lines.map(function (l) { return l.code; });
    var check = Rules.validateLine(raw, { bounds: state.bounds, usedCodes: used });
    if (check.errors.length) return { ok: false, errors: check.errors };
    var line = Object.assign(normalize(check.value), { id: uuid(), createdAt: new Date().toISOString() });
    state.lines.push(line);
    persist(state);
    emit("lines");
    return { ok: true, line: line };
  }

  function updateLine(id, raw) {
    var idx = findIndex(id);
    if (idx < 0) return { ok: false, errors: ["测线不存在"] };
    var used = state.lines.filter(function (l) { return l.id !== id; }).map(function (l) { return l.code; });
    var check = Rules.validateLine(raw, { bounds: state.bounds, usedCodes: used });
    if (check.errors.length) return { ok: false, errors: check.errors };
    var before = state.lines[idx];
    var invalidated = Rules.fingerprint([before]) !== Rules.fingerprint([check.value]);
    var updated = Object.assign({}, before, normalize(check.value), { id: id, updatedAt: new Date().toISOString() });
    state.lines[idx] = updated;
    persist(state);
    // 修改坐标/航向/测宽/拍照间隔 => 指纹变化，已通过成果与新数据不再匹配，立即按新数据重算
    emit("lines");
    return { ok: true, line: updated, invalidated: invalidated };
  }

  function removeLine(id) {
    var idx = findIndex(id);
    if (idx < 0) return { ok: false, errors: ["测线不存在"] };
    var removed = state.lines.splice(idx, 1)[0];
    persist(state);
    emit("lines");
    return { ok: true, removed: removed };
  }

  function listLines() {
    return Rules.sortLines(state.lines);
  }

  function currentEvaluation() {
    return Rules.evaluate(state.lines);
  }

  function currentFingerprint() {
    return Rules.fingerprint(state.lines);
  }

  // 找到指纹匹配的最新已通过版本（有则说明现有成果仍有效）
  function matchingPassed(fp) {
    for (var i = state.results.length - 1; i >= 0; i--) {
      if (state.results[i].status === "passed" && state.results[i].fp === fp) return state.results[i];
    }
    return null;
  }

  var inflight = {}; // 指纹 -> 进行中的提交 Promise，保证并发只跑一次

  // 拼图提交：ready 才占用版本号并生成成果；waiting 只登记为待补测。
  // 同指纹的重复提交（含并发点击）沿用首次结果。
  function submitMosaic() {
    var fp = Rules.fingerprint(state.lines);
    if (inflight[fp]) {
      // 并发提交：挂到首次提交上，沿用其结果并标记为复用
      return inflight[fp].then(function (r) { return Object.assign({}, r, { reused: true }); });
    }

    if (state.attempts[fp]) {
      var first = state.attempts[fp];
      if (first.status === "passed" && first.version) {
        var existing = state.results.find(function (r) { return r.version === first.version; });
        if (existing && existing.fp === fp) {
          return Promise.resolve({ ok: true, status: "passed", result: existing, reused: true });
        }
      }
      if (first.status === "waiting") {
        return Promise.resolve({ ok: true, status: "waiting", reused: true, reasons: first.reasons || [] });
      }
    }

    var p = new Promise(function (resolve) {
      setTimeout(function () {
        // 以提交时刻的测线为准做快照；若处理期间数据被修改，快照指纹可能过期
        var snapshot = JSON.parse(JSON.stringify(state.lines));
        var snapshotFp = Rules.fingerprint(snapshot);
        if (snapshotFp !== fp) {
          delete inflight[fp];
          resolve(submitMosaic());
          return;
        }
        var ev = Rules.evaluate(snapshot);
        if (ev.ready) {
          var existing = matchingPassed(fp);
          if (existing) {
            state.attempts[fp] = { status: "passed", version: existing.version };
            persist(state);
            delete inflight[fp];
            emit("results");
            resolve({ ok: true, status: "passed", result: existing, reused: true });
            return;
          }
          var version = state.nextVersion++;
          var result = {
            version: version,
            status: "passed",
            createdAt: new Date().toISOString(),
            fp: fp,
            lines: snapshot,
            pairs: ev.pairs,
            reasons: [],
            readOnly: true // 成果一经生成即为只读；再改数据只能重算出新版本
          };
          state.results.push(result);
          state.attempts[fp] = { status: "passed", version: version };
          persist(state);
          delete inflight[fp];
          emit("results");
          resolve({ ok: true, status: "passed", result: result, reused: false });
        } else {
          // 待补测不占用版本号，也不生成可导出成果
          state.attempts[fp] = {
            status: "waiting",
            at: new Date().toISOString(),
            reasons: ev.reasons,
            pairs: ev.pairs
          };
          persist(state);
          delete inflight[fp];
          emit("results");
          resolve({ ok: true, status: "waiting", reused: false, reasons: ev.reasons, pairs: ev.pairs });
        }
      }, SUBMIT_DELAY);
    });
    inflight[fp] = p;
    return p;
  }

  function listResults() {
    return state.results.slice().sort(function (a, b) { return b.version - a.version; });
  }
  function getResult(version) {
    return state.results.find(function (r) { return r.version === version; }) || null;
  }

  // 成果导出数据（仅导出已通过、与版本绑定的只读快照）
  function resultExport(version) {
    var r = getResult(version);
    if (!r || r.status !== "passed") return null;
    return {
      version: "v" + r.version,
      status: "passed",
      generatedAt: r.createdAt,
      readOnly: true,
      lines: r.lines,
      pairs: r.pairs.map(function (p) {
        return { pair: p.label, overlap: p.rateText, headingAlternated: p.alternate, pass: p.pass };
      })
    };
  }

  function setBounds(bounds) {
    state.bounds = { e: Math.max(1, Number(bounds.e) || 100), n: Math.max(1, Number(bounds.n) || 100) };
    persist(state);
  }

  function exportJSON() {
    return {
      lines: Rules.sortLines(state.lines),
      results: state.results.map(function (r) { return r; }),
      bounds: { e: state.bounds.e, n: state.bounds.n },
      evaluation: currentEvaluation(),
      fingerprint: currentFingerprint()
    };
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) { return f !== fn; });
    };
  }

  function reset() { // 测试用
    state = defaultState();
    persist(state);
    emit("reset");
  }

  global.SurveyStore = {
    addLine: addLine,
    updateLine: updateLine,
    removeLine: removeLine,
    listLines: listLines,
    findLine: findLine,
    currentEvaluation: currentEvaluation,
    currentFingerprint: currentFingerprint,
    matchingPassed: matchingPassed,
    submitMosaic: submitMosaic,
    listResults: listResults,
    getResult: getResult,
    resultExport: resultExport,
    setBounds: setBounds,
    exportJSON: exportJSON,
    subscribe: subscribe,
    reset: reset
  };
})(window);
