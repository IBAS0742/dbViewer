# 查询视图 .view.json 格式规范（v1）

查询视图 = 发布者预制的「过滤 SQL + 参数表单 + 展示效果」。使用者导入后，
左栏变成参数表单，填值运行即得表格与图表；使用者无需懂 SQL。

参考实现：仓库 `examples/views/` 下有三个可直接校验的示例
（`fire-year-month.dbview.json` 聚合型、`fire-month-trend.dbview.json` 单参数聚合型、
`fire-satellite-detail.dbview.json` 明细多选型）。

## 1. 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `format` | ✔ | 固定 `"dbchart-query-view"` |
| `version` | ✔ | 固定 `1` |
| `name` | ✔ | 视图显示名，一句中文，如「按年份查看各月火点」 |
| `id` |  | 视图标识（字母/数字/`-`/`_`）；缺省取 name |
| `description` |  | 一两句话说明视图用途与参数含义，显示在参数表单上方 |
| `author` |  | 发布者署名 |
| `params` |  | 参数定义数组（见 §2），缺省 = 无参数视图 |
| `sql` | ✔ | 单条 SELECT 查询（见 §3） |
| `display` |  | `{ columns, chart }` 展示效果（见 §4），缺省显示全部结果列 |

## 2. params：参数表单

每个参数在界面上占一行：标签 = `label`（缺省用 `key`），右侧小字显示 `key`。

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `key` | 全部 | 参数名，`[A-Za-z_][A-Za-z0-9_]*`，全局唯一，必须出现在 SQL 里 |
| `label` | 全部 | 界面显示名，用中文，如「开始年份」 |
| `type` | 全部 | `number` / `text` / `date` / `select`，缺省 `text` |
| `required` | 全部 | `true` 时留空会阻止运行并提示 |
| `default` | 全部 | 默认值（number 需为数字且落在 min/max 内；date 为 `YYYY-MM-DD`） |
| `min` / `max` / `step` | number | 数值输入的范围与步长 |
| `placeholder` | number/text | 输入框占位提示 |
| `help` | 全部 | 参数下方一行灰色说明（如「留空表示不限制」） |
| `options` | select | 候选项：`["Aqua","Terra"]` 或 `[{ "value": 1, "label": "1月" }]` |
| `multiple` | select | `true` 时渲染为多选胶囊，值是数组（不勾选 = 不限） |

界面表现：`number`→数字输入框；`text`→文本框；`date`→日期选择器；
`select`→下拉框（含「（不限）」空选项）；`select + multiple`→胶囊多选 + 全选/清空。

## 3. sql 书写规则

1. **只允许一条 SELECT（或 WITH…SELECT）**。禁止第二个语句、PRAGMA、ATTACH；
   写了分号之外的多语句会被拒绝。应用在主进程再次校验。
2. **LIMIT 由应用自动追加**（受使用者的「数据上限」控制，2万~10万行），
   视图 SQL 末尾不要再写 LIMIT（写了则尊重，但不建议）。
3. **命名参数**：`:key`（推荐）、`@key`、`$key`。参数值经 `?` 参数化绑定执行，绝不拼接进 SQL。
   字符串/注释里的冒号不会被误认（`'12:30'` 安全）。
4. **可留空的参数写成「IS NULL 短路」模式**——空值绑定为 NULL，条件自动失效：
   ```sql
   WHERE (:year_from IS NULL OR year >= :year_from)
     AND (:year_to   IS NULL OR year <= :year_to)
     AND (:keyword   IS NULL OR INSTRUMENT LIKE '%' || :keyword || '%')
   ```
5. **多选参数**：`SATELLITE IN (:satellites)`。绑定时数组展开为 IN 列表
   （`IN (:p)` 与 `IN :p` 都可以）；空数组绑定为 NULL，配合 IS NULL 模式即「不限」。
6. **结果列用中文别名**：`SELECT month AS "月份", COUNT(*) AS "火点数量"`。
   别名同时是 `display.columns` 和图表字段引用的 key。非别名结果列名 = 原字段名。
7. **SQL 已做 GROUP BY 聚合时**，图表配置必须写 `"agg": "direct"`（直取结果值，
   不做二次聚合），否则坐标轴会显示「求和(xxx)」且语义错误。
8. 允许 JOIN 任意表、窗口函数、CTE——只要是一条 SELECT。

## 4. display：展示效果

### columns（使用者能看到/导出哪些字段）

```json
"columns": ["月份", "火点数量"]                    // 字符串 = 用原列名/别名
"columns": [{ "key": "月份", "label": "月份" }]    // 对象可覆盖表头显示名
```

- 顺序即数据预览与导出的列顺序；**只列想暴露的字段**，未列出的结果列不进预览和导出
  （但使用者仍可在图表配置里选它们）；
- 缺省 `columns` = 显示全部结果列。

### chart（导入后自动应用的图表配置）

与应用内置预设同构，按类型填字段：

| 图表 type | 必填 | 可选 |
| --- | --- | --- |
| line / area / bar / hbar | `x` | `y`(数值列)、`agg`、`sort`、`series`、`xBins`、`stacked` |
| scatter / bubble | `x`、`y` | bubble 加 `size`，均可 `series` |
| pie / doughnut / funnel | `nameField` | `value`、`agg` |
| heatmap / bar3D | `x`、`y` | `value`、`agg`、`xBins`、`yBins` |
| scatter3D | `x`、`y`、`z` | `value`(颜色列) |

- `x/y/z/nameField/value/series` 填**结果列的别名**（§3 第 6 条）；
- 聚合型视图统一 `"agg": "direct"`；
- `title` 建议写上（图表顶部标题）；
- 使用者仍可自行改图表类型和字段映射——chart 只是打开时的默认效果。

## 5. 运行时行为（发布者需要知道的）

- 行数上限：默认 2 万行（使用者可调至 10 万），超限时结果取**前 N 行**
  （明细型视图建议在 SQL 里 `ORDER BY` 保证截取有意义；聚合型通常行数很少无此问题）；
- 「导出图表数据」导出图表聚合结果；「导出完整数据」由主进程重跑完整 SQL（不带 LIMIT），
  列为 display.columns；
- 视图定义在使用者本地缓存，重启应用自动恢复；「退出视图」清除；
- 安全：主进程仅接受单条只读 SELECT，sql.js 全程操作内存副本、数据库文件永不回写，
  所有参数值参数化绑定。

## 6. 发布前自查清单

1. `node scripts/validate-view.js <文件> --db=<数据文件>` 全部 ✓，无「0 行」警告；
2. SQL 里每个 `:参数` 与 params 一一对应，没有未使用/未定义的参数；
3. 可留空参数都用了 IS NULL 短路模式；必填参数标了 `required` 且给了合理 `default`；
4. 聚合型视图 chart 写了 `"agg": "direct"`；明细视图考虑了超上限截取的排序；
5. `name`/`description`/`label`/`help` 都是面向使用者的中文文案。
