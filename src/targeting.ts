import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { platformPolicyFor, type PlatformPolicy } from "./platform.js";

export interface TargetingConfig {
  allowed_roots?: readonly string[];
  project_aliases?: Readonly<Record<string, string>>;
}

export interface TargetingFilesystem {
  realpath(value: string): string;
  isDirectory(value: string): boolean;
  isLink(value: string): boolean;
  sameDirectory(left: string, right: string): boolean;
}

const disk: TargetingFilesystem = {
  realpath: value => realpathSync.native(value),
  isDirectory: value => statSync(value).isDirectory(),
  isLink: value => lstatSync(value).isSymbolicLink(),
  sameDirectory: (left, right) => {
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    // Inode/file identity must be usable; lexical case folding alone is
    // insufficient when Windows directories opt into case-sensitive names.
    return a.isDirectory() && b.isDirectory() && a.ino !== 0n && b.ino !== 0n &&
      a.dev === b.dev && a.ino === b.ino;
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Closed schema: aliases contain only a cwd, never execution settings.
export function parseTargetingConfig(value: unknown): TargetingConfig {
  if (!record(value) || Object.keys(value).some(key => !["allowed_roots", "project_aliases"].includes(key))) {
    throw new Error("Invalid targeting policy fields");
  }
  const roots = value.allowed_roots;
  const aliases = value.project_aliases;
  const validPath = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1_000;
  if (roots !== undefined && (!Array.isArray(roots) || roots.length > 100 || !roots.every(validPath))) {
    throw new Error("allowed_roots must be an array of at most 100 absolute paths");
  }
  if (aliases !== undefined && (!record(aliases) || Object.keys(aliases).length > 100 ||
      Object.entries(aliases).some(([key, v]) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(key) || !validPath(v)))) {
    throw new Error("project_aliases must map at most 100 simple names to absolute cwd strings");
  }
  return {
    ...(roots === undefined ? {} : { allowed_roots: [...roots as string[]] }),
    ...(aliases === undefined ? {} : { project_aliases: { ...aliases as Record<string, string> } }),
  };
}

export class TargetingPolicy {
  readonly #config: TargetingConfig;
  readonly #paths: typeof path.win32;

  constructor(
    config: TargetingConfig = {},
    private readonly platform: PlatformPolicy = platformPolicyFor(),
    private readonly fs: TargetingFilesystem = disk,
  ) {
    this.#config = parseTargetingConfig(config);
    this.#paths = platform.platform === "win32" ? path.win32 : path.posix;
    for (const root of this.#config.allowed_roots ?? []) this.#strictPath(root);
    for (const cwd of Object.values(this.#config.project_aliases ?? {})) this.platform.validateCwd(cwd);
  }

  get restricted(): boolean { return this.#config.allowed_roots !== undefined; }

  resolve(cwd: string | undefined, alias: string | undefined): string | undefined {
    if (cwd !== undefined && alias !== undefined) throw new Error("project_alias and cwd are mutually exclusive");
    if (alias !== undefined) {
      const aliases = this.#config.project_aliases;
      if (!aliases || !Object.hasOwn(aliases, alias)) throw new Error("Unknown project_alias");
      cwd = aliases[alias];
    }
    return cwd === undefined ? undefined : this.check(cwd);
  }

  samePath(left: string, right: string): boolean {
    if (this.#key(left) !== this.#key(right)) return false;
    if (!this.restricted) return true;
    try { return this.fs.sameDirectory(left, right); }
    catch { return false; }
  }

  check(value: string): string {
    if (!this.restricted) return this.platform.validateCwd(value);
    try {
      const candidate = this.#strictPath(value);
      const roots = this.#config.allowed_roots!.map(root => this.#strictPath(root));
      if (!roots.some(root => this.#within(root, candidate))) throw new Error("outside allowed roots");
      // Roots cannot silently retarget themselves through links or junctions.
      for (const root of roots) {
        this.#rejectLinks(root);
        if (!this.fs.isDirectory(root) || !this.samePath(root, this.#strictPath(this.fs.realpath(root)))) {
          throw new Error("allowed root cannot be verified");
        }
      }
      this.#rejectLinks(candidate);
      if (!this.fs.isDirectory(candidate)) throw new Error("cwd is not a directory");
      const canonical = this.#strictPath(this.fs.realpath(candidate));
      if (!roots.some(root => this.#canonicalWithin(root, canonical))) throw new Error("canonical cwd outside allowed roots");
      this.#rejectLinks(canonical);
      if (!this.samePath(canonical, this.#strictPath(this.fs.realpath(candidate)))) throw new Error("cwd changed during inspection");
      return canonical;
    } catch {
      throw new Error("TARGETING_DENIED: cwd is outside allowed_roots or cannot be safely canonicalized");
    }
  }

  #strictPath(value: string): string {
    const windows = this.platform.platform === "win32";
    const parts = value.split(windows ? /[\\/]/ : /\//);
    if (parts.includes("..") || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid path");
    if (windows && parts.slice(1).some(part => part !== "" && part !== "." &&
        (/[. ]$/.test(part) || /[:<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
      throw new Error("Ambiguous Windows path");
    }
    return this.platform.validateCwd(value);
  }

  #key(value: string): string {
    const normalized = this.#paths.normalize(value);
    const root = this.#paths.parse(normalized).root;
    const trimmed = normalized.length > root.length ? normalized.replace(this.platform.platform === "win32" ? /[\\/]+$/ : /\/+$/, "") : normalized;
    return this.platform.platform === "win32" ? trimmed.toLowerCase() : trimmed;
  }

  #within(root: string, candidate: string): boolean {
    const relative = this.#paths.relative(this.#key(root), this.#key(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + this.#paths.sep) && !this.#paths.isAbsolute(relative));
  }

  #canonicalWithin(root: string, candidate: string): boolean {
    if (!this.#within(root, candidate)) return false;
    const relative = this.#paths.relative(this.#key(root), this.#key(candidate));
    const depth = relative === "" ? 0 : relative.split(this.#paths.sep).length;
    let ancestor = candidate;
    for (let index = 0; index < depth; index += 1) ancestor = this.#paths.dirname(ancestor);
    return this.fs.sameDirectory(root, ancestor);
  }

  #rejectLinks(value: string): void {
    let current = value;
    while (true) {
      if (this.fs.isLink(current)) throw new Error("Linked paths are not allowed");
      const parent = this.#paths.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}
