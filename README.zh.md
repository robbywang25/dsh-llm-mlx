# dsh-llm-mlx

[English](README.md)

把本机 [MLX-LM](https://github.com/ml-explore/mlx-lm) 或
[MLX-VLM](https://github.com/Blaizzy/mlx-vlm) 模型作为 DeepSeek Harness
提供方使用。插件通过 DSH 内置的 OpenAI-compatible 适配器增加 `local-mlx`
路由，也可以在 DSH 进程存活期间启动并托管 `mlx_lm.server` 或
`mlx_vlm.server`。

仓库不包含任何模型权重。托管启动仅支持 Apple 芯片 macOS，服务固定绑定
`127.0.0.1`。

本 bundle 还会在 macOS 上用插件依赖树里的同一份上游实现替换 DSH Desktop
2.0.3 的 subprocess provider，规避 packaged `node-pty` 把
`app.asar.unpacked` 再改成不存在的 `app.asar.unpacked.unpacked` 路径。Read
Only／Workspace Write 仍走 DSH 内置 Seatbelt 隔离；Linux 与 Windows 的进程
provider 不变。

## 前置条件

- 托管 MLX 启动需要 Apple 芯片 macOS。
- DeepSeek Harness `0.1.0-rc.6` 或 `0.1.1-rc.1+`。
- 一个已经安装 `mlx-lm` 或 `mlx-vlm` 的本机 Python 环境（与模型类型匹配），
  以及下载好的 MLX 模型。

插件也可以复用已经独立运行在 `http://127.0.0.1:18080/v1` 的
OpenAI-compatible 服务；这种模式下 DSH 不拥有该进程。

## 安装

安装到 Web profile：

```bash
dsh plugin --profile web add https://github.com/robbywang25/dsh-llm-mlx/releases/download/v0.4.0/dsh-llm-mlx-0.4.0.tgz
```

安装到 DSH Desktop profile：

```bash
dsh plugin --profile desktop add https://github.com/robbywang25/dsh-llm-mlx/releases/download/v0.4.0/dsh-llm-mlx-0.4.0.tgz
```

固定版本的 Release 包含已经构建好的 `lib/`，没有安装期 lifecycle script。
也可通过 `github:robbywang25/dsh-llm-mlx` 安装 Git 源码。dsh-market 目录独立更新，
使用时应核对条目中的制品版本。

v0.4.0 的自定义 `RuntimeDependencies` 适配器需要提供 `verifyModel`。设置
`modelPath` 时，内置适配器会校验服务器声明的模型元数据；身份未知或不匹配会拒绝
复用。这不证明权重内容或生成质量。可选代理的预算和中断响应行为见下文。

## 方案 A：复用已有 MLX 服务

在已安装 `mlx-lm` 的 Python 环境中启动：

```bash
python -m mlx_lm server \
  --model /模型的绝对路径 \
  --host 127.0.0.1 \
  --port 18080 \
  --max-tokens 512 \
  --chat-template-args '{"enable_thinking":false}'
```

视觉语言模型使用安装了 `mlx-vlm` 的环境：

```bash
python -m mlx_vlm.server \
  --model /MLX-VLM模型的绝对路径 \
  --host 127.0.0.1 \
  --port 18080 \
  --max-tokens 512
```

然后进入 DSH **设置 → 模型 → Local MLX**，填写任意非空本机占位值，例如
`local-only`。本机 MLX 服务不校验这个值；通用 OpenAI 客户端只要求 API Key 字段
非空。该值只会发送到回环地址。

新建会话并选择 **MLX Local Model**。

## 方案 B：让 DSH 托管 MLX 服务

启动 DSH 前设置：

```bash
export DSH_MLX_MODEL_PATH=/模型的绝对路径
export DSH_MLX_PYTHON=/Python解释器的绝对路径
dsh web
```

设置 `DSH_MLX_MODEL_PATH` 默认会开启 `mlx-lm` 托管启动。插件会先检查模型配置、
tokenizer 配置和 safetensors 权重，然后才启动 Python。设置了 `modelPath` 时，复用
健康服务还须通过 `/health` 和 `/v1/models` 的模型身份校验；不同模型或无法确认的
身份会明确报错，已有进程保持不变。托管启动会等待身份一致，失败时只清理本次启动的
子进程；不接管被其它服务占用的端口。

MLX-VLM 优先使用已加载模型字段，避免把下载缓存当作当前模型。MLX-LM 则要求模型
列表中存在唯一的本地绝对路径；Hub 仓库名不能证明本地默认模型。路径比较使用完整
规范路径并解析符号链接，不按目录名猜测。歧义或畸形元数据会被拒绝；每次元数据读取
限时 1 秒、上限 64 KiB。没有设置 `modelPath` 的独立服务保留原有健康检查复用方式；
需要约束目标模型时，应明确设置该路径。

这项检查发生在插件启用时，验证的是服务声明的模型身份，不验证权重内容、Python
引擎身份或实际生成能力。`serverEngine` 用于选择托管启动命令；完整链路仍需真实生成验收。

若要使用持久的本机 profile 配置，可在对应 profile 的 `cordis.patch.yml` 中加入：

```yaml
- id: llm-mlx-runtime
  config:
    autoStart: true
    serverEngine: mlx-lm
    modelPath: /模型的绝对路径
    pythonExecutable: /Python解释器的绝对路径
```

视觉语言模型设置 `serverEngine: mlx-vlm`。托管启动会改用 MLX-VLM 模块及其
支持的服务参数，不会把 MLX-LM 专属采样参数传给它。内存受限的 Mac 若需要把
多个 Agent 请求改为串行排队，可设置 `maxNumSeqs: 1`，避免无上限 continuous
batch 同时解码。

### 可选的 CC Switch／Claude Desktop SSE 兼容层

部分 MLX-VLM 版本会在每个 OpenAI 流式 `delta` 中同时输出
`reasoning_content` 和弃用别名 `reasoning`。CC Switch 3.20.x 用同一个 serde
字段解析这两个名字，因重复字段而丢弃整块 SSE；因此可能出现非流式调用成功、
Claude Desktop 却没有正文的现象。

只有复现该症状时，才在第二个端口开启插件的回环兼容代理：

```yaml
- id: llm-mlx-runtime
  config:
    autoStart: true
    serverEngine: mlx-vlm
    modelPath: /模型的绝对路径
    pythonExecutable: /Python解释器的绝对路径
    port: 18081
    maxNumSeqs: 1
    ccSwitchProxyPort: 18082
    ccSwitchChatOnly: true
```

DSH 继续指向原始模型端点；只把 CC Switch 的 Claude Desktop provider 的 OpenAI
Chat Completions Base URL 设为 `http://127.0.0.1:18082/v1`。代理仅删除重复的弃用
别名，其余字段逐流转发；它只绑定回环地址并随 DSH 插件停止。删除
`ccSwitchProxyPort` 即可关闭。

`ccSwitchChatOnly: true` 会把 Cowork 的 Agent／developer 指令替换为精简的本机
聊天指令，删除 OpenAI 工具声明和工具结果消息，同时保留用户／助手对话正文。首次
在 Claude Desktop 体验本机或解除对齐的模型时建议开启最小权限模式；即使用户只
要求文本，Cowork 仍可能附带大量工具目录和 Agent 提示。此模式明确不支持 Cowork
工具执行；代理不会记录消息正文或凭据。只有明确需要并已单独信任本机模型的工具
调用时，才省略此设置。

可选代理默认允许 10 秒建立连接；完整请求发送后，最多等待 5 分钟接收首个响应
正文数据。收到正文后，每个数据块都会重新开始独立的 5 分钟空闲计时。只有响应头
不算完成预填充等待；只要正文持续到达，就没有整次生成的总时长截止。较慢的本机
模型可以调整预算，同时保留边界：

```yaml
    ccSwitchProxyLimits:
      connectTimeoutMs: 10000
      firstByteTimeoutMs: 300000
      idleTimeoutMs: 300000
      maxSseEventBytes: 1048576
```

各项必须为正整数；超时最多支持 1 小时，SSE 事件缓冲最多支持 16 MiB。默认
1 MiB 按每个事件的 UTF-8 字节计数，包含分隔符，不限制整段流的累计大小。普通
JSON 响应直接转发，不收集完整正文。超时在输出开始前返回 504；超大 SSE 事件
或上游响应中断返回 502。已经开始输出时会直接终止不完整响应，不追加错误正文；
客户端应将该回答视为未完成。客户端取消或代理退出时会关闭对应的上游请求。
格式不合法的请求 URL 会返回 400，不向上游发起请求，也不会让代理宿主进程退出。
这些设置只作用于可选代理，不会自动开启它或改变直连模型的路由。代码调用方可将
相同字段传入 `options.limits`。

不要把某位用户的本机模型路径提交到公共仓库。

## 默认值

| 设置 | 默认值 |
| --- | --- |
| 托管服务引擎 | `mlx-lm` |
| MLX-VLM 并发序列 | 使用服务默认值；可选 `maxNumSeqs` |
| CC Switch SSE 兼容代理 | 默认关闭；可选 `ccSwitchProxyPort` |
| CC Switch 纯聊天工具边界 | 默认关闭；可选 `ccSwitchChatOnly` |
| Provider | `local-mlx` |
| 模型 ID | `default_model` |
| API Base URL | `http://127.0.0.1:18080/v1` |
| 向 DSH 声明的上下文窗口 | 16,384 tokens |
| 最大输出 | 512 tokens |
| Temperature / top-p / top-k | `0.6` / `0.8` / `20` |
| Thinking 模板参数 | 关闭 |
| 托管启动 | 只有设置 `DSH_MLX_MODEL_PATH` 才开启 |

提供方配置仍可在 DSH 模型页修改。如果服务使用其他端口，必须同时修改运行时端口
和 provider Base URL。

## 安全边界

- 托管服务的 host 固定为 `127.0.0.1`，插件不提供局域网或公网监听选项。
- 可选的 CC Switch 兼容代理同样只绑定 `127.0.0.1`，只接受回环 MLX 上游，
  不记录凭据或消息正文。
- 模型路径必须是已存在的本机绝对路径；插件不会下载模型。
- Python 使用参数数组启动，不经过 shell。
- 插件不上传权重、prompt、回复、凭据或遥测。
- `DSH_MLX_API_KEY` 只是本机占位符，不是外部凭据。
- macOS PTY 兼容 provider 只改变同一份上游 subprocess 实现及其原生 helper 的加载位置，不削弱 DSH 权限 preset，也不绕过 Seatbelt。
- 插件卸载时只停止自己创建的子进程，不会停止独立管理的服务。

MLX HTTP 服务用于本机开发。请只在回环地址使用，不要直接暴露到
不受信任的网络。

## 验证

```bash
curl --fail http://127.0.0.1:18080/health
curl --fail http://127.0.0.1:18080/v1/models
```

对于受影响的 DSH Desktop 版本，还需分别在 Full Access 与 Read Only 下用 `pwd`
等无副作用命令验证 Bash。Read Only 必须报告 Seatbelt 隔离成功，不能静默退化为
无隔离执行。

最终验收必须是：新建 DSH 会话，选择 **MLX Local Model**，并实际收到模型回复。
只有模型卡可见或 health 返回 `200`，都不等于完整 DSH 链路通过。

仓库校验：

```bash
npm ci --ignore-scripts
npm run check
```

## 卸载

```bash
dsh plugin --profile web remove dsh-llm-mlx
# 或
dsh plugin --profile desktop remove dsh-llm-mlx
```

由插件托管的服务会随插件卸载而停止；独立服务需单独停止。卸载后可在 DSH 模型
设置中删除本机占位凭据。

## 许可证

MIT。MLX-LM、MLX-VLM 与每个模型继续适用各自许可证；本仓库不重新分发它们。
