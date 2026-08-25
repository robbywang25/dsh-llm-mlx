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

declare const name = "llm-mlx-runtime";
/** Mount the optional server owner; the provider route itself comes from the bundle patch. */
declare function apply(ctx: Context, config: Config): void;

export { Config, Config as PluginConfig, type ResolvedConfig, type RuntimeDependencies, type RuntimeHandle, type RuntimeLogger, apply, buildServerArgs, endpointFor, ensureMlxRuntime, healthUrlFor, isHealthyPayload, name, resolveConfig };
