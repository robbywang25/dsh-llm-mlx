// src/config.ts
import { isAbsolute } from "path";
import z from "@deepseek-ai/schemastery";

// src/proxy-budgets.ts
var DEFAULT_PROXY_LIMITS = Object.freeze({
  connectTimeoutMs: 1e4,
  firstByteTimeoutMs: 3e5,
  idleTimeoutMs: 3e5,
  maxSseEventBytes: 1024 * 1024
});
var MAX_PROXY_TIMEOUT_MS = 36e5;
var MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;
function resolveProxyLimits(options = {}) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("dsh-llm-mlx: proxy limits must be an object");
  }
  const limits = { ...DEFAULT_PROXY_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = options[key] === void 0 ? limits[key] : options[key];
    const maximum = key === "maxSseEventBytes" ? MAX_SSE_EVENT_BYTES : MAX_PROXY_TIMEOUT_MS;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`dsh-llm-mlx: proxy ${key} must be an integer between 1 and ${String(maximum)}`);
    }
    limits[key] = value;
  }
  return limits;
}
function createUpstreamBudget(limits, expired) {
  const timers = /* @__PURE__ */ new Map();
  let finished = false;
  let receivedBody = false;
  const clear = (phase) => {
    clearTimeout(timers.get(phase));
    timers.delete(phase);
  };
  const finish = () => {
    finished = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  const arm = (phase, milliseconds) => {
    if (finished) return;
    clear(phase);
    const timer = setTimeout(() => {
      finish();
      expired(phase);
    }, milliseconds);
    timer.unref();
    timers.set(phase, timer);
  };
  arm("connect", limits.connectTimeoutMs);
  return {
    connected: () => clear("connect"),
    requestFinished: () => {
      if (!receivedBody) arm("first-byte", limits.firstByteTimeoutMs);
    },
    bodyReceived: () => {
      receivedBody = true;
      clear("first-byte");
      arm("idle", limits.idleTimeoutMs);
    },
    finish
  };
}

// src/config.ts
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
  ccSwitchProxyLimits: z.object({
    connectTimeoutMs: z.number().step(1).min(1).max(MAX_PROXY_TIMEOUT_MS).default(DEFAULT_PROXY_LIMITS.connectTimeoutMs),
    firstByteTimeoutMs: z.number().step(1).min(1).max(MAX_PROXY_TIMEOUT_MS).default(DEFAULT_PROXY_LIMITS.firstByteTimeoutMs),
    idleTimeoutMs: z.number().step(1).min(1).max(MAX_PROXY_TIMEOUT_MS).default(DEFAULT_PROXY_LIMITS.idleTimeoutMs),
    maxSseEventBytes: z.number().step(1).min(1).max(MAX_SSE_EVENT_BYTES).default(DEFAULT_PROXY_LIMITS.maxSseEventBytes)
  }),
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
    ccSwitchProxyLimits: resolveProxyLimits(config.ccSwitchProxyLimits),
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    topP: config.topP ?? DEFAULT_TOP_P,
    topK: config.topK ?? DEFAULT_TOP_K,
    disableThinking: config.disableThinking ?? true,
    logLevel: config.logLevel ?? "WARNING"
  };
}

// src/runtime.ts
import { spawn } from "child_process";
import { access, mkdir, readdir, realpath, stat } from "fs/promises";
import { createConnection } from "net";
import { isAbsolute as isAbsolute2, join, resolve } from "path";
import { setTimeout as delay } from "timers/promises";
import { tmpdir } from "os";
var HEALTH_POLL_MS = 250;
var STOP_GRACE_MS = 5e3;
var HEALTH_TIMEOUT_MS = 1e3;
var MAX_IDENTITY_BYTES = 64 * 1024;
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
  return isHealthyPayload(await readIdentityJson(url));
}
async function readIdentityJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok || response.body === null) return void 0;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_IDENTITY_BYTES) return void 0;
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    return void 0;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
async function canonicalModelPath(path) {
  return realpath(path).catch(() => resolve(path));
}
function modelIds(body) {
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) return void 0;
  const ids = [];
  for (const item of body.data) {
    if (typeof item !== "object" || item === null || !("id" in item) || typeof item.id !== "string" || item.id.length === 0 || /[\0\r\n]/.test(item.id)) return void 0;
    ids.push(item.id);
  }
  return ids;
}
async function verifyModelIdentity(endpoint, modelPath) {
  let base;
  try {
    base = new URL(endpoint);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !["/v1", "/v1/"].includes(base.pathname) || base.username || base.password || base.search || base.hash || !isAbsolute2(modelPath)) return "unavailable";
  } catch {
    return "unavailable";
  }
  const [health, models, expected] = await Promise.all([
    readIdentityJson(new URL("/health", base).href),
    readIdentityJson(new URL("/v1/models", base).href),
    canonicalModelPath(modelPath)
  ]);
  const ids = modelIds(models);
  if (!isHealthyPayload(health) || ids === void 0) return "unavailable";
  const paths = new Set(await Promise.all(ids.filter(isAbsolute2).map(canonicalModelPath)));
  if (typeof health === "object" && health !== null && "loaded_model" in health) {
    const loaded = health.loaded_model;
    if (typeof loaded !== "string" || !isAbsolute2(loaded) || /[\0\r\n]/.test(loaded)) return "unavailable";
    if (await canonicalModelPath(loaded) !== expected) return "mismatched";
    return paths.has(expected) ? "matched" : "unavailable";
  }
  if (paths.size !== 1) return "unavailable";
  return paths.has(expected) ? "matched" : "mismatched";
}
function isHealthyPayload(body) {
  if (typeof body !== "object" || body === null) return false;
  const status = body.status;
  return status === "ok" || status === "healthy";
}
async function isPortOpen(host, port) {
  return new Promise((resolve2) => {
    const socket = createConnection({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolve2(open);
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
  verifyModel: verifyModelIdentity,
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
  const promise = new Promise((resolve2) => {
    child.once("error", (error) => {
      settled = true;
      resolve2({ code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      settled = true;
      resolve2({ code, signal });
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
    if (config.modelPath !== void 0) {
      const identity = await dependencies.verifyModel(endpoint, config.modelPath);
      if (identity !== "matched") {
        throw new Error(identity === "mismatched" ? `dsh-llm-mlx: healthy server at ${endpoint} reports a different model; existing process was not changed` : `dsh-llm-mlx: cannot verify configured modelPath at ${endpoint}; existing process was not changed`);
      }
    }
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
  try {
    while (dependencies.now() < deadline) {
      if (await dependencies.isHealthy(healthUrl)) {
        const identity = await dependencies.verifyModel(endpoint, config.modelPath);
        if (exit.exited()) {
          throw new Error(`dsh-llm-mlx: ${config.serverEngine} server stopped during startup (${exitDescription(await exit.promise)})`);
        }
        if (identity === "mismatched") {
          throw new Error(`dsh-llm-mlx: server at ${endpoint} reports a different model during managed startup`);
        }
        if (identity === "matched") {
          logger.info(`dsh-llm-mlx: managed loopback server is healthy with the configured model at ${endpoint}`);
          return {
            mode: "spawned",
            endpoint,
            ...child.pid === void 0 ? {} : { pid: child.pid },
            dispose: () => terminate(child, exit, dependencies.sleep)
          };
        }
      }
      const state = await Promise.race([
        exit.promise.then((value) => ({ kind: "exit", value })),
        dependencies.sleep(HEALTH_POLL_MS).then(() => ({ kind: "tick" }))
      ]);
      if (state.kind === "exit") {
        throw new Error(`dsh-llm-mlx: ${config.serverEngine} server stopped during startup (${exitDescription(state.value)})`);
      }
    }
    throw new Error(`dsh-llm-mlx: ${config.serverEngine} server did not become healthy with the configured model within ${String(config.startupTimeoutMs)} ms`);
  } catch (error) {
    await terminate(child, exit, dependencies.sleep);
    throw error;
  }
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
  constructor(maxEventBytes) {
    super();
    this.maxEventBytes = maxEventBytes;
  }
  maxEventBytes;
  decoder = new StringDecoder("utf8");
  buffer = "";
  _transform(chunk, _encoding, callback) {
    try {
      this.buffer += this.decoder.write(chunk);
      this.flushCompleteBlocks();
      callback();
    } catch (error) {
      callback(error);
    }
  }
  _flush(callback) {
    try {
      this.buffer += this.decoder.end();
      this.flushCompleteBlocks();
      if (this.buffer.length > 0) this.push(normalizeCcSwitchSseBlock(this.buffer));
      this.buffer = "";
      callback();
    } catch (error) {
      callback(error);
    }
  }
  flushCompleteBlocks() {
    while (true) {
      const next = takeSseBlock(this.buffer);
      if (Buffer.byteLength(next?.block ?? this.buffer, "utf8") > this.maxEventBytes) {
        throw new Error("local MLX upstream SSE event too large");
      }
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
  return new Promise((resolve2, reject) => {
    server.close((error) => error === void 0 ? resolve2() : reject(error));
    server.closeAllConnections?.();
  });
}
async function startCcSwitchCompatibilityProxy(upstreamEndpoint, listenPort, logger, options = {}) {
  const upstream = new URL(upstreamEndpoint);
  if (upstream.protocol !== "http:" || upstream.hostname !== LOOPBACK_HOST) {
    throw new Error("dsh-llm-mlx: CC Switch compatibility proxy requires a 127.0.0.1 HTTP upstream");
  }
  const limits = resolveProxyLimits(options.limits);
  const activeRequests = /* @__PURE__ */ new Set();
  const server = createServer((clientRequest, clientResponse) => {
    const requestStartedAt = Date.now();
    let requested;
    try {
      requested = new URL(clientRequest.url ?? "/", "http://loopback.invalid");
    } catch {
      clientRequest.once("error", () => clientResponse.destroy());
      clientRequest.resume();
      clientResponse.writeHead(400, { "content-type": "application/json", connection: "close" });
      clientResponse.end(JSON.stringify({ error: "invalid local compatibility request URL" }));
      return;
    }
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
    let normalizer;
    let settled = false;
    const cancelUpstream = () => {
      if (settled) return;
      settled = true;
      budget.finish();
      activeRequests.delete(cancelUpstream);
      clientRequest.unpipe(upstreamRequest);
      upstreamResponseStream?.unpipe();
      normalizer?.unpipe();
      normalizer?.destroy();
      upstreamRequest.destroy();
      upstreamResponseStream?.destroy();
    };
    const fail = (status, message) => {
      if (settled) return;
      cancelUpstream();
      logger.warn(`dsh-llm-mlx: CC Switch compatibility ${message}`);
      if (clientResponse.destroyed) return;
      if (clientResponse.headersSent) {
        clientResponse.destroy();
        return;
      }
      for (const name2 of clientResponse.getHeaderNames()) clientResponse.removeHeader(name2);
      clientResponse.writeHead(status, { "content-type": "application/json", connection: "close" });
      clientResponse.end(JSON.stringify({ error: message }));
    };
    const budget = createUpstreamBudget(limits, (phase) => {
      fail(504, `local MLX upstream ${phase} timeout`);
    });
    activeRequests.add(cancelUpstream);
    const upstreamRequest = httpRequest({
      hostname: LOOPBACK_HOST,
      port: upstream.port,
      method: clientRequest.method,
      path: `${requested.pathname}${requested.search}`,
      headers: forwardedHeaders
    }, (upstreamResponse) => {
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      upstreamResponseStream = upstreamResponse;
      upstreamResponse.on("data", () => budget.bodyReceived());
      upstreamResponse.once("end", () => budget.finish());
      upstreamResponse.once("aborted", () => fail(502, "local MLX upstream response interrupted"));
      upstreamResponse.once("error", () => fail(502, "local MLX upstream response unavailable"));
      if (options.diagnostics === true) {
        logger.info(`dsh-llm-mlx: CC Switch diagnostic upstream headers status=${String(upstreamResponse.statusCode ?? 0)} elapsedMs=${String(Date.now() - requestStartedAt)}`);
        upstreamResponse.once("data", (chunk) => {
          logger.info(`dsh-llm-mlx: CC Switch diagnostic first upstream body bytes=${String(chunk.length)} elapsedMs=${String(Date.now() - requestStartedAt)}`);
        });
      }
      const transformed = upstreamResponse.headers["content-type"]?.toLowerCase().startsWith("text/event-stream") ?? false;
      clientResponse.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [name2, value] of Object.entries(responseHeaders(upstreamResponse.headers, transformed))) {
        if (value !== void 0) clientResponse.setHeader(name2, value);
      }
      if (transformed) {
        normalizer = new CcSwitchSseNormalizer(limits.maxSseEventBytes);
        normalizer.once("error", () => fail(502, "local MLX upstream SSE event too large"));
        upstreamResponse.pipe(normalizer).pipe(clientResponse);
      } else {
        upstreamResponse.pipe(clientResponse);
      }
    });
    upstreamRequest.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", () => budget.connected());
      else budget.connected();
    });
    upstreamRequest.once("finish", () => budget.requestFinished());
    upstreamRequest.once("error", () => fail(502, "local MLX upstream unavailable"));
    clientRequest.once("aborted", cancelUpstream);
    clientRequest.once("error", () => {
      cancelUpstream();
      clientResponse.destroy();
    });
    clientResponse.once("finish", cancelUpstream);
    clientResponse.once("close", cancelUpstream);
    if (!sanitizeChatRequest) {
      clientRequest.pipe(upstreamRequest);
      return;
    }
    const chunks = [];
    let totalBytes = 0;
    const maxBodyBytes = 16 * 1024 * 1024;
    clientRequest.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        chunks.length = 0;
        fail(413, "local compatibility request too large");
      } else {
        chunks.push(chunk);
      }
    });
    clientRequest.once("end", () => {
      if (settled) return;
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
  await new Promise((resolve2, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(listenPort, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve2();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("dsh-llm-mlx: CC Switch compatibility proxy did not bind a TCP port");
  }
  const endpoint = `http://${LOOPBACK_HOST}:${String(address.port)}/v1`;
  logger.info(`dsh-llm-mlx: CC Switch SSE compatibility proxy is listening at ${endpoint}`);
  return {
    endpoint,
    dispose: async () => {
      for (const cancel of activeRequests) cancel();
      await closeServer(server);
    }
  };
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
      }, { chatOnly: resolved.ccSwitchChatOnly, limits: resolved.ccSwitchProxyLimits });
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
