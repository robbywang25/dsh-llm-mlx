# Security Policy

## Supported versions

Security fixes are made on the latest `0.2.x` release while the plugin and
DeepSeek Harness remain in developer preview.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting form for this repository. Do not
open a public issue containing credentials, private model paths, prompts,
responses, or other sensitive logs.

Include the plugin version, DSH version, macOS version, a minimal reproduction,
and redacted logs. Never attach model weights or a DSH credentials file.

## Trust boundary

- Managed inference binds only to `127.0.0.1`.
- The plugin never downloads or uploads model weights.
- Model paths must be absolute and are passed to Python without a shell.
- Only a child process started by the plugin is terminated during cleanup.
- An external server on the configured port is reused only after its `/health`
  response matches the expected MLX-LM or MLX-VLM shape.

The user controls the selected Python interpreter and local model directory.
Treat both as trusted local code and data.
