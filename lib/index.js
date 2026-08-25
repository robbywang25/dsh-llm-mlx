// src/config.ts
import { isAbsolute } from "path";
import z from "@deepseek-ai/schemastery";
var DEFAULT_PORT = 18080;
var DEFAULT_STARTUP_TIMEOUT_MS = 9e4;
var DEFAULT_MAX_TOKENS = 512;
var DEFAULT_TEMPERATURE = 0.6;
var DEFAULT_TOP_P = 0.8;
var DEFAULT_TOP_K = 20;
var Config = z.object({
  autoStart: z.boolean().default(false),
  serverEngine: z.union(["mlx-lm", "mlx-vlm"]).default("mlx-lm"),
  modelPath: z.string(),
  pythonExecutable: z.string().default("python3"),
  port: z.number().step(1).min(1024).max(65535).default(DEFAULT_PORT),
  startupTimeoutMs: z.number().step(1).min(1e3).max(3e5).default(DEFAULT_STARTUP_TIMEOUT_MS),
  maxTokens: z.number().step(1).min(1).max(32768).default(DEFAULT_MAX_TOKENS),
  temperature: z.number().min(0).max(2).default(DEFAULT_TEMPERATURE),
  topP: z.number().min(0).max(1).default(DEFAULT_TOP_P),
  topK: z.number().step(1).min(0).max(1e3).default(DEFAULT_TOP_K),
  disableThinking: z.boolean().default(true),
  logLevel: z.union(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]).default("WARNING")
});
function cleanString(value, field) {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`dsh-llm-mlx: ${field} must be non-empty and have no surrounding whitespace`);
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`dsh-llm-mlx: ${field} must be a single plain-text value`);
  }
  return value;
}
function resolveConfig(config) {
  const autoStart = config.autoStart ?? false;
  const modelPath = config.modelPath === void 0 ? void 0 : cleanString(config.modelPath, "modelPath");
  if (autoStart && modelPath === void 0) {
    throw new Error("dsh-llm-mlx: modelPath is required when autoStart is enabled");
  }
  if (modelPath !== void 0 && !isAbsolute(modelPath)) {
    throw new Error("dsh-llm-mlx: modelPath must be an absolute local path");
  }
  return {
    autoStart,
    serverEngine: config.serverEngine ?? "mlx-lm",
    ...modelPath === void 0 ? {} : { modelPath },
    pythonExecutable: cleanString(config.pythonExecutable ?? "python3", "pythonExecutable"),
    host: "127.0.0.1",
    port: config.port ?? DEFAULT_PORT,
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    topP: config.topP ?? DEFAULT_TOP_P,
    topK: config.topK ?? DEFAULT_TOP_K,
    disableThinking: config.disableThinking ?? true,
    logLevel: config.logLevel ?? "WARNING"
  };
}

// src/runtime.ts
import { spawn } from "child_process";
import { access, mkdir, readdir, stat } from "fs/promises";
import { createConnection } from "net";
import { join } from "path";
import { setTimeout as delay } from "timers/promises";
import { tmpdir } from "os";
var HEALTH_POLL_MS = 250;
var STOP_GRACE_MS = 5e3;
var HEALTH_TIMEOUT_MS = 1e3;
function endpointFor(config) {
  return `http://${config.host}:${String(config.port)}/v1`;
}
function healthUrlFor(config) {
  return `http://${config.host}:${String(config.port)}/health`;
}
function buildServerArgs(config) {
  if (config.modelPath === void 0) {
    throw new Error("dsh-llm-mlx: cannot build server arguments without modelPath");
  }
  if (config.serverEngine === "mlx-vlm") {
    const args2 = [
      "-m",
      "mlx_vlm.server",
      "--model",
      config.modelPath,
      "--host",
      config.host,
      "--port",
      String(config.port),
      "--max-tokens",
      String(config.maxTokens),
      "--log-level",
      config.logLevel
    ];
    if (!config.disableThinking) args2.push("--enable-thinking");
    return args2;
  }
  const args = [
    "-m",
    "mlx_lm",
    "server",
    "--model",
    config.modelPath,
    "--host",
    config.host,
    "--port",
    String(config.port),
    "--max-tokens",
    String(config.maxTokens),
    "--temp",
    String(config.temperature),
    "--top-p",
    String(config.topP),
    "--top-k",
    String(config.topK),
    "--log-level",
    config.logLevel
  ];
  if (config.disableThinking) {
    args.push("--chat-template-args", '{"enable_thinking":false}');
  }
  return args;
}
async function inspectModel(modelPath) {
  const details = await stat(modelPath);
  if (!details.isDirectory()) {
    throw new Error("dsh-llm-mlx: modelPath must point to a local model directory");
  }
  const files = new Set(await readdir(modelPath));
  for (const required of ["config.json", "tokenizer_config.json"]) {
    if (!files.has(required)) {
      throw new Error(`dsh-llm-mlx: modelPath is missing ${required}`);
    }
    await access(join(modelPath, required));
  }
  if (![...files].some((file) => file.endsWith(".safetensors"))) {
    throw new Error("dsh-llm-mlx: modelPath contains no .safetensors weights");
  }
}
async function isHealthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = await response.json();
    return isHealthyPayload(body);
  } catch {
    return false;
  }
}
function isHealthyPayload(body) {
  if (typeof body !== "object" || body === null) return false;
  const status = body.status;
  return status === "ok" || status === "healthy";
}
async function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(HEALTH_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
var defaultDependencies = {
  platform: process.platform,
  arch: process.arch,
  inspectModel,
  isHealthy,
  isPortOpen,
  spawnProcess(executable, args, env) {
    return spawn(executable, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
  },
  sleep: (milliseconds) => delay(milliseconds),
  now: () => Date.now(),
  makeCacheDirectory: (path) => mkdir(path, { recursive: true, mode: 448 }).then(() => void 0)
};
function observeExit(child) {
  let settled = false;
  const promise = new Promise((resolve) => {
    child.once("error", (error) => {
      settled = true;
      resolve({ code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });
  return { promise, exited: () => settled };
}
async function terminate(child, exit, sleep) {
  if (exit.exited()) return;
  child.kill("SIGTERM");
  await Promise.race([exit.promise, sleep(STOP_GRACE_MS)]);
  if (!exit.exited()) {
    child.kill("SIGKILL");
    await Promise.race([exit.promise, sleep(1e3)]);
  }
}
function exitDescription(state) {
  if (state.error !== void 0) return state.error.message;
  if (state.signal !== null) return `signal ${state.signal}`;
  return `exit code ${String(state.code)}`;
}
async function ensureMlxRuntime(config, logger, dependencies = defaultDependencies) {
  const endpoint = endpointFor(config);
  const healthUrl = healthUrlFor(config);
  if (await dependencies.isHealthy(healthUrl)) {
    logger.info(`dsh-llm-mlx: reusing healthy loopback server at ${endpoint}`);
    return { mode: "reused", endpoint, dispose: async () => void 0 };
  }
  if (!config.autoStart) {
    logger.warn(`dsh-llm-mlx: no healthy server at ${endpoint}; configure one or enable managed startup`);
    return { mode: "disabled", endpoint, dispose: async () => void 0 };
  }
  if (dependencies.platform !== "darwin" || dependencies.arch !== "arm64") {
    throw new Error("dsh-llm-mlx: managed MLX startup requires Apple-silicon macOS");
  }
  if (config.modelPath === void 0) {
    throw new Error("dsh-llm-mlx: modelPath is required for managed startup");
  }
  if (await dependencies.isPortOpen(config.host, config.port)) {
    throw new Error(`dsh-llm-mlx: loopback port ${String(config.port)} is occupied by a non-healthy service`);
  }
  await dependencies.inspectModel(config.modelPath);
  const cacheDirectory = join(tmpdir(), "dsh-llm-mlx-hf-cache");
  await dependencies.makeCacheDirectory(cacheDirectory);
  const child = dependencies.spawnProcess(config.pythonExecutable, buildServerArgs(config), {
    ...process.env,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? cacheDirectory
  });
  child.stderr?.resume();
  const exit = observeExit(child);
  const deadline = dependencies.now() + config.startupTimeoutMs;
  while (dependencies.now() < deadline) {
    if (await dependencies.isHealthy(healthUrl)) {
      logger.info(`dsh-llm-mlx: managed loopback server is healthy at ${endpoint}`);
      return {
        mode: "spawned",
        endpoint,
        ...child.pid === void 0 ? {} : { pid: child.pid },
        dispose: () => terminate(child, exit, dependencies.sleep)
      };
    }
    const state = await Promise.race([
      exit.promise.then((value) => ({ kind: "exit", value })),
      dependencies.sleep(HEALTH_POLL_MS).then(() => ({ kind: "tick" }))
    ]);
    if (state.kind === "exit") {
      throw new Error(`dsh-llm-mlx: ${config.serverEngine} server stopped during startup (${exitDescription(state.value)})`);
    }
  }
  await terminate(child, exit, dependencies.sleep);
  throw new Error(`dsh-llm-mlx: ${config.serverEngine} server did not become healthy within ${String(config.startupTimeoutMs)} ms`);
}

// src/index.ts
var name = "llm-mlx-runtime";
function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.effect(async () => {
    const runtime = await ensureMlxRuntime(resolved, {
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message)
    });
    return async () => runtime.dispose();
  }, "dsh-llm-mlx: local MLX runtime");
}
export {
  Config,
  apply,
  buildServerArgs,
  endpointFor,
  ensureMlxRuntime,
  healthUrlFor,
  isHealthyPayload,
  name,
  resolveConfig
};
