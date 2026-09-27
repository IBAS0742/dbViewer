# 数据图表浏览器（SQLite → 过滤 → ECharts → Excel）

一个 Electron 应用：打开任意 SQLite `.db` 文件，自动读取字段信息生成过滤表单，
按字段配置绘制多种 ECharts 图表（含热力图、3D 图），并把图表数据或**全部字段的
完整过滤数据**导出为 Excel / CSV。

## 运行

```bash
npm install
npm start
```

可选：启动时直接打开某个库（跳过文件选择框）：

```bash
npm start -- --db="D:\codes\new_libo\export\small_range.db"
```

浏览器里预览界面（演示模式，使用模拟数据，不连真实数据库）：

```bash
npm run demo   # 然后打开 http://localhost:8123/renderer/index.html
```

## 操作流程

1. **打开 DB 文件** → 选择 `.db / .sqlite / .sqlite3 / .db3` 文件；
2. 选择**数据表**（自动选行数最多的表）；
3. 左侧自动生成**过滤表单**：枚举字段显示多选胶囊、数值字段显示最小/最大、
   日期字段显示日期区间、长文本字段显示“包含”关键字；顶部搜索框可快速定位字段；
4. 点击 **应用过滤并刷新**（或右上选择**预设图表**自动应用）；
5. 选择**图表类型**、配置字段映射，点击 **绘制图表**；
6. 导出：
   - **导出图表数据**：当前图表聚合后的数据（如热力图的 x/y/数量）；
   - **导出完整数据 (Excel/CSV)**：所有字段、所有符合过滤条件的行
     （不受绘图采样上限影响，在主进程直接查库导出）。

## 字段中文标签配置（config.json）

界面上的字段名优先读取项目根目录 `config.json` 的 `fieldLabels`，
key 是数据库字段名，value 是显示名。未配置的字段显示原始名。

```json
{
  "fieldLabels": {
    "year": "年份",
    "elevation": "海拔",
    "ndvi": "植被指数NDVI"
  }
}
```

- 修改后重启应用生效（过滤表单、图表坐标轴、图例、导出表头都会使用该名称）；
- 当前已按 `small_range.db` 的 47 个字段配好了一份中文标签，可直接增删改。

## 默认图表预设配置（config.json）

`chartPresets` 数组中的每一项都会出现在界面“预设图表”下拉框里，选择即自动
完成字段映射并绘制（如有 `filters` 会自动填入过滤表单）。当前内置 16 个预设，
例如：

| 预设 | 类型 | 关键配置 |
| --- | --- | --- |
| 逐年火点数量趋势 | 折线/面积 | `x: year, agg: count` |
| 各月份火点数量分布 | 柱状 | `x: month, agg: count` |
| 各年份分卫星火点数量 | 堆叠柱状 | `x: year, series: SATELLITE, stacked: true` |
| 海拔分布直方图 | 柱状(分箱) | `x: elevation, xBins: 24` |
| 逐年平均火点功率 | 折线 | `x: year, y: FRP, agg: avg` |
| 各置信等级占比 | 饼图/环形/漏斗 | `nameField: conf, agg: count` |
| **年份×海拔 火点密度** | **热力图** | `x: year, y: elevation, yBins: 14, agg: count` |
| 月份×海拔 火点密度 | 热力图 | `x: month, y: elevation` |
| 年份×海拔 火点数量 | 3D柱状 | 同热力图，`type: bar3D` |
| NDVI 与海拔关系 | 散点 | `x: ndvi, y: elevation` |
| 亮度-亮温-功率 | 气泡图 | `x/y/size` |
| 年份-海拔-功率 | 3D散点 | `x/y/z` + `value`(颜色) |
| 高森林覆盖区分布 | 热力图+默认过滤 | `filters: [{col: lt_forest, op: between, values: [0.5, ""]}]` |

新增预设示例（加到 `chartPresets` 数组即可）：

```json
{
  "id": "my-chart",
  "name": "我的图表",        // 预设显示名（下拉框里看到的文字）
  "table": "*",            // 表名，或 "*" 任意表
  "type": "heatmap",       // 图表类型，见下表
  "x": "year",             // X 字段
  "y": "elevation",        // Y 字段
  "yBins": 14,             // 数值轴分箱数（取值少时自动当作分类）
  "value": "",             // 数值字段（留空则计数）
  "agg": "count",          // count / sum / avg / max / min
  "sort": "x-asc",         // x-asc / x-desc / value-asc / value-desc
  "stacked": false,        // 柱状图分组堆叠
  "title": "标题",
  "filters": []            // 可选，打开时自动填充过滤表单
}
```

## 支持的图表类型

| 类型 | 必选字段 | 可选字段 | 说明 |
| --- | --- | --- | --- |
| 折线图 / 面积图 / 柱状图 / 条形图 | X | 数值字段、系列(分组)、聚合、排序、分箱 | 数值 X 取值多时自动分箱；系列字段可拆分多系列 |
| 散点图 | X、Y | 系列 | 原始数据点 |
| 气泡图 | X、Y | 大小字段、系列 | 气泡大小按字段值缩放 |
| 饼图 / 环形图 / 漏斗图 | 名称字段（配置键 `nameField`） | 数值字段、聚合 | 按名称聚合计数或统计 |
| 热力图 | X、Y | 数值字段、聚合、X/Y 分箱 | 交叉聚合，颜色表示数量/均值等（即“x=年份，y=海拔，交点颜色=个数”） |
| 3D 柱状图 | X、Y | 同热力图 | 交叉聚合，高度表示值 |
| 3D 散点图 | X、Y、Z | 颜色数值字段 | 真三维散点 |

聚合方式：计数（默认，无需数值字段）/ 求和 / 平均 / 最大 / 最小。

## 数据上限说明

- 绘图与预览默认最多加载 **2 万行**（顶部"数据上限"可调到 10 万行）。
  超过上限时按 **rowid 等间隔抽样**（每 k 行取 1 行），即使表按年份等有序存储，
  各时间段的数据也能进入图表；界面会提示当前抽样行数；
- **导出完整数据不受此限制**：主进程直接查询全部符合条件的行再写文件。

## 自动打包与发布（GitHub Actions）

仓库已配置 [.github/workflows/build.yml](.github/workflows/build.yml)，**日常使用只需 `git push`，无需打标签**：

- **push 到 `main`**：三平台自动打包，并把安装包滚动更新到仓库
  **Releases 页的「最新构建」**（每次推送替换上一份，直接下载即可）；
- **push 标签 `v*`**（可选，用于正式版本）：额外创建一份正式版 Release；
- **手动触发**：Actions 页面 → Build → Run workflow。

```bash
git push          # 推上去即可，几分钟后到 Releases 页下载三平台安装包
```

（tag 并不是分支，只是给某次提交起一个版本名；想留正式版本号时再用它即可。）

产物对照：

| 平台 | 文件 |
| --- | --- |
| Windows | `db-chart-explorer-<版本>-win-x64.exe`（安装版）、`-win-x64.zip`（便携版） |
| macOS | `-mac-arm64.dmg`（M 系列）、`-mac-x64.dmg`（Intel），未签名 |
| Linux | `-linux-x86_64.AppImage`、`-linux-amd64.deb` |

打包说明：

- macOS 未做代码签名（无 Apple 开发者证书），用户首次打开需右键 →「打开」，
  或执行 `xattr -cr 应用路径`；有证书时在 CI 里配置 `CSC_LINK`/`CSC_KEY_PASSWORD`
  并去掉 `build.mac.identity: null` 即可自动签名；
- 自定义图标：把 `build/icon.ico`（≥256×256）、`build/icon.icns`、`build/icon.png`
  放入仓库即可，无需改配置；
- 打包后 `config.json` 位于安装目录 `resources/` 下，exe 同级目录放一份同名文件可
  覆盖默认配置（无需重新打包）；
- 73MB 的 `small_range.db` 默认不入库（见 `.gitignore`），CI 中的管道测试会自动跳过
  依赖数据文件的部分；如需在 CI 跑完整数据测试可 `git add -f small_range.db`（<100MB）。

## 技术说明

- SQLite 通过 **sql.js**（WASM）读取，无原生依赖、无编译要求；
- 图表使用 **ECharts 5 + echarts-gl**（3D）；Excel 导出使用 **SheetJS(xlsx)**；
- 主进程/渲染进程隔离（contextIsolation），查询条件全部参数化绑定，防 SQL 注入。
