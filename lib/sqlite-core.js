/* lib/sqlite-core.js — SQLite 读取/过滤/结构推断的纯逻辑层。
 * Electron 主进程与 Node 测试脚本共用，保证行为一致。 */
const initSqlJs = require('sql.js');

let SQLP = null;
function getSQL() {
  if (!SQLP) SQLP = initSqlJs();
  return SQLP;
}

/* 按路径缓存已打开的库（大文件加载约 1~2 秒） */
function createEngine() {
  let cachedDb = { path: null, db: null };
  return {
    async getDb(filePath) {
      if (cachedDb.path === filePath && cachedDb.db) return cachedDb.db;
      const SQL = await getSQL();
      const fs = require('fs');
      const buf = fs.readFileSync(filePath);
      const db = new SQL.Database(new Uint8Array(buf));
      if (cachedDb.db) { try { cachedDb.db.close(); } catch (_) { /* ignore */ } }
      cachedDb = { path: filePath, db };
      return db;
    }
  };
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
function qOne(db, sql, params = []) {
  const r = qAll(db, sql, params);
  return r[0] || null;
}
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/* ---------------- 字段类型推断 ---------------- */
const NUMERIC_DECL = /(INT|REAL|FLOA|DOUB|DEC|NUM)/i;
const DATE_DECL = /(DATE|TIME)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const MAX_ENUM = 80;          // 字符串字段枚举值上限
const MAX_ENUM_NUM = 12;      // 数值字段按枚举处理的上限

/* 两阶段：先按 10 段采样初判类型与候选枚举列，
 * 再对候选列用 SELECT DISTINCT 取全量枚举值（保证过滤选项完整）。 */
const SAMPLE_N = 150;         // 每段采样行数
const MAX_VERIFY = 15;        // 最多精确验证的枚举候选列数

function inferSchema(db, table) {
  const ti = qAll(db, `PRAGMA table_info(${quoteIdent(table)})`);
  const total = qOne(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).c;
  const t = quoteIdent(table);
  const sample = [];
  const step = Math.max(1, Math.floor((total - SAMPLE_N) / 9));
  const offsets = new Set();
  for (let i = 0; i < 10; i++) offsets.add(total > SAMPLE_N ? Math.min(total - SAMPLE_N, i * step) : 0);
  for (const off of offsets) {
    sample.push(...qAll(db, `SELECT * FROM ${t} LIMIT ${SAMPLE_N} OFFSET ${off}`));
  }

  const columns = ti.filter(c => c.name).map(c => {
    const name = c.name;
    const decl = c.type || '';
    let kind;
    if (DATE_DECL.test(decl)) kind = 'date';
    else if (NUMERIC_DECL.test(decl)) kind = 'number';
    else if (decl && /TEXT|CHAR|CLOB/i.test(decl)) kind = 'string';
    else {
      const vals = sample.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
      const nums = vals.filter(v => (typeof v === 'number' && isFinite(v)) ||
        (typeof v === 'string' && !DATE_RE.test(v) && v.trim() !== '' && isFinite(Number(v))));
      kind = vals.length && nums.length / vals.length > 0.9 ? 'number' : 'string';
    }

    const col = { name, declType: decl, kind };
    const sampled = [...new Set(sample.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== ''))];

    if (kind === 'number') {
      const nums = sampled.filter(v => isFinite(Number(v))).map(Number);
      if (nums.length && nums.length <= MAX_ENUM_NUM) col._candidate = true;
      if (nums.length) { col.min = Math.min(...nums); col.max = Math.max(...nums); }
    } else if (col.kind === 'string') {
      const strs = [...new Set(sampled.map(String))];
      if (strs.length && strs.every(v => DATE_RE.test(v))) col.kind = 'date';
      else if (strs.length <= MAX_ENUM) col._candidate = true;
      else col.distinctCount = strs.length;
    }
    return col;
  });

  // 第二阶段：候选列精确取全量枚举值
  const candidates = columns.filter(c => c._candidate).slice(0, MAX_VERIFY);
  for (const col of candidates) {
    const vals = qAll(db, `SELECT DISTINCT ${quoteIdent(col.name)} FROM ${t}`)
      .map(r => r[col.name])
      .filter(v => v !== null && v !== undefined && v !== '');
    if (col.kind === 'number') {
      const nums = [...new Set(vals.map(Number))].sort((a, b) => a - b);
      if (nums.length <= MAX_ENUM_NUM) {
        col.kind = 'enum-number';
        col.distinct = nums;
        col.min = nums[0];
        col.max = nums[nums.length - 1];
      }
    } else if (vals.length <= MAX_ENUM) {
      col.kind = 'enum';
      col.distinct = vals.map(String).sort();
    } else {
      col.distinctCount = vals.length;
    }
    delete col._candidate;
  }

  return { total, columns };
}

/* ---------------- 过滤条件 -> SQL WHERE ---------------- */
function buildWhere(filters) {
  const clauses = [];
  const params = [];
  for (const f of filters || []) {
    if (!f || !f.col) continue;
    const col = quoteIdent(f.col);
    if (f.op === 'in' && Array.isArray(f.values) && f.values.length) {
      clauses.push(`${col} IN (${f.values.map(() => '?').join(',')})`);
      for (const v of f.values) params.push(f.numeric ? Number(v) : v);
    } else if (f.op === 'like' && f.value) {
      clauses.push(`${col} LIKE ?`);
      params.push(`%${f.value}%`);
    } else if (f.op === 'between') {
      const [a, b] = f.values || [];
      if (a !== '' && a != null) {
        clauses.push(`${col} >= ?`);
        params.push(f.numeric ? Number(a) : a);
      }
      if (b !== '' && b != null) {
        // date 用 < (b + 1 day)，兼容 '2024-01-31' 与 '2024-01-31T00:00:00' 两种存储
        clauses.push(f.numeric ? `${col} <= ?` : `${col} < date(?, '+1 day')`);
        params.push(f.numeric ? Number(b) : b);
      }
    }
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

/* 分页抽样查询：数据量超过 limit 时按 rowid 等间隔抽样，
 * 保证排序存储的表（如按年份）各处数据都能进入图表。 */
function sampleQuery(db, table, filters, limit) {
  const t = quoteIdent(table);
  const { where, params } = buildWhere(filters);
  const cap = Math.min(Number(limit) || 20000, 100000);
  const total = qOne(db, `SELECT COUNT(*) AS c FROM ${t} ${where}`, params).c;
  if (total <= cap) {
    return { total, rows: qAll(db, `SELECT * FROM ${t} ${where} LIMIT ${cap}`, params), limited: false };
  }
  const k = Math.max(2, Math.floor(total / cap));
  try {
    const rows = qAll(db,
      `SELECT * FROM ${t} ${where ? where + ' AND' : 'WHERE'} (rowid % ${k}) = 0 LIMIT ${cap}`, params);
    if (rows.length) return { total, rows, limited: true };
  } catch (_) { /* 无 rowid 的表退回顺序取前 N 行 */ }
  return { total, rows: qAll(db, `SELECT * FROM ${t} ${where} LIMIT ${cap}`, params), limited: true };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = { getSQL, createEngine, qAll, qOne, quoteIdent, inferSchema, buildWhere, sampleQuery, csvCell };
