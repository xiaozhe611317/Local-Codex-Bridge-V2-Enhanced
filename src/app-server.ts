import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  RuntimeStore,
  redactText,
  sanitizeForTransport,
  type RpcId,
  type RuntimeSupervisionStatus,
} from "./runtime.js";
import { platformPolicyFor, type PlatformPolicy } from "./platform.js";
import { VERSION } from "./version.js";
import { consistentNativeAcknowledgement } from "./native-evidence.js";
import { observeRecoveryNotification, responseTurn, terminalThreadRead, type LateTurnEvidence } from "./late-turn-recovery.js";

const MAX_JSONL_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LATE_RESPONSE_TTL_MS = 60_000;
const DEFAULT_LATE_RESPONSE_LIMIT = 256;
const GRACEFUL_CLOSE_TIMEOUT_MS = 1_500;
const SOFT_TERMINATE_TIMEOUT_MS = 1_000;
const HARD_TERMINATE_TIMEOUT_MS = 1_000;
const MAX_SCOPE_ID_CHARS = 200;
const THREADLESS_REQUEST_ERROR = {
  code: -32601,
  message: "Unsupported app-server request without thread context",
} as const;
const MUTATING_REQUEST_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/settings/update",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

interface PendingCall {
  method: string;
  issuedSequence: number;
  threadId?: string;
  turnId?: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

type LateResponseCandidate =
  | { method: "thread/start" }
  | { method: "thread/resume"; requestedThreadId: string }
  | { method: "turn/start"; requestedThreadId: string }
  | {
      method: "turn/steer" | "turn/interrupt";
      requestedThreadId: string;
      requestedTurnId: string;
    };

interface RetainedLateResponse {
  candidate: LateResponseCandidate;
  timedOutAt: string;
  expiresAtMs: number;
  turnEvidence?: LateTurnEvidence;
}

export interface AppServerLaunchOptions {
  executable?: string;
  prefixArgs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  platformPolicy?: PlatformPolicy;
  requestTimeoutMs?: number;
  lateResponseTtlMs?: number;
  lateResponseLimit?: number;
}

export interface AppServerStatus {
  source: "bridge_managed_app_server";
  state: "not_started" | "starting" | "ready" | "unavailable" | "exited" | "restarting" | "closing" | "closed";
  pid: number | null;
  pid_status: "available" | "unavailable";
  process_state: "not_running" | "exited" | "running" | "unknown";
  initialized: boolean;
  live: RuntimeSupervisionStatus;
  operations_in_flight: number;
  rpc_requests_in_flight: number;
  writes_in_flight: number;
  native_mutation_outcome_unknown: boolean;
  safe_to_restart: boolean;
  restart_denied_reasons: string[];
}

export interface ChildTerminationTimeouts {
  readonly gracefulMs: number;
  readonly softMs: number;
  readonly hardMs: number;
}

const DEFAULT_CHILD_TERMINATION_TIMEOUTS: ChildTerminationTimeouts = {
  gracefulMs: GRACEFUL_CLOSE_TIMEOUT_MS,
  softMs: SOFT_TERMINATE_TIMEOUT_MS,
  hardMs: HARD_TERMINATE_TIMEOUT_MS,
};

function rpcKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedScopeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_ID_CHARS
    ? value
    : undefined;
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function lateResponseCandidate(
  method: string,
  params: unknown,
): LateResponseCandidate | undefined {
  if (method === "thread/start") {
    return { method };
  }
  const record = asRecord(params);
  if (method === "turn/steer" || method === "turn/interrupt") {
    const requestedThreadId = boundedScopeId(record?.threadId);
    const requestedTurnId = boundedScopeId(
      method === "turn/steer" ? record?.expectedTurnId : record?.turnId,
    );
    return requestedThreadId && requestedTurnId
      ? { method, requestedThreadId, requestedTurnId }
      : undefined;
  }
  if (method !== "thread/resume" && method !== "turn/start") {
    return undefined;
  }
  const requestedThreadId = boundedScopeId(record?.threadId);
  return requestedThreadId ? { method, requestedThreadId } : undefined;
}

function messageFromUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(sanitizeForTransport(value));
  } catch {
    return String(value);
  }
}

function requestTimeoutError(method: string): Error {
  if (MUTATING_REQUEST_METHODS.has(method)) {
    return new Error(
      `Codex app-server acknowledgement timed out for already-sent mutating request ${method}; operation outcome is UNKNOWN because Codex may already have accepted it. Re-observe or read before retrying. No automatic retry is performed.`,
    );
  }
  return new Error(`Codex app-server request timed out: ${method}`);
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = environment.CODEX_EXE?.trim();
  if (explicit) {
    if (/[\0\r\n]/.test(explicit)) {
      throw new Error("CODEX_EXE contains an invalid control character");
    }
  }
  // Desktop updates replace the versioned bin directory. Recover only paths
  // belonging to this user's official desktop installation, never custom paths.
  if (platform === "win32" && environment.LOCALAPPDATA) {
    const bin = path.join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const relative = explicit ? path.relative(bin, explicit) : "";
    const desktopPath = /^[a-f0-9]+[\\/]codex\.exe$/i.test(relative);
    if (!explicit || (desktopPath && !existsSync(explicit))) {
      try {
        const candidates = readdirSync(bin, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && /^[a-f0-9]+$/i.test(entry.name))
          .map(entry => path.join(bin, entry.name, "codex.exe"))
          .filter(candidate => existsSync(candidate) && statSync(candidate).isFile())
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
        if (candidates[0]) return candidates[0];
      } catch {
        // Preserve the original explicit-path/PATH error if discovery fails.
      }
    }
  }
  if (explicit) return explicit;
  return "codex";
}

export function resolveCodexChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.CONTROL_PLANE_API_KEY;
  return childEnvironment;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  platformPolicy: PlatformPolicy,
): Promise<boolean> {
  if (platformPolicy.hasChildExited(child)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export async function terminateAppServerChild(
  child: ChildProcessWithoutNullStreams,
  platformPolicy: PlatformPolicy,
  timeouts: ChildTerminationTimeouts = DEFAULT_CHILD_TERMINATION_TIMEOUTS,
): Promise<void> {
  if (platformPolicy.hasChildExited(child)) {
    return;
  }

  let terminationError: Error | undefined;
  try {
    child.stdin.end();
  } catch (error) {
    terminationError = error instanceof Error ? error : new Error(String(error));
  }
  if (await waitForExit(child, timeouts.gracefulMs, platformPolicy)) {
    return;
  }
  if (platformPolicy.hasChildExited(child)) {
    return;
  }

  try {
    platformPolicy.softTerminateChild(child);
  } catch (error) {
    terminationError = error instanceof Error ? error : new Error(String(error));
  }
  if (await waitForExit(child, timeouts.softMs, platformPolicy)) {
    return;
  }
  if (platformPolicy.hasChildExited(child)) {
    return;
  }

  try {
    platformPolicy.hardTerminateChild(child);
  } catch (error) {
    terminationError = error instanceof Error ? error : new Error(String(error));
  }
  if (await waitForExit(child, timeouts.hardMs, platformPolicy)) {
    return;
  }

  const detail = terminationError ? `: ${terminationError.message}` : "";
  throw new Error(
    `Codex app-server did not exit after graceful, soft, and hard termination${detail}`,
  );
}

export function writeWithBackpressure(
  stream: Writable,
  chunk: string,
): Promise<void> {
  if (!stream.writable || stream.writableEnded || stream.destroyed) {
    return Promise.reject(new Error("Codex app-server stdin is not writable"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackDone = false;
    let drainDone = false;

    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const maybeResolve = (): void => {
      if (!settled && writeReturned && callbackDone && drainDone) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onDrain = (): void => {
      drainDone = true;
      maybeResolve();
    };
    const onError = (error: Error): void => fail(error);
    const onClose = (): void =>
      fail(new Error("Codex app-server stdin closed during write"));
    const onWrite = (error?: Error | null): void => {
      if (error) {
        fail(error);
        return;
      }
      callbackDone = true;
      maybeResolve();
    };

    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      const accepted = stream.write(chunk, "utf8", onWrite);
      if (settled) {
        return;
      }
      if (accepted) {
        drainDone = true;
        stream.off("drain", onDrain);
      }
      writeReturned = true;
      maybeResolve();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error(messageFromUnknown(error)),
      );
    }
  });
}

export function createSerializedWriter(
  write: (chunk: string) => Promise<void>,
): (chunk: string) => Promise<void> {
  let tail = Promise.resolve();
  return async (chunk: string): Promise<void> => {
    const current = tail.then(() => write(chunk));
    tail = current.catch(() => undefined);
    await current;
  };
}

export class AppServerManager {
  readonly runtime: RuntimeStore;

  readonly #executable: string | undefined;
  readonly #prefixArgs: readonly string[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platformPolicy: PlatformPolicy;
  readonly #requestTimeoutMs: number;
  readonly #lateResponseTtlMs: number;
  readonly #lateResponseLimit: number;
  readonly #pendingCalls = new Map<string, PendingCall>();
  readonly #lateResponses = new Map<string, RetainedLateResponse>();
  readonly #writeLine: (chunk: string) => Promise<void>;

  #child: ChildProcessWithoutNullStreams | null = null;
  #childTerminationPromise: Promise<void> | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #fatal: Error | null = null;
  #closing = false;
  #initialized = false;
  #nextRequestId = 1;
  #evidenceSequence = 0;
  #stdoutBuffer = Buffer.alloc(0);
  #operations = 0;
  #writesInFlight = 0;
  #uncertainMutation = false;
  readonly #uncertainMutationIds = new Set<string>();
  #uncertaintyOverflow = false;
  #restarting = false;
  #restartPromise: Promise<void> | null = null;
  #retiringChild: ChildProcessWithoutNullStreams | null = null;

  status(): AppServerStatus {
    const live = this.runtime.supervisionStatus();
    const child = this.#child;
    const exited = child ? this.#platformPolicy.hasChildExited(child) : false;
    const state = this.#closing ? (child ? "closing" : "closed")
      : this.#restarting ? "restarting"
      : exited ? "exited"
      : this.#fatal ? "unavailable"
      : this.#initialized ? "ready"
      : this.#startPromise ? "starting" : "not_started";
    const reasons: string[] = [];
    if (this.#closing) reasons.push("manager_closing");
    if (this.#restarting) reasons.push("restart_in_progress");
    if (state === "starting") reasons.push("initialization_in_progress");
    if (live.active_turns > 0) reasons.push("active_turns");
    if (live.unscoped_active_threads > 0) reasons.push("unscoped_active_threads");
    if (live.unknown_state_threads > 0) reasons.push("unknown_runtime_state");
    if (live.pending_requests > 0) reasons.push("pending_requests");
    if (this.#operations > 0 || this.#pendingCalls.size > 0 || this.#writesInFlight > 0) reasons.push("native_operations_in_flight");
    if (this.#uncertainMutation && child && !exited) reasons.push("native_mutation_outcome_unknown");
    return {
      source: "bridge_managed_app_server",
      state,
      pid: child && !exited ? child.pid ?? null : null,
      pid_status: child && !exited && child.pid !== undefined ? "available" : "unavailable",
      process_state: !child ? "not_running" : exited ? "exited" : child.pid ? "running" : "unknown",
      initialized: this.#initialized && !exited && !this.#fatal && !this.#restarting,
      live,
      operations_in_flight: this.#operations,
      rpc_requests_in_flight: this.#pendingCalls.size,
      writes_in_flight: this.#writesInFlight,
      native_mutation_outcome_unknown: this.#uncertainMutation && !!child && !exited,
      safe_to_restart: reasons.length === 0,
      restart_denied_reasons: reasons,
    };
  }

  async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#restarting || this.#closing) throw new Error("Codex app-server manager is restarting or closing");
    this.#operations += 1;
    try { return await operation(); }
    finally { this.#operations -= 1; }
  }

  async restart(): Promise<void> {
    const status = this.status();
    if (!status.safe_to_restart) {
      throw new Error("RESTART_DENIED: " + status.restart_denied_reasons.join(", "));
    }
    // Synchronous gate covers the complete terminate/handshake interval.
    this.#restarting = true;
    this.#restartPromise = this.#restart();
    try { await this.#restartPromise; }
    finally { this.#restarting = false; this.#restartPromise = null; }
  }

  async #restart(): Promise<void> {
    const child = this.#child;
    try {
      if (child) {
        this.#retiringChild = child;
        await this.#terminateChild(child);
        if (!this.#platformPolicy.hasChildExited(child)) throw new Error("Managed child exit is unverified");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      this.#child = null;
      this.#childTerminationPromise = null;
      this.#initialized = false;
      this.#fatal = null;
      this.#startPromise = null;
      this.#stdoutBuffer = Buffer.alloc(0);
      this.#lateResponses.clear();
      this.#uncertainMutation = false;
      this.#uncertainMutationIds.clear();
      this.#uncertaintyOverflow = false;
      this.runtime.resetAfterRestart();
      if (this.#closing) throw new Error("Codex app-server manager is closing");
      this.#startPromise = this.#start();
      await this.#startPromise;
    } catch (error) {
      this.runtime.recordDiagnostic("restart_failure", { operation: "explicit_restart", status: "failed" });
      this.#fatal ??= new Error("Explicit app-server restart failed");
      throw error;
    } finally {
      this.#retiringChild = null;
    }
  }

  constructor(
    runtime = new RuntimeStore(),
    options: AppServerLaunchOptions = {},
  ) {
    this.runtime = runtime;
    const sourceEnvironment = options.environment ?? process.env;
    this.#platformPolicy = options.platformPolicy ?? platformPolicyFor();
    this.#executable = options.executable;
    this.#prefixArgs = options.prefixArgs ?? [];
    this.#environment = resolveCodexChildEnvironment(sourceEnvironment);
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#lateResponseTtlMs = positiveIntegerOption(
      options.lateResponseTtlMs,
      DEFAULT_LATE_RESPONSE_TTL_MS,
      "lateResponseTtlMs",
    );
    this.#lateResponseLimit = positiveIntegerOption(
      options.lateResponseLimit,
      DEFAULT_LATE_RESPONSE_LIMIT,
      "lateResponseLimit",
    );
    this.#writeLine = createSerializedWriter(async (chunk) => {
      const child = this.#child;
      if (
        this.#closing ||
        this.#fatal ||
        !child ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error("Codex app-server stdin is not writable");
      }
      await writeWithBackpressure(child.stdin, chunk);
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    return await this.withOperation(async () => {
      await this.ensureReady();
      return await this.#request(method, params, this.#requestTimeoutMs);
    });
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    await this.withOperation(async () => {
      await this.ensureReady();
      await this.#write({ id, result });
    });
  }

  async ensureReady(): Promise<void> {
    if (this.#restarting) throw new Error("Codex app-server manager is restarting");
    if (this.#closing) {
      throw new Error("Codex app-server manager is closing");
    }
    if (this.#fatal) {
      throw new Error(
        `Codex app-server is unavailable and will not be auto-restarted: ${this.#fatal.message}`,
      );
    }
    if (this.#initialized && this.#child) {
      return;
    }
    if (!this.#startPromise) {
      this.#startPromise = this.#start();
    }
    await this.#startPromise;
  }

  async close(): Promise<void> {
    if (this.#closePromise) {
      return await this.#closePromise;
    }
    this.#closePromise = this.#close();
    return await this.#closePromise;
  }

  async #start(): Promise<void> {
    // Desktop updates can remove a version directory while this manager lives.
    // Resolve on every launch, including an explicitly requested restart.
    // Caller-supplied executable overrides remain authoritative.
    const executable = this.#executable ?? resolveCodexExecutable(this.#environment);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        executable,
        [...this.#prefixArgs, "app-server", "--listen", "stdio://"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          ...this.#platformPolicy.appServerSpawnOptions(),
          env: this.#environment,
        },
      );
    } catch (error) {
      this.#fatal = new Error(
        `Failed to spawn ${executable}: ${redactText(messageFromUnknown(error))}`,
      );
      throw this.#fatal;
    }

    this.#child = child;
    child.stdin.on("error", (error) => this.#onStdinError(child, error));
    child.stdin.once("close", () => this.#onStdinClose(child));
    child.stdout.on("data", (chunk: Buffer) => {
      if (child === this.#child && child !== this.#retiringChild) this.#onStdout(chunk);
    });
    child.stderr.on("data", () => {
      // Drain without forwarding potentially sensitive child diagnostics.
    });
    child.once("exit", (code, signal) => this.#onExit(child, code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.off("error", onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child.off("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      child.on("error", (error) => this.#onChildError(child, error));

      await this.#request(
        "initialize",
        {
          clientInfo: {
            name: "local-codex-bridge",
            title: "Local Codex Bridge",
            version: VERSION,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
          },
        },
        30_000,
      );
      await this.#write({ method: "initialized", params: {} });
      this.#initialized = true;
    } catch (error) {
      const failure =
        this.#fatal ??
        new Error(`Codex app-server initialization failed: ${redactText(messageFromUnknown(error))}`);
      this.#fatal = failure;
      try {
        await this.#terminateChild(child);
      } catch (terminationError) {
        failure.message += `; shutdown failed: ${messageFromUnknown(terminationError)}`;
      }
      throw failure;
    }
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = rpcKey(id);
    const lateCandidate = lateResponseCandidate(method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pendingCalls.delete(key)) {
          return;
        }
        if (MUTATING_REQUEST_METHODS.has(method)) {
          this.#uncertainMutation = true;
          if (this.#uncertainMutationIds.size < this.#lateResponseLimit) this.#uncertainMutationIds.add(key);
          else this.#uncertaintyOverflow = true;
          const scope = asRecord(params);
          this.runtime.recordDiagnostic("mutation_outcome_unknown", { method, outcome: "UNKNOWN" },
            boundedScopeId(scope?.threadId), boundedScopeId(scope?.turnId ?? scope?.expectedTurnId));
        }
        if (lateCandidate) {
          this.#retainLateResponse(key, lateCandidate);
        }
        reject(requestTimeoutError(method));
      }, timeoutMs);
      const requestScope = asRecord(params);
      const threadId = boundedScopeId(requestScope?.threadId);
      const turnId = boundedScopeId(requestScope?.turnId ?? requestScope?.expectedTurnId);
      this.#pendingCalls.set(key, { method, resolve, reject, timer, issuedSequence: this.#evidenceSequence,
        ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) });
      void this.#write({ method, id, params }).catch((error: unknown) => {
        const pending = this.#pendingCalls.get(key);
        if (!pending) {
          this.#lateResponses.delete(key);
          return;
        }
        clearTimeout(pending.timer);
        this.#pendingCalls.delete(key);
        pending.reject(
          new Error(`Failed to write app-server request ${method}: ${messageFromUnknown(error)}`),
        );
      });
    });
  }

  #retainLateResponse(key: string, candidate: LateResponseCandidate): void {
    const now = Date.now();
    for (const [retainedKey, retained] of this.#lateResponses) {
      if (retained.expiresAtMs <= now) {
        this.#lateResponses.delete(retainedKey);
      }
    }
    while (this.#lateResponses.size >= this.#lateResponseLimit) {
      const oldest = this.#lateResponses.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#lateResponses.delete(oldest);
    }
    this.#lateResponses.set(key, {
      candidate,
      timedOutAt: new Date(now).toISOString(),
      expiresAtMs: now + this.#lateResponseTtlMs,
    });
  }

  #pruneLateResponses(): void {
    const now = Date.now();
    for (const [key, retained] of this.#lateResponses) {
      if (retained.expiresAtMs <= now) this.#lateResponses.delete(key);
    }
  }

  #settleLateResponse(key: string): void {
    this.#lateResponses.delete(key);
    this.#uncertainMutationIds.delete(key);
    this.#uncertainMutation = this.#uncertaintyOverflow || this.#uncertainMutationIds.size > 0;
  }

  #uniqueTurnEvidence(retained: RetainedLateResponse): boolean {
    if (retained.candidate.method !== "turn/start" || !retained.turnEvidence) return false;
    const threadId = retained.candidate.requestedThreadId;
    return [...this.#lateResponses.values()].filter(other =>
      other.candidate.method === "turn/start" && other.candidate.requestedThreadId === threadId &&
      other.turnEvidence?.turnId === retained.turnEvidence!.turnId).length === 1;
  }

  #recoverFromNotification(method: string, params: unknown): void {
    for (const [key, retained] of this.#lateResponses) {
      if (retained.candidate.method !== "turn/start" || !retained.turnEvidence) continue;
      const threadId = retained.candidate.requestedThreadId;
      const evidence = retained.turnEvidence;
      observeRecoveryNotification(evidence, threadId, method, params, this.#evidenceSequence);
      if (!evidence.terminal || !evidence.idle) continue;
      if (!this.#uniqueTurnEvidence(retained)) {
        evidence.terminal = null;
        evidence.idle = false;
        continue;
      }
      const live = this.runtime.observe(threadId, undefined, 1);
      if (live && live.active_turn_id === null && ["idle", "completed", "failed", "interrupted"].includes(live.runtime_status)) {
        this.#settleLateResponse(key);
      }
    }
  }

  #recoverFromThreadRead(pending: PendingCall, result: unknown): void {
    if (pending.method !== "thread/read" || !pending.threadId) return;
    for (const [key, retained] of this.#lateResponses) {
      const evidence = retained.turnEvidence;
      if (retained.candidate.method !== "turn/start" || retained.candidate.requestedThreadId !== pending.threadId ||
          !evidence || !this.#uniqueTurnEvidence(retained) ||
          evidence.boundSequence > pending.issuedSequence || evidence.lastSequence > pending.issuedSequence) continue;
      if (terminalThreadRead(result, pending.threadId, evidence.turnId) &&
          this.runtime.confirmRecoveredThreadRead(pending.threadId, evidence.turnId)) {
        this.#settleLateResponse(key);
      }
    }
  }

  #reconcileLateResponse(
    retained: RetainedLateResponse,
    response: Record<string, unknown>,
  ): boolean {
    if (retained.turnEvidence) retained.turnEvidence.lastSequence = this.#evidenceSequence;
    if (response.error !== undefined && response.error !== null) {
      if (Object.hasOwn(response, "result") || retained.turnEvidence) return false;
      const nativeError = asRecord(response.error);
      if (typeof nativeError?.code !== "number" || typeof nativeError.message !== "string") return false;
      const candidate = retained.candidate;
      if (candidate.method !== "thread/start") {
        const turnId = candidate.method === "turn/steer" || candidate.method === "turn/interrupt"
          ? candidate.requestedTurnId
          : undefined;
        this.runtime.recordLateMutationError({
          method: candidate.method,
          threadId: candidate.requestedThreadId,
          ...(turnId ? { turnId } : {}),
          timedOutAt: retained.timedOutAt,
          error: response.error,
        });
      }
      return true;
    }
    const result = asRecord(response.result);
    if (!result) {
      return false;
    }
    const candidate = retained.candidate;
    if (candidate.method === "thread/start" || candidate.method === "thread/resume") {
      const threadId = boundedScopeId(asRecord(result.thread)?.id);
      if (
        !threadId || !consistentNativeAcknowledgement(result, { threadId }, "thread") ||
        (candidate.method === "thread/resume" &&
          threadId !== candidate.requestedThreadId)
      ) {
        return false;
      }
      this.runtime.reconcileLateMutationSuccess({
        method: candidate.method,
        threadId,
        timedOutAt: retained.timedOutAt,
      });
      return true;
    }

    if (candidate.method === "turn/steer" || candidate.method === "turn/interrupt") {
      if (!consistentNativeAcknowledgement(result, { threadId: candidate.requestedThreadId, turnId: candidate.requestedTurnId }, "turn") ||
          (candidate.method === "turn/steer" && result.turnId !== candidate.requestedTurnId)) return false;
      this.runtime.reconcileLateMutationSuccess({
        method: candidate.method,
        threadId: candidate.requestedThreadId,
        turnId: candidate.requestedTurnId,
        timedOutAt: retained.timedOutAt,
      });
      return true;
    }

    const turn = responseTurn(result, candidate.requestedThreadId, retained.turnEvidence?.turnId);
    const turnId = boundedScopeId(turn?.id);
    if (!turn || !turnId) return false;
    retained.turnEvidence ??= {
      turnId, boundSequence: this.#evidenceSequence, lastSequence: this.#evidenceSequence,
      terminal: null, idle: false,
    };
    const status = turn.status;
    // A scoped turn id alone cannot settle a timed-out mutation. Validate the
    // native Turn status before reconciliation can preserve an older idle state.
    // Thread/Bridge states (for example idle) are not supported Turn statuses.
    if (typeof status !== "string" || !["inProgress", "completed", "failed", "interrupted"].includes(status) ||
        !consistentNativeAcknowledgement(result, { threadId: candidate.requestedThreadId, turnId }, "turn")) {
      this.runtime.recordDiagnostic("mutation_outcome_unknown", {
        method: candidate.method, reason: "invalid_late_turn_status",
      }, candidate.requestedThreadId, turnId);
      return false;
    }
    this.runtime.reconcileLateMutationSuccess({
      method: candidate.method,
      threadId: candidate.requestedThreadId,
      turnId,
      status,
      timedOutAt: retained.timedOutAt,
    });
    return true;
  }

  async #write(message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    this.#writesInFlight += 1;
    try { await this.#writeLine(encoded); }
    finally { this.#writesInFlight -= 1; }
  }

  #onStdout(chunk: Buffer): void {
    if (this.#fatal || this.#closing) {
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdoutBuffer.length > MAX_JSONL_BYTES) {
          this.#protocolFailure("app-server JSONL line exceeded 10 MiB");
        }
        return;
      }
      if (newline > MAX_JSONL_BYTES) {
        this.#protocolFailure("app-server JSONL line exceeded 10 MiB");
        return;
      }
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }
      try {
        this.#dispatch(JSON.parse(line.toString("utf8")) as unknown);
        if (this.#fatal) {
          return;
        }
      } catch (error) {
        this.#protocolFailure(`invalid app-server JSONL: ${messageFromUnknown(error)}`);
        return;
      }
    }
  }

  #dispatch(message: unknown): void {
    this.#evidenceSequence += 1;
    this.#pruneLateResponses();
    const record = asRecord(message);
    if (!record) {
      throw new Error("app-server emitted a non-object message");
    }
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "string" || typeof record.id === "number"
        ? record.id
        : undefined;

    if (method) {
      if (id !== undefined) {
        const recorded = this.runtime.recordServerRequest(id, method, record.params);
        if (recorded === "threadless") {
          void this.#write({
            id,
            error: THREADLESS_REQUEST_ERROR,
          }).catch((error: unknown) => {
            this.#protocolFailure(
              `failed to reject unsupported app-server request: ${messageFromUnknown(error)}`,
            );
          });
        } else if (recorded === "duplicate") {
          this.#protocolFailure(
            `app-server protocol anomaly: duplicate outstanding ${typeof id} request id`,
          );
        }
      } else {
        this.runtime.recordNotification(method, record.params);
        this.#recoverFromNotification(method, record.params);
      }
      return;
    }
    if (id === undefined) {
      throw new Error("app-server response has no request id");
    }
    const pending = this.#pendingCalls.get(rpcKey(id));
    if (!pending) {
      const retained = this.#lateResponses.get(rpcKey(id));
      if (retained) {
        const verified = this.#reconcileLateResponse(retained, record);
        if (verified) {
          this.#settleLateResponse(rpcKey(id));
        }
      }
      return;
    }
    clearTimeout(pending.timer);
    this.#pendingCalls.delete(rpcKey(id));
    if ("error" in record && record.error !== undefined && record.error !== null) {
      const errorRecord = asRecord(record.error);
      const detail =
        typeof errorRecord?.message === "string"
          ? errorRecord.message
          : messageFromUnknown(record.error);
      this.runtime.recordDiagnostic("native_rpc_error", { method: pending.method, error: record.error }, pending.threadId, pending.turnId);
      pending.reject(
        new Error(`Codex app-server ${pending.method} failed: ${redactText(detail)}`),
      );
    } else {
      this.#recoverFromThreadRead(pending, record.result);
      pending.resolve(record.result);
    }
  }

  #protocolFailure(message: string): void {
    if (this.#fatal) {
      return;
    }
    this.runtime.recordDiagnostic("protocol_error", { message });
    this.#fatal = new Error(redactText(message));
    this.runtime.markAppServerExited(this.#fatal.message);
    this.#rejectAll(this.#fatal);
    const child = this.#child;
    if (child && !this.#platformPolicy.hasChildExited(child)) {
      void this.#terminateChild(child).catch(() => {
        // The latched protocol failure remains authoritative; close() reuses and awaits this same bounded termination attempt.
      });
    }
  }

  #onChildError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.#child || child === this.#retiringChild || this.#closing) {
      return;
    }
    this.runtime.recordDiagnostic("app_server_unexpected_exit", { process_error: error.message });
    this.#fatal = new Error(`Codex app-server process error: ${redactText(error.message)}`);
    this.runtime.markAppServerExited(this.#fatal.message);
    this.#rejectAll(this.#fatal);
  }

  #onStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.#child || child === this.#retiringChild || this.#closing || this.#fatal) {
      return;
    }
    this.#protocolFailure(
      `Codex app-server stdin failed: ${messageFromUnknown(error)}`,
    );
  }

  #onStdinClose(child: ChildProcessWithoutNullStreams): void {
    if (
      child !== this.#child ||
      child === this.#retiringChild ||
      this.#closing ||
      this.#fatal ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    this.#protocolFailure("Codex app-server stdin closed unexpectedly");
  }

  #onExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.#child) {
      return;
    }
    this.#initialized = false;
    if (this.#closing || child === this.#retiringChild) {
      return;
    }
    this.runtime.recordDiagnostic("app_server_unexpected_exit", { exit_code: code, signal });
    const failure = new Error(
      `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
    );
    this.#fatal = failure;
    this.runtime.markAppServerExited(failure.message);
    this.#rejectAll(failure);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingCalls.clear();
    this.#lateResponses.clear();
  }

  #terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!this.#childTerminationPromise) {
      this.#childTerminationPromise = terminateAppServerChild(
        child,
        this.#platformPolicy,
      );
    }
    return this.#childTerminationPromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    await this.#restartPromise?.catch(() => undefined);
    const child = this.#child;
    if (!child) {
      return;
    }
    this.#rejectAll(new Error("Codex app-server manager is shutting down"));
    await this.#terminateChild(child);
    // Newer Windows Codex helpers may retain inherited pipe handles after the
    // direct child has exited. Release only this manager's local pipe ends.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    this.#child = null;
  }
}
