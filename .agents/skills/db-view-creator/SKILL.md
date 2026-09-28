---
name: db-view-creator
description: 为「数据图表浏览器」（dbViewer / db-chart-explorer）创建可导入的查询视图（.view.json）——带参数表单的过滤 SQL + 展示字段 + 默认图表，发布者一键生成，使用者导入即用。凡是用户想为 SQLite 数据库生成过滤查询/可分享的查询配置/让使用者按条件查询并看图，或提到 查询视图、.view.json、导入视图、视图发布、dbViewer 视图 时使用，即使用户没有明确说"查询视图"这个词。
---

# db-view-creator：创建数据图表浏览器的查询视图

查询视图是一个 `.view.json` 文件：发布者写好「带 `:参数` 占位的单条 SELECT + 参数表单定义 + 展示字段/默认图表」，使用者在本应用里点「导入查询视图」选择该文件，填参数（如年份、卫星）、点运行即可看到过滤后的表格和图表。**使用者不需要写任何 SQL。**

## 工作流（严格按顺序）

### 1. 摸清数据库结构 —— 不要凭空猜字段

在 dbViewer 仓库根目录运行：

```bash
node scripts/validate-view.js --inspect --db=路径/xxx.db
# 不传 --db 时默认用仓库根目录的 small_range.db
```

输出 JSON：每张表的行数、每个字段的 `kind`（`enum` 枚举含候选值 / `enum-number` 数值枚举 / `number` 数值含 min/max / `date` / `string`）。**只允许使用输出里真实存在的表名和字段名。** 枚举字段的候选值直接用作 select 参数的 options。

### 2. 阅读 [references/spec.md](references/spec.md)

它是格式权威定义：params 每种类型的表单表现、SQL 书写规则（可选参数模式、多选 IN 展开、LIMIT 由应用自动追加）、display.columns/chart 的字段映射。写文件前必读。

### 3. 编写 `<视图id>.view.json`

硬性规则（细节见 spec.md，违反任何一条都会被第 4 步拦下）：

- `format` 固定 `"dbchart-query-view"`，`version` 固定 `1`；`name` 用一句中文说明视图做什么；
- `sql` 是**单条** SELECT（或 WITH...SELECT），不许有第二个语句、不许写 LIMIT（应用会自动加）；
- SQL 里每个 `:参数` 都必须在 `params` 数组里定义，`params` 里每个 key 也都要出现在 SQL 里；
- 「可留空」的参数一律写成 `(:p IS NULL OR 列 运算符 :p)` 模式，空值绑定 NULL 时自动变成「不限」；
- 多选参数用 `SATELLITE IN (:satellites)`，绑定器会把数组展开成 IN 列表；
- 结果列用 `AS "中文名"` 起别名，`display.columns` 与别名一一对应；SQL 已做 GROUP BY 聚合时图表配置写 `"agg": "direct"`（直取，不要二次聚合）；
- 字段名/别名含中文时必须用双引号包起来。

### 4. 验证循环 —— 全绿才算完成

```bash
node scripts/validate-view.js 路径/xxx.view.json --db=路径/xxx.db
```

- 每一项都必须是 `✓`；出现 `✗` 就按报错修改后重跑，不许带着失败交付；
- 出现「默认参数下结果为 0 行」的 ⚠ 也要处理：调整默认值或放宽条件，保证使用者首次导入就有数据看；
- 没有 `.db` 数据文件时脚本只做结构校验，要在输出里提醒用户拿到数据环境后再跑一次连库校验。

### 5. 交付

告诉使用者三句话：把 `.view.json` 发给使用者 → 打开 dbViewer 并选择 .db 文件 → 点顶栏「导入查询视图」选中文件，填参数点「运行查询」。发布者侧建议把视图文件放进 `examples/views/` 一起提交，CI 会自动校验。

## 参考示例（完整字段语义见 references/spec.md）

```json
{
  "format": "dbchart-query-view",
  "version": 1,
  "id": "fire-year-month",
  "name": "指定年份区间的各月火点统计",
  "description": "选择起止年份，统计每个月的火点数量。参数可留空表示不限制。",
  "params": [
    { "key": "year_from", "label": "开始年份", "type": "number", "min": 2000, "max": 2026, "help": "留空表示不限制" },
    { "key": "year_to", "label": "结束年份", "type": "number", "min": 2000, "max": 2026, "default": 2020 }
  ],
  "sql": "SELECT month AS \"月份\", COUNT(*) AS \"火点数量\" FROM fire WHERE (:year_from IS NULL OR year >= :year_from) AND (:year_to IS NULL OR year <= :year_to) GROUP BY month ORDER BY month",
  "display": {
    "columns": ["月份", "火点数量"],
    "chart": { "type": "bar", "x": "月份", "y": "火点数量", "agg": "direct", "sort": "x-asc", "title": "各月火点数量（指定年份区间）" }
  }
}
```

## 常见错误 → 修正

| 校验报错 | 原因与修法 |
| --- | --- |
| `sql 使用了参数 :x，但 params 中没有定义` | SQL 里的 `:x` 拼写和 params[].key 不一致 |
| `结果集中不存在: xxx` | display.columns 用了未 SELECT 的列；给列补 `AS "别名"` |
| `display.chart.type 不是支持的图表类型` | type 只能是 line/area/bar/hbar/scatter/bubble/pie/doughnut/funnel/heatmap/bar3D/scatter3D |
| SQL 执行报 `no such column` | 字段是 --inspect 输出之外的臆造；重新 inspect |
| 分类图数值都挤在一个点 | y 列被二次聚合了；已 GROUP BY 的 SQL 记得 `"agg": "direct"` |
