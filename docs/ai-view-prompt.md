# 让 AI 帮你生成图表配置 — 提示词模板

本应用的「图表配置」（查询视图）= **查询 SQL + 参数表单 + 图表显示逻辑**，一个 JSON 文件搞定。

最快的使用方式：应用内点 **「我的配置」→「🤖 AI 生成配置」**，会自动带上当前打开表的结构生成提示词（两种模式可切换、一键复制）；AI 回复的 JSON 用 **「我的配置」→「📋 粘贴导入」** 直接吃进去（自动剥掉 markdown 代码围栏、容忍前后说明文字，校验通过即保存复用）。

本文档提供同样的模板，方便在其他场景（网页版 AI、其他助手）复制使用。

---

## 方式一：描述需求，直接生成（推荐先用这个）

把下面整段复制给 AI，改两处：表结构、需求描述。

```text
你是一名数据分析师 + SQLite 专家。请根据下面的表结构和我的需求，生成一个「图表配置 JSON」。

【数据库表结构】
（把你的表结构贴在这里：表名、每个字段的字段名/类型/含义/示例值。
 若不知道字段取值分布，可写"枚举字段请先假设并留参数"）

【需求】
（在这里描述你想要的图表，例如：
 我想看按年份统计的火点数量趋势，画折线图；
 可以按卫星（Aqua/Terra，可多选）和最低置信等级筛选；
 年份范围做成两个数字参数，留空表示不限。）

【输出格式】
只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释文字），结构如下：
{
  "format": "dbchart-query-view",
  "version": 1,
  "name": "配置名（简洁，会作为同名覆盖的 key）",
  "description": "一句话说明这个配置回答什么问题",
  "sql": "SELECT ... WHERE col = :param ...（SQLite 方言，单条只读 SELECT，可用 WITH）",
  "params": [
    { "key": "year_from", "label": "开始年份", "type": "number", "required": true, "help": "留空不限" },
    { "key": "satellites", "label": "卫星", "type": "select", "multiple": true,
      "options": ["Aqua", "Terra"], "default": ["Aqua"] },
    { "key": "day", "label": "日期", "type": "date" }
  ],
  "display": {
    "columns": [{ "key": "结果列名", "label": "显示名" }],
    "chart": { "type": "heatmap", "x": "列名", "y": "列名", "xBins": 20, "yBins": 12, "agg": "count", "title": "图表标题" }
  }
}

【图表类型 chart.type 可选】line 折线 / area 面积 / bar 柱状 / hbar 条形 / scatter 散点 /
bubble 气泡 / pie 饼图 / doughnut 环形 / funnel 漏斗 / heatmap 热力图 / bar3D 3D柱状 / scatter3D 3D散点。
类型对应必填键：折线/柱状类需 x；散点/气泡需 x,y（气泡可加 size）；饼/环/漏斗需 nameField；
热力图/3D柱状需 x,y（数值列配 xBins/yBins 分箱）；3D散点需 x,y,z（可加 value 上色）。
聚合 agg：count（计数，无需数值列）/ sum / avg / max / min / direct（SQL 已聚合时用 direct）。

【硬性规则】
1. SQL 只能是单条 SELECT（或 WITH...SELECT），禁止任何写操作、多语句、PRAGMA；
2. SQL 里用 :参数名 占位，参数名必须都在 params 里定义；文本参数为空时表示不限，
   用 (:p IS NULL OR col = :p) 或 (:p IS NULL OR col LIKE :p) 写法保证留空可用；
3. params.type 可选 number / text / date / select；select 可加 multiple 和 options（字符串数组或 {value,label}）；
4. display.chart 的字段必须引用 SQL 结果列的别名，不能用原表字段名；
5. 数字开头的结果列别名要用引号包住，如 AS "3d"。
```

---

## 方式二：让 AI 先向我提问，再生成

适合需求还比较模糊、或你对表结构细节不确定的情况。把下面整段复制给 AI：

```text
你是一名数据分析师 + SQLite 专家。我想用「图表配置 JSON」描述一个数据图表，
你先理解我的需求；如果以下信息不足以写出正确的 SQL 和图表配置，
请先向我提出 3~6 个关键问题（用列表），等我回答后再输出配置 JSON。
如果信息已足够，直接输出配置 JSON，不要再提问。

【数据库表结构】
（把你的表结构贴在这里：表名、每个字段的字段名/类型/含义/示例值）

【我想要看的图表 / 想回答的问题】
（在这里描述，例如：我想看 2015 年以后各卫星的火点数量随月份的变化，能按海拔过滤）

【输出格式】
只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释文字），结构如下：
{
  "format": "dbchart-query-view",
  "version": 1,
  "name": "配置名（简洁，会作为同名覆盖的 key）",
  "description": "一句话说明这个配置回答什么问题",
  "sql": "SELECT ... WHERE col = :param ...（SQLite 方言，单条只读 SELECT，可用 WITH）",
  "params": [
    { "key": "year_from", "label": "开始年份", "type": "number", "required": true, "help": "留空不限" },
    { "key": "satellites", "label": "卫星", "type": "select", "multiple": true,
      "options": ["Aqua", "Terra"], "default": ["Aqua"] },
    { "key": "day", "label": "日期", "type": "date" }
  ],
  "display": {
    "columns": [{ "key": "结果列名", "label": "显示名" }],
    "chart": { "type": "heatmap", "x": "列名", "y": "列名", "xBins": 20, "yBins": 12, "agg": "count", "title": "图表标题" }
  }
}

【图表类型 chart.type 可选】line 折线 / area 面积 / bar 柱状 / hbar 条形 / scatter 散点 /
bubble 气泡 / pie 饼图 / doughnut 环形 / funnel 漏斗 / heatmap 热力图 / bar3D 3D柱状 / scatter3D 3D散点。
类型对应必填键：折线/柱状类需 x；散点/气泡需 x,y（气泡可加 size）；饼/环/漏斗需 nameField；
热力图/3D柱状需 x,y（数值列配 xBins/yBins 分箱）；3D散点需 x,y,z（可加 value 上色）。
聚合 agg：count（计数，无需数值列）/ sum / avg / max / min / direct（SQL 已聚合时用 direct）。

【硬性规则】
1. SQL 只能是单条 SELECT（或 WITH...SELECT），禁止任何写操作、多语句、PRAGMA；
2. SQL 里用 :参数名 占位，参数名必须都在 params 里定义；文本参数为空时表示不限，
   用 (:p IS NULL OR col = :p) 或 (:p IS NULL OR col LIKE :p) 写法保证留空可用；
3. params.type 可选 number / text / date / select；select 可加 multiple 和 options（字符串数组或 {value,label}）；
4. display.chart 的字段必须引用 SQL 结果列的别名，不能用原表字段名；
5. 数字开头的结果列别名要用引号包住，如 AS "3d"。
```

---

## 拿到 AI 的 JSON 之后

1. 应用内点 **「我的配置」→「📋 粘贴导入」**，把 AI 输出（整段或只复制 JSON 都行）粘进去 → 「导入并保存」；
2. 校验通过后自动存入配置库并运行；有错误会逐条列出，把报错发回给 AI 让它修正即可；
3. 同名 `name` 的配置再次导入会**覆盖更新**；在「我的配置」里可以随时应用 / 导出文件 / 删除；
4. 想把当前参数调整结果存档，视图模式下点侧栏的 **「保存为配置」**。

## 参数类型速查

| type | 控件 | 附加键 |
| --- | --- | --- |
| `number` | 数字输入框 | `min` / `max` / `step` |
| `text` | 文本输入框 | `placeholder` |
| `date` | 日期选择器 | — |
| `select` | 下拉框 | `options`（必填）；`multiple: true` 变多选胶囊，`default` 给默认值 |

## SQL 留空即「不限」的写法示例

```sql
SELECT year, COUNT(*) AS cnt
FROM fire
WHERE (:year_from IS NULL OR year >= :year_from)
  AND (:year_to   IS NULL OR year <= :year_to)
  AND (:sat       IS NULL OR SATELLITE = :sat)
GROUP BY year
ORDER BY year
```

数字参数留空会绑定为 NULL → 条件自动放行；这就是「必填参数校验 + 留空不限」能同时成立的原因。

## 完整可跑的例子

仓库 [examples/views/](../examples/views) 里有三个示例配置（按年份区间统计各月火点 / 按卫星海拔筛选明细 / 指定月份历年趋势），可以直接「导入配置」试跑，也是给 AI 参考的绝佳 few-shot 样例——生成提示词时可以把其中一个的内容一并贴给 AI。
