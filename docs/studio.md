# GeoCore Studio —— 双标签页 GIS 工作台

> 标签页 A（地图工作台）：传统 ArcGIS 风格的地图优先界面，可视化操作直连分析内核。
> 标签页 B（Agent 对话）：真实 DSH 大脑（dsh-base + 你配置的模型），自然语言驱动全部 GIS 原语。
> 两个标签页共享同一份 datasets 与 artifacts——对话产生的结果一键上图，地图上的操作产出 Agent 可引用的 artifact。

## 架构

```text
浏览器（http://127.0.0.1:4173）
 ├─ 标签页 A 地图工作台：Leaflet + 图层树 + 六种可视化操作表单
 └─ 标签页 B Agent 对话：ndjson 事件流（assistant/chunk 流式文本、tool 卡片、artifact 徽章上图）
        │
        ▼
apps/geocore-studio（dsh profile 插件，与 dsh-base 同进程）
 ├─ REST：/api/config /api/inventory /api/read /api/analyze /api/visualize /api/file
 ├─ POST /api/chat → StudioAgent（agents.create → followup → whenIdle，事件按 seq 增量下发）
 └─ ctx.tools.register(gis_inspect / gis_analyze / gis_visualize)
        │
        ▼
geocore Python 内核（无状态，read/list 为 Studio 扩展动作）
```

关键决定：**不自己实现 Agent 循环**——StudioAgent 是 dsh-headless 一次性驱动的多轮化改造
（同款 `agents.create` + `followup` + `sessions.flush`），因此标签页 B 拿到的是与
`dsh --profile headless` 完全一致的系统提示、工具协议与模型配置。

## 启动

```bash
# 0) 前置：geocore 已 pip install -e .；profile 已建好（见下）
# 1) 构建（改代码后需要）
cd apps/geocore-studio && npm install && npm run build
# 2) 启动（dsh CLI 从 web profile 的安装目录取）
node "$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile geocore-studio
# 3) 打开 http://127.0.0.1:4173
```

profile 位于 `~/.dsh/profiles/geocore-studio/`（dsh-base bundle + cordis.patch.yml 指向
`apps/geocore-studio/dist/studio-plugin.mjs`，含 port/pythonCmd/geocoreWorkdir/datasetsDir 配置）。
修改启动配置就编辑那个 patch 文件。

## 使用

**地图工作台**
- 左侧图层树：数据集与 artifacts（可展开中间步骤图层）点击即上图；已加载图层支持
  显隐/缩放/移除与字段样式（单色/分类/分级）。
- 工具条六操作：筛选 / 缓冲区 / 邻近筛选 / 叠加分析 / 分区统计 / 度量——表单提交即
  `gis_analyze` 等价调用，结果自动上图并在右侧面板展示步骤摘要与 CRS 告警。
- 点击要素查看属性。

**Agent 对话**
- 直接用自然语言提问；回复流式渲染，工具调用显示为卡片（含人话摘要与告警）。
- 产物徽章「在地图中查看」：切回地图标签并自动加载该 artifact。
- Agent 会话在服务器进程内常驻多轮；重启进程即开新会话（历史持久化在 ~/.dsh/sessions，
  回放 UI 属后续工作）。

## 已知边界（诚实清单）

- 会话不回放：刷新页面后对话区清空（服务端 session 仍在 ~/.dsh/sessions，可导出）。
- 审批策略沿用 profile 默认（workspace-write + ask）；Agent 若发起需审批的 bash 操作，
  在无应答者的 Studio 里会失败关闭——GIS 工具本身不受影响。本地完全放开可用
  `DSH_PERMISSION_MODE=danger-full-access` 启动。
- IAB（ZCode 内置浏览器）对该站的 load 事件上报异常（页面实际正常，goto 会超时）；
  用 Chrome/Edge 打开无此问题。
- 大图层上图上限 8000 要素（read.max_features），超出截断并提示。
