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

## 3. ctx.tools.register 形态适配（重要）

官方文档对 tools service 只给出占位签名（见
`docs/user/develop/framework/service.md` 与 subsystems/core.md 提示，
线上仓库 deepseek-ai/deepseek-harness）。为抵御签名微调，
`src/tools.ts::registerTools()` 依次尝试三种形态：

```ts
tools.register(def)                 // 形态 A：单对象
tools.register(name, def)           // 形态 B：名定义分离
tools.add?.(name, def)              // 形态 C：常见替代命名
tools.defineTool?.(def)
```

全部失败会抛出明确错误并指向适配文件位置——接新宿主只需改这一个函数。
**若你拿到了 harness 的确切 ToolRuntime 类型，请删除自适应层、改为强类型调用。**

## 4. 桥协议

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

## 5. 本地无 Harness 时的验证路径

`test/bridge.test.ts` 用 node:test 直连真实 Python 内核覆盖四条黄金链路
（inspect、链式 analyze+artifact 落盘、错误码映射、空结果提示），
等效于工具层的端到端验收；接入宿主后建议再补一条真实工具注册冒烟。
