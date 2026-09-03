# DSH GeoCore

**Agent-native GIS Runtime for DeepSeek Harness。**
Agent 只见 3 个工具；内核由七类 GIS 原语治理；底层引擎可整体替换。

> 项目目标：让 Harness 通过极少数工具组合解决通用 2D 矢量分析任务，
> 并以 benchmark（而非主观判断）证明覆盖率。
> 当前状态：**Phase 1 Vector Core 完成**（见下方路线图），
> 外加 **GeoCore Studio 地图工作台**（DSH 风格 GIS 界面；自然语言对话由 DSH 主界面承担）。

## 快速开始

```bash
# 0) 依赖：Python ≥3.11；首次安装内核
pip install -e ".[viz,dev]"

# 1) 生成合成城市「临江市」（6 区/22 道路/40 地块/医院学校 POI/河流洪水区）
python scripts/make_synthetic_data.py

# 2) 跑测试：55 个用例 + 14 道起始基准题（含 CRS 度量陷阱回归）
python -m pytest -q

# 3) 端到端演示：物流园区选址（缓冲→求交→扣除洪水→度量→分区→出图）
python scripts/demo_siting.py
```

直接驱动内核（不接 Agent）：

```bash
echo {"action":"inspect","path":"datasets/synthetic/parcels.geojson"} |
  python -m geocore run --workdir .
```

## 三个 Agent 工具

| 工具 | 一句话 |
| --- | --- |
| `gis_inspect` | 理解数据本身：几何/CRS/字段/质量/可做何分析 |
| `gis_analyze` | 执行空间分析计划：操作词表 + `@步骤`/`artifact_id#步骤` 链式引用 |
| `gis_visualize` | 表达结果：分级设色/分类专题图 PNG + 图例 |

完整契约（错误码、词表、语义警示）：[docs/tool-api.md](docs/tool-api.md)

## 目录结构

```text
DSH-GIS/
├── src/geocore/            # Python 内核（无状态，可作为库使用）
│   ├── runtime/            #   数据源 / CRS·几何修复管线 / Artifact 沙箱
│   ├── analysis/           #   词表处理器、请求级解析器、执行器
│   ├── providers/          #   Provider 抽象 + geopandas 实现（QGIS 留插槽）
│   └── viz/                #   matplotlib 专题图（离线中文字体）
├── plugin-geocore/         # DeepSeek Harness 插件（TypeScript/cordis v4）
│   └── src/{bridge,service,tools,index}.ts
├── apps/geocore-studio/    # GeoCore Studio：地图工作台（dsh profile 插件）
│   ├── src/                #   服务插件：REST + 静态前端（DSH 风格主题）
│   └── web/                #   前端：Leaflet 图层树 + 六种可视化操作
├── scripts/                # 合成数据生成、选址端到端演示
├── tests/                  # pytest 全套 + bench/starter.jsonl 基准题集
└── docs/                   # 架构 / 工具契约 / Harness 接入 / Studio 指南
```

## 路线图

- [x] **Phase 1 — Vector Core**：数据准备自动管线、Query&Measure / Proximity /
      Overlay / Zonal 四类原语、Artifact 中间步骤持久化与跨调用引用、专题图、
      JSON 桥协议、Harness 插件、55 测试 + 14 基准题
- [ ] **Phase 2 — Field GIS**：Raster/DEM/Map Algebra 与矢量交互
- [ ] **Phase 3 — Network & Spatial Statistics**：七类补全
- [ ] **Phase 4 — Scale**：PostGIS/DuckDB-Spatial 后端、并行与缓存、150–200 题全量 benchmark

## 治理铁律（新 PR 必答两问）

1. 这个能力属于现有七类中的哪一类？
2. 为什么现有原语组合不出来？

只有第二问成立才允许新增第八类；否则只加算法、后端或优化器——**不加 Agent 工具**。

## 文档

- [架构总览](docs/architecture.md) —— 三层结构、可靠性铁律、Artifact 设计、已知边界
- [工具 API 契约](docs/tool-api.md)
- [DeepSeek Harness 集成指南](docs/dsh-integration.md)
- [GeoCore Studio 指南](docs/studio.md) —— 地图工作台的架构、启动与使用

## 许可

内核依赖均为 BSD/MIT/Apache 系纯 Python 地理栈；
如未来引入 QGIS runtime 分发，需先复核其 GPL 条款对集成方式的影响。
