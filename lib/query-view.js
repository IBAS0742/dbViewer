/* lib/query-view.js — 查询视图（.view.json）的纯逻辑层：
 * 规范校验、SQL 参数扫描与绑定（:name -> ? 占位）、行数/上限包装、
 * 结果列类型推断。Electron 主进程、渲染进程（UMD）、测试脚本共用，
 * 保证发布者校验器（scripts/validate-view.js）与应用运行行为一致。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.QueryView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'dbchart-query-view';
  const VERSION = 1;
  const PARAM_TYPES = ['number', 'text', 'date', 'select'];
  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

  /* ---------------- SQL 扫描 ----------------
   * 跳过字符串字面量、引号/方括号标识符与注释，只收集引号外的
   * :name / @name / $name 命名参数与语句分隔符，供绑定与校验使用。 */
  function scanSql(sql) {
    const tokens = [];
    const semicolons = [];
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const c = sql[i];
      if (c === "'" || c === '"' || c === '`') {
        const q = c;
        i++;
        while (i < n) {
          if (sql[i] === q) {
            if (sql[i + 1] === q) { i += 2; continue; } // '' 转义
            i++;
            break;
          }
          i++;
        }
      } else if (c === '[') {
        i++;
        while (i < n && sql[i] !== ']') i++;
        i++;
      } else if (c === '-' && sql[i + 1] === '-') {
        while (i < n && sql[i] !== '\n') i++;
      } else if (c === '/' && sql[i + 1] === '*') {
        i += 2;
        while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 2;
      } else if (c === ';') {
        semicolons.push(i);
        i++;
      } else if ((c === ':' || c === '@' || c === '$') && sql[i + 1] === c) {
        i += 2; // ::（类型转换等）不是命名参数
      } else if (c === ':' || c === '@' || c === '$') {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
        if (m) {
          tokens.push({ name: m[0], start: i, end: i + 1 + m[0].length });
          i += 1 + m[0].length;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    return { tokens, semicolons };
  }

  function extractParamNames(sql) {
    return [...new Set(scanSql(sql).tokens.map(t => t.name))];
  }

  function stripOuter(sql) {
    return String(sql || '').trim().replace(/;+\s*$/, '');
  }

  function isReadOnlySelect(sql) {
    return /^\s*(SELECT|WITH)\b/i.test(stripOuter(sql));
  }

  function hasMultipleStatements(sql) {
    return scanSql(stripOuter(sql)).semicolons.length > 0;
  }

  /* 命名参数 -> 位置参数。数组值展开为 IN 列表（同名的所有出现位置展开一致，
   * 空数组/null 绑定为 NULL，配合 (:p IS NULL OR col IN (:p)) 写法即「不限」）。
   * 写成 IN (:p) 时外层已有括号则不再包裹，写成 IN :p 也一样能展开。 */
  function buildViewSql(sql, values) {
    const s = stripOuter(sql);
    const { tokens } = scanSql(s);
    if (!tokens.length) return { sql: s, params: [] };
    const parts = [];
    const params = [];
    let last = s.length;
    for (let k = tokens.length - 1; k >= 0; k--) {
      const t = tokens[k];
      parts.unshift(s.slice(t.end, last));
      last = t.start;
      if (!values || values[t.name] === undefined) {
        throw new Error(`SQL 中的参数 :${t.name} 没有对应的值（请在 params 中定义并提供）`);
      }
      const v = values[t.name];
      const hasOwnParens = s[t.start - 1] === '(' && s[t.end] === ')';
      if (Array.isArray(v) && v.length) {
        const list = v.map(() => '?').join(',');
        parts.unshift(hasOwnParens ? list : `(${list})`);
        params.unshift(...v);
      } else {
        parts.unshift('?');
        params.unshift(Array.isArray(v) ? null : v);
      }
    }
    parts.unshift(s.slice(0, last));
    return { sql: parts.join(''), params };
  }

  /* 应用层行数上限：SQL 自带 LIMIT/OFFSET（含参数形式）结尾时不再追加 */
  const TAIL_VALUE = '(?:\\d+|:?[A-Za-z_][A-Za-z0-9_]*)';
  const TRAILING_LIMIT_RE = new RegExp(`\\bLIMIT\\s+${TAIL_VALUE}\\s*(OFFSET\\s+${TAIL_VALUE}\\s*)?$`, 'i');

  function appendLimit(sql, limit) {
    const s = stripOuter(sql);
    if (TRAILING_LIMIT_RE.test(s)) return s;
    return `${s} LIMIT ${limit}`;
  }

  function countWrap(sql) {
    return `SELECT COUNT(*) AS c FROM (${stripOuter(sql)})`;
  }

  /* ---------------- 规范校验 ---------------- */

  function normalizeDisplayColumns(cols) {
    return (cols || []).map(c => {
      if (typeof c === 'string') return { key: c };
      if (c && typeof c === 'object' && c.key !== undefined) {
        return { key: String(c.key), label: c.label === undefined ? undefined : String(c.label) };
      }
      return { key: String(c && c.key), label: undefined };
    });
  }

  /* opts.chartTypes 可传 ChartBuilder.CHART_TYPES，用于校验 display.chart.type */
  function validateViewSpec(spec, opts) {
    const errors = [];
    const warnings = [];
    const chartTypes = opts && opts.chartTypes;

    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, errors: ['视图文件内容不是 JSON 对象'], warnings, spec: null };
    }
    if (spec.format !== FORMAT) errors.push(`format 必须是 "${FORMAT}"`);
    if (spec.version !== VERSION) errors.push(`version 必须是 ${VERSION}`);
    if (!spec.name || typeof spec.name !== 'string' || !spec.name.trim()) {
      errors.push('缺少 name（视图显示名）');
    }

    const sql = typeof spec.sql === 'string' ? spec.sql : '';
    if (!sql.trim()) {
      errors.push('缺少 sql（单条 SELECT 查询语句）');
    } else {
      if (!isReadOnlySelect(sql)) errors.push('sql 只允许单条 SELECT（或 WITH ... SELECT）查询语句');
      if (hasMultipleStatements(sql)) errors.push('sql 中不允许出现多个语句（多余的分号 ;）');
    }

    const params = Array.isArray(spec.params) ? spec.params : [];
    if (spec.params !== undefined && !Array.isArray(spec.params)) errors.push('params 必须是数组');
    const seen = new Set();
    for (const p of params) {
      const at = `params[${p && p.key !== undefined ? JSON.stringify(p.key) : '?'}]`;
      if (!p || typeof p !== 'object') { errors.push(`${at} 不是对象`); continue; }
      if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) {
        errors.push(`${at}.key 非法（字母/下划线开头，仅字母数字下划线）`);
        continue;
      }
      if (seen.has(p.key)) errors.push(`${at} 的 key 重复`);
      seen.add(p.key);
      if (p.type !== undefined && !PARAM_TYPES.includes(p.type)) {
        errors.push(`${at}.type 只支持 ${PARAM_TYPES.join(' / ')}`);
      }
      const type = p.type || 'text';
      if (type === 'select') {
        if (!Array.isArray(p.options) || !p.options.length) {
          errors.push(`${at} 是 select 类型，options 不能为空`);
        } else {
          for (const o of p.options) {
            const v = o && typeof o === 'object' ? o.value : o;
            if (v === undefined) { errors.push(`${at}.options 每项需为值或 {value,label}`); break; }
          }
        }
      }
      if (p.multiple !== undefined && p.multiple !== false && type !== 'select') {
        errors.push(`${at}.multiple 只有 select 类型支持`);
      }
      if (p.default !== undefined && p.default !== null && p.default !== '') {
        if (type === 'number') {
          const d = Number(p.default);
          if (!isFinite(d)) errors.push(`${at}.default 不是有效数字`);
          else {
            if (p.min !== undefined && isFinite(Number(p.min)) && d < Number(p.min)) errors.push(`${at}.default 小于 min`);
            if (p.max !== undefined && isFinite(Number(p.max)) && d > Number(p.max)) errors.push(`${at}.default 大于 max`);
          }
        } else if (type === 'date' && !DATE_RE.test(String(p.default))) {
          errors.push(`${at}.default 需为 YYYY-MM-DD 格式`);
        }
      }
    }

    let tokenNames = [];
    if (sql.trim()) {
      tokenNames = extractParamNames(sql);
      for (const t of tokenNames) {
        if (!seen.has(t)) errors.push(`sql 使用了参数 :${t}，但 params 中没有定义`);
      }
      for (const k of seen) {
        if (!tokenNames.includes(k)) warnings.push(`参数 ${k} 在 sql 中未被使用`);
      }
    }

    let display = null;
    if (spec.display !== undefined && spec.display !== null) {
      if (typeof spec.display !== 'object' || Array.isArray(spec.display)) {
        errors.push('display 必须是对象');
      } else {
        display = {};
        if (spec.display.columns !== undefined) {
          if (!Array.isArray(spec.display.columns)) errors.push('display.columns 必须是数组');
          else display.columns = normalizeDisplayColumns(spec.display.columns);
        }
        if (spec.display.chart !== undefined) {
          const c = spec.display.chart;
          if (!c || typeof c !== 'object' || Array.isArray(c)) {
            errors.push('display.chart 必须是对象');
          } else {
            display.chart = c;
            if (chartTypes && c.type && !chartTypes.some(t => t.type === c.type)) {
              errors.push(`display.chart.type "${c.type}" 不是支持的图表类型`);
            }
          }
        }
      }
    }

    const ok = errors.length === 0;
    return {
      ok,
      errors,
      warnings,
      spec: ok ? {
        format: FORMAT,
        version: VERSION,
        id: (spec.id !== undefined ? String(spec.id) : String(spec.name).trim()),
        name: String(spec.name).trim(),
        description: spec.description ? String(spec.description) : '',
        author: spec.author ? String(spec.author) : '',
        params: params.filter(p => p && typeof p === 'object' && typeof p.key === 'string' && KEY_RE.test(p.key)),
        sql: stripOuter(sql),
        display
      } : null
    };
  }

  /* 参数默认值 -> 绑定值（校验器/测试用）：未填默认值的参数绑定为 null */
  function defaultParamValues(spec) {
    const out = {};
    for (const p of spec.params || []) {
      if (p.multiple) out[p.key] = Array.isArray(p.default) ? p.default : [];
      else if (p.default !== undefined && p.default !== null && p.default !== '') out[p.key] = p.default;
      else out[p.key] = null;
    }
    return out;
  }

  /* ---------------- 结果列类型推断（渲染进程构建伪 schema 用） ---------------- */
  function inferResultColumns(columns, rows) {
    const sample = (rows || []).slice(0, 200);
    return (columns || []).map(name => {
      const vals = sample.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
      let kind = 'string';
      if (vals.length) {
        const nums = vals.filter(v => (typeof v === 'number' && isFinite(v)) ||
          (typeof v === 'string' && v.trim() !== '' && !DATE_PREFIX_RE.test(v) && isFinite(Number(v))));
        if (nums.length / vals.length > 0.9) kind = 'number';
        else if (vals.every(v => typeof v === 'string' && DATE_PREFIX_RE.test(v))) kind = 'date';
      }
      const col = { name, declType: '', kind };
      if (kind === 'number') {
        const nums = vals.map(Number).filter(isFinite);
        if (nums.length) { col.min = Math.min(...nums); col.max = Math.max(...nums); }
      }
      return col;
    });
  }

  return {
    FORMAT, VERSION, PARAM_TYPES,
    scanSql, extractParamNames, stripOuter,
    isReadOnlySelect, hasMultipleStatements,
    buildViewSql, appendLimit, countWrap,
    validateViewSpec, defaultParamValues, inferResultColumns
  };
});
