# GeoCore Studio —— GIS 地图工作台

> 传统 ArcGIS 风格的地图优先界面：图层树 + 六种可视化操作直连分析内核。
> 自然语言对话由 **DSH 主界面本身**承担（gis_inspect / gis_analyze / gis_visualize
> 已注册进 DSH 的 tools 服务）——Studio 不再内嵌独立对话，两侧共享同一份
> datasets 与 artifacts：DSH 里对话产生的结果在 Studio 图层树一键上图，
> Studio 上的操作产出 DSH Agent 可引用的 artifact。

## 嵌入 DSH 主界面（页内展开，非独立页面）

DSH Web 主界面**右上角的图标按钮 🗺**（由本包的 `dsh.client`
客户端覆盖层注入，悬停有文字提示）会在 **DSH 页面内**铺开一个全屏嵌入层（iframe
加载 Studio 服务），再次点击（图标变 ✕）收起——**不发生页面导航，DSH 会话状态原地保留**。

- 展开前先对 `127.0.0.1:4173/api/config` 探活（该接口放开了 CORS 供跨源探测）；
  服务未启动时嵌入层显示提示文字而非空白。
- 嵌入模式下 Studio 不显示"返回 DSH"按钮（无 `?from` 来源时自动隐藏）。
- 独立在浏览器打开 `http://127.0.0.1:4173` 仍是完整可用的工作台。

## 主题与风格（对齐 DSH）

- Studio 样式令牌取自 DSH 的 dsw 设计系统（`dsh-client-ui-theme`）：
  中性色阶 neutral-bluish、品牌蓝 deepseek-500/400、12px 圆角、细边框、
  DSH 式单色主按钮（亮 = 墨色底白字，暗 = 白底墨字）。
- 双主题：`?theme=dark|light` 显式指定，缺省跟随系统 `prefers-color-scheme`
  （index.html 内联脚本先行设定，避免闪白）。
- 嵌入 DSH 时，覆盖层按钮直接引用宿主页面的 `--dsw-alias-*` 变量（带回退），
  自动跟随 DSH 主题；展开时读取 `body[data-ds-dark-theme]` 把当前主题以
  `?theme=` 透传给 Studio iframe。

> 注：嵌入地址固定为 `http://127.0.0.1:4173`（与插件配置端口一致）；
> 改端口需同步改 `client/index.ts` 的 STUDIO_URL/PROBE_URL 并重新构建。

## 架构

```text
浏览器（http://127.0.0.1:4173）
 └─ 地图工作台：Leaflet + 图层树 + 六种可视化操作表单
        │
        ▼
apps/geocore-studio（dsh profile 插件，与 dsh-base 同进程）
 ├─ REST：/api/config /api/inventory /api/read /api/analyze /api/visualize /api/file
 └─ ctx.tools.register(gis_inspect / gis_analyze / gis_visualize)
        │
        ▼
geocore Python 内核（无状态，read/list 为 Studio 扩展动作）

DSH 主界面（Agent 对话）
 └─ 同一 tools 注册 → 自然语言驱动同一内核，产物落同一 workdir
```

关键决定：**Agent 对话不在 Studio 内重复造轮子**——DSH 主界面就是 Agent UI，
Studio 专注可视化工作台；两者经共享的 tools 注册与 artifacts 目录协作。

## 启动

**方式一（推荐）：挂进 DSH web profile，随 DSH 一起启动。**
`~/.dsh/profiles/web/cordis.patch.yml` 已插入 geocore-studio 条目——正常启动你的 DSH 后，
点击主界面右上角 🗺 图标即可页内展开 Studio（DSH 聊天界面的 gis 工具与
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

**自然语言分析**
- 在 DSH 主界面直接用自然语言提问（gis 工具已注册）；
  产生的 artifact 会出现在 Studio 图层树的"分析产物"分组，点击即上图。

## 已知边界（诚实清单）

- 大图层上图上限 8000 要素（read.max_features），超出截断并提示。
- IAB（ZCode 内置浏览器）对该站的 load 事件上报异常（页面实际正常，goto 会超时）；
  用 Chrome/Edge 打开无此问题。
