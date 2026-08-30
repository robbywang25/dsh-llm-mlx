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
dsh plugin --profile web add github:robbywang25/dsh-llm-mlx
```

安装到 DSH Desktop profile：

```bash
dsh plugin --profile desktop add github:robbywang25/dsh-llm-mlx
```

包内包含已经构建好的 `lib/`，没有安装期 lifecycle script。市场条目正式发布后，
也可从 dsh-market 安装。

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
tokenizer 配置和 safetensors 权重，然后才启动 Python。若 `18080` 上已有健康服务，
插件会直接复用；若端口被不健康服务占用则拒绝接管；卸载时只结束由插件自己启动的
进程。

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
支持的服务参数，不会把 MLX-LM 专属采样参数传给它。

不要把某位用户的本机模型路径提交到公共仓库。

## 默认值

| 设置 | 默认值 |
| --- | --- |
| 托管服务引擎 | `mlx-lm` |
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
