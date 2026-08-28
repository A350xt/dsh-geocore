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
        '- query.filter {input, where}            属性过滤。pandas query 语法；关键字列名用反引号如 `class`',
        '- query.select {input, predicate, ref}   空间选择；predicate ∈ intersects/within/contains/touches/crosses/overlaps',
        '- query.measure {input, measures}        度量；measures ⊆ [area_sqkm, area_ha, length_km, count]，会附加面积/长度列',
        '- proximity.buffer {input, distance_m, dissolve?, quad_segs?}',
        '- proximity.within_distance {input, ref, distance_m}   距参照层 distance_m 米以内筛选',
        '- proximity.nearest {input, ref, k?, join_attrs?}      每个要素的最近参照要素及距离',
        '- overlay.intersection / difference / union {a, b}',
        '- overlay.clip {a, b}                    用 b 掩膜裁剪 a（只保留 a 属性）',
        '- zonal.summarize {regions, data, stats?, field?}      分区统计：点计数/属性和、线长度占比、面面积占比与按面积加权统计',
        '',
        '规则：距离单位米、结果输出到 artifacts 目录并返回 artifact_id。',
        '后续引用三种写法：@步骤id（同一请求内）、artifact_id（最终结果）、artifact_id#步骤id（持久化的中间步骤）。',
        '空结果是常见异常信号（过滤过严？CRS 不匹配？）；确属预期时给该步加 "allow_empty": true。',
        '永远不要自己算坐标或长度——一律通过本工具完成度量。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '本次分析的人类可读标题' },
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
        '返回 image_path 与图例说明，可把路径展示给用户或继续引用。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'artifact_id 或数据集绝对路径' },
          title: { type: 'string', description: '地图标题（默认中文）' },
          style: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['single', 'point', 'categorical', 'choropleth'] },
              field: { type: 'string', description: 'categorical/choropleth 模式的着色字段' },
              classification: { type: 'string', enum: ['quantile', 'equal_interval'] },
              classes: { type: 'integer', minimum: 2, maximum: 9 },
              cmap: { type: 'string', description: 'matplotlib colormap 名，如 YlOrRd/viridis' },
              color: { type: 'string', description: 'single/point 模式的基础颜色' },
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
