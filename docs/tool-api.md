# 工具 API 契约（v0.1，Phase 1 Vector Core）

三个工具构成模型的全部 GIS 表达面。所有响应都是单条 JSON 封套：

```json
{ "ok": true,  "result": { ... } }
{ "ok": false, "error": { "code": "…", "message": "…", "details": { … } } }
```

错误码（稳定契约）：

| code | 触发场景 | 模型应如何反应 |
| --- | --- | --- |
| `E_BAD_REQUEST` | 参数缺失/类型错/where 非法/非法 artifact_id | 读取 details 修正后重试 |
| `E_INPUT_MISSING` | 路径不存在 / 图层或字段缺失 / artifact 不存在 | 先 `gis_inspect` 摸清输入 |
| `E_CRS_AMBIGUOUS` | 数据缺 CRS 且坐标不在经纬度值域 | 让用户提供 CRS 或先转换 |
| `E_OP_UNKNOWN` | op 名不在词表 | 使用 details.available 中的名字 |
| `E_GEOMETRY_INVALID_UNFIXABLE` | make_valid 也救不了 | 放弃该层或请用户清洗 |
| `E_EMPTY_RESULT` | 步骤产出 0 要素且未标 allow_empty | 自查过滤条件；确属预期加 `"allow_empty": true` |
| `E_OUTPUT_ERROR` | artifact 写出失败 | 检查 workdir 权限 |
| `E_INTERNAL` | 未预期异常（附 traceback） | 上报用户 |

---

## gis_inspect

请求：`{ "path": "<GeoJSON|GPKG|SHP|CSV(含 lon/lat 列)>" }`
GPKG 可选 `"layer"`；多图层时缺省取第一层。

响应要点：`kind/count/crs/extent_bbox/geometry_types/fields[{name,dtype,samples}]/
quality{invalid_geometries,null_geometries,missing_crs,wgs84_assumable_if_missing}/
capabilities[]/notes[]`。

使用教条：**遇到陌生数据，第一步永远是 inspect**。由 quality 决定是否需要预处理，
由 capabilities 声明当前内核能做什么。

## gis_analyze

请求：`{ title?, operations: Op[], output?: { format: "gpkg"|"geojson" } }`

`Op = { id, op, <按词表传参>, allow_empty? }`。步骤按序执行；
后续步骤引用前序结果的三种写法：

| 写法 | 作用域 |
| --- | --- |
| `"@<id>"` | 同一请求内的中间结果 |
| `"ar_xxx…"` | 已有 artifact 的最终结果 |
| `"ar_xxx…#<stepId>"` | 该 artifact 内持久化的中间步骤图层 |

### 操作词表

```text
query.filter            { input, where }
query.select            { input, predicate?, ref }        # intersects|within|contains|touches|crosses|overlaps
query.measure           { input, measures? }              # area_sqkm area_ha length_km count → 追加同名列并给汇总行

proximity.buffer        { input, distance_m, dissolve?, quad_segs?=16 }
proximity.within_distance { input, ref, distance_m }      # 距参照层 distance_m 以内筛选
proximity.nearest       { input, ref, k?=1, join_attrs? } # 输出 nearest_rank / nearest_distance_m / nearest_<attr>

overlay.intersection    { a, b }                          # 属性合并；两输入同名列归一为 <col>_a / <col>_b
overlay.difference      { a, b }
overlay.union           { a, b }
overlay.clip            { a, b }                          # 只保留 a 的属性

zonal.summarize         { regions, data, stats?, field? } # regions 必须为面
```

zonal 说明：
- 点数据：stats ∈ count,sum,mean,min,max（sum/mean 等需 field）
- 线数据：total_length_km, share_pct（对每区求落入长度）；field.sum 为按长度分摊的加权贡献
- 面数据：count,total_area_sqkm,share_pct；field.sum 按交叠面积分摊、field.mean 为面积加权均值
- 输出列前缀 `data_`（如 `data_count`、`data_beds_sum_apportioned`）
- ⚠ 一份数据跨多个区会重复计入各区；`share_pct` 是"占全层比例"，跨区求和 ≠100%

where 表达式：pandas query 语法；**Python 关键字列名必须用反引号**，
如 `` `class` == '高速' ``（引擎自动改写为安全别名）。危险关键字直接拒绝。

响应 result：`artifact_id/title/result{path,format,count,geometry_types}/
summary[](中文摘要)/steps[]{id,op,count,summary}/warnings[]/crs{analysis,sources}/
inputs[]/intermediate_layers{stepId:{layer,count}}`。

CRS 承诺：任一步涉及度量则整次分析统一到一个米制投影坐标系（首个输入决定：
已投影→采用；地理→按范围选 UTM），所有重投影都记入 warnings。

## gis_visualize

请求：`{ source, title?, style? }`
source 同上三种引用写法；写入既有 artifact 目录或新建 map 类型 artifact。

style 键：`mode`(single|point|categorical|choropleth)、`field`、
`classification`(quantile|equal_interval)、`classes`(2-9)、`cmap`、`color`、
`size`、`figsize`、`dpi`。
响应：`image_path + legend[] + warnings[]`。中文字体默认 Microsoft YaHei。

## 底层协议（供桥实现者）

```bash
python -m geocore run --workdir <dir>   # stdin: {"action":"analyze", ...payload}
                                        # stdout: 单封套 JSON；exit 0 ok / 2 领域错误 / 1 内部错误
```

其他 action：`inspect`、`visualize`、`show`（含 artifact_id）、`operations`
（返回当前可用 op 词表，便于自省）。
