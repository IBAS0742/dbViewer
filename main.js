const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { createEngine, qAll, qOne, quoteIdent, inferSchema, buildWhere, sampleQuery, csvCell } = require('./lib/sqlite-core');

const engine = createEngine();
const getDb = (p) => engine.getDb(p);

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
let win = null;

function registerIpc() {
  ipcMain.handle('dialog:pick-db', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择 SQLite 数据库文件',
      defaultPath: app.getAppPath(),
      properties: ['openFile'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });

  ipcMain.handle('db:list-tables', async (e, filePath) => {
    const db = await getDb(filePath);
    const tables = qAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    const out = tables.map(t => ({
      name: t.name,
      rows: qOne(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(t.name)}`).c
    }));
    return { tables: out };
  });

  ipcMain.handle('db:get-schema', async (e, { path: p, table }) => {
    const db = await getDb(p);
    return inferSchema(db, table);
  });

  ipcMain.handle('db:query', async (e, args) => {
    const db = await getDb(args.path);
    return sampleQuery(db, args.table, args.filters, args.limit);
  });

  // 完整数据导出（在主进程查询全部符合条件的行，不受绘图采样上限影响）
  ipcMain.handle('db:export', async (e, args) => {
    const db = await getDb(args.path);
    const t = quoteIdent(args.table);
    const { where, params } = buildWhere(args.filters);
    const cols = qAll(db, `PRAGMA table_info(${t})`).map(c => c.name).filter(Boolean);
    const headers = args.headers || {};
    const headRow = cols.map(c => headers[c] || c);
    const format = args.format === 'csv' ? 'csv' : 'xlsx';
    const defaultName = args.defaultName || `${args.table}_导出.${format}`;

    const res = await dialog.showSaveDialog(win, {
      title: '导出数据',
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    const stmt = db.prepare(`SELECT * FROM ${t} ${where}`);
    try {
      stmt.bind(params);
      let count = 0;
      if (format === 'csv') {
        const stream = fs.createWriteStream(res.filePath, { encoding: 'utf8' });
        stream.write('\ufeff' + headRow.map(csvCell).join(',') + '\r\n');
        let batch = [];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          batch.push(cols.map(c => csvCell(row[c])).join(','));
          count++;
          if (batch.length >= 5000) { stream.write(batch.join('\r\n') + '\r\n'); batch = []; }
        }
        if (batch.length) stream.write(batch.join('\r\n') + '\r\n');
        await new Promise((resolve, reject) => {
          stream.end(err => (err ? reject(err) : resolve()));
        });
      } else {
        const aoa = [headRow];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          aoa.push(cols.map(c => (row[c] === undefined ? null : row[c])));
          count++;
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa, { dense: true });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, String(args.table || '数据').slice(0, 31));
        XLSX.writeFile(wb, res.filePath, { dense: true });
      }
      return { ok: true, filePath: res.filePath, count };
    } finally {
      stmt.free();
    }
  });

  // 渲染进程已算好的数据（如图表聚合结果）写成 Excel
  ipcMain.handle('export:sheets', async (e, args) => {
    const wb = XLSX.utils.book_new();
    for (const sh of args.sheets || []) {
      const head = sh.columns.map(c => c.label || c.key);
      const aoa = [head];
      for (const r of sh.rows) aoa.push(sh.columns.map(c => (r[c.key] === undefined ? null : r[c.key])));
      const ws = XLSX.utils.aoa_to_sheet(aoa, { dense: true });
      ws['!cols'] = sh.columns.map(c => ({
        wch: Math.max(10, Math.min(28, String(c.label || c.key).length * 2 + 2))
      }));
      XLSX.utils.book_append_sheet(wb, ws, String(sh.name || 'Sheet').slice(0, 31));
    }
    const res = await dialog.showSaveDialog(win, {
      title: '导出图表数据',
      defaultPath: args.defaultName || '图表数据.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    XLSX.writeFile(wb, res.filePath, { dense: true });
    const total = (args.sheets || []).reduce((s, x) => s + (x.rows ? x.rows.length : 0), 0);
    return { ok: true, filePath: res.filePath, count: total };
  });

  ipcMain.handle('app:load-config', () => loadConfig());
}

let configCache = null;
function loadConfig() {
  if (configCache) return configCache;
  // 依次查找：exe 同级目录（便携版可放一份覆盖）→ 安装目录 resources（打包内置，
  // extraResources 复制）→ 应用资源目录（asar 内，开发模式）
  const candidates = [];
  try { candidates.push(path.join(path.dirname(app.getPath('exe')), 'config.json')); } catch (_) { /* ignore */ }
  try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'config.json')); } catch (_) { /* ignore */ }
  candidates.push(path.join(app.getAppPath(), 'config.json'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        configCache = JSON.parse(fs.readFileSync(p, 'utf8'));
        return configCache;
      }
    } catch (err) {
      console.error('读取配置失败:', p, err.message);
    }
  }
  configCache = { fieldLabels: {}, chartPresets: [] };
  return configCache;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const dbArg = process.argv.find(a => a.startsWith('--db='));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    dbArg ? { query: { db: dbArg.slice('--db='.length) } } : undefined);

  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
