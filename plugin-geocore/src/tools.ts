/** 三个 Agent-facing 工具：对齐宿主 @deepseek-ai/dsh-tools 的 ToolDefinition 真实契约。
 *
 * 契约要点（dsh-tools lib/types/index.d.ts）：
 *   register(definition: ToolDefinition): () => void
 *   ToolDefinition = ToolSchema{ name, description, parameters } +
 *     { output: { schema, render }, execute(args, exec), timeoutMs? }
 * 模型可见面只有 name/description/parameters；output.render 决定结果如何投影为
 * ContentBlock[]（此处统一文本投影）。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PythonBridge } from './bridge.js';

/** 工具协同超时要大于桥自身超时，保证超时由桥负责报错而不是被宿主先掐断。 */
const TOOL_TIMEOUT_MS = 330_000;

const MAX_RENDER_CHARS = 400_000;

function textProjection(_args: unknown, value: unknown) {
  let text = JSON.stringify(value);
  if (text.length > MAX_RENDER_CHARS) {
    text = text.slice(0, MAX_RENDER_CHARS) + '…[截断：结果过大，请缩小分析范围]';
  }
  return [{ type: 'text' as const, text }];
}

const OBJECT_SCHEMA = { type: 'object' } as const;

export function buildToolDefs(bridge: PythonBridge): ToolDefinition[] {
  return [
    {
      name: 'gis_inspect',
      description: [
        '理解空间数据本身（不做分析）。遇到任何陌生的地理数据，第一原则是先 inspect 再分析。',
        '输入：{path}（GeoJSON/GeoPackage/Shapefile/CSV+经纬度列）。',
        '返回：几何类型、CRS、范围、要素数、字段与样本值、数据质量告警（无效几何/缺 CRS）、可做的分析类别。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '空间数据的绝对路径' },
        },
        required: ['path'],
        additionalProperties: true,
      },
      output: { schema: OBJECT_SCHEMA, render: textProjection },
      execute: async (args) => bridge.call('inspect', args as Record<string, unknown>),
      timeoutMs: TOOL_TIMEOUT_MS,
    },
    {
      name: 'gis_analyze',
      description: [
        '执行一个空间分析任务：按顺序运行 operations 数组中的 GIS 原语步骤，后一步可用 "@步骤id" 引用前一步结果。',
        '',
        '可用操作词表（op）：',
        '- query.filter {input, where}            属性过滤。pandas query 语法；关键字列名用反引号如 `class`；',
        '                                          时间列已自动解析，可直接写 time >= "2024-06-01" 这类比较',
        '- query.select {input, predicate, ref}   空间选择；predicate ∈ intersects/within/contains/touches/crosses/overlaps',
        '- query.measure {input, measures, group_by?}  度量；measures ⊆ [area_sqkm, area_ha, length_km, count]；',
        '                                          group_by 给出后按该字段分组，每组数值直接在 steps[].table 返回',
        '- proximity.buffer {input, distance_m, dissolve?, quad_segs?}',
        '- proximity.within_distance {input, ref, distance_m}   距参照层 distance_m 米以内筛选',
        '- proximity.nearest {input, ref, k?, join_attrs?}      每个要素的最近参照要素及距离',
        '- overlay.intersection / difference / union {a, b}',
        '- overlay.clip {a, b}                    用 b 掩膜裁剪 a（只保留 a 属性）',
        '- zonal.summarize {regions, data, stats?, field?}      分区统计：点计数/属性和、线长度占比、面面积占比与按面积加权统计',
        '- trajectory.build {input, time_field, group_by?}      点按时间排序连成轨迹线（飓风路径/GPS 轨迹）',
        '',
        '栅格算子（raster 域，GeoTIFF 输入/输出；组合时自动对齐到首个输入的模板）：',
        '- raster.info {input}                                   元信息：行列/像元/CRS/NoData 占比/分位数（见 steps[].table）',
        '- raster.create {bounds, cellsize, crs?, value?}        建空模板栅格（bounds=[minx,miny,maxx,maxy]）',
        '- raster.from_vector {input, cellsize|template, field?} 矢量栅格化（取字段值或覆盖=1）',
        '- raster.align {input, template, method?}               重采样对齐到模板',
        '- raster.mask {input, mask, invert?, fill?}             掩膜（矢量或栅格；fill 数值=填值，缺省 NoData）',
        '- raster.merge {inputs[]}                               镶嵌多幅（重叠先到先得）',
        '- raster.distance {input, cellsize?, max_distance_m?}   欧氏距离场（米）',
        '- raster.distance_decay {input, d0, f0?, mode?}         距离衰减作用分（linear/square/exponential；定级因子一步出）',
        '- raster.cost_distance {source, cost}                   累积成本距离（cost 值×米；NoData/≤0 不可通行）',
        '- raster.cost_path {source, cost, to}                   成本最短路径（LineString，取 to 第一个点）',
        '- raster.nearest {input, ref}                           就近分配：每像元=最近参照要素序号',
        '- raster.con {input, condition, true, false}            条件赋值（condition 如 "value >= 500" 或 "nodata"；值可为 "nodata"）',
        '- raster.calc {inputs:{别名:引用}, expression}           受限逐像元表达式（四则/乘方 + abs/min/max/clip/sqrt/exp/ln）',
        '- raster.reclassify {input, mapping:[[lo,hi,new]…]}     表驱动重分类（左闭右开；未落表=NoData 可用 nodata 参数填）',
        '- raster.breaks {input, classes, method?}               只求断点不执行（equal_interval/quantile/jenks；接 reclassify 消费）',
        '- raster.histogram {input, bins?}                       直方图+累计频率表（频率曲线定级用）',
        '- raster.weighted_sum {inputs:[{ref,weight}…]}          加权叠加（权重自动归一化）',
        '- raster.focal {input, stat, kernel_size?}              邻域统计 mean/min/max/median/std（默认 3×3）',
        '- raster.zonal_stats {regions, data, stats?}            栅格分区统计（count/mean/min/max/sum/majority）',
        '- raster.polygonize {input, field?, dissolve?}          栅格转面（同值溶解，级别区出图）',
        '- raster.contour {input, levels?|interval?}             等值线提取（LineString，level 字段）',
        '- raster.sample {raster, points, field?}                栅格值采样到点（输出矢量，接 query/overlay）',
        '',
        '规则：距离单位米、结果输出到 artifacts 目录并返回 artifact_id；',
        '响应自带 preview（最终结果前 10 行）与 steps[].table（分组明细），常用取数不必再读 artifact 文件。',
        '后续引用三种写法：@步骤id（同一请求内）、artifact_id（最终结果）、artifact_id#步骤id（持久化的中间步骤）。',
        'CRS 策略：度量类操作自动投影到米制坐标系；纯过滤/选择/轨迹保持源 CRS；',
        '顶层 crs 参数可显式指定（"source" 跟随首个输入，或 "EPSG:32622" 等固定坐标系）。',
        '空结果是常见异常信号（过滤过严？CRS 不匹配？）；确属预期时给该步加 "allow_empty": true。',
        '永远不要自己算坐标或长度——一律通过本工具完成度量。',
        '提示：路径用正斜杠（D:/data/x.geojson）或双反斜杠；中文路径/中文标题/中文属性值均支持。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '本次分析的人类可读标题' },
          crs: {
            type: 'string',
            description: '分析坐标系覆盖：\'source\' 保持首个输入的 CRS；或显式 CRS 串如 \'EPSG:32622\'。缺省自动（度量类用 UTM）',
          },
          operations: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '步骤标识，供 @引用' },
                op: { type: 'string', description: '操作名，见上方词表' },
                allow_empty: { type: 'boolean', description: '允许该步结果为空而不报错' },
              },
              required: ['id', 'op'],
              additionalProperties: true,
            },
          },
          output: {
            type: 'object',
            properties: {
              format: { type: 'string', enum: ['gpkg', 'geojson'], default: 'gpkg' },
            },
            additionalProperties: false,
          },
        },
        required: ['operations'],
        additionalProperties: true,
      },
      output: { schema: OBJECT_SCHEMA, render: textProjection },
      execute: async (args, exec) => bridge.call('analyze', args as Record<string, unknown>, exec?.signal),
      timeoutMs: TOOL_TIMEOUT_MS,
    },
    {
      name: 'gis_visualize',
      description: [
        '把分析结果表达成专题地图 PNG（分析归 gis_analyze，表达归本工具）。',
        'source 可以是 artifact_id、artifact_id#步骤id 或数据文件路径；style.mode ∈ single/point/categorical/choropleth。',
        'choropleth 需要 style.field 为数值列，classification ∈ quantile/equal_interval。',
        '多层出图：base 指定底图层（如陆地/行政区），垫在主图层之下；base_style 可调底图颜色。',
        'categorical 模式可用 style.category_colors {"类别值": "#rrggbb"} 显式控制每个类别的颜色。',
        'point 模式可用 style.size_field + size_range [min,max] 按数值字段缩放点径。',
        '标题支持中文（自动使用系统中文字体）。返回 image_path 与图例说明。',
        '栅格 source（.tif 路径或 raster 产物的 artifact_id）同样支持：',
        'style.mode=continuous（色带+百分位拉伸 [2,98]，可给 vmin/vmax/cmap/unit）',
        '或 categorical（category_colors 指定类别色表）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'artifact_id 或数据集绝对路径' },
          base: { type: 'string', description: '底图层（artifact_id 或路径），垫在主图层之下' },
          base_style: {
            type: 'object',
            description: '底图样式 {color, edgecolor, alpha}',
            properties: {
              color: { type: 'string' },
              edgecolor: { type: 'string' },
              alpha: { type: 'number', minimum: 0, maximum: 1 },
            },
            additionalProperties: false,
          },
          title: { type: 'string', description: '地图标题（支持中文）' },
          style: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['single', 'point', 'categorical', 'choropleth'] },
              field: { type: 'string', description: 'categorical/choropleth 模式的着色字段' },
              classification: { type: 'string', enum: ['quantile', 'equal_interval'] },
              classes: { type: 'integer', minimum: 2, maximum: 9 },
              cmap: { type: 'string', description: 'matplotlib colormap 名，如 YlOrRd/viridis' },
              color: { type: 'string', description: 'single/point 模式的基础颜色' },
              category_colors: {
                type: 'object',
                description: 'categorical 模式：{类别值: "#rrggbb"} 显式指定各类颜色',
                additionalProperties: { type: 'string' },
              },
              size_field: { type: 'string', description: 'point 模式：按该数值字段缩放点径' },
              size_range: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: '点径范围 [min, max]，与 size_field 搭配',
              },
            },
            additionalProperties: true,
          },
        },
        required: ['source'],
        additionalProperties: true,
      },
      output: { schema: OBJECT_SCHEMA, render: textProjection },
      execute: async (args, exec) => bridge.call('visualize', args as Record<string, unknown>, exec?.signal),
      timeoutMs: TOOL_TIMEOUT_MS,
    },
  ];
}
