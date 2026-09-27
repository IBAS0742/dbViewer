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

  // 无障碍/交互关键点：图表 canvas 存在、过滤生效
  const ok = info.rowInfo.includes('过滤后') && errors.length === 0;
  console.log(errors.length ? '\n控制台错误:\n' + errors.join('\n') : '\n无控制台错误 ✅');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
