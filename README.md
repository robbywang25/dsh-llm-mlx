# dsh-llm-mlx

[中文](README.zh.md)

Use a local [MLX-LM](https://github.com/ml-explore/mlx-lm) or
[MLX-VLM](https://github.com/Blaizzy/mlx-vlm) model as a DeepSeek Harness
provider. The plugin contributes a `local-mlx` model route through DSH's
built-in OpenAI-compatible adapter and can optionally start and own
`mlx_lm.server` or `mlx_vlm.server` for the lifetime of the DSH process.

No model weights are included. Managed startup is limited to Apple-silicon
macOS and binds the server to `127.0.0.1`.

## Requirements

- Apple-silicon macOS for managed MLX startup.
- DeepSeek Harness `0.1.0-rc.6` or `0.1.1-rc.1+`.
- A local Python environment with `mlx-lm` or `mlx-vlm`, matching the selected
  model, and a downloaded MLX model.

The provider can also reuse an independently managed OpenAI-compatible server
at `http://127.0.0.1:18080/v1`; in that mode DSH does not own its process.

## Install

For the Web profile:

```bash
dsh plugin --profile web add github:robbywang25/dsh-llm-mlx
```

For DSH Desktop's profile:

```bash
dsh plugin --profile desktop add github:robbywang25/dsh-llm-mlx
```

The package ships committed `lib/` output and has no install lifecycle script.
It can also be installed from dsh-market after the catalog entry is published.

## Option A: reuse an existing MLX server

Start the server from the Python environment that contains `mlx-lm`:

```bash
python -m mlx_lm server \
  --model /absolute/path/to/your-mlx-model \
  --host 127.0.0.1 \
  --port 18080 \
  --max-tokens 512 \
  --chat-template-args '{"enable_thinking":false}'
```

For a vision-language model, use an environment containing `mlx-vlm`:

```bash
python -m mlx_vlm.server \
  --model /absolute/path/to/your-mlx-vlm-model \
  --host 127.0.0.1 \
  --port 18080 \
  --max-tokens 512
```

Then open DSH **Settings → Models → Local MLX** and enter any non-empty local
placeholder such as `local-only`. The local MLX servers do not require this
value; the generic OpenAI client requires a non-empty API-key field. The value
is sent only to the loopback endpoint.

Create a new session and choose **MLX Local Model**.

## Option B: let DSH own the MLX server

Set these variables before starting DSH:

```bash
export DSH_MLX_MODEL_PATH=/absolute/path/to/your-mlx-model
export DSH_MLX_PYTHON=/absolute/path/to/python
dsh web
```

`DSH_MLX_MODEL_PATH` enables managed `mlx-lm` startup by default. The plugin
checks for local model configuration, tokenizer configuration, and safetensors
weights before it spawns Python. It reuses an already healthy server on port
`18080`, refuses an occupied unhealthy port, and terminates only a server
process that it started.

For a persistent machine-local profile setting, add this to that profile's
`cordis.patch.yml` instead of exporting variables:

```yaml
- id: llm-mlx-runtime
  config:
    autoStart: true
    serverEngine: mlx-lm
    modelPath: /absolute/path/to/your-mlx-model
    pythonExecutable: /absolute/path/to/python
```

Set `serverEngine: mlx-vlm` for a vision-language model. MLX-VLM managed
startup uses its own module and supported server flags; MLX-LM-only sampling
flags are not passed to it.

Do not commit a user-specific model path to a public repository.

## Defaults

| Setting | Default |
| --- | --- |
| Managed server engine | `mlx-lm` |
| Provider | `local-mlx` |
| Model id | `default_model` |
| API base URL | `http://127.0.0.1:18080/v1` |
| Context window advertised to DSH | 16,384 tokens |
| Maximum output | 512 tokens |
| Temperature / top-p / top-k | `0.6` / `0.8` / `20` |
| Thinking template flag | disabled |
| Managed startup | off unless `DSH_MLX_MODEL_PATH` is set |

The provider profile remains editable through DSH's Models page. If a server
uses another port, update both its runtime configuration and the provider base
URL.

## Security boundary

- The managed server host is fixed to `127.0.0.1`; the plugin has no LAN or
  public bind option.
- Model paths must be absolute and point to existing local MLX files. The
  plugin does not download models.
- Python is launched with an argument array, never through a shell.
- The plugin does not upload weights, prompts, responses, credentials, or
  telemetry.
- The placeholder `DSH_MLX_API_KEY` is not an external credential.
- Unloading the plugin stops only the child process that the plugin owns. An
  independently managed server is never stopped.

The MLX HTTP servers are local development servers. Keep them on loopback and
do not expose them directly to an untrusted network.

## Verify

```bash
curl --fail http://127.0.0.1:18080/health
curl --fail http://127.0.0.1:18080/v1/models
```

The final acceptance test is a new DSH session that has **MLX Local Model**
selected and receives a real reply. A visible model card or a `200` health
response alone does not prove the full DSH path.

Repository checks:

```bash
npm ci --ignore-scripts
npm run check
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-llm-mlx
# or
dsh plugin --profile desktop remove dsh-llm-mlx
```

Managed servers stop when the plugin unloads. Stop an independently managed
server separately. The optional local placeholder credential can be removed
from DSH's Models settings after uninstalling.

## License

MIT. MLX-LM, MLX-VLM, and each model keep their own licenses; this repository
does not redistribute them.
