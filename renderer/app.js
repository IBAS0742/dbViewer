/* app.js — 渲染进程主逻辑：打开库 → 过滤表单 → 图表配置 → 绘图 → 导出 */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  demo: false,
  dbPath: null,
  table: null,
  schema: null,
  colMeta: new Map(),
  rows: [],
  total: 0,
  limited: false,
  filtersApplied: [],
  labels: {},
  presets: [],
  chartType: 'line',
  chart: null,
  chartData: null,
  filterEls: new Map()
};

const CAT_TYPES = new Set(['line', 'area', 'bar', 'hbar']);
const PIE_TYPES = new Set(['pie', 'doughnut', 'funnel']);
const GRID_TYPES = new Set(['heatmap', 'bar3D']);

function lbl(col) { return state.labels[col] || col; }
function kindOf(col) { return (state.colMeta.get(col) || {}).kind || 'string'; }

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtN(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100);
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 4000);
}
function busy(on) { $('#busy').hidden = !on; }

/* ================================================================ */
/* 打开数据库                                                        */
/* ================================================================ */
async function openDbPath(p) {
  busy(true);
  try {
    const { tables } = await window.api.listTables(p);
    if (!tables.length) { toast('该文件中没有数据表', true); return; }
    state.dbPath = p;
    const fn = $('#file-name');
    if (fn) { fn.textContent = p.split(/[\\/]/).pop(); fn.title = p; }
    const sel = $('#table-select');
    sel.innerHTML = '';
    tables.sort((a, b) => b.rows - a.rows);
    for (const t of tables) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = `${t.name} (${fmtN(t.rows)} 行)`;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    await loadTable(tables[0].name);
  } catch (err) {
    toast('打开数据库失败: ' + err.message, true);
  } finally {
    busy(false);
  }
}

async function loadTable(table) {
  state.table = table;
  busy(true);
  try {
    state.schema = await window.api.getSchema(state.dbPath, table);
    state.colMeta = new Map(state.schema.columns.map(c => [c.name, c]));
    renderFilterForm();
    renderPresets();
    ['btn-export-chart', 'btn-export-full', 'btn-export-csv', 'btn-draw'].forEach(id => { $('#' + id).disabled = false; });
    // 默认应用第一个预设
    const first = state.presets.find(p => !p.table || p.table === table || p.table === '*');
    if (first) {
      $('#preset-select').value = first.id || first.name;
      applyPreset(first);
    } else {
      await applyFilters();
    }
  } catch (err) {
    toast('读取表结构失败: ' + err.message, true);
  } finally {
    busy(false);
  }
}

/* ================================================================ */
/* 过滤表单                                                          */
/* ================================================================ */
function renderFilterForm() {
  const form = $('#filter-form');
  form.innerHTML = '';
  state.filterEls = new Map();

  for (const col of state.schema.columns) {
    const g = document.createElement('details');
    g.className = 'fgroup';
    g.dataset.col = col.name;
    const summary = document.createElement('summary');
    const hint = col.kind === 'enum' || col.kind === 'enum-number'
      ? `${col.distinct.length} 项可选`
      : col.kind === 'number' ? `数值 ${fmtN(col.min)} ~ ${fmtN(col.max)}`
        : col.kind === 'date' ? '日期' : '文本包含';
    summary.innerHTML = `${escHtml(lbl(col.name))} <span class="hint">${escHtml(col.name)} · ${hint}</span>`;
    g.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'fbody';
    const controls = { col, kind: col.kind };

    if (col.kind === 'enum' || col.kind === 'enum-number') {
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const v of col.distinct) {
        const c = document.createElement('label');
        c.className = 'chip';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = String(v);
        input.addEventListener('change', () => c.classList.toggle('on', input.checked));
        c.appendChild(input);
        c.appendChild(document.createTextNode(String(v)));
        chips.appendChild(c);
      }
      const mini = document.createElement('div');
      mini.className = 'mini-btns';
      const bAll = document.createElement('button'); bAll.textContent = '全选';
      bAll.addEventListener('click', () => { chips.querySelectorAll('input').forEach(i => { i.checked = true; i.closest('.chip').classList.add('on'); }); });
      const bNone = document.createElement('button'); bNone.textContent = '清空';
      bNone.addEventListener('click', () => { chips.querySelectorAll('input').forEach(i => { i.checked = false; i.closest('.chip').classList.remove('on'); }); });
      mini.append(bAll, bNone);
      body.append(chips, mini);
      controls.chips = chips;
      g.open = col.distinct.length <= 10;
    } else if (col.kind === 'number') {
      const row = document.createElement('div');
      row.className = 'range-row';
      const min = document.createElement('input');
      min.type = 'number'; min.placeholder = '最小值';
      const mid = document.createElement('span'); mid.textContent = '—';
      const max = document.createElement('input');
      max.type = 'number'; max.placeholder = '最大值';
      row.append(min, mid, max);
      body.appendChild(row);
      controls.min = min; controls.max = max;
      g.open = false;
    } else if (col.kind === 'date') {
      const row = document.createElement('div');
      row.className = 'range-row';
      const from = document.createElement('input');
      from.type = 'date';
      const mid = document.createElement('span'); mid.textContent = '—';
      const to = document.createElement('input');
      to.type = 'date';
      row.append(from, mid, to);
      body.appendChild(row);
      controls.min = from; controls.max = to;
      g.open = false;
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '包含关键字…';
      input.style.width = '100%';
      body.appendChild(input);
      controls.text = input;
      g.open = false;
    }

    g.appendChild(body);
    form.appendChild(g);
    state.filterEls.set(col.name, { group: g, controls });
  }
}

function collectFilters() {
  const out = [];
  for (const [name, { controls }] of state.filterEls) {
    const col = controls.col;
    if (controls.chips) {
      const vals = [...controls.chips.querySelectorAll('input:checked')].map(i =>
        col.kind === 'enum-number' ? Number(i.value) : i.value);
      if (vals.length && vals.length < col.distinct.length) {
        out.push({ col: name, op: 'in', values: vals, numeric: col.kind === 'enum-number' });
      }
    }
    if (controls.min !== undefined) {
      const a = controls.min.value, b = controls.max.value;
      if (a !== '' || b !== '') {
        out.push({ col: name, op: 'between', values: [a, b], numeric: col.kind === 'number' });
      }
    }
    if (controls.text && controls.text.value.trim() !== '') {
      out.push({ col: name, op: 'like', value: controls.text.value.trim() });
    }
  }
  return out;
}

function clearFilterControls() {
  for (const { controls } of state.filterEls.values()) {
    if (controls.chips) controls.chips.querySelectorAll('input').forEach(i => { i.checked = false; i.closest('.chip').classList.remove('on'); });
    if (controls.min) controls.min.value = '';
    if (controls.max) controls.max.value = '';
    if (controls.text) controls.text.value = '';
  }
}

function applyPresetFilters(filters) {
  for (const f of filters) {
    const entry = state.filterEls.get(f.col);
    if (!entry) continue;
    const { controls } = entry;
    if (f.op === 'in' && controls.chips) {
      const set = new Set(f.values.map(String));
      controls.chips.querySelectorAll('input').forEach(i => {
        const on = set.has(i.value);
        i.checked = on;
        i.closest('.chip').classList.toggle('on', on);
      });
    } else if (f.op === 'between' && controls.min) {
      controls.min.value = f.values && f.values[0] != null ? f.values[0] : '';
      controls.max.value = f.values && f.values[1] != null ? f.values[1] : '';
    } else if (f.op === 'like' && controls.text) {
      controls.text.value = f.value || '';
    }
  }
}

/* ================================================================ */
/* 图表配置表单                                                      */
/* ================================================================ */
function fieldOptions(optional) {
  let h = optional ? '<option value="">（无）</option>' : '';
  for (const col of state.schema.columns) {
    const l = lbl(col.name);
    h += `<option value="${escHtml(col.name)}">${escHtml(l === col.name ? col.name : `${l} · ${col.name}`)}</option>`;
  }
  return h;
}
function aggOptions() {
  return ChartBuilder.AGGS.map(a => `<option value="${a.value}">${a.name}</option>`).join('');
}
function sortOptions() {
  return [['x-asc', '按X升序'], ['x-desc', '按X降序'], ['value-asc', '按数值升序'], ['value-desc', '按数值降序']]
    .map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
}
function fld(id, label, inner) {
  return `<label class="inline-label">${label}<select id="cfg-${id}">${inner}</select></label>`;
}
function fldNum(id, label, ph) {
  return `<label class="inline-label">${label}<input type="number" id="cfg-${id}" placeholder="${ph}" style="width:76px"></label>`;
}
function fldText(id, label, ph) {
  return `<label class="inline-label">${label}<input type="text" id="cfg-${id}" placeholder="${ph}" style="width:180px"></label>`;
}
function fldCheck(id, label) {
  return `<label class="inline-label"><input type="checkbox" id="cfg-${id}">${label}</label>`;
}

function populateChartConfig(type, preset) {
  const c = $('#chart-config');
  if (!state.schema) { c.innerHTML = ''; return; }
  let h = '';
  if (CAT_TYPES.has(type)) {
    h += fld('x', 'X 轴字段', fieldOptions(false));
    h += fldNum('xBins', 'X分箱', '20');
    h += fld('series', '系列(分组)', fieldOptions(true));
    h += fld('y', '数值字段', fieldOptions(true));
    h += fld('agg', '聚合', aggOptions());
    h += fld('sort', '排序', sortOptions());
    if (type === 'bar') h += fldCheck('stacked', '堆叠');
    h += fldText('title', '标题', '默认自动');
  } else if (type === 'scatter' || type === 'bubble') {
    h += fld('x', 'X 轴字段', fieldOptions(false));
    h += fld('y', 'Y 轴字段', fieldOptions(false));
    if (type === 'bubble') h += fld('size', '气泡大小', fieldOptions(true));
    h += fld('series', '系列(分组)', fieldOptions(true));
    h += fldText('title', '标题', '默认自动');
  } else if (PIE_TYPES.has(type)) {
    h += fld('nameField', '名称字段', fieldOptions(false));
    h += fld('value', '数值字段', fieldOptions(true));
    h += fld('agg', '聚合', aggOptions());
    h += fldText('title', '标题', '默认自动');
  } else if (GRID_TYPES.has(type)) {
    h += fld('x', 'X 轴字段', fieldOptions(false));
    h += fldNum('xBins', 'X分箱', '20');
    h += fld('y', 'Y 轴字段', fieldOptions(false));
    h += fldNum('yBins', 'Y分箱', '12');
    h += fld('value', '数值字段', fieldOptions(true));
    h += fld('agg', '聚合', aggOptions());
    h += fldText('title', '标题', '默认自动');
  } else if (type === 'scatter3D') {
    h += fld('x', 'X 轴字段', fieldOptions(false));
    h += fld('y', 'Y 轴字段', fieldOptions(false));
    h += fld('z', 'Z 轴字段', fieldOptions(false));
    h += fld('value', '颜色数值字段', fieldOptions(true));
    h += fldText('title', '标题', '默认自动');
  }
  c.innerHTML = h;

  if (preset) {
    const set = (id, v) => {
      const el = document.getElementById('cfg-' + id);
      if (!el || v === undefined || v === null) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    };
    ['x', 'xBins', 'series', 'y', 'yBins', 'z', 'size', 'nameField', 'value', 'agg', 'sort', 'title', 'stacked']
      .forEach(k => set(k, preset[k]));
  }
}

function readCfg() {
  const type = state.chartType;
  const v = id => { const el = document.getElementById('cfg-' + id); return el ? String(el.value).trim() : ''; };
  const n = id => { const s = v(id); const i = parseInt(s, 10); return s === '' || !isFinite(i) ? null : Math.max(2, i); };
  const b = id => { const el = document.getElementById('cfg-' + id); return !!(el && el.checked); };
  const cfg = { type, title: v('title') };
  if (CAT_TYPES.has(type)) {
    cfg.x = v('x'); cfg.xBins = n('xBins');
    cfg.series = v('series') || null;
    cfg.y = v('y') || null;
    cfg.agg = cfg.y ? (v('agg') || 'sum') : 'count';
    cfg.stacked = b('stacked');
    cfg.sort = v('sort') || 'x-asc';
  } else if (type === 'scatter' || type === 'bubble') {
    cfg.x = v('x'); cfg.y = v('y');
    cfg.size = type === 'bubble' ? (v('size') || null) : null;
    cfg.series = v('series') || null;
  } else if (PIE_TYPES.has(type)) {
    cfg.nameField = v('nameField'); cfg.value = v('value') || null;
    cfg.agg = cfg.value ? (v('agg') || 'sum') : 'count';
  } else if (GRID_TYPES.has(type)) {
    cfg.x = v('x'); cfg.xBins = n('xBins');
    cfg.y = v('y'); cfg.yBins = n('yBins');
    cfg.value = v('value') || null;
    cfg.agg = cfg.value ? (v('agg') || 'avg') : 'count';
  } else if (type === 'scatter3D') {
    cfg.x = v('x'); cfg.y = v('y'); cfg.z = v('z');
    cfg.value = v('value') || null;
  }
  return cfg;
}

function validateCfg(cfg) {
  const t = cfg.type;
  const need = [];
  if (CAT_TYPES.has(t) || GRID_TYPES.has(t)) need.push(['x', 'X 轴字段']);
  if (t === 'scatter' || t === 'bubble' || GRID_TYPES.has(t)) need.push(['y', 'Y 轴字段']);
  if (t === 'scatter3D') need.push(['x', 'X 轴字段'], ['y', 'Y 轴字段'], ['z', 'Z 轴字段']);
  if (PIE_TYPES.has(t)) need.push(['nameField', '名称字段']);
  for (const [k, name] of need) {
    if (!cfg[k]) return `请先选择「${name}」`;
  }
  return null;
}

/* ================================================================ */
/* 绘图                                                             */
/* ================================================================ */
function drawChart() {
  if (!state.schema) return;
  const cfg = readCfg();
  const err = validateCfg(cfg);
  if (err) { toast(err, true); return; }

  const res = ChartBuilder.build(cfg.type, cfg, state.rows, { lbl, kind: kindOf });
  const empty = $('#chart-empty');
  if (res.error) {
    empty.textContent = res.error;
    empty.classList.remove('hidden');
    state.chartData = null;
    return;
  }
  empty.classList.add('hidden');
  state.cfg = cfg;
  state.chartData = res.chartData;

  if (state.chart) state.chart.dispose();
  state.chart = echarts.init($('#chart'));
  state.chart.setOption(res.option);

  const typeName = (ChartBuilder.CHART_TYPES.find(t => t.type === cfg.type) || {}).name || cfg.type;
  $('#chart-msg').textContent = `${typeName} · 图表数据 ${fmtN(res.chartData.rows.length)} 条`;
}

/* ================================================================ */
/* 查询 + 预览                                                       */
/* ================================================================ */
async function applyFilters() {
  if (!state.dbPath) return;
  state.filtersApplied = collectFilters();
  busy(true);
  try {
    const limit = Number($('#sample-limit').value) || 20000;
    const res = await window.api.query({
      path: state.dbPath, table: state.table,
      filters: state.filtersApplied, limit
    });
    state.rows = res.rows;
    state.total = res.total;
    state.limited = res.limited;
    const n = state.filtersApplied.length;
    $('#filter-count').textContent = n ? String(n) : '';
    updateRowInfo();
    renderPreview();
    drawChart();
  } catch (err) {
    toast('查询失败: ' + err.message, true);
  } finally {
    busy(false);
  }
}

function updateRowInfo() {
  const parts = [`表共 ${fmtN(state.schema ? state.schema.total : 0)} 条`];
  if (state.filtersApplied.length) parts.push(`过滤后 ${fmtN(state.total)} 条`);
  if (state.limited) parts.push(`等间隔抽样 ${fmtN(state.rows.length)} 条用于绘图/预览`);
  $('#row-info').textContent = parts.join(' · ');
}

function renderPreview() {
  const box = $('#data-table');
  const rows = state.rows.slice(0, 100);
  if (!rows.length) {
    box.innerHTML = '<div class="empty-hint">没有符合条件的数据</div>';
    $('#preview-info').textContent = '';
    return;
  }
  const cols = state.schema.columns.map(c => c.name);
  let h = '<table><thead><tr>';
  for (const c of cols) h += `<th title="${escHtml(c)}">${escHtml(lbl(c))}</th>`;
  h += '</tr></thead><tbody>';
  for (const r of rows) {
    h += '<tr>';
    for (const c of cols) {
      const v = r[c];
      h += `<td>${v === null || v === undefined ? '' : escHtml(typeof v === 'number' ? fmtN(v) : v)}</td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  box.innerHTML = h;
  $('#preview-info').textContent = `符合 ${fmtN(state.total)} 条，预览前 ${rows.length} 行`;
}

/* ================================================================ */
/* 预设                                                              */
/* ================================================================ */
function renderPresets() {
  const sel = $('#preset-select');
  sel.innerHTML = '<option value="">（自选配置）</option>';
  const list = state.presets.filter(p => !p.table || p.table === '*' || p.table === state.table);
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id || p.name;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

function applyPreset(p) {
  if (p.type) {
    state.chartType = p.type;
    $('#chart-type').value = p.type;
  }
  populateChartConfig(state.chartType, p);
  clearFilterControls();
  if (Array.isArray(p.filters)) applyPresetFilters(p.filters);
  applyFilters();
}

/* ================================================================ */
/* 导出                                                              */
/* ================================================================ */
function chartTypeName(t) {
  return (ChartBuilder.CHART_TYPES.find(x => x.type === t) || {}).name || t;
}

async function exportChartData() {
  if (!state.chartData) { toast('请先绘制图表', true); return; }
  if (state.demo) { toast('演示模式不支持导出，请在 Electron 应用中使用', true); return; }
  const name = `${state.table}_${state.cfg.title || chartTypeName(state.cfg.type)}_图表数据.xlsx`;
  try {
    const res = await window.api.exportSheets({
      defaultName: name,
      sheets: [{ name: '图表数据', columns: state.chartData.columns, rows: state.chartData.rows }]
    });
    if (res.ok) toast(`已导出 ${fmtN(res.count)} 行图表数据 → ${res.filePath}`);
    else if (!res.canceled) toast('导出失败', true);
  } catch (err) { toast('导出失败: ' + err.message, true); }
}

async function exportFull(format) {
  if (!state.dbPath) return;
  if (state.demo) { toast('演示模式不支持导出，请在 Electron 应用中使用', true); return; }
  busy(true);
  try {
    const res = await window.api.exportFull({
      path: state.dbPath,
      table: state.table,
      filters: state.filtersApplied,
      headers: state.labels,
      format,
      defaultName: `${state.table}_全部字段_过滤导出.${format}`
    });
    if (res.ok) toast(`已导出 ${fmtN(res.count)} 行完整数据 → ${res.filePath}`);
  } catch (err) {
    toast('导出失败: ' + err.message, true);
  } finally {
    busy(false);
  }
}

/* ================================================================ */
/* 初始化                                                            */
/* ================================================================ */
function fillChartTypes() {
  const sel = $('#chart-type');
  sel.innerHTML = ChartBuilder.CHART_TYPES
    .map(t => `<option value="${t.type}">${t.name}（需: ${t.need}）</option>`).join('');
}

function bindEvents() {
  $('#btn-open').addEventListener('click', async () => {
    if (state.demo) { toast('演示模式：请运行 electron . 后打开真实数据库'); return; }
    const res = await window.api.pickDbFile();
    if (res && !res.canceled && res.path) openDbPath(res.path);
  });
  $('#table-select').addEventListener('change', e => { if (e.target.value) loadTable(e.target.value); });
  $('#btn-apply').addEventListener('click', applyFilters);
  $('#btn-clear').addEventListener('click', () => { clearFilterControls(); applyFilters(); });
  $('#btn-draw').addEventListener('click', drawChart);
  $('#chart-type').addEventListener('change', e => {
    state.chartType = e.target.value;
    $('#preset-select').value = '';
    populateChartConfig(state.chartType);
    if (state.rows.length) drawChart();
  });
  $('#preset-select').addEventListener('change', e => {
    if (!e.target.value) return;
    const p = state.presets.find(x => (x.id || x.name) === e.target.value);
    if (p) applyPreset(p);
  });
  $('#sample-limit').addEventListener('change', applyFilters);
  $('#btn-export-chart').addEventListener('click', exportChartData);
  $('#btn-export-full').addEventListener('click', () => exportFull('xlsx'));
  $('#btn-export-csv').addEventListener('click', () => exportFull('csv'));
  $('#filter-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const [name, { group }] of state.filterEls) {
      const hit = !q || name.toLowerCase().includes(q) || lbl(name).toLowerCase().includes(q);
      group.classList.toggle('hidden-by-search', !hit);
      if (q && hit) group.open = true;
    }
  });
  window.addEventListener('resize', () => { if (state.chart) state.chart.resize(); });
}

(async function init() {
  state.demo = !!(window.api && window.api.demo);
  if (state.demo) {
    const b = document.createElement('span');
    b.className = 'demo-banner';
    b.textContent = '演示模式（浏览器预览，数据库功能需在 Electron 中运行）';
    $('#file-name').replaceWith(b);
  }
  try {
    const cfg = await window.api.loadConfig();
    state.labels = (cfg && cfg.fieldLabels) || {};
    state.presets = (cfg && cfg.chartPresets) || [];
  } catch (err) {
    /* 配置缺失时使用原始字段名 */
  }
  fillChartTypes();
  bindEvents();
  populateChartConfig(state.chartType);

  const qp = new URLSearchParams(location.search);
  const dbArg = qp.get('db');
  if (dbArg) openDbPath(dbArg);
  else if (state.demo) openDbPath('demo://fire'); // 浏览器演示模式自动加载模拟数据
})();
