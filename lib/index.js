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
  maxNumSeqs: z.number().step(1).min(1).max(64),
  ccSwitchProxyPort: z.number().step(1).min(1024).max(65535),
  ccSwitchChatOnly: z.boolean().default(false),
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
  const serverEngine = config.serverEngine ?? "mlx-lm";
  const modelPath = config.modelPath === void 0 ? void 0 : cleanString(config.modelPath, "modelPath");
  if (autoStart && modelPath === void 0) {
    throw new Error("dsh-llm-mlx: modelPath is required when autoStart is enabled");
  }
  if (modelPath !== void 0 && !isAbsolute(modelPath)) {
    throw new Error("dsh-llm-mlx: modelPath must be an absolute local path");
  }
  if (config.maxNumSeqs !== void 0 && serverEngine !== "mlx-vlm") {
    throw new Error("dsh-llm-mlx: maxNumSeqs is supported only by mlx-vlm");
  }
  if (config.ccSwitchProxyPort !== void 0 && config.ccSwitchProxyPort === (config.port ?? DEFAULT_PORT)) {
    throw new Error("dsh-llm-mlx: ccSwitchProxyPort must differ from the MLX server port");
  }
  if ((config.ccSwitchChatOnly ?? false) && config.ccSwitchProxyPort === void 0) {
    throw new Error("dsh-llm-mlx: ccSwitchChatOnly requires ccSwitchProxyPort");
  }
  return {
    autoStart,
    serverEngine,
    ...modelPath === void 0 ? {} : { modelPath },
    pythonExecutable: cleanString(config.pythonExecutable ?? "python3", "pythonExecutable"),
    host: "127.0.0.1",
    port: config.port ?? DEFAULT_PORT,
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...config.maxNumSeqs === void 0 ? {} : { maxNumSeqs: config.maxNumSeqs },
    ...config.ccSwitchProxyPort === void 0 ? {} : { ccSwitchProxyPort: config.ccSwitchProxyPort },
    ccSwitchChatOnly: config.ccSwitchChatOnly ?? false,
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
    if (config.maxNumSeqs !== void 0) {
      args2.push("--max-num-seqs", String(config.maxNumSeqs));
    }
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

// src/cc-switch-proxy.ts
import { createServer, request as httpRequest } from "http";
import { StringDecoder } from "string_decoder";
import { Transform } from "stream";
var LOOPBACK_HOST = "127.0.0.1";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeCcSwitchOpenAiChunk(value) {
  if (!isRecord(value) || !Array.isArray(value.choices)) return value;
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    const delta = choice.delta;
    const hasPreferred = Object.prototype.hasOwnProperty.call(delta, "reasoning_content");
    const hasLegacy = Object.prototype.hasOwnProperty.call(delta, "reasoning");
    if (!hasPreferred || !hasLegacy) continue;
    if (delta.reasoning_content == null && delta.reasoning != null) {
      delta.reasoning_content = delta.reasoning;
    }
    delete delta.reasoning;
  }
  return value;
}
var CHAT_ONLY_SYSTEM_PROMPT = [
  "You are a local chat assistant.",
  "Answer the user's message directly and concisely in the same language.",
  "Do not use tools, access files, or claim actions you did not perform."
].join(" ");
function sanitizeCcSwitchChatRequest(value) {
  if (!isRecord(value)) {
    return { value, removedTools: 0, replacedAgentMessages: 0, removedToolMessages: 0 };
  }
  const removedTools = Array.isArray(value.tools) ? value.tools.length : 0;
  delete value.tools;
  delete value.tool_choice;
  delete value.parallel_tool_calls;
  let replacedAgentMessages = 0;
  let removedToolMessages = 0;
  if (Array.isArray(value.messages)) {
    const conversation = [];
    for (const message of value.messages) {
      if (!isRecord(message)) continue;
      if (message.role === "system" || message.role === "developer") {
        replacedAgentMessages += 1;
        continue;
      }
      if (message.role === "tool") {
        removedToolMessages += 1;
        continue;
      }
      const cleanMessage = { ...message };
      delete cleanMessage.tool_calls;
      delete cleanMessage.function_call;
      conversation.push(cleanMessage);
    }
    value.messages = [{ role: "system", content: CHAT_ONLY_SYSTEM_PROMPT }, ...conversation];
  }
  return { value, removedTools, replacedAgentMessages, removedToolMessages };
}
function normalizeDataLine(line) {
  const match = /^(data:\s*)(.*)$/.exec(line);
  if (match === null || match[2] === "[DONE]") return line;
  try {
    const parsed = JSON.parse(match[2]);
    return `${match[1]}${JSON.stringify(normalizeCcSwitchOpenAiChunk(parsed))}`;
  } catch {
    return line;
  }
}
function normalizeCcSwitchSseBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  return block.split(/\r?\n/).map(normalizeDataLine).join(newline);
}
function takeSseBlock(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (match === null) return void 0;
  const end = match.index + match[0].length;
  return { block: buffer.slice(0, end), rest: buffer.slice(end) };
}
var CcSwitchSseNormalizer = class extends Transform {
  decoder = new StringDecoder("utf8");
  buffer = "";
  _transform(chunk, _encoding, callback) {
    this.buffer += this.decoder.write(chunk);
    this.flushCompleteBlocks();
    callback();
  }
  _flush(callback) {
    this.buffer += this.decoder.end();
    this.flushCompleteBlocks();
    if (this.buffer.length > 0) this.push(normalizeCcSwitchSseBlock(this.buffer));
    this.buffer = "";
    callback();
  }
  flushCompleteBlocks() {
    while (true) {
      const next = takeSseBlock(this.buffer);
      if (next === void 0) return;
      this.push(normalizeCcSwitchSseBlock(next.block));
      this.buffer = next.rest;
    }
  }
};
function responseHeaders(headers, transformed) {
  const result = { ...headers };
  if (transformed) {
    delete result["content-length"];
    delete result["transfer-encoding"];
  }
  return result;
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error === void 0 ? resolve() : reject(error));
    server.closeAllConnections?.();
  });
}
async function startCcSwitchCompatibilityProxy(upstreamEndpoint, listenPort, logger, options = {}) {
  const upstream = new URL(upstreamEndpoint);
  if (upstream.protocol !== "http:" || upstream.hostname !== LOOPBACK_HOST) {
    throw new Error("dsh-llm-mlx: CC Switch compatibility proxy requires a 127.0.0.1 HTTP upstream");
  }
  const server = createServer((clientRequest, clientResponse) => {
    const requestStartedAt = Date.now();
    const requested = new URL(clientRequest.url ?? "/", "http://loopback.invalid");
    const sanitizeChatRequest = options.chatOnly === true && clientRequest.method === "POST" && requested.pathname.endsWith("/chat/completions");
    const forwardedHeaders = {
      ...clientRequest.headers,
      host: `${LOOPBACK_HOST}:${upstream.port}`
    };
    if (sanitizeChatRequest) {
      delete forwardedHeaders["content-length"];
      delete forwardedHeaders["transfer-encoding"];
    }
    let upstreamResponseStream;
    const upstreamRequest = httpRequest({
      hostname: LOOPBACK_HOST,
      port: upstream.port,
      method: clientRequest.method,
      path: `${requested.pathname}${requested.search}`,
      headers: forwardedHeaders
    }, (upstreamResponse) => {
      upstreamResponseStream = upstreamResponse;
      if (options.diagnostics === true) {
        logger.info(`dsh-llm-mlx: CC Switch diagnostic upstream headers status=${String(upstreamResponse.statusCode ?? 0)} elapsedMs=${String(Date.now() - requestStartedAt)}`);
        upstreamResponse.once("data", (chunk) => {
          logger.info(`dsh-llm-mlx: CC Switch diagnostic first upstream body bytes=${String(chunk.length)} elapsedMs=${String(Date.now() - requestStartedAt)}`);
        });
      }
      const transformed = upstreamResponse.headers["content-type"]?.toLowerCase().startsWith("text/event-stream") ?? false;
      clientResponse.writeHead(
        upstreamResponse.statusCode ?? 502,
        responseHeaders(upstreamResponse.headers, transformed)
      );
      if (transformed) {
        upstreamResponse.pipe(new CcSwitchSseNormalizer()).pipe(clientResponse);
      } else {
        upstreamResponse.pipe(clientResponse);
      }
    });
    upstreamRequest.once("error", (error) => {
      if (clientResponse.destroyed) return;
      logger.warn(`dsh-llm-mlx: CC Switch compatibility upstream error (${error.message})`);
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { "content-type": "application/json" });
      }
      clientResponse.end(JSON.stringify({ error: "local MLX upstream unavailable" }));
    });
    const cancelUpstream = () => {
      upstreamRequest.destroy();
      upstreamResponseStream?.destroy();
    };
    clientRequest.once("aborted", cancelUpstream);
    clientResponse.once("close", () => {
      if (!clientResponse.writableEnded) cancelUpstream();
    });
    if (!sanitizeChatRequest) {
      clientRequest.pipe(upstreamRequest);
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    const maxBodyBytes = 16 * 1024 * 1024;
    clientRequest.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= maxBodyBytes) chunks.push(chunk);
    });
    clientRequest.once("end", () => {
      if (totalBytes > maxBodyBytes) {
        upstreamRequest.destroy();
        if (!clientResponse.headersSent) clientResponse.writeHead(413, { "content-type": "application/json" });
        clientResponse.end(JSON.stringify({ error: "local compatibility request too large" }));
        return;
      }
      const body = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        if (options.diagnostics === true && isRecord(parsed)) {
          logger.info([
            "dsh-llm-mlx: CC Switch diagnostic request",
            `model=${typeof parsed.model === "string" ? parsed.model : "unknown"}`,
            `stream=${String(parsed.stream === true)}`,
            `maxTokens=${typeof parsed.max_tokens === "number" ? String(parsed.max_tokens) : "unset"}`,
            `messages=${Array.isArray(parsed.messages) ? String(parsed.messages.length) : "0"}`,
            `tools=${Array.isArray(parsed.tools) ? String(parsed.tools.length) : "0"}`
          ].join(" "));
        }
        const sanitized = sanitizeCcSwitchChatRequest(parsed);
        const payload = Buffer.from(JSON.stringify(sanitized.value));
        upstreamRequest.setHeader("content-length", String(payload.length));
        if (sanitized.removedTools > 0) {
          logger.info(`dsh-llm-mlx: CC Switch chat-only mode removed ${String(sanitized.removedTools)} tool declarations`);
        }
        if (sanitized.replacedAgentMessages > 0 || sanitized.removedToolMessages > 0) {
          logger.info(`dsh-llm-mlx: CC Switch chat-only mode replaced ${String(sanitized.replacedAgentMessages)} agent messages and removed ${String(sanitized.removedToolMessages)} tool messages`);
        }
        upstreamRequest.end(payload);
      } catch {
        upstreamRequest.setHeader("content-length", String(body.length));
        upstreamRequest.end(body);
      }
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(listenPort, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("dsh-llm-mlx: CC Switch compatibility proxy did not bind a TCP port");
  }
  const endpoint = `http://${LOOPBACK_HOST}:${String(address.port)}/v1`;
  logger.info(`dsh-llm-mlx: CC Switch SSE compatibility proxy is listening at ${endpoint}`);
  return { endpoint, dispose: () => closeServer(server) };
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
    let proxy;
    try {
      proxy = resolved.ccSwitchProxyPort === void 0 ? void 0 : await startCcSwitchCompatibilityProxy(runtime.endpoint, resolved.ccSwitchProxyPort, {
        info: (message) => ctx.logger.info(message),
        warn: (message) => ctx.logger.warn(message)
      }, { chatOnly: resolved.ccSwitchChatOnly });
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
    return async () => {
      await proxy?.dispose();
      await runtime.dispose();
    };
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
  normalizeCcSwitchOpenAiChunk,
  normalizeCcSwitchSseBlock,
  resolveConfig,
  sanitizeCcSwitchChatRequest,
  startCcSwitchCompatibilityProxy
};
