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
  filterEls: new Map(),
  // 查询视图（导入式过滤 SQL）
  view: null,             // validateViewSpec 归一化后的视图定义
  viewDisplayCols: null,  // [{key,label}] 或 null（显示全部结果列）
  viewParamsApplied: null, // 上次成功运行的参数值（换表后回填）
  viewParamEls: [],       // [{p, get}]
  // 图表配置库（“我的配置”：可存多份，重启复用，同名覆盖）
  savedViews: [],         // [{id, savedAt, spec}]
  savedRaw: new Map()     // id -> 原始 JSON 文本（导出/再保存用）
};
const VIEW_STORE_KEY = 'dbchart:last-view';      // 兼容旧版：当前激活视图（渲染态）
const VIEWS_STORE_KEY = 'dbchart:saved-views';   // 配置库：[{id, savedAt, raw}]

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
    // 视图模式：左栏是视图参数表单，换表/换库后直接重跑视图
    if (state.view) {
      renderViewPanel();
      await runView();
      return;
    }
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
    $('#btn-export-image').disabled = true;
    return;
  }
  empty.classList.add('hidden');
  state.cfg = cfg;
  state.chartData = res.chartData;

  if (state.chart) state.chart.dispose();
  state.chart = echarts.init($('#chart'));
  state.chart.setOption(res.option);
  $('#btn-export-image').disabled = false;
  // 若用户之前开着全屏，绘图后同样更新到全屏层中的画布
  if (state.fullscreen) state.chart.resize();

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
  if (state.view) {
    const parts = [`视图结果 ${fmtN(state.total)} 条`];
    if (state.limited) parts.push(`超上限，取前 ${fmtN(state.rows.length)} 条绘图/预览`);
    $('#row-info').textContent = parts.join(' · ');
    return;
  }
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
  // 视图模式：只显示视图指定的展示列（发布者可控使用者看到哪些字段）
  const viewInfo = state.view && state.schema ? viewDisplayInfo() : null;
  const cols = viewInfo ? viewInfo.cols : state.schema.columns.map(c => c.name);
  const headerOf = c => viewInfo ? (viewInfo.headers[c] || c) : lbl(c);
  let h = '<table><thead><tr>';
  for (const c of cols) h += `<th title="${escHtml(c)}">${escHtml(headerOf(c))}</th>`;
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
  // 视图模式：预设基于表字段映射，与视图结果列不匹配，忽略（下拉框已禁用，此处兜底）
  if (state.view) return;
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
/* 图表配置库（“我的配置”）：保存 / 应用 / 删除 / 导出                  */
/* ================================================================ */
function loadSavedViews() {
  state.savedViews = [];
  state.savedRaw = new Map();
  try {
    const arr = JSON.parse(localStorage.getItem(VIEWS_STORE_KEY) || '[]');
    if (Array.isArray(arr)) {
      for (const item of arr) {
        try {
          const raw = typeof item.raw === 'string' ? item.raw : JSON.stringify(item.raw);
          const res = QueryView.validateViewSpec(JSON.parse(raw), { chartTypes: ChartBuilder.CHART_TYPES });
          if (!res.ok) continue; // 单份损坏不拖垮整个配置库
          state.savedRaw.set(item.id, raw);
          state.savedViews.push({ id: item.id, savedAt: item.savedAt || '', spec: res.spec });
        } catch (_) { /* 跳过坏数据 */ }
      }
    }
  } catch (_) { /* 忽略本地存储异常 */ }
}

function persistSavedViews() {
  try {
    const arr = state.savedViews.map(v => ({ id: v.id, savedAt: v.savedAt, raw: state.savedRaw.get(v.id) }));
    localStorage.setItem(VIEWS_STORE_KEY, JSON.stringify(arr));
  } catch (err) {
    toast('配置保存失败（本地存储不可用）: ' + err.message, true);
  }
}

function viewIdOf(spec) {
  const base = String(spec.name || 'view').trim().toLowerCase();
  return base.replace(/\s+/g, '-') || 'view';
}

/* 导入成功后调用：同名（name 字段）覆盖，否则新增 */
function upsertSavedView(rawText) {
  const res = QueryView.validateViewSpec(JSON.parse(rawText), { chartTypes: ChartBuilder.CHART_TYPES });
  if (!res.ok) return { ok: false, errors: res.errors };
  const id = viewIdOf(res.spec);
  const idx = state.savedViews.findIndex(v => v.id === id);
  const entry = { id, savedAt: new Date().toISOString().slice(0, 10), spec: res.spec };
  if (idx >= 0) state.savedViews[idx] = entry;
  else state.savedViews.push(entry);
  state.savedRaw.set(id, rawText);
  persistSavedViews();
  return { ok: true, replaced: idx >= 0, spec: res.spec };
}

function removeSavedView(id) {
  const idx = state.savedViews.findIndex(v => v.id === id);
  if (idx < 0) return;
  state.savedViews.splice(idx, 1);
  state.savedRaw.delete(id);
  persistSavedViews();
}

async function applySavedView(id) {
  const raw = state.savedRaw.get(id);
  if (!raw) { toast('配置不存在', true); return; }
  const ok = await importViewFromText(raw);
  if (ok) closeViewsModal();
}

async function exportSavedView(id) {
  const v = state.savedViews.find(x => x.id === id);
  const raw = state.savedRaw.get(id);
  if (!v || !raw) return;
  if (state.demo) {
    toast('演示模式没有保存对话框；配置 JSON 已输出到控制台', true);
    console.log(raw);
    return;
  }
  try {
    const res = await window.api.saveViewFile({
      defaultName: `${sanitizeFileName(v.spec.name)}.view.json`,
      content: raw
    });
    if (res.ok) toast(`已导出配置 → ${res.filePath}`);
    else if (!res.canceled) toast('导出失败' + (res.error ? ': ' + res.error : ''), true);
  } catch (err) {
    toast('导出失败: ' + err.message, true);
  }
}

function renderViewsModal() {
  const list = $('#views-list');
  if (!state.savedViews.length) {
    list.innerHTML = '<div class="views-empty">还没有保存的配置。点「导入配置」选择文件，或「粘贴导入」AI 生成的 JSON。</div>';
    return;
  }
  list.innerHTML = '';
  for (const v of state.savedViews) {
    const item = document.createElement('div');
    item.className = 'view-item' + (state.view && state.view.name === v.spec.name ? ' current' : '');
    const main = document.createElement('div');
    main.className = 'vi-main';
    const pN = document.createElement('div');
    pN.className = 'vi-name';
    pN.textContent = v.spec.name + (state.view && state.view.name === v.spec.name ? '（当前使用中）' : '');
    const meta = [];
    if (v.spec.description) meta.push(v.spec.description);
    meta.push(`${v.spec.params.length} 参数 · ${v.savedAt}保存`);
    const pM = document.createElement('div');
    pM.className = 'vi-meta';
    pM.textContent = meta.join(' · ');
    main.append(pN, pM);
    const bUse = document.createElement('button'); bUse.className = 'btn primary'; bUse.textContent = '应用';
    bUse.addEventListener('click', () => applySavedView(v.id));
    const bExp = document.createElement('button'); bExp.className = 'btn'; bExp.textContent = '导出';
    bExp.addEventListener('click', () => exportSavedView(v.id));
    const bDel = document.createElement('button'); bDel.className = 'btn'; bDel.textContent = '删除';
    bDel.addEventListener('click', () => {
      if (!confirm(`删除配置「${v.spec.name}」？此操作不可恢复。`)) return;
      removeSavedView(v.id);
      renderViewsModal();
      toast(`已删除配置「${v.spec.name}」`);
    });
    item.append(main, bUse, bExp, bDel);
    list.appendChild(item);
  }
}

function openViewsModal() { renderViewsModal(); $('#views-modal').hidden = false; }
function closeViewsModal() { $('#views-modal').hidden = true; }

/* ================================================================ */
/* 粘贴导入（直接吃 AI 输出的 JSON）                                   */
/* ================================================================ */
/* AI 偶尔会用 ```json 代码围栏包住 JSON，或在 JSON 前后加说明文字，这里剥掉再解析 */
function extractJsonText(text) {
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // 截取第一个 { 到最后一个 }（AI 可能在 JSON 前后加了说明文字）
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

function openPasteModal() { closeViewsModal(); $('#paste-err').hidden = true; $('#paste-area').value = ''; $('#paste-modal').hidden = false; $('#paste-area').focus(); }
function closePasteModal() { $('#paste-modal').hidden = true; }

async function importPasted() {
  const text = $('#paste-area').value.trim();
  if (!text) { toast('请先粘贴配置 JSON', true); return; }
  const jsonText = extractJsonText(text);
  let rawJson;
  try { rawJson = JSON.parse(jsonText); }
  catch (err) {
    const box = $('#paste-err');
    box.textContent = '不是合法的 JSON：' + err.message + '\n请检查粘贴内容（可整段粘贴 AI 回复，会自动提取 JSON 部分）。';
    box.hidden = false;
    return;
  }
  const r = upsertSavedView(JSON.stringify(rawJson));
  if (!r.ok) {
    const box = $('#paste-err');
    box.textContent = '配置校验未通过：\n' + r.errors.join('\n');
    box.hidden = false;
    return;
  }
  closePasteModal();
  // importViewFromText 内部会提示「已导入/已更新」并自动运行
  await applySavedView(viewIdOf(r.spec));
}

/* ================================================================ */
/* AI 提示词生成器                                                     */
/* ================================================================ */
const AI_PROMPT_SPEC = [
  '【输出格式】',
  '只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释文字），结构如下：',
  '{',
  '  "format": "dbchart-query-view",',
  '  "version": 1,',
  '  "name": "配置名（简洁，会作为同名覆盖的 key）",',
  '  "description": "一句话说明这个配置回答什么问题",',
  '  "sql": "SELECT ... WHERE col = :param ...（SQLite 方言，单条只读 SELECT，可用 WITH）",',
  '  "params": [',
  '    { "key": "year_from", "label": "开始年份", "type": "number", "required": true, "help": "留空不限" },',
  '    { "key": "satellites", "label": "卫星", "type": "select", "multiple": true,',
  '      "options": ["Aqua", "Terra"], "default": ["Aqua"] },',
  '    { "key": "day", "label": "日期", "type": "date" }',
  '  ],',
  '  "display": {',
  '    "columns": [{ "key": "结果列名", "label": "显示名" }],',
  '    "chart": { "type": "heatmap", "x": "列名", "y": "列名", "xBins": 20, "yBins": 12, "agg": "count", "title": "图表标题" }',
  '  }',
  '}',
  '',
  '【图表类型 chart.type 可选】line 折线 / area 面积 / bar 柱状 / hbar 条形 / scatter 散点 /',
  'bubble 气泡 / pie 饼图 / doughnut 环形 / funnel 漏斗 / heatmap 热力图 / bar3D 3D柱状 / scatter3D 3D散点。',
  '类型对应必填键：折线/柱状类需 x；散点/气泡需 x,y（气泡可加 size）；饼/环/漏斗需 nameField；',
  '热力图/3D柱状需 x,y（数值列配 xBins/yBins 分箱）；3D散点需 x,y,z（可加 value 上色）。',
  '聚合 agg：count（计数，无需数值列）/ sum / avg / max / min / direct（SQL 已聚合时用 direct）。',
  '',
  '【硬性规则】',
  '1. SQL 只能是单条 SELECT（或 WITH...SELECT），禁止任何写操作、多语句、PRAGMA;',
  '2. SQL 里用 :参数名 占位，参数名必须都在 params 里定义；文本参数为空时表示不限，',
  '   用 (:p IS NULL OR col = :p) 或 (:p IS NULL OR col LIKE :p) 写法保证留空可用;',
  '3. params.type 可选 number / text / date / select；select 可加 multiple 和 options（字符串数组或 {value,label}）;',
  '4. display.chart 的字段必须引用 SQL 结果列的别名，不能用原表字段名;',
  '5. 数字开头的结果列别名要用引号包住，如 AS "3d"。'
].join('\n');

function buildTableSummary() {
  if (!state.schema || !state.schema.columns || !state.schema.columns.length) return null;
  const lines = state.schema.columns.map(c => {
    const m = state.colMeta.get(c.name) || c;
    if (m.kind === 'enum' || m.kind === 'enum-number') {
      return `- ${c.name}（${m.kind === 'enum-number' ? '数值枚举' : '枚举'}）取值: ${(m.distinct || []).join(' / ')}`;
    }
    if (m.kind === 'number') return `- ${c.name}（数值）范围 ${m.min} ~ ${m.max}`;
    if (m.kind === 'date') return `- ${c.name}（日期）`;
    return `- ${c.name}（文本）`;
  });
  return `表名: ${state.table || '?'}，共 ${state.schema.total ?? '?'} 行\n字段:\n${lines.join('\n')}`;
}

function buildAiPrompt(mode) {
  const schema = buildTableSummary();
  const schemaBlock = schema
    ? `【数据库表结构（当前打开的表，字段/取值以此为准）】\n${schema}\n`
    : `【数据库表结构】\n（当前未打开数据库。请把你的表结构贴在这里：表名、字段名、类型、示例值）\n`;
  const common = `${schemaBlock}
【需求】
${mode === 'b'
    ? '请先理解我想要的图表（见下），如果以下信息不足以写出正确的 SQL 和图表配置，\n请先向我提出 3~6 个关键问题（用列表），等我回答后再输出配置 JSON。\n如果信息已足够，直接输出配置 JSON，不要再提问。\n\n【我想要看的图表 / 想回答的问题】\n（在这里描述，例如：我想看 2015 年以后各卫星的火点数量随月份的变化，能按海拔过滤）'
    : '（在这里描述你想要的图表，例如：按年份统计火点数量并画折线图，能按卫星和置信等级筛选）'}

${AI_PROMPT_SPEC}`;
  return common;
}

let aiMode = 'a';
function renderAiPrompt() {
  const tip = $('#ai-tip');
  const text = buildAiPrompt(aiMode);
  $('#ai-prompt').textContent = text;
  tip.textContent = aiMode === 'a'
    ? '复制下面的提示词发给 AI（已自动带上当前表结构），把「需求」部分改成你的问题，AI 输出的 JSON 用「粘贴导入」即可。'
    : '这种模式让 AI 先向你提问、补齐信息后再产出配置。同样复制发给 AI，按它的提问回答即可。';
  $('#ai-tab-a').classList.toggle('on', aiMode === 'a');
  $('#ai-tab-b').classList.toggle('on', aiMode === 'b');
}

function openAiModal() { closeViewsModal(); aiMode = 'a'; renderAiPrompt(); $('#ai-copy-hint').textContent = ''; $('#ai-modal').hidden = false; }
function closeAiModal() { $('#ai-modal').hidden = true; }

async function copyAiPrompt() {
  const text = $('#ai-prompt').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('#ai-copy-hint').textContent = '已复制 ✓';
  } catch (_) {
    // 剪贴板 API 不可用（如非安全上下文）时退化为选中文本
    const range = document.createRange();
    range.selectNodeContents($('#ai-prompt'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    $('#ai-copy-hint').textContent = '已全选，请 Ctrl+C 复制';
  }
  setTimeout(() => { $('#ai-copy-hint').textContent = ''; }, 2500);
}

/* ================================================================ */
/* 查询视图（导入式过滤 SQL）                                          */
/* ================================================================ */

function sanitizeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || '视图';
}

async function importViewFromFile() {
  if (state.demo) {
    toast('演示模式没有本地文件对话框；可在控制台调用 importViewFromText(JSON.stringify(spec)) 体验', true);
    return;
  }
  try {
    const res = await window.api.pickViewFile();
    if (res.canceled) return;
    if (res.error) { toast(res.error, true); return; }
    await importViewFromText(res.content);
  } catch (err) {
    toast('导入查询视图失败: ' + err.message, true);
  }
}

/* 导入并校验视图定义；通过后进入视图模式（有库则自动按默认参数运行） */
async function importViewFromText(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (err) { toast('视图文件不是合法 JSON: ' + err.message, true); return false; }
  const res = QueryView.validateViewSpec(raw, { chartTypes: ChartBuilder.CHART_TYPES });
  if (!res.ok) {
    console.error('查询视图校验失败:', res.errors);
    toast('视图文件有误: ' + res.errors.slice(0, 2).join('；') +
      (res.errors.length > 2 ? `（共 ${res.errors.length} 处，详见控制台）` : ''), true);
    return false;
  }
  state.view = res.spec;
  try { localStorage.setItem(VIEW_STORE_KEY, text); } catch (_) { /* 存储失败可忽略 */ }
  // 写入配置库（同名覆盖），重启后可在「我的配置」里继续复用
  try {
    const saved = upsertSavedView(text);
    if (saved.ok) toast(saved.replaced
      ? `已导入并更新配置「${res.spec.name}」`
      : `已导入配置「${res.spec.name}」，已存入「我的配置」`);
  } catch (_) { /* 入库失败不影响本次使用 */ }
  renderViewPanel();
  if (state.chart) { state.chart.dispose(); state.chart = null; }
  state.chartData = null;
  $('#btn-export-image').disabled = true;
  $('#chart-empty').classList.remove('hidden');
  $('#chart-empty').textContent = state.dbPath ? '点击「运行查询」获取数据' : '已导入视图，请先打开数据库文件';
  if (res.warnings.length) console.warn('查询视图警告:', res.warnings);
  if (state.dbPath && state.table) await runView();
  else toast(`已导入视图「${res.spec.name}」`);
  return true;
}

/* 渲染左栏参数表单（优先回填上次运行的值，其次规范默认值） */
function renderViewPanel() {
  const spec = state.view;
  document.body.classList.add('view-mode');
  $('#side-title').textContent = '① 查询参数';
  $('#btn-exit-view').hidden = false;
  $('#view-title').textContent = spec.name;
  $('#view-desc').textContent = spec.description || '';
  $('#view-sql').textContent = spec.sql;
  $('#btn-save-view').hidden = false;
  $('#filter-count').textContent = spec.params.length ? `${spec.params.length} 参数` : '';
  // 预设基于表字段映射，与视图结果列不匹配，视图模式下禁用避免误用
  $('#preset-select').disabled = true;

  const box = $('#view-params');
  box.innerHTML = '';
  state.viewParamEls = [];
  const last = state.viewParamsApplied || {};

  for (const p of spec.params) {
    const row = document.createElement('div');
    row.className = 'vparam';
    row.dataset.key = p.key;
    const type = p.type || 'text';
    const lab = document.createElement('label');
    lab.innerHTML = `${escHtml(p.label || p.key)}${p.required ? ' <span class="req">*</span>' : ''}` +
      ` <span class="hint">${escHtml(p.key)}</span>`;
    row.appendChild(lab);

    let get = () => null;
    const opts = p.options ? p.options.map(o => (o && typeof o === 'object') ? o : { value: o }) : [];

    if (type === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      if (p.min !== undefined) input.min = p.min;
      if (p.max !== undefined) input.max = p.max;
      if (p.step !== undefined) input.step = p.step;
      input.placeholder = p.placeholder || '数值';
      const prev = last[p.key] !== undefined && last[p.key] !== null ? last[p.key] : p.default;
      input.value = prev === undefined || prev === null ? '' : String(prev);
      get = () => (input.value.trim() === '' ? null : Number(input.value));
      row.appendChild(input);
    } else if (type === 'date') {
      const input = document.createElement('input');
      input.type = 'date';
      input.value = last[p.key] || p.default || '';
      get = () => (input.value.trim() === '' ? null : input.value.trim());
      row.appendChild(input);
    } else if (type === 'select' && p.multiple) {
      // 多选胶囊（同枚举过滤风格）；不勾选 = 不限（绑定为 NULL）
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const o of opts) {
        const c = document.createElement('label');
        c.className = 'chip';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.val = JSON.stringify(o.value === undefined ? null : o.value);
        const checkedList = Array.isArray(last[p.key]) ? last[p.key] : (Array.isArray(p.default) ? p.default : []);
        input.checked = checkedList.some(v => String(v) === String(o.value));
        input.addEventListener('change', () => c.classList.toggle('on', input.checked));
        c.appendChild(input);
        c.appendChild(document.createTextNode(String(o.label !== undefined ? o.label : o.value)));
        if (input.checked) c.classList.add('on');
        chips.appendChild(c);
      }
      const mini = document.createElement('div');
      mini.className = 'mini-btns';
      const bAll = document.createElement('button'); bAll.textContent = '全选';
      bAll.addEventListener('click', () => { chips.querySelectorAll('input').forEach(i => { i.checked = true; i.closest('.chip').classList.add('on'); }); });
      const bNone = document.createElement('button'); bNone.textContent = '清空(不限)';
      bNone.addEventListener('click', () => { chips.querySelectorAll('input').forEach(i => { i.checked = false; i.closest('.chip').classList.remove('on'); }); });
      mini.append(bAll, bNone);
      row.append(chips, mini);
      get = () => [...chips.querySelectorAll('input:checked')].map(i => JSON.parse(i.dataset.val));
    } else if (type === 'select') {
      const sel = document.createElement('select');
      sel.appendChild(new Option('（不限）', ''));
      for (const o of opts) {
        sel.appendChild(new Option(String(o.label !== undefined ? o.label : o.value), JSON.stringify(o.value === undefined ? null : o.value)));
      }
      const want = last[p.key] !== undefined && last[p.key] !== null ? last[p.key] : p.default;
      if (want !== undefined && want !== null && want !== '') {
        const hit = opts.find(o => String(o.value) === String(want));
        if (hit) sel.value = JSON.stringify(hit.value);
      }
      get = () => (sel.value === '' ? null : JSON.parse(sel.value));
      row.appendChild(sel);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = p.placeholder || '';
      const prev = last[p.key] !== undefined && last[p.key] !== null ? last[p.key] : p.default;
      input.value = prev === undefined || prev === null ? '' : String(prev);
      get = () => (input.value.trim() === '' ? null : input.value.trim());
      row.appendChild(input);
    }

    if (p.help) {
      const h = document.createElement('div');
      h.className = 'help';
      h.textContent = p.help;
      row.appendChild(h);
    }
    box.appendChild(row);
    state.viewParamEls.push({ p, get });
  }
}

function collectViewParams() {
  const out = {};
  for (const { p, get } of state.viewParamEls) {
    const v = get();
    const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (p.required && empty) throw new Error(`请填写必填参数「${p.label || p.key}」`);
    if (!empty && (p.type || 'text') === 'number' && !isFinite(Number(v))) {
      throw new Error(`参数「${p.label || p.key}」需要填写数字`);
    }
    out[p.key] = v;
  }
  return out;
}

/* 运行视图：绑定参数 -> 主进程执行 SQL -> 结果列构建伪 schema，
 * 图表配置/预览/导出全部复用常规管线 */
async function runView() {
  const spec = state.view;
  if (!spec) return;
  if (!state.dbPath) { toast('请先打开数据库文件，再运行视图查询', true); return; }
  let params;
  try { params = collectViewParams(); }
  catch (err) { toast(err.message, true); return; }

  busy(true);
  try {
    const limit = Number($('#sample-limit').value) || 20000;
    const res = await window.api.queryView({ path: state.dbPath, sql: spec.sql, params, limit });
    if (res.error) { toast(res.error, true); return; }
    state.viewParamsApplied = params;
    state.rows = res.rows;
    state.total = res.total;
    state.limited = res.limited;
    state.filtersApplied = [];

    const colNames = (res.columns && res.columns.length) ? res.columns : (res.rows[0] ? Object.keys(res.rows[0]) : []);
    const cols = QueryView.inferResultColumns(colNames, res.rows);
    state.schema = { total: res.total, columns: cols };
    state.colMeta = new Map(cols.map(c => [c.name, c]));
    state.viewDisplayCols = (spec.display && spec.display.columns) || null;

    updateRowInfo();
    renderPreview();

    const chart = (spec.display && spec.display.chart) || null;
    if (chart && chart.type) {
      state.chartType = chart.type;
      $('#chart-type').value = chart.type;
      $('#preset-select').value = '';
      populateChartConfig(chart.type, chart);
      drawChart();
    } else {
      state.chartType = 'line';
      $('#chart-type').value = 'line';
      populateChartConfig('line');
      $('#chart-empty').classList.remove('hidden');
      $('#chart-empty').textContent = '视图未指定图表，可自行选择类型并「绘制图表」';
    }
    ['btn-export-chart', 'btn-export-full', 'btn-export-csv', 'btn-draw'].forEach(id => { $('#' + id).disabled = false; });
  } catch (err) {
    toast('运行视图失败: ' + err.message, true);
  } finally {
    busy(false);
  }
}

function exitView() {
  state.view = null;
  state.viewDisplayCols = null;
  state.viewParamsApplied = null;
  state.viewParamEls = [];
  try { localStorage.removeItem(VIEW_STORE_KEY); } catch (_) { /* 忽略 */ }
  document.body.classList.remove('view-mode');
  $('#side-title').textContent = '① 数据过滤';
  $('#btn-exit-view').hidden = true;
  $('#btn-save-view').hidden = true;
  $('#filter-count').textContent = '';
  $('#chart-msg').textContent = '';
  $('#preset-select').disabled = false;
  // 视图运行时 state.schema 已是结果列的伪 schema，必须重新加载真实表结构
  if (state.dbPath && state.table) {
    loadTable(state.table);
  } else {
    $('#filter-form').innerHTML = '<div class="empty-hint">请先打开一个 .db 文件</div>';
  }
}

/* 视图展示列 -> 预览/导出用的列与表头 */
function viewDisplayInfo() {
  const disp = state.viewDisplayCols;
  const cols = disp ? disp.map(c => c.key) : state.schema.columns.map(c => c.name);
  const headers = {};
  for (const k of cols) {
    const d = disp ? disp.find(c => c.key === k) : null;
    headers[k] = (d && d.label) || state.labels[k] || k;
  }
  return { cols, headers };
}

/* ================================================================ */
/* 面板折叠（侧栏 / 数据预览）                                         */
/* ================================================================ */
const LAYOUT_KEY = 'dbchart:layout';

function loadLayout() {
  try {
    const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    if (s.side) { document.body.classList.add('side-collapsed'); }
    if (s.table) { document.body.classList.add('table-collapsed'); }
  } catch (_) { /* 忽略本地存储异常 */ }
  syncFoldUi();
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      side: document.body.classList.contains('side-collapsed'),
      table: document.body.classList.contains('table-collapsed')
    }));
  } catch (_) { /* 忽略本地存储异常 */ }
}

function syncFoldUi() {
  const bSide = $('#btn-toggle-sidebar');
  const bTable = $('#btn-toggle-table');
  const sideCollapsed = document.body.classList.contains('side-collapsed');
  const tableCollapsed = document.body.classList.contains('table-collapsed');
  if (bSide) {
    bSide.textContent = sideCollapsed ? '›' : '‹';
    bSide.title = sideCollapsed ? '展开侧栏' : '折叠侧栏，把空间让给图表';
    bSide.setAttribute('aria-expanded', sideCollapsed ? 'false' : 'true');
  }
  if (bTable) {
    bTable.textContent = tableCollapsed ? '▴' : '▾';
    bTable.title = tableCollapsed ? '展开数据预览' : '折叠数据预览，把空间让给图表';
    bTable.setAttribute('aria-expanded', tableCollapsed ? 'false' : 'true');
  }
}

function togglePanel(which) {
  if (which === 'side') document.body.classList.toggle('side-collapsed');
  else document.body.classList.toggle('table-collapsed');
  syncFoldUi();
  saveLayout();
  // 容器尺寸变化后 ECharts 必须重算画布，否则出现拉伸/留白
  if (state.chart) state.chart.resize();
}

/* ================================================================ */
/* 图表全屏（DOM 移动到覆盖层，退出时归位）                             */
/* ================================================================ */
function fullscreenOn() {
  if (!state.chart) { toast('请先绘制图表，再进入全屏', true); return; }
  const layer = $('#chart-full');
  $('#full-wrap').appendChild($('#chart'));
  layer.hidden = false;
  $('#full-title').textContent = (state.cfg && (state.cfg.title || chartTypeName(state.cfg.type))) || '图表全屏预览';
  state.fullscreen = true;
  state.chart.resize();
}

function fullscreenOff() {
  if (!state.fullscreen) return;
  $('#chart-full').hidden = true;
  $('#chart-wrap').appendChild($('#chart'));
  state.fullscreen = false;
  state.chart.resize();
}

function toggleFullscreen() { state.fullscreen ? fullscreenOff() : fullscreenOn(); }

/* ================================================================ */
/* 导出图表图片（面板尺寸 / 全屏大图）                                  */
/* ================================================================ */
function currentChartTitle() {
  return (state.cfg && (state.cfg.title || chartTypeName(state.cfg.type))) || '图表';
}

async function exportChartImage(mode) {
  if (!state.chart) { toast('请先绘制图表，再导出图片', true); return; }
  if (state.demo) { toast('演示模式不支持导出，请在 Electron 应用中使用', true); return; }
  busy(true);
  try {
    // 全屏模式：临时挂到覆盖层按全窗口尺寸重绘，导出后恢复原位
    if (mode === 'fullscreen' && !state.fullscreen) fullscreenOn();
    const chart = state.chart;
    const w = Math.max(chart.getWidth(), 10), h = Math.max(chart.getHeight(), 10);
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
    const res = await window.api.exportImage({
      dataUrl: url, width: w, height: h,
      defaultName: `${state.table || '图表'}_${currentChartTitle()}_全屏模式.png`
    });
    if (res.ok) toast(`已导出图片 (${Math.round(w)}×${Math.round(h)}) → ${res.filePath}`);
    else if (!res.canceled) toast('导出失败' + (res.error ? ': ' + res.error : ''), true);
  } catch (err) {
    toast('导出失败: ' + err.message, true);
  } finally {
    if (mode === 'fullscreen' && state.fullscreen) fullscreenOff();
    busy(false);
  }
}

function openExportMenu() {
  if (!state.chart) { toast('请先绘制图表，再导出图片', true); return; }
  $('#export-menu').hidden = false;
}

function closeExportMenu() { $('#export-menu').hidden = true; }

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
    if (state.view) {
      // 视图模式：主进程重跑完整 SQL 导出（不受绘图上限影响），列取视图展示列
      const info = viewDisplayInfo();
      const res = await window.api.exportView({
        path: state.dbPath,
        sql: state.view.sql,
        params: state.viewParamsApplied || {},
        columns: info.cols,
        headers: info.headers,
        format,
        defaultName: `${sanitizeFileName(state.view.name)}_查询结果.${format}`
      });
      if (res.ok) toast(`已导出 ${fmtN(res.count)} 行视图结果 → ${res.filePath}`);
      else if (!res.canceled) toast('导出失败' + (res.error ? ': ' + res.error : ''), true);
      return;
    }
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
  $('#btn-import-view').addEventListener('click', importViewFromFile);
  $('#btn-my-views').addEventListener('click', openViewsModal);
  $('#btn-views-close').addEventListener('click', closeViewsModal);
  $('#views-modal').addEventListener('mousedown', e => { if (e.target.id === 'views-modal') closeViewsModal(); });
  $('#btn-view-paste').addEventListener('click', openPasteModal);
  $('#btn-view-ai').addEventListener('click', openAiModal);
  $('#btn-paste-ok').addEventListener('click', importPasted);
  $('#btn-paste-cancel').addEventListener('click', closePasteModal);
  $('#paste-modal').addEventListener('mousedown', e => { if (e.target.id === 'paste-modal') closePasteModal(); });
  $('#btn-ai-close').addEventListener('click', closeAiModal);
  $('#ai-modal').addEventListener('mousedown', e => { if (e.target.id === 'ai-modal') closeAiModal(); });
  $('#btn-ai-copy').addEventListener('click', copyAiPrompt);
  $('#ai-tab-a').addEventListener('click', () => { aiMode = 'a'; renderAiPrompt(); });
  $('#ai-tab-b').addEventListener('click', () => { aiMode = 'b'; renderAiPrompt(); });
  $('#btn-save-view').addEventListener('click', () => {
    if (!state.view) return;
    try {
      const raw = state.savedRaw.get(viewIdOf(state.view)) || JSON.stringify(state.view);
      const r = upsertSavedView(raw);
      if (r.ok) toast(r.replaced ? `配置「${r.spec.name}」已保存（覆盖旧版）` : `已保存为配置「${r.spec.name}」`);
    } catch (err) { toast('保存失败: ' + err.message, true); }
  });
  $('#btn-run-view').addEventListener('click', runView);
  $('#btn-exit-view').addEventListener('click', exitView);
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
  $('#sample-limit').addEventListener('change', () => { state.view ? runView() : applyFilters(); });
  $('#btn-export-chart').addEventListener('click', exportChartData);
  $('#btn-export-full').addEventListener('click', () => exportFull('xlsx'));
  $('#btn-export-csv').addEventListener('click', () => exportFull('csv'));
  $('#btn-toggle-sidebar').addEventListener('click', () => togglePanel('side'));
  $('#side-flap').addEventListener('click', () => togglePanel('side'));
  $('#btn-toggle-table').addEventListener('click', () => togglePanel('table'));
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#btn-full-exit').addEventListener('click', fullscreenOff);
  $('#btn-export-image').addEventListener('click', openExportMenu);
  $('#btn-export-image-cancel').addEventListener('click', closeExportMenu);
  $('#export-menu').addEventListener('mousedown', e => { if (e.target.id === 'export-menu') closeExportMenu(); });
  $('#btn-export-image-ok').addEventListener('click', () => {
    const mode = (document.querySelector('input[name="export-size"]:checked') || {}).value || 'panel';
    closeExportMenu();
    exportChartImage(mode);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#paste-modal').hidden) { closePasteModal(); return; }
    if (!$('#ai-modal').hidden) { closeAiModal(); return; }
    if (!$('#views-modal').hidden) { closeViewsModal(); return; }
    if (!$('#export-menu').hidden) { closeExportMenu(); return; }
    if (state.fullscreen) fullscreenOff();
  });
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
  loadLayout();

  // 恢复配置库（多份图表配置，重启可复用）；再激活上次使用的视图
  loadSavedViews();
  try {
    const saved = localStorage.getItem(VIEW_STORE_KEY);
    if (saved) {
      const res = QueryView.validateViewSpec(JSON.parse(saved), { chartTypes: ChartBuilder.CHART_TYPES });
      if (res.ok) {
        state.view = res.spec;
        renderViewPanel();
      } else {
        localStorage.removeItem(VIEW_STORE_KEY);
      }
    }
  } catch (_) { /* 忽略本地存储异常 */ }

  const qp = new URLSearchParams(location.search);
  const dbArg = qp.get('db');
  if (dbArg) openDbPath(dbArg);
  else if (state.demo) openDbPath('demo://fire'); // 浏览器演示模式自动加载模拟数据
})();
