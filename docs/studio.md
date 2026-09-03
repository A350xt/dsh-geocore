# GeoCore Studio —— 双标签页 GIS 工作台

> 标签页 A（地图工作台）：传统 ArcGIS 风格的地图优先界面，可视化操作直连分析内核。
> 标签页 B（Agent 对话）：真实 DSH 大脑（dsh-base + 你配置的模型），自然语言驱动全部 GIS 原语。
> 两个标签页共享同一份 datasets 与 artifacts——对话产生的结果一键上图，地图上的操作产出 Agent 可引用的 artifact。

## 与 DSH 主界面的同标签页切换

DSH Web 主界面右下角有 **「🗺 GeoCore 地图」** 悬浮按钮（由本包的 `dsh.client`
客户端覆盖层注入），点击后**同一个浏览器标签页**切换到 Studio；
Studio 顶栏随之出现 **「↩ 返回 DSH」** 按钮，点击切回 DSH 对话界面。
往返地址通过 `?from=` 参数 + sessionStorage 记忆（直接打开 4173 时不显示返回按钮）。

> 注：悬浮按钮跳转地址固定为 `http://127.0.0.1:4173`（与插件配置端口一致）；
> 改端口需同步改 `client/index.ts` 的 STUDIO_URL 并重新构建。

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

**方式一（推荐）：挂进 DSH web profile，随 DSH 一起启动。**
`~/.dsh/profiles/web/cordis.patch.yml` 已插入 geocore-studio 条目——正常启动你的 DSH 后，
浏览器另开一个标签页访问 **http://127.0.0.1:4173** 即可（DSH 聊天界面的 gis 工具与
Studio 页面同源同进程，共享 artifacts；端口被占用时仅告警，不影响 DSH 本体）。

**方式二：独立启动（不跑完整 DSH web）。**

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
