/*
 * chart-builder.js — 纯函数模块：把「过滤后的行数据 + 图表配置」转换成
 * ECharts option 和可供导出的扁平数据。
 * 在渲染进程通过 <script> 加载（挂到 window.ChartBuilder），
 * 也可以在 Node 里 require() 做单元测试。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ChartBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHART_TYPES = [
    { type: 'line',      name: '折线图',        need: 'x' },
    { type: 'area',      name: '面积图',        need: 'x' },
    { type: 'bar',       name: '柱状图',        need: 'x' },
    { type: 'hbar',      name: '条形图(横向)',   need: 'x' },
    { type: 'scatter',   name: '散点图',        need: 'x,y' },
    { type: 'bubble',    name: '气泡图',        need: 'x,y,size' },
    { type: 'pie',       name: '饼图',          need: 'name' },
    { type: 'doughnut',  name: '环形图',        need: 'name' },
    { type: 'funnel',    name: '漏斗图',        need: 'name' },
    { type: 'heatmap',   name: '热力图',        need: 'x,y' },
    { type: 'bar3D',     name: '3D柱状图',      need: 'x,y' },
    { type: 'scatter3D', name: '3D散点图',      need: 'x,y,z' }
  ];

  const AGGS = [
    { value: 'count',  name: '计数' },
    { value: 'sum',    name: '求和' },
    { value: 'avg',    name: '平均' },
    { value: 'max',    name: '最大' },
    { value: 'min',    name: '最小' },
    { value: 'direct', name: '原值(数据已聚合)' }
  ];

  /* ---------------- 工具函数 ---------------- */

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  function decimalsFor(span, bins) {
    const step = (span / Math.max(bins, 1)) || 1;
    if (step >= 10) return 0;
    if (step >= 1) return step % 1 === 0 ? 0 : 1;
    if (step >= 0.1) return 1;
    return 2;
  }

  function fmtN(n, d) {
    if (!isFinite(n)) return '-';
    const s = n.toFixed(d === undefined ? 2 : d);
    return s.replace(/\.?0+$/, '');
  }

  function axisTitleFor(cfg, lbl) {
    // direct：数据在 SQL 里已聚合（查询视图），坐标轴直接用结果列名
    if (cfg.agg === 'direct' && cfg.value) return lbl(cfg.value);
    if (!cfg.value || cfg.agg === 'count') return '数量';
    const names = { sum: '求和', avg: '平均', max: '最大', min: '最小' };
    return `${names[cfg.agg] || cfg.agg}(${lbl(cfg.value)})`;
  }

  /* 数值/分类轴的 key 提取。数值高基数自动分箱。 */
  function axisKeys(rows, col, kind, binsOpt) {
    if (kind === 'number') {
      const nums = [];
      for (const r of rows) {
        const n = toNum(r[col]);
        if (n !== null) nums.push(n);
      }
      const distinct = [...new Set(nums)];
      if (distinct.length <= Math.max(30, binsOpt || 0)) {
        distinct.sort((a, b) => a - b);
        // 统一转字符串，与分类轴/网格聚合的 key 保持一致
        return {
          keyFn: v => { const n = toNum(v); return n === null ? null : String(n); },
          keys: distinct.map(String),
          isBin: false
        };
      }
      const bins = Math.max(2, binsOpt || 20);
      const min = Math.min(...distinct);
      const max = Math.max(...distinct);
      if (max === min) return { keyFn: v => (toNum(v) === null ? null : String(min)), keys: [String(min)], isBin: false };
      const d = decimalsFor(max - min, bins);
      const step = (max - min) / bins;
      const label = i => {
        const a = min + i * step;
        const b = a + step;
        return i === bins - 1 ? `[${fmtN(a, d)}, ${fmtN(max, d)}]` : `[${fmtN(a, d)}, ${fmtN(b, d)})`;
      };
      const keys = [];
      for (let i = 0; i < bins; i++) keys.push(label(i));
      return {
        keyFn: v => {
          const n = toNum(v);
          if (n === null) return null;
          let i = Math.floor((n - min) / step);
          if (i >= bins) i = bins - 1;
          if (i < 0) i = 0;
          return keys[i];
        },
        keys, isBin: true
      };
    }
    // 分类轴
    const count = new Map();
    for (const r of rows) {
      const v = r[col];
      if (v === null || v === undefined || v === '') continue;
      const s = String(v);
      count.set(s, (count.get(s) || 0) + 1);
    }
    let keys = [...count.keys()];
    if (keys.length && keys.every(k => isFinite(Number(k)))) keys.sort((a, b) => Number(a) - Number(b));
    else keys.sort((a, b) => (count.get(b) || 0) - (count.get(a) || 0));
    let capped = false;
    if (keys.length > 120) { keys = keys.slice(0, 120); capped = true; }
    return { keyFn: v => (v === null || v === undefined || v === '' ? null : String(v)), keys, isBin: false, capped };
  }

  /* 分组聚合。返回 map: seriesKey -> xKey -> {count, n, sum, min, max} */
  function pivot(rows, cfg, xAxis, sAxis) {
    const map = new Map();
    for (const r of rows) {
      const xk = xAxis.keyFn(r[cfg.x]);
      if (xk === null) continue;
      const sk = sAxis ? (sAxis.keyFn(r[cfg.series]) ?? '(空)') : '_';
      let sm = map.get(sk);
      if (!sm) { sm = new Map(); map.set(sk, sm); }
      let acc = sm.get(xk);
      if (!acc) { acc = { count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity }; sm.set(xk, acc); }
      acc.count++;
      if (cfg.value && cfg.agg !== 'count') {
        const n = toNum(r[cfg.value]);
        if (n !== null) { acc.n++; acc.sum += n; if (n < acc.min) acc.min = n; if (n > acc.max) acc.max = n; }
      }
    }
    const val = a => {
      if (!a) return null;
      switch (cfg.agg) {
        case 'sum': case 'direct': return a.n ? a.sum : null;
        case 'avg': return a.n ? a.sum / a.n : null;
        case 'max': return a.n ? a.max : null;
        case 'min': return a.n ? a.min : null;
        default: return a.count;
      }
    };
    return { map, val };
  }

  function orderKeys(keys, sort, totals) {
    const arr = keys.slice();
    if (sort === 'x-desc') arr.reverse();
    else if (sort === 'value-asc' && totals) arr.sort((a, b) => (totals.get(a) || 0) - (totals.get(b) || 0));
    else if (sort === 'value-desc' && totals) arr.sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0));
    return arr;
  }

  function commonOption(cfg, lbl) {
    return {
      title: { text: cfg.title || '', left: 'center', top: 8, textStyle: { fontSize: 15 } },
      tooltip: { trigger: 'axis' },
      toolbox: {
        right: 12, top: 4,
        feature: { saveAsImage: { title: '保存图片' }, restore: { show: false } }
      },
      grid: { left: 70, right: 30, top: cfg.title ? 52 : 30, bottom: 70, containLabel: false }
    };
  }

  function palette(n) {
    const base = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#dc2626', '#ca8a04', '#4f46e5'];
    if (n <= base.length) return base;
    const out = [];
    for (let i = 0; i < n; i++) out.push(base[i % base.length]);
    return out;
  }

  /* ---------------- 各类型构建器 ---------------- */

  /* line / area / bar / hbar：分类(或分箱)X 轴 + 聚合值 */
  function buildCategoryChart(type, cfg, rows, ctx) {
    const lbl = ctx.lbl;
    const xAxis = axisKeys(rows, cfg.x, ctx.kind(cfg.x), cfg.xBins);
    const sAxis = cfg.series ? axisKeys(rows, cfg.series, ctx.kind(cfg.series), 30) : null;
    const { map, val } = pivot(rows, cfg, xAxis, sAxis);

    // X 轴排序（按值排序时以各系列合计为准）
    const totals = new Map();
    for (const xk of xAxis.keys) {
      let t = 0;
      for (const sm of map.values()) t += (val(sm.get(xk)) || 0);
      totals.set(xk, t);
    }
    const xKeys = orderKeys(xAxis.keys, cfg.sort || 'x-asc', totals);

    let seriesKeys = ['_'];
    if (sAxis) {
      seriesKeys = [...map.keys()].sort((a, b) => {
        const ta = [...map.get(a).values()].reduce((s, x) => s + (val(x) || 0), 0);
        const tb = [...map.get(b).values()].reduce((s, x) => s + (val(x) || 0), 0);
        return tb - ta;
      });
      if (seriesKeys.length > 30) seriesKeys = seriesKeys.slice(0, 30);
    }

    const keyIndex = new Map(xKeys.map((k, i) => [k, i]));
    const aggName = axisTitleFor(cfg, lbl);
    const series = seriesKeys.map(sk => {
      const sm = map.get(sk) || new Map();
      const data = xKeys.map(xk => {
        const v = val(sm.get(xk));
        return v === null ? null : Math.round(v * 1e6) / 1e6;
      });
      const name = sk === '_' ? aggName : sk;
      const s = { name, type: type === 'area' ? 'line' : (type === 'hbar' ? 'bar' : type), data };
      if (type === 'line' || type === 'area') {
        s.smooth = true;
        s.symbol = xKeys.length > 60 ? 'none' : 'circle';
        s.symbolSize = 6;
        s.lineStyle = { width: 2 };
      }
      if (type === 'area') s.areaStyle = { opacity: 0.25 };
      if (type === 'bar' && cfg.stacked && sAxis) s.stack = 'total';
      if (type === 'bar') s.itemStyle = { borderRadius: [3, 3, 0, 0] };
      return s;
    });

    const rotate = xKeys.length > 14 || xKeys.some(k => String(k).length > 8);
    const catAxis = {
      type: 'category',
      data: xKeys,
      name: lbl(cfg.x),
      nameLocation: 'middle',
      nameGap: rotate ? 46 : 30,
      axisLabel: { rotate: rotate ? (xKeys.length > 40 ? 90 : 40) : 0, hideOverlap: true }
    };
    const valAxis = { type: 'value', name: aggName, scale: cfg.agg !== 'count' };

    const option = commonOption(cfg, lbl);
    option.legend = sAxis ? { top: 30, type: 'scroll' } : undefined;
    if (type === 'hbar') {
      option.xAxis = valAxis;
      option.yAxis = { ...catAxis, name: '', inverse: true, axisLabel: { hideOverlap: true }, nameGap: 20 };
      option.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' } };
      option.grid = { left: 30, right: 40, top: cfg.title ? 52 : 30, bottom: 50, containLabel: true };
    } else {
      option.xAxis = catAxis;
      option.yAxis = valAxis;
      option.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' } };
    }
    option.series = series;
    if (xKeys.length > 40 && type !== 'hbar') {
      option.dataZoom = [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 12 }];
    }

    // 导出数据
    const chartRows = [];
    const colDefs = [{ key: 'x', label: lbl(cfg.x) }];
    if (sAxis) colDefs.push({ key: 'series', label: lbl(cfg.series) });
    colDefs.push({ key: 'value', label: aggName });
    for (const sk of seriesKeys) {
      const sm = map.get(sk) || new Map();
      for (const xk of xKeys) {
        const v = val(sm.get(xk));
        if (v === null) continue;
        const r = { x: xk, value: Math.round(v * 1e6) / 1e6 };
        if (sAxis) r.series = sk;
        chartRows.push(r);
      }
    }
    return { option, chartData: { columns: colDefs, rows: chartRows } };
  }

  /* pie / doughnut / funnel：按名称字段聚合 */
  function buildPieChart(type, cfg, rows, ctx) {
    const lbl = ctx.lbl;
    const nameField = cfg.nameField || cfg.name; // 兼容旧写法
    const nAxis = axisKeys(rows, nameField, ctx.kind(nameField), 60);
    const aggName = axisTitleFor(cfg, lbl);
    const totals = new Map();
    for (const r of rows) {
      const k = nAxis.keyFn(r[nameField]);
      if (k === null) continue;
      let acc = totals.get(k);
      if (!acc) { acc = { count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity }; totals.set(k, acc); }
      acc.count++;
      if (cfg.value && cfg.agg !== 'count') {
        const n = toNum(r[cfg.value]);
        if (n !== null) { acc.n++; acc.sum += n; if (n < acc.min) acc.min = n; if (n > acc.max) acc.max = n; }
      }
    }
    const pick = a => (cfg.agg === 'sum' || cfg.agg === 'direct') ? a.sum
      : cfg.agg === 'avg' ? (a.n ? a.sum / a.n : 0)
        : cfg.agg === 'max' ? a.max : cfg.agg === 'min' ? a.min : a.count;
    let data = nAxis.keys.map(k => ({ name: k, value: Math.round(pick(totals.get(k)) * 1e6) / 1e6 }))
      .filter(d => d.value > 0 || cfg.agg !== 'count')
      .sort((a, b) => b.value - a.value);
    if (data.length > 60) data = data.slice(0, 60);

    const option = commonOption(cfg, lbl);
    option.tooltip = { trigger: 'item', formatter: '{b}<br/>{c} ({d}%)' };
    option.legend = data.length > 8 ? { type: 'scroll', orient: 'vertical', right: 8, top: 'middle' } : { top: 30 };
    option.grid = undefined;
    option.series = [{
      name: aggName,
      type: type === 'doughnut' ? 'pie' : type,
      radius: type === 'doughnut' ? ['42%', '68%'] : '62%',
      center: data.length > 8 ? ['40%', '55%'] : ['50%', '55%'],
      data,
      label: { formatter: '{b}\n{c} ({d}%)' },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.25)' } }
    }];
    if (type === 'funnel') {
      option.series[0] = {
        name: aggName, type: 'funnel', sort: 'descending', gap: 3,
        left: '8%', width: '70%',
        label: { position: 'inside', formatter: '{b}: {c}' },
        data
      };
      option.legend = undefined;
      option.tooltip = { trigger: 'item', formatter: '{b}<br/>{c}' };
    }

    const chartRows = data.map(d => ({ name: d.name, value: d.value }));
    return {
      option,
      chartData: { columns: [{ key: 'name', label: lbl(nameField) }, { key: 'value', label: aggName }], rows: chartRows }
    };
  }

  /* scatter / bubble */
  function buildScatterChart(type, cfg, rows, ctx) {
    const lbl = ctx.lbl;
    const groups = new Map();
    if (cfg.series) {
      for (const r of rows) {
        const k = r[cfg.series] === null || r[cfg.series] === undefined || r[cfg.series] === '' ? '(空)' : String(r[cfg.series]);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
    } else {
      groups.set('数据', rows);
    }
    // 系列过多时合并
    let entries = [...groups.entries()];
    if (entries.length > 20) {
      entries.sort((a, b) => b[1].length - a[1].length);
      const top = entries.slice(0, 19);
      const rest = entries.slice(19).flatMap(e => e[1]);
      if (rest.length) top.push(['其他', rest]);
      entries = top;
    }

    let sizeMin = Infinity, sizeMax = -Infinity;
    if (type === 'bubble' && cfg.size) {
      for (const r of rows) {
        const n = toNum(r[cfg.size]);
        if (n !== null) { if (n < sizeMin) sizeMin = n; if (n > sizeMax) sizeMax = n; }
      }
      if (!isFinite(sizeMin)) { sizeMin = 0; sizeMax = 1; }
    }
    const sizeOf = v => {
      if (type !== 'bubble' || !cfg.size || sizeMax === sizeMin) return 8;
      const t = (v - sizeMin) / (sizeMax - sizeMin);
      return 5 + 40 * Math.sqrt(Math.max(0, Math.min(1, t)));
    };

    const series = entries.map(([name, gRows], gi) => ({
      name,
      type: 'scatter',
      data: gRows.map(r => {
        const x = toNum(r[cfg.x]);
        const y = toNum(r[cfg.y]);
        if (x === null || y === null) return null;
        if (type === 'bubble' && cfg.size) {
          const s = toNum(r[cfg.size]);
          return { value: [x, y], s0: s === null ? null : s, symbolSize: sizeOf(s === null ? sizeMin : s) };
        }
        return [x, y];
      }).filter(Boolean),
      symbolSize: type === 'bubble' ? undefined : 7,
      itemStyle: { opacity: 0.65, color: palette(entries.length)[gi % palette(entries.length).length] },
      large: gRows.length > 5000,
      largeThreshold: 3000
    }));

    const option = commonOption(cfg, lbl);
    option.tooltip = {
      trigger: 'item',
      formatter: p => {
        const v = Array.isArray(p.value) ? p.value : p.value.value;
        let s = `${lbl(cfg.x)}: ${fmtN(v[0])}<br/>${lbl(cfg.y)}: ${fmtN(v[1])}`;
        if (type === 'bubble' && cfg.size && p.data.s0 !== null && p.data.s0 !== undefined) s += `<br/>${lbl(cfg.size)}: ${fmtN(p.data.s0)}`;
        if (cfg.series) s = `${p.seriesName}<br/>` + s;
        return s;
      }
    };
    option.xAxis = { type: 'value', name: lbl(cfg.x), scale: true, nameLocation: 'middle', nameGap: 28 };
    option.yAxis = { type: 'value', name: lbl(cfg.y), scale: true, nameLocation: 'middle', nameGap: 45 };
    option.legend = cfg.series ? { top: 30, type: 'scroll' } : undefined;
    option.series = series;

    const colDefs = [{ key: 'x', label: lbl(cfg.x) }, { key: 'y', label: lbl(cfg.y) }];
    if (type === 'bubble' && cfg.size) colDefs.push({ key: 'size', label: lbl(cfg.size) });
    if (cfg.series) colDefs.push({ key: 'series', label: lbl(cfg.series) });
    const chartRows = [];
    for (const ser of series) {
      for (const item of ser.data) {
        const row = { x: item[0] ?? item.value[0], y: item[1] ?? item.value[1] };
        if (type === 'bubble' && cfg.size) row.size = item.s0;
        if (cfg.series) row.series = ser.name;
        chartRows.push(row);
      }
    }
    return { option, chartData: { columns: colDefs, rows: chartRows } };
  }

  /* heatmap / bar3D：二维网格聚合，颜色(或高度)表示值 */
  function buildGridChart(type, cfg, rows, ctx) {
    const lbl = ctx.lbl;
    const xAxis = axisKeys(rows, cfg.x, ctx.kind(cfg.x), cfg.xBins);
    const yAxis = axisKeys(rows, cfg.y, ctx.kind(cfg.y), cfg.yBins || 12);
    const aggName = axisTitleFor(cfg, lbl);

    const grid = new Map();
    for (const r of rows) {
      const xk = xAxis.keyFn(r[cfg.x]);
      const yk = yAxis.keyFn(r[cfg.y]);
      if (xk === null || yk === null) continue;
      const key = xk + '\u0001' + yk;
      let acc = grid.get(key);
      if (!acc) { acc = { count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity }; grid.set(key, acc); }
      acc.count++;
      if (cfg.value && cfg.agg !== 'count') {
        const n = toNum(r[cfg.value]);
        if (n !== null) { acc.n++; acc.sum += n; if (n < acc.min) acc.min = n; if (n > acc.max) acc.max = n; }
      }
    }
    const val2 = a => {
      if (!a) return null;
      switch (cfg.agg) {
        case 'sum': case 'direct': return a.n ? a.sum : null;
        case 'avg': return a.n ? a.sum / a.n : null;
        case 'max': return a.n ? a.max : null;
        case 'min': return a.n ? a.min : null;
        default: return a.count;
      }
    };
    let minV = Infinity, maxV = -Infinity;
    const data = [];
    for (const [key, acc] of grid) {
      const [xk, yk] = key.split('\u0001');
      const xi = xAxis.keys.indexOf(xk);
      const yi = yAxis.keys.indexOf(yk);
      const v = val2(acc);
      if (xi < 0 || yi < 0 || v === null) continue;
      data.push({ value: [xi, yi, Math.round(v * 1e6) / 1e6] });
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!isFinite(minV)) { minV = 0; maxV = 1; }

    const visualMap = {
      min: minV, max: maxV, calculable: true,
      orient: 'horizontal', left: 'center', bottom: 8,
      inRange: type === 'heatmap'
        ? { color: ['#e0f2fe', '#7dd3fc', '#38bdf8', '#0284c7', '#075985', '#1e3a5f'] }
        : { color: ['#93c5fd', '#3b82f6', '#1d4ed8'] },
      text: ['高', '低']
    };

    const option = commonOption(cfg, lbl);
    option.visualMap = visualMap;
    option.tooltip = {
      position: 'top',
      formatter: p => {
        const [xi, yi, v] = p.value;
        return `${lbl(cfg.x)}: ${xAxis.keys[xi]}<br/>${lbl(cfg.y)}: ${yAxis.keys[yi]}<br/>${aggName}: ${fmtN(v)}`;
      }
    };

    if (type === 'heatmap') {
      option.grid = { left: 90, right: 40, top: cfg.title ? 52 : 30, bottom: 110 };
      option.xAxis = {
        type: 'category', data: xAxis.keys, name: lbl(cfg.x),
        nameLocation: 'middle', nameGap: 40,
        axisLabel: { rotate: xAxis.keys.length > 16 ? 45 : 0, hideOverlap: true },
        splitArea: { show: true }
      };
      option.yAxis = {
        type: 'category', data: yAxis.keys, name: lbl(cfg.y),
        nameLocation: 'middle', nameGap: 60, splitArea: { show: true }
      };
      option.series = [{
        type: 'heatmap', data,
        emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } }
      }];
    } else {
      option.grid = undefined;
      option.tooltip = undefined;
      option.visualMap.orient = 'vertical';
      option.visualMap.left = 8;
      option.visualMap.bottom = 'center';
      option.xAxis3D = { type: 'category', data: xAxis.keys, name: lbl(cfg.x) };
      option.yAxis3D = { type: 'category', data: yAxis.keys, name: lbl(cfg.y) };
      option.zAxis3D = { type: 'value', name: aggName };
      option.grid3D = {
        boxWidth: 110, boxDepth: 90, boxHeight: 70,
        viewControl: { distance: 220, alpha: 22, beta: 40 },
        light: { main: { intensity: 1.2 }, ambient: { intensity: 0.3 } }
      };
      option.series = [{
        type: 'bar3D', data, shading: 'lambert',
        barSize: 2.5,
        emphasis: { itemStyle: { color: '#f59e0b' } }
      }];
    }

    const rowsOut = data.map(d => ({
      x: xAxis.keys[d.value[0]], y: yAxis.keys[d.value[1]], value: d.value[2]
    }));
    return {
      option,
      chartData: {
        columns: [{ key: 'x', label: lbl(cfg.x) }, { key: 'y', label: lbl(cfg.y) }, { key: 'value', label: aggName }],
        rows: rowsOut
      }
    };
  }

  /* scatter3D */
  function buildScatter3D(cfg, rows, ctx) {
    const lbl = ctx.lbl;
    let minV = Infinity, maxV = -Infinity;
    const data = [];
    for (const r of rows) {
      const x = toNum(r[cfg.x]);
      const y = toNum(r[cfg.y]);
      const z = toNum(r[cfg.z]);
      if (x === null || y === null || z === null) continue;
      let c = null;
      if (cfg.value) {
        c = toNum(r[cfg.value]);
        if (c !== null) { if (c < minV) minV = c; if (c > maxV) maxV = c; }
      }
      data.push(c === null ? [x, y, z] : [x, y, z, c]);
    }
    if (!isFinite(minV)) { minV = 0; maxV = 1; }

    const option = commonOption(cfg, lbl);
    option.tooltip = undefined;
    option.grid = undefined;
    option.xAxis3D = { type: 'value', name: lbl(cfg.x) };
    option.yAxis3D = { type: 'value', name: lbl(cfg.y) };
    option.zAxis3D = { type: 'value', name: lbl(cfg.z) };
    option.grid3D = {
      boxWidth: 100, boxDepth: 100, boxHeight: 80,
      viewControl: { distance: 240, alpha: 22, beta: 40 },
      light: { main: { intensity: 1.2 }, ambient: { intensity: 0.3 } }
    };
    const series = {
      type: 'scatter3D', data,
      symbolSize: 6,
      shading: 'color',
      itemStyle: { opacity: 0.8, color: cfg.value ? undefined : '#2563eb' }
    };
    if (cfg.value) {
      option.visualMap = {
        min: minV, max: maxV, calculable: true,
        orient: 'vertical', left: 8, bottom: 'center',
        text: [lbl(cfg.value) + ' 高', lbl(cfg.value) + ' 低'],
        dimension: 3,
        inRange: { color: ['#2563eb', '#16a34a', '#eab308', '#dc2626'] }
      };
    }
    option.series = [series];

    const colDefs = [
      { key: 'x', label: lbl(cfg.x) }, { key: 'y', label: lbl(cfg.y) }, { key: 'z', label: lbl(cfg.z) }
    ];
    if (cfg.value) colDefs.push({ key: 'c', label: lbl(cfg.value) });
    const chartRows = data.map(d => {
      const r = { x: d[0], y: d[1], z: d[2] };
      if (cfg.value) r.c = d[3];
      return r;
    });
    return { option, chartData: { columns: colDefs, rows: chartRows } };
  }

  /* ---------------- 入口 ---------------- */

  function build(type, cfg, rows, ctx) {
    if (!rows || !rows.length) {
      return { option: null, chartData: null, error: '当前过滤条件下没有数据' };
    }
    cfg = Object.assign({}, cfg);
    // 分类图表中「数值字段」在表单里叫 y，聚合逻辑统一叫 value
    if ((type === 'line' || type === 'area' || type === 'bar' || type === 'hbar') && cfg.y && !cfg.value) {
      cfg.value = cfg.y;
    }
    switch (type) {
      case 'line': case 'area': case 'bar': case 'hbar':
        return buildCategoryChart(type, cfg, rows, ctx);
      case 'pie': case 'doughnut': case 'funnel':
        return buildPieChart(type, cfg, rows, ctx);
      case 'scatter': case 'bubble':
        return buildScatterChart(type, cfg, rows, ctx);
      case 'heatmap': case 'bar3D':
        return buildGridChart(type, cfg, rows, ctx);
      case 'scatter3D':
        return buildScatter3D(cfg, rows, ctx);
      default:
        return { option: null, chartData: null, error: `未知图表类型: ${type}` };
    }
  }

  /* 某类型需要哪些配置项（用于渲染动态表单） */
  function formFieldsFor(type) {
    switch (type) {
      case 'line': case 'area': case 'bar': case 'hbar':
        return ['x', 'xBins', 'series', 'y', 'agg', 'stacked', 'sort', 'title'];
      case 'scatter':
        return ['x', 'y', 'series', 'title'];
      case 'bubble':
        return ['x', 'y', 'size', 'series', 'title'];
      case 'pie': case 'doughnut': case 'funnel':
        return ['nameField', 'value', 'agg', 'title'];
      case 'heatmap':
        return ['x', 'xBins', 'y', 'yBins', 'value', 'agg', 'title'];
      case 'bar3D':
        return ['x', 'xBins', 'y', 'yBins', 'value', 'agg', 'title'];
      case 'scatter3D':
        return ['x', 'y', 'z', 'value', 'title'];
      default:
        return ['x', 'title'];
    }
  }

  return { build, formFieldsFor, axisKeys, CHART_TYPES, AGGS };
});
