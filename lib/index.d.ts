import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { ChildProcess } from 'node:child_process';

type MlxLogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
type MlxServerEngine = 'mlx-lm' | 'mlx-vlm';
interface ResolvedConfig {
    readonly autoStart: boolean;
    readonly serverEngine: MlxServerEngine;
    readonly modelPath?: string;
    readonly pythonExecutable: string;
    readonly host: '127.0.0.1';
    readonly port: number;
    readonly startupTimeoutMs: number;
    readonly maxTokens: number;
    readonly maxNumSeqs?: number;
    readonly ccSwitchProxyPort?: number;
    readonly ccSwitchChatOnly: boolean;
    readonly temperature: number;
    readonly topP: number;
    readonly topK: number;
    readonly disableThinking: boolean;
    readonly logLevel: MlxLogLevel;
}
interface Config {
    /** Start and own an MLX server instead of reusing an already-running endpoint. */
    autoStart?: boolean;
    /** Python server implementation used for managed startup. */
    serverEngine?: MlxServerEngine;
    /** Absolute path to a local MLX model directory. Required when autoStart is true. */
    modelPath?: string;
    /** Python executable or absolute interpreter path containing the selected server package. */
    pythonExecutable?: string;
    /** Loopback TCP port used by both the server and provider profile. */
    port?: number;
    /** Maximum time to wait for the server health endpoint. */
    startupTimeoutMs?: number;
    /** Default generation limit passed to mlx_lm.server. */
    maxTokens?: number;
    /** Optional MLX-VLM continuous-batch concurrency limit. */
    maxNumSeqs?: number;
    /** Optional loopback port for the CC Switch OpenAI-SSE compatibility proxy. */
    ccSwitchProxyPort?: number;
    /** Replace agent instructions and remove tool traffic for a least-privilege chat-only route. */
    ccSwitchChatOnly?: boolean;
    /** Default sampling temperature passed to mlx_lm.server. */
    temperature?: number;
    /** Default nucleus-sampling threshold passed to mlx_lm.server. */
    topP?: number;
    /** Default top-k threshold passed to mlx_lm.server. */
    topK?: number;
    /** Disable Qwen-style thinking in the server chat template. */
    disableThinking?: boolean;
    /** mlx_lm.server log level. */
    logLevel?: MlxLogLevel;
}
declare const Config: z<Config>;
/** Resolve defaults and enforce the local-only process boundary. */
declare function resolveConfig(config: Config): ResolvedConfig;

interface RuntimeLogger {
    info(message: string): void;
    warn(message: string): void;
}
interface RuntimeHandle {
    readonly mode: 'disabled' | 'reused' | 'spawned';
    readonly endpoint: string;
    readonly pid?: number;
    dispose(): Promise<void>;
}
interface RuntimeDependencies {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    inspectModel(modelPath: string): Promise<void>;
    isHealthy(url: string): Promise<boolean>;
    isPortOpen(host: string, port: number): Promise<boolean>;
    spawnProcess(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess;
    sleep(milliseconds: number): Promise<void>;
    now(): number;
    makeCacheDirectory(path: string): Promise<void>;
}
declare function endpointFor(config: ResolvedConfig): string;
declare function healthUrlFor(config: ResolvedConfig): string;
declare function buildServerArgs(config: ResolvedConfig): string[];
/** Accept the health payloads used by both supported local server packages. */
declare function isHealthyPayload(body: unknown): boolean;
/** Reuse a healthy loopback server or start and own one local MLX server process. */
declare function ensureMlxRuntime(config: ResolvedConfig, logger: RuntimeLogger, dependencies?: RuntimeDependencies): Promise<RuntimeHandle>;

interface CcSwitchProxyLogger {
    info(message: string): void;
    warn(message: string): void;
}
interface CcSwitchProxyHandle {
    readonly endpoint: string;
    dispose(): Promise<void>;
}
interface CcSwitchProxyOptions {
    /** Replace agent instructions and remove tool traffic, keeping Claude Desktop chat-only. */
    readonly chatOnly?: boolean;
    /** Log only request shape and timing; never message text, headers, or credentials. */
    readonly diagnostics?: boolean;
}
/**
 * CC Switch 3.20.x aliases `reasoning_content` to `reasoning` while decoding
 * OpenAI SSE chunks. Some MLX-VLM releases emit both keys, which serde treats
 * as a duplicate field and drops. Keep the preferred key and preserve a
 * non-null legacy value if that is the only reasoning payload.
 */
declare function normalizeCcSwitchOpenAiChunk(value: unknown): unknown;
/** Replace agent instructions while preserving user and ordinary assistant message text. */
interface ChatSanitizationResult {
    readonly value: unknown;
    readonly removedTools: number;
    readonly replacedAgentMessages: number;
    readonly removedToolMessages: number;
}
declare function sanitizeCcSwitchChatRequest(value: unknown): ChatSanitizationResult;
/** Normalize complete SSE text while preserving its newline convention. */
declare function normalizeCcSwitchSseBlock(block: string): string;
/**
 * Start a loopback-only reverse proxy that makes MLX-VLM OpenAI SSE compatible
 * with CC Switch without changing the model server or the signed desktop app.
 */
declare function startCcSwitchCompatibilityProxy(upstreamEndpoint: string, listenPort: number, logger: CcSwitchProxyLogger, options?: CcSwitchProxyOptions): Promise<CcSwitchProxyHandle>;

declare const name = "llm-mlx-runtime";
/** Mount the optional server owner; the provider route itself comes from the bundle patch. */
declare function apply(ctx: Context, config: Config): void;

export { type CcSwitchProxyHandle, type CcSwitchProxyLogger, type CcSwitchProxyOptions, Config, Config as PluginConfig, type ResolvedConfig, type RuntimeDependencies, type RuntimeHandle, type RuntimeLogger, apply, buildServerArgs, endpointFor, ensureMlxRuntime, healthUrlFor, isHealthyPayload, name, normalizeCcSwitchOpenAiChunk, normalizeCcSwitchSseBlock, resolveConfig, sanitizeCcSwitchChatRequest, startCcSwitchCompatibilityProxy };
