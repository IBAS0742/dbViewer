/* 可视化冒烟测试：Edge headless 打开 demo 模式页面，
 * 依次切换预设图表并截图，收集控制台错误。
 * 运行：node scripts/visual-test.js（需先 node scripts/serve-demo.js 8123） */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const URL = 'http://localhost:8123/renderer/index.html';
const OUT = path.join(__dirname, '..', 'shots');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const exe = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) { console.error('未找到 Edge/Chrome'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1480, height: 940 }
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('#chart canvas', { timeout: 20000 });
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, '01-initial-line.png') });
  console.log('✓ 01 初始（默认预设：逐年火点数量趋势 折线图）');

  async function usePreset(text, shot, label) {
    await page.evaluate((t) => {
      const sel = document.querySelector('#preset-select');
      const opt = [...sel.options].find(o => o.textContent.includes(t));
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change'));
    }, text);
    await sleep(1400);
    await page.screenshot({ path: path.join(OUT, shot) });
    console.log(`✓ ${shot} ${label}`);
  }

  await usePreset('年份×海拔 火点密度', '02-heatmap.png', '热力图（年份×海拔）');
  await usePreset('3D柱状', '03-bar3d.png', '3D 柱状图');
  await usePreset('各置信等级火点占比', '04-pie.png', '饼图');
  await usePreset('逐年平均火点功率', '05-avg-line.png', '数值字段聚合折线（平均FRP）');

  // 应用过滤：年份 2010-2020 + 昼夜=D，然后切回趋势折线
  await page.evaluate(() => {
    document.querySelectorAll('#filter-form details').forEach(d => { d.open = true; });
    const group = col => document.querySelector(`.fgroup[data-col="${col}"]`);
    const y = group('year');
    y.querySelector('input[type="number"]').value = '2010';
    y.querySelectorAll('input[type="number"]')[1].value = '2020';
    const dn = group('DAYNIGHT');
    const chip = [...dn.querySelectorAll('.chip')].find(c => c.textContent.trim() === 'D');
    chip.querySelector('input').checked = true;
    chip.classList.add('on');
    document.querySelector('#btn-apply').click();
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, '06-filtered.png') });
  console.log('✓ 06 应用过滤（年份 2010-2020 + 昼夜=D）');

  const info = await page.evaluate(() => ({
    rowInfo: document.querySelector('#row-info').textContent,
    chartMsg: document.querySelector('#chart-msg').textContent,
    filterCount: document.querySelector('#filter-count').textContent,
    previewInfo: document.querySelector('#preview-info').textContent
  }));
  console.log('页面状态:', JSON.stringify(info, null, 2));

  // 导入查询视图（演示模式没有文件对话框，直接注入示例视图文件内容）
  const viewSpec = await page.evaluate(async () => {
    const r = await fetch('../examples/views/fire-year-month.dbview.json');
    return await r.text();
  });
  const imported = await page.evaluate(async (t) => {
    try { return await importViewFromText(t); } catch (e) { return 'err:' + e.message; }
  }, viewSpec);
  await sleep(3500); // 演示模式首次运行视图需加载 sql.js 并构建内存库
  await page.screenshot({ path: path.join(OUT, '07-view-import.png') });
  console.log('✓ 07-view-import.png 导入查询视图（默认参数自动运行）');

  // 修改参数（开始年份 2015）重新运行
  await page.evaluate(() => {
    const row = document.querySelector('.vparam[data-key="year_from"]');
    row.querySelector('input').value = '2015';
    document.querySelector('#btn-run-view').click();
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, '08-view-param.png') });
  console.log('✓ 08-view-param.png 修改参数后重新运行');

  const vinfo = await page.evaluate(() => ({
    sideTitle: document.querySelector('#side-title').textContent,
    viewTitle: document.querySelector('#view-title').textContent,
    rowInfo: document.querySelector('#row-info').textContent,
    previewHeader: document.querySelector('#data-table th') ? document.querySelector('#data-table th').textContent : '',
    paramCount: document.querySelectorAll('#view-params .vparam').length,
    chartMsg: document.querySelector('#chart-msg').textContent
  }));
  console.log('视图状态:', JSON.stringify(vinfo, null, 1));

  // 退出视图模式，确认恢复常规过滤表单与预设
  await page.evaluate(() => { document.querySelector('#btn-exit-view').click(); });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, '09-view-exit.png') });
  console.log('✓ 09-view-exit.png 退出视图恢复常规模式');
  const xinfo = await page.evaluate(() => ({
    sideTitle: document.querySelector('#side-title').textContent,
    viewVisible: !document.querySelector('#view-panel').hidden,
    filterGroups: document.querySelectorAll('#filter-form .fgroup').length,
    presetEnabled: !document.querySelector('#preset-select').disabled,
    rowInfo: document.querySelector('#row-info').textContent
  }));
  console.log('退出后状态:', JSON.stringify(xinfo, null, 1));

  // 侧栏折叠/展开两轮循环，确认可恢复且图表画布跟随容器尺寸
  const fold = await page.evaluate(() => {
    const w = () => document.querySelector('#sidebar').getBoundingClientRect().width;
    document.querySelector('#btn-toggle-sidebar').click();
    const a = w();
    document.querySelector('#side-flap').click();
    const b = w();
    document.querySelector('#btn-toggle-sidebar').click();
    const c = w();
    document.querySelector('#side-flap').click();
    const d = w();
    return { a, b, c, d, chartW: Math.round(document.querySelector('#chart canvas').getBoundingClientRect().width) };
  });
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, '10-fold-restore.png') });
  console.log(`✓ 10-fold-restore.png 侧栏折叠/展开两轮：${fold.a}→${fold.b}→${fold.c}→${fold.d}px`);

  // 数据预览折叠/展开
  const foldTable = await page.evaluate(() => {
    const h = () => document.querySelector('#table-panel').getBoundingClientRect().height;
    document.querySelector('#btn-toggle-table').click();
    const a = h();
    document.querySelector('#btn-toggle-table').click();
    const b = h();
    return { a, b };
  });
  console.log(`✓ 数据预览折叠/展开：${Math.round(foldTable.a)}→${Math.round(foldTable.b)}px`);

  // 图表全屏：进入 → Esc 退出 → 图表归位
  const fs1 = await page.evaluate(() => {
    document.querySelector('#btn-fullscreen').click();
    return {
      layerShown: !document.querySelector('#chart-full').hidden,
      chartInLayer: !!document.querySelector('#full-wrap #chart'),
      canvasW: Math.round(document.querySelector('#full-wrap #chart canvas').getBoundingClientRect().width)
    };
  });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, '11-fullscreen.png') });
  console.log(`✓ 11-fullscreen.png 图表全屏：画布 ${fs1.canvasW}px`);
  await page.keyboard.press('Escape');
  await sleep(400);
  const fs2 = await page.evaluate(() => ({
    layerHidden: document.querySelector('#chart-full').hidden,
    chartBackHome: !!document.querySelector('#chart-wrap #chart'),
    canvasW: Math.round(document.querySelector('#chart-wrap #chart canvas').getBoundingClientRect().width)
  }));
  console.log(`✓ Esc 退出全屏：图层隐藏=${fs2.layerHidden} 图表归位=${fs2.chartBackHome} 画布 ${fs2.canvasW}px`);

  // 导出图片菜单：打开/关闭（不真的导出，演示模式无主进程）
  const menu = await page.evaluate(() => {
    document.querySelector('#btn-export-image').click();
    const shown = !document.querySelector('#export-menu').hidden;
    document.querySelector('input[value="fullscreen"]').checked = true;
    document.querySelector('#btn-export-image-cancel').click();
    return { shown, closed: document.querySelector('#export-menu').hidden };
  });
  console.log(`✓ 导出图片菜单：打开=${menu.shown} 关闭=${menu.closed}（全屏尺寸选项可选）`);

  // 粘贴导入 AI 风格回复（带说明文字 + 代码围栏），确认入库并自动运行
  const demoSpec = JSON.stringify({
    format: 'dbchart-query-view', version: 1,
    name: '冒烟-各月火点分布', description: '按月份统计火点数量（冒烟测试）',
    sql: 'SELECT month, COUNT(*) AS cnt FROM fire WHERE (:sat IS NULL OR SATELLITE = :sat) GROUP BY month ORDER BY month',
    params: [{ key: 'sat', label: '卫星', type: 'select', options: ['Aqua', 'Terra'] }],
    display: { columns: [{ key: 'month', label: '月份' }, { key: 'cnt', label: '火点数量' }],
      chart: { type: 'bar', x: 'month', value: 'cnt', agg: 'direct', title: '冒烟-各月火点分布' } }
  });
  const pasted = await page.evaluate(async (fallback) => {
    let text = fallback;
    try {
      const r = await fetch('../examples/views/fire-year-month.dbview.json');
      if (r.ok) text = '好的，这是配置：\n```json\n' + (await r.text()) + '\n```';
    } catch (_) { /* 用兜底 spec */ }
    document.querySelector('#btn-my-views').click();
    document.querySelector('#btn-view-paste').click();
    document.querySelector('#paste-area').value = text;
    document.querySelector('#btn-paste-ok').click();
    return new Promise(res => setTimeout(() => res({
      viewMode: document.body.classList.contains('view-mode'),
      viewTitle: document.querySelector('#view-title').textContent,
      saved: JSON.parse(localStorage.getItem('dbchart:saved-views') || '[]').length
    }), 4000));
  }, demoSpec);
  console.log(`✓ 粘贴导入（带围栏文本）：视图模式=${pasted.viewMode}「${pasted.viewTitle}」入库 ${pasted.saved} 份`);

  // 我的配置：同名覆盖 + 列表渲染
  const managed = await page.evaluate(() => {
    document.querySelector('#btn-my-views').click();
    const list = document.querySelector('#views-list');
    return {
      items: list.children.length,
      markedCurrent: !!list.querySelector('.view-item.current'),
      hasUseBtn: [...list.querySelectorAll('button')].some(b => b.textContent === '应用')
    };
  });
  await page.screenshot({ path: path.join(OUT, '12-my-views.png') });
  console.log(`✓ 12-my-views.png 我的配置：${managed.items} 份，当前使用中标记=${managed.markedCurrent}`);
  await page.evaluate(() => { document.querySelector('#btn-views-close').click(); });

  // AI 提示词：自动带表结构 + 两种模式
  const ai = await page.evaluate(() => {
    document.querySelector('#btn-my-views').click();
    document.querySelector('#btn-view-ai').click();
    const a = document.querySelector('#ai-prompt').textContent;
    document.querySelector('#ai-tab-b').click();
    const b = document.querySelector('#ai-prompt').textContent;
    document.querySelector('#btn-ai-close').click();
    return {
      hasSchema: a.includes('表名: fire'),
      hasSpec: a.includes('dbchart-query-view'),
      modeBAsks: b.includes('3~6 个关键问题')
    };
  });
  console.log(`✓ AI 提示词：表结构=${ai.hasSchema} 规范=${ai.hasSpec} 提问模式=${ai.modeBAsks}`);

  // 清理冒烟测试数据，避免污染下次运行的断言
  await page.evaluate(() => {
    localStorage.removeItem('dbchart:saved-views');
    localStorage.removeItem('dbchart:last-view');
  });

  // 无障碍/交互关键点：图表 canvas 存在、过滤生效、视图可导入可运行、可正常退出
  const ok = info.rowInfo.includes('过滤后') && imported === true &&
    vinfo.sideTitle.includes('查询参数') && vinfo.rowInfo.includes('视图结果') &&
    vinfo.paramCount === 2 && vinfo.previewHeader.includes('月份') &&
    xinfo.sideTitle.includes('数据过滤') && xinfo.viewVisible === false &&
    xinfo.filterGroups >= 30 && xinfo.presetEnabled && xinfo.rowInfo.includes('4,000') &&
    fold.a < 30 && fold.b > 200 && fold.c < 30 && fold.d > 200 &&
    foldTable.a < 60 && foldTable.b > 200 &&
    fs1.layerShown && fs1.chartInLayer && fs1.canvasW > 1200 &&
    fs2.layerHidden && fs2.chartBackHome && fs2.canvasW > 900 &&
    menu.shown && menu.closed &&
    pasted.viewMode && pasted.saved >= 1 &&
    managed.items >= 1 && managed.markedCurrent && managed.hasUseBtn &&
    ai.hasSchema && ai.hasSpec && ai.modeBAsks &&
    errors.length === 0;
  console.log(errors.length ? '\n控制台错误:\n' + errors.join('\n') : '\n无控制台错误 ✅');
  if (!ok) console.error('存在未通过的检查项 ❌');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
