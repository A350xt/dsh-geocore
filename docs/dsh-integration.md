# DeepSeek Harness 集成指南

本插件按官方 cordis 规范实现（TypeScript / `@deepseek-ai/cordis` v4），
通过子进程桥接 Python 内核。宿主不需要安装任何 GIS 依赖。

## 0. 前置条件

- Python ≥3.11 且已安装内核：`pip install -e .`（仓库根目录执行）
- Node ≥20 + npm（构建插件）
- DeepSeek Harness 宿主（`ctx.tools` 服务可用）

## 1. 构建

```bash
cd plugin-geocore
npm install
npm run build        # 产物在 lib/
npm test             # 桥契约测试：直连真实 Python 内核（需合成数据集，见 README）
```

## 2. 在 Harness 中加载

```ts
import geocore from '@dsh/plugin-geocore';

await ctx.plugin(geocore, {
  pythonCmd: 'python',              // 或 GEOCORE_PYTHON 环境变量；默认 'python'
  workdir:   'D:/data/gis-workdir', // artifacts/ 与相对路径数据的根目录；默认 process.cwd()
  timeoutMs: 300_000,
});
```

插件行为：

1. 构造并注册名为 **`gis`** 的 cordis Service（`ctx.gis` 可直接调 `call(action,payload)`）。
2. 向宿主 `ctx.tools` 注册三个工具：
   `gis_inspect` / `gis_analyze` / `gis_visualize`。
3. `tools` 服务未就绪时通过 `ctx.inject(['tools'], …)` 挂起，就绪后自动注册。

## 3. 工具注册契约（已对齐真实 API）

插件直接使用宿主 `@deepseek-ai/dsh-tools` 的 `ToolDefinition` 强类型
（`register(definition): () => void`，见其 lib/types/index.d.ts）。要点：

- 模型可见面只有 `name / description / parameters`（JSON Schema）；
- `output: { schema, render(args, value) }` 为必填，本插件统一做文本投影（超 40 万字符截断）；
- `execute(args, exec)` 会把 `exec.signal` 透传给 Python 桥，宿主取消时整树终止子进程；
- 每工具 `timeoutMs: 330000`，略大于桥自身 300s 超时，保证超时语义由桥负责。

以 **0.1.1-rc.2** 版本的 dsh-tools/dsh-llm 类型编译通过（`npm run build` 零错误）。

## 4. 安装到本机 DSH profile（已验证路径）

1. 构建插件：`cd plugin-geocore && npm install && npm run build`（产物 `lib/index.js`）。
2. 准备工作目录：如 `D:/work/DSH-GIS/dsh-work`（artifacts 落这里）。
3. 编辑 `~/.dsh/profiles/web/cordis.patch.yml`（改前备份），追加 insert 条目：

   ```yaml
   - id: geocore
     insert:
       - id: dsh-plugin-geocore
         name: file:///D:/work/DSH-GIS/plugin-geocore/lib/index.js
         config:
           pythonCmd: python
           workdir: D:/work/DSH-GIS/dsh-work
           timeoutMs: 300000
   ```

4. 重启 DSH（或重载 profile）。验证：设置 → 插件清单应出现
   `dsh-plugin-geocore`；会话中可见三个 gis 工具。

**免重启验证**：`node plugin-geocore/test/dsh_host_smoke.mjs`
用宿主自己的 cordis 启动最小宿主，断言三工具注册 + 真实内核执行 + gis 服务就位。

## 5. 桥协议

每请求独立进程，封套契约与 CLI 完全一致（docs/tool-api.md 底部）：

```text
spawn(pythonCmd, ['-m','geocore','run','--workdir',workdir], {shell:false})
stdin  ← {"action":"analyze","operations":[…]}
stdout → {"ok":true,"result":{…}} | {"ok":false,"error":{code,message,details}}
```

桥内建保护：

| 保护 | 行为 |
| --- | --- |
| 命令白名单 | pythonCmd 禁止 shell 元字符（环境变量来源同样把守） |
| 超时 | 默认 300s，到点 `taskkill /T` 整树终止 → `E_BRIDGE_TIMEOUT` |
| 输出上限 | stdout >64MB 终止 → `E_BRIDGE_OVERSIZED_OUTPUT` |
| 坏输出 | 无合法封套 → `E_BRIDGE_BROKEN_OUTPUT` 附 stderr 尾巴 |
| Artifact 越界 | id 白名单正则 + realpath 包含性校验，杜绝路径逃逸 |

## 6. 本地无 Harness 时的验证路径

`test/bridge.test.ts` 用 node:test 直连真实 Python 内核覆盖四条黄金链路
（inspect、链式 analyze+artifact 落盘、错误码映射、空结果提示），
等效于工具层的端到端验收；接入宿主后建议再补一条真实工具注册冒烟。
