/* 查询视图（.view.json）校验器 —— 发布者（或生成视图的 AI）在交付前必须运行本脚本验证。
 *
 * 用法：
 *   node scripts/validate-view.js <视图1.view.json> [视图2...] [--db=路径.db]
 *   node scripts/validate-view.js --inspect [路径.db]      # 查看库中的表/字段/类型（生成 SQL 前用）
 *
 * --db 不传时默认用仓库根目录 small_range.db；数据文件不存在时只做结构校验，
 * 连库检查自动跳过（CI 环境无数据文件也能跑）。任一文件校验失败则退出码为 1。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'small_range.db');
const QueryView = require('../lib/query-view');
const ChartBuilder = require('../renderer/chart-builder');
const { createEngine, qAll, qOne, quoteIdent, inferSchema } = require('../lib/sqlite-core');

let dbPath = null;
let inspect = false;
const files = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--db=')) dbPath = path.resolve(a.slice(5));
  else if (a === '--inspect') inspect = true;
  else files.push(a);
}

let failed = 0;
function say(ok, name, extra) {
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
}

async function inspectDb(file) {
  if (!fs.existsSync(file)) {
    console.error(`数据库文件不存在: ${file}`);
    process.exit(1);
  }
  const engine = createEngine();
  const db = await engine.getDb(file);
  const tables = qAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map(t => t.name);
  const out = [];
  for (const name of tables) {
    const total = qOne(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).c;
    const schema = inferSchema(db, name);
    out.push({
      table: name,
      rows: total,
      columns: schema.columns.map(c => ({
        name: c.name,
        kind: c.kind,
        ...(c.distinct ? { distinct: c.distinct.slice(0, 30) } : {}),
        ...(c.kind === 'number' ? { min: c.min, max: c.max } : {})
      }))
    });
  }
  console.log(`# ${file}`);
  console.log(JSON.stringify(out, null, 2));
}

async function validateFile(file, db) {
  console.log(`\n== ${path.relative(ROOT, file) || file} ==`);
  if (!fs.existsSync(file)) { say(false, '文件存在', file); return; }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    say(true, 'JSON 解析');
  } catch (err) {
    say(false, 'JSON 解析', err.message);
    return;
  }

  const res = QueryView.validateViewSpec(raw, { chartTypes: ChartBuilder.CHART_TYPES });
  for (const e of res.errors) say(false, '规范校验', e);
  if (res.errors.length) return;
  say(true, '规范校验');
  for (const w of res.warnings) console.log(`  ⚠ ${w}`);
  const spec = res.spec;
  console.log(`  视图: ${spec.name}${spec.params.length ? `（${spec.params.length} 个参数）` : '（无参数）'}`);

  // 用默认参数值做绑定，验证每个 :参数 都能取到值
  let built;
  try {
    built = QueryView.buildViewSql(spec.sql, QueryView.defaultParamValues(spec));
    say(true, '参数绑定', `${built.params.length} 个绑定值`);
  } catch (err) {
    say(false, '参数绑定', err.message);
    return;
  }

  if (!db) {
    console.log('  ⚠ 未找到数据库文件，跳过连库检查（结构校验已通过）');
    return;
  }

  // 连库：SQL 必须能编译（语法/表/列都存在）、默认参数下能查出数据
  let total, rows, columns;
  try {
    total = qOne(db, QueryView.countWrap(built.sql), built.params).c;
    rows = qAll(db, QueryView.appendLimit(built.sql, 500), built.params);
    const stmt = db.prepare(QueryView.appendLimit(built.sql, 1));
    try { columns = stmt.getColumnNames ? stmt.getColumnNames() : (rows[0] ? Object.keys(rows[0]) : []); } finally { stmt.free(); }
    say(true, 'SQL 编译与执行', `结果 ${total} 行 / 列: ${columns.join(', ')}`);
    if (total === 0) console.log('  ⚠ 默认参数下结果为 0 行——请确认默认值合理，使用者首次打开会是空图');
  } catch (err) {
    say(false, 'SQL 编译与执行', err.message);
    return;
  }

  // 展示列必须是查询结果的子集
  if (spec.display && spec.display.columns) {
    const missing = spec.display.columns.filter(c => !columns.includes(c.key));
    if (missing.length) say(false, 'display.columns', `结果集中不存在: ${missing.map(c => c.key).join(', ')}`);
    else say(true, 'display.columns', spec.display.columns.map(c => c.label || c.key).join(', '));
  }

  // 图表配置必须能真的画出来
  if (spec.display && spec.display.chart && spec.display.chart.type) {
    const chart = spec.display.chart;
    const kindMap = QueryView.inferResultColumns(columns, rows);
    const kinds = Object.fromEntries(kindMap.map(c => [c.name, c.kind]));
    const config = require(path.join(ROOT, 'config.json'));
    const labels = config.fieldLabels || {};
    const out = ChartBuilder.build(chart.type, chart, rows, { lbl: c => labels[c] || c, kind: c => kinds[c] || 'string' });
    if (out.error) say(false, `图表 ${chart.type}`, out.error);
    else if (!out.chartData || !out.chartData.rows.length) say(false, `图表 ${chart.type}`, '图上没有数据（检查 x/y 字段或默认参数）');
    else say(true, `图表 ${chart.type}`, `图上 ${out.chartData.rows.length} 条`);
  }
}

(async () => {
  if (inspect) { await inspectDb(dbPath || DEFAULT_DB); return; }

  if (!files.length) {
    console.error('用法: node scripts/validate-view.js <视图.json...> [--db=路径.db]\n' +
      '      node scripts/validate-view.js --inspect [路径.db]');
    process.exit(1);
  }

  const useDb = dbPath || DEFAULT_DB;
  const hasDb = fs.existsSync(useDb);
  if (!hasDb) console.log(`[skip] 未找到 ${path.basename(useDb)}，仅做结构校验（不连库）`);
  const engine = hasDb ? createEngine() : null;
  const db = hasDb ? await engine.getDb(useDb) : null;

  for (const f of files) await validateFile(path.resolve(f), db);

  console.log(failed === 0 ? '\n全部通过 ✅（可以交付导入）' : `\n${failed} 项失败 ❌（请修复后重跑）`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('校验器异常:', err); process.exit(1); });
