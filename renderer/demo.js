/*
 * demo.js — 浏览器演示模式：没有 Electron 环境时（如直接用浏览器打开
 * 页面调试），用模拟数据代替数据库，便于预览界面与图表效果。
 * 在 Electron 中运行时本文件不做任何事（window.api 已由 preload 注入）。
 */
(function () {
  'use strict';
  if (window.api) return; // 真实 Electron 环境

  /* ---------- 确定性随机 ---------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260927);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = arr => arr[Math.floor(rnd() * arr.length)];

  /* ---------- 生成与 fire 表结构一致的模拟数据 ---------- */
  const N = 4000;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const year = ri(2000, 2026);
    const monthW = pick([3, 3, 3, 4, 4, 4, 4, 5, 5, 2, 12, 1, 11]);
    const elevation = Math.round(80 + Math.pow(rnd(), 1.8) * 5400);
    const conf = pick(['conf30', 'conf30', 'conf30', 'conf50', 'conf50', 'conf70', 'conf80', 'conf85']);
    const doy = Math.min(365, Math.round((monthW - 1) * 30.4 + ri(1, 30)));
    const date = `${year}-${String(monthW).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`;
    rows.push({
      conf,
      fid: i + 1,
      LATITUDE: Math.round((26 + rnd() * 8) * 10000) / 10000,
      LONGITUDE: Math.round((75 + rnd() * 15) * 10000) / 10000,
      BRIGHTNESS: Math.round((300 + rnd() * 60) * 10) / 10,
      SCAN: Math.round(rnd() * 3 * 10) / 10,
      TRACK: Math.round(rnd() * 3 * 10) / 10,
      ACQ_DATE: date + 'T00:00:00.000',
      ACQ_TIME: String(ri(0, 2359)).padStart(4, '0'),
      SATELLITE: rnd() < 0.62 ? 'Aqua' : 'Terra',
      INSTRUMENT: 'MODIS',
      CONFIDENCE: ri(0, 100),
      VERSION: rnd() < 0.87 ? '6.03' : '61.03',
      BRIGHT_T31: Math.round((280 + rnd() * 50) * 10) / 10,
      FRP: Math.round(Math.pow(rnd(), 3) * 200 * 10) / 10,
      DAYNIGHT: rnd() < 0.79 ? 'D' : 'N',
      TYPE: rnd() < 0.98 ? 0 : 2,
      year, month: monthW, date, doy,
      lai: Math.round(rnd() * 5 * 1000) / 1000,
      ndvi: Math.round(rnd() * 0.9 * 1000) / 1000,
      aspect: ri(0, 359),
      slope: Math.round(rnd() * 60 * 10) / 10,
      elevation,
      burn: rnd() < 0.1 ? 1 : 0,
      lt_other: Math.round(rnd() * 100) / 100,
      lt_forest: Math.round(rnd() * 100) / 100,
      lt_shrub: Math.round(rnd() * 100) / 100,
      lt_grass: Math.round(rnd() * 100) / 100,
      lt_cropland: Math.round(rnd() * 100) / 100,
      lt_1: Math.round(rnd() * 100) / 100
    });
  }

  const COLS = Object.keys(rows[0]).map(name => {
    const v0 = rows[0][name];
    let kind = typeof v0 === 'number' ? 'number' : 'string';
    if (kind === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v0)) kind = 'date';
    const col = { name, declType: kind === 'number' ? 'REAL' : 'TEXT', kind };
    if (kind === 'number') {
      const distinct = [...new Set(rows.map(r => r[name]))];
      if (distinct.length <= 12) { col.kind = 'enum-number'; col.distinct = distinct.sort((a, b) => a - b); }
      else { col.min = Math.min(...distinct); col.max = Math.max(...distinct); }
    } else {
      const distinct = [...new Set(rows.map(r => String(r[name])))];
      if (kind !== 'date' && distinct.length <= 80) { col.kind = 'enum'; col.distinct = distinct.sort(); }
    }
    return col;
  });

  function match(row, f) {
    const v = row[f.col];
    if (f.op === 'in') {
      const set = new Set(f.values.map(String));
      return set.has(String(v));
    }
    if (f.op === 'like') return String(v ?? '').includes(f.value);
    if (f.op === 'between') {
      const [a, b] = f.values || [];
      const num = f.numeric;
      const av = num ? Number(a) : a, bv = num ? Number(b) : b;
      const vv = num ? Number(v) : v;
      if (a !== '' && a != null && !(vv >= av)) return false;
      if (b !== '' && b != null) {
        if (num) { if (!(vv <= bv)) return false; }
        else { const next = new Date(b); next.setDate(next.getDate() + 1); if (!(new Date(v) < next)) return false; }
      }
      return true;
    }
    return true;
  }

  /* embedded 配置：优先 fetch 真实 config.json */
  const FALLBACK_CONFIG = {
    fieldLabels: { year: '年份', elevation: '海拔', conf: '火点置信等级', DAYNIGHT: '昼夜', SATELLITE: '卫星', FRP: '火点功率FRP', ndvi: '植被指数NDVI', month: '月份', BRIGHTNESS: '辐射亮度', BRIGHT_T31: '亮温T31', lt_forest: '土地覆盖-森林' },
    chartPresets: [
      { id: 'year-count-line', name: '逐年火点数量趋势（折线）', table: '*', type: 'line', x: 'year', agg: 'count', sort: 'x-asc', title: '逐年火点数量趋势（演示数据）' },
      { id: 'year-elev-heat', name: '年份×海拔 火点密度（热力图）', table: '*', type: 'heatmap', x: 'year', y: 'elevation', yBins: 14, agg: 'count', title: '年份×海拔 火点密度（演示数据）' }
    ]
  };

  /* ---------- 查询视图支持：浏览器里用 sql.js 构建内存库，完整走一遍视图 SQL ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('脚本加载失败: ' + src));
      document.head.appendChild(s);
    });
  }

  let demoDb = null;
  async function ensureDemoDb() {
    if (demoDb) return demoDb;
    await loadScript('../node_modules/sql.js/dist/sql-wasm.js');
    const SQL = await window.initSqlJs({ locateFile: f => '../node_modules/sql.js/dist/' + f });
    demoDb = new SQL.Database();
    demoDb.run(`CREATE TABLE fire (${COLS.map(c => `"${c.name}" ${c.declType || 'TEXT'}`).join(',')})`);
    const placeholders = `(${COLS.map(() => '?').join(',')})`;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      demoDb.run(
        `INSERT INTO fire VALUES ${chunk.map(() => placeholders).join(',')}`,
        chunk.flatMap(r => COLS.map(c => r[c.name]))
      );
    }
    return demoDb;
  }

  function qAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }
  function qOne(db, sql, params = []) { return qAll(db, sql, params)[0] || null; }

  async function demoRunView(args) {
    try {
      const db = await ensureDemoDb();
      const built = QueryView.buildViewSql(args.sql, args.params || {});
      const cap = Math.min(Math.max(Number(args.limit) || 20000, 1), 100000);
      const lsql = QueryView.appendLimit(built.sql, cap);
      const total = qOne(db, QueryView.countWrap(built.sql), built.params).c;
      const out = qAll(db, lsql, built.params);
      let columns = out[0] ? Object.keys(out[0]) : [];
      const stmt = db.prepare(lsql);
      try { if (stmt.getColumnNames) columns = stmt.getColumnNames(); } catch (_) { /* 首行 key 兜底 */ } finally { stmt.free(); }
      return { total, rows: out, columns, limited: total > out.length };
    } catch (err) {
      return { error: err.message };
    }
  }

  window.api = {
    demo: true,
    async loadConfig() {
      try {
        const r = await fetch('../config.json');
        if (r.ok) return await r.json();
      } catch (e) { /* file:// 或无配置时用内置 */ }
      return FALLBACK_CONFIG;
    },
    async listTables() { return { tables: [{ name: 'fire', rows: rows.length }] }; },
    async getSchema() { return { total: rows.length, columns: COLS }; },
    async query(args) {
      const filters = args.filters || [];
      const out = rows.filter(r => filters.every(f => match(r, f)));
      const limit = Math.min(Number(args.limit) || 20000, 100000);
      return { total: out.length, rows: out.slice(0, limit), limited: out.length > limit };
    },
    async queryView(args) { return demoRunView(args); },
    async exportView() { return { ok: false, error: '演示模式不支持导出' }; },
    async exportFull() { return { ok: false, error: '演示模式不支持导出' }; },
    async exportSheets() { return { ok: false, error: '演示模式不支持导出' }; },
    async pickDbFile() { return { canceled: true }; },
    async pickViewFile() { return { canceled: true }; }
  };
})();
