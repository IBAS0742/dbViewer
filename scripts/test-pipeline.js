/* Node 层数据管道测试：打开真实 db → 结构推断 → 过滤 SQL → 图表构建 → Excel/CSV 导出
 * 运行：node scripts/test-pipeline.js */
const path = require('path');
const fs = require('fs');
const os = require('os');

const DB = path.resolve(__dirname, '..', 'small_range.db');
const { createEngine, qAll, qOne, inferSchema, buildWhere, csvCell } = require('../lib/sqlite-core');
const ChartBuilder = require('../renderer/chart-builder');
const config = require('../config.json');

const labels = config.fieldLabels || {};
const lbl = c => labels[c] || c;

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  else { console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); failed++; }
}

(async () => {
  console.log('== 0. 查询视图纯逻辑（不依赖数据文件） ==');
  const QueryView = require('../lib/query-view');
  check('扫描器忽略字符串里的冒号', JSON.stringify(QueryView.extractParamNames("SELECT '12:30' AS t, :a FROM x")) === JSON.stringify(['a']),
    JSON.stringify(QueryView.extractParamNames("SELECT '12:30' AS t, :a FROM x")));
  check('扫描器忽略注释里的参数', JSON.stringify(QueryView.extractParamNames('-- :b 注释\n/* :c */ SELECT :a FROM x')) === JSON.stringify(['a']));
  check('多语句检测', QueryView.hasMultipleStatements('SELECT 1; SELECT 2') === true && QueryView.hasMultipleStatements('SELECT 1;') === false);
  check('只读校验', QueryView.isReadOnlySelect('DELETE FROM t') === false && QueryView.isReadOnlySelect('WITH t AS (SELECT 1) SELECT * FROM t') === true);
  const b1 = QueryView.buildViewSql('SELECT * FROM t WHERE a = :x AND b IN (:list)', { x: 1, list: ['p', 'q'] });
  check('数组参数展开为 IN 列表', b1.sql === 'SELECT * FROM t WHERE a = ? AND b IN (?,?)' && JSON.stringify(b1.params) === JSON.stringify([1, 'p', 'q']), b1.sql);
  const b2 = QueryView.buildViewSql('SELECT * FROM t WHERE a = :x', { x: null });
  check('空参数绑定为 NULL', b2.params.length === 1 && b2.params[0] === null);
  const b3 = QueryView.buildViewSql('SELECT * FROM t WHERE a = :x AND b = :x', { x: 5 });
  check('同名参数多处出现', b3.params.length === 2);
  let threw = false;
  try { QueryView.buildViewSql('SELECT * FROM t WHERE a = :nope', {}); } catch (_) { threw = true; }
  check('未提供的参数报错', threw);
  check('追加 LIMIT', QueryView.appendLimit('SELECT * FROM t', 100) === 'SELECT * FROM t LIMIT 100');
  check('自带 LIMIT/OFFSET 不重复追加', QueryView.appendLimit('SELECT * FROM t LIMIT 10 OFFSET 5', 100) === 'SELECT * FROM t LIMIT 10 OFFSET 5');
  const badSpec = QueryView.validateViewSpec(
    { format: 'dbchart-query-view', version: 1, name: 'x', sql: 'SELECT * FROM t WHERE a = :missing' }, {});
  check('SQL 参数未定义被拒绝', !badSpec.ok && badSpec.errors.some(e => e.includes(':missing')));
  const badChart = QueryView.validateViewSpec(
    { format: 'dbchart-query-view', version: 1, name: 'x', sql: 'SELECT 1', display: { chart: { type: 'nope' } } },
    { chartTypes: ChartBuilder.CHART_TYPES });
  check('未知图表类型被拒绝', !badChart.ok);

  if (!fs.existsSync(DB)) {
    // CI 环境通常不含 73MB 的数据文件，此时只验证模块可加载
    require('../renderer/chart-builder');
    require('../config.json');
    console.log('[skip] 未找到 small_range.db，跳过数据管道测试（模块加载正常）');
    return;
  }
  console.log('== 1. 打开数据库 & 结构推断 ==');
  const engine = createEngine();
  const db = await engine.getDb(DB);
  const tables = qAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map(t => t.name);
  check('表列表包含 fire', tables.includes('fire'), tables.join(','));
  const schema = inferSchema(db, 'fire');
  check('行数 290471', schema.total === 290471, String(schema.total));
  const kinds = Object.fromEntries(schema.columns.map(c => [c.name, c.kind]));
  check('conf 是枚举(5项)', kinds.conf === 'enum' && schema.columns.find(c => c.name === 'conf').distinct.length === 5,
    JSON.stringify(schema.columns.find(c => c.name === 'conf').distinct));
  check('year 是数值(27个取值不作枚举)', kinds.year === 'number', kinds.year);
  check('month 是枚举且完整 12 项', kinds.month === 'enum-number' && schema.columns.find(c => c.name === 'month').distinct.length === 12,
    JSON.stringify(schema.columns.find(c => c.name === 'month').distinct));
  check('elevation 是数值', kinds.elevation === 'number');
  check('ACQ_DATE 是日期', kinds.ACQ_DATE === 'date');
  check('SATELLITE 是枚举', kinds.SATELLITE === 'enum');
  check('ACQ_TIME 是文本', kinds.ACQ_TIME === 'string');
  const kindOf = c => kinds[c] || 'string';

  console.log('== 2. 过滤条件 -> SQL ==');
  const filters = [
    { col: 'conf', op: 'in', values: ['conf70', 'conf80'], numeric: false },
    { col: 'year', op: 'between', values: [2015, 2020], numeric: true },
    { col: 'elevation', op: 'between', values: [1000, 3000], numeric: true },
    { col: 'SATELLITE', op: 'like', value: 'Aqua' }
  ];
  const { where, params } = buildWhere(filters);
  const n1 = qOne(db, `SELECT COUNT(*) AS c FROM "fire" ${where}`, params).c;
  const n2 = qOne(db, `SELECT COUNT(*) AS c FROM "fire" WHERE conf IN ('conf70','conf80') AND year BETWEEN 2015 AND 2020 AND elevation >= 1000 AND elevation <= 3000 AND SATELLITE = 'Aqua'`).c;
  check('参数化过滤计数与直接 SQL 一致', n1 === n2 && n1 > 0, `${n1} vs ${n2}`);

  const dateF = [{ col: 'ACQ_DATE', op: 'between', values: ['2020-01-01', '2020-12-31'], numeric: false }];
  const dw = buildWhere(dateF);
  const dn1 = qOne(db, `SELECT COUNT(*) AS c FROM "fire" ${dw.where}`, dw.params).c;
  const dn2 = qOne(db, `SELECT COUNT(*) AS c FROM "fire" WHERE ACQ_DATE >= '2020-01-01' AND ACQ_DATE < date('2021-01-01')`).c;
  check('日期区间(含 T00:00 存储)计数一致', dn1 === dn2 && dn1 > 0, `${dn1} vs ${dn2}`);

  console.log('== 3. 查询行数据 ==');
  const limit = 20000;
  const rows = qAll(db, `SELECT * FROM "fire" ${where} LIMIT ${limit}`, params);
  const total = n1;
  check('返回行数 = min(total, limit)', rows.length === Math.min(total, limit), `${rows.length}`);
  check('行包含全部字段', Object.keys(rows[0]).length === schema.columns.length, `${Object.keys(rows[0]).length}`);

  console.log('== 3.5 等间隔抽样（rowid 取模）==');
  const { sampleQuery } = require('../lib/sqlite-core');
  const s1 = sampleQuery(db, 'fire', [], 20000);
  const yearSet = new Set(s1.rows.map(r => r.year));
  check('无过滤抽样行数 ≈ 上限', s1.rows.length >= 15000 && s1.rows.length <= 20000, `${s1.rows.length}`);
  check('抽样覆盖全部 27 个年份', yearSet.size === 27, `覆盖 ${yearSet.size} 年`);
  const s2 = sampleQuery(db, 'fire', filters, 20000);
  check('过滤后不足上限时不抽样', s2.limited === false && s2.rows.length === total, `${s2.rows.length}/${total}`);

  console.log('== 4. 全部预设图表构建 ==');
  const ctx = { lbl, kind: kindOf };
  for (const p of config.chartPresets) {
    // 预设自身 filters 也走同一过滤管道
    let rws = rows, tot = total;
    if (p.filters && p.filters.length) {
      const w = buildWhere([...filters, ...p.filters]);
      tot = qOne(db, `SELECT COUNT(*) AS c FROM "fire" ${w.where}`, w.params).c;
      rws = qAll(db, `SELECT * FROM "fire" ${w.where} LIMIT ${limit}`, w.params);
    }
    const res = ChartBuilder.build(p.type, p, rws, ctx);
    const ok = !res.error && res.option && res.option.series && res.option.series.length &&
               res.chartData && res.chartData.rows.length > 0;
    check(p.name, ok, res.error || `图上数据 ${res.chartData ? res.chartData.rows.length : 0} 条 / 行数据 ${rws.length}`);
    if (ok && p.type === 'heatmap') {
      const sum = res.chartData.rows.reduce((s, r) => s + r.value, 0);
      check(`  热力图计数守恒(≤行数)`, sum <= rws.length, `聚合合计 ${sum} / 行 ${rws.length}`);
    }
  }

  console.log('== 4.5 查询视图连库管道（examples/views） ==');
  const viewsDir = path.join(__dirname, '..', 'examples', 'views');
  const viewFiles = fs.readdirSync(viewsDir).filter(f => f.endsWith('.json'));
  check('示例视图文件存在', viewFiles.length >= 3, viewFiles.join(', '));
  for (const f of viewFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(viewsDir, f), 'utf8'));
    const v = QueryView.validateViewSpec(raw, { chartTypes: ChartBuilder.CHART_TYPES });
    if (!v.ok) { check(`${f} 规范校验`, false, v.errors.join('；')); continue; }
    const spec = v.spec;
    const built = QueryView.buildViewSql(spec.sql, QueryView.defaultParamValues(spec));
    let vtotal = 0, vrows = [], colNames = [];
    try {
      vtotal = qOne(db, QueryView.countWrap(built.sql), built.params).c;
      vrows = qAll(db, QueryView.appendLimit(built.sql, 500), built.params);
      colNames = vrows[0] ? Object.keys(vrows[0]) : [];
    } catch (err) {
      check(`${spec.name} 查询执行`, false, err.message);
      continue;
    }
    check(`${spec.name} 默认参数能查出数据`, vtotal > 0 && vrows.length > 0, `${vtotal} 行`);
    if (spec.display && spec.display.columns) {
      const missing = spec.display.columns.filter(c => !colNames.includes(c.key));
      check(`${spec.name} 展示列都在结果集中`, missing.length === 0, missing.map(c => c.key).join(','));
    }
    if (spec.display && spec.display.chart) {
      const kinds = Object.fromEntries(QueryView.inferResultColumns(colNames, vrows).map(c => [c.name, c.kind]));
      const out = ChartBuilder.build(spec.display.chart.type, spec.display.chart, vrows, { lbl, kind: c => kinds[c] || 'string' });
      check(`${spec.name} 图表能构建`, !out.error && out.chartData && out.chartData.rows.length > 0,
        out.error || `图上 ${out.chartData.rows.length} 条`);
    }
  }

  console.log('== 5. Excel / CSV 导出（主进程同款逻辑） ==');
  const XLSX = require('xlsx');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-'));
  const head = schema.columns.map(c => lbl(c.name) || c.name);
  const aoa = [head, ...rows.slice(0, 1000).map(r => schema.columns.map(c => (r[c.name] === undefined ? null : r[c.name])))];
  const ws = XLSX.utils.aoa_to_sheet(aoa, { dense: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'fire');
  const xlsxPath = path.join(tmp, 'test.xlsx');
  XLSX.writeFile(wb, xlsxPath, { dense: true });
  check('xlsx 写出', fs.statSync(xlsxPath).size > 10000, `${(fs.statSync(xlsxPath).size / 1024).toFixed(0)} KB`);

  const csvLines = [head.map(csvCell).join(',')];
  for (const r of rows.slice(0, 1000)) csvLines.push(schema.columns.map(c => csvCell(r[c.name])).join(','));
  const csvPath = path.join(tmp, 'test.csv');
  fs.writeFileSync(csvPath, '\ufeff' + csvLines.join('\r\n'));
  check('csv 写出', fs.statSync(csvPath).size > 10000, `${(fs.statSync(csvPath).size / 1024).toFixed(0)} KB`);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('测试异常:', err); process.exit(1); });
