import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TargetingPolicy, parseTargetingConfig, type TargetingFilesystem } from "../src/targeting.js";
import { localTargetingConfig, LOCAL_SETTINGS_ENV } from "../src/local-config.js";
import { WINDOWS_PLATFORM_POLICY, DARWIN_PLATFORM_POLICY, platformPolicyFor } from "../src/platform.js";

const simpleDisk: TargetingFilesystem = { realpath: value => value, isDirectory: () => true, isLink: () => false, sameDirectory: (a, b) => a.toLowerCase().replace(/[\\/]+$/, "") === b.toLowerCase().replace(/[\\/]+$/, "") };

test("unconfigured targeting retains native path normalization without touching disk", () => {
  const forbidden: TargetingFilesystem = {
    realpath: () => { throw Error("disk access"); },
    isDirectory: () => { throw Error("disk access"); },
    isLink: () => { throw Error("disk access"); },
    sameDirectory: () => { throw Error("disk access"); },
  };
  const policy = new TargetingPolicy({}, WINDOWS_PLATFORM_POLICY, forbidden);
  assert.equal(policy.check("D:/Example/child/../project"), "D:\\Example\\project");
  assert.equal(policy.resolve(undefined, undefined), undefined);
  assert.throws(() => policy.resolve(undefined, "missing"), /Unknown project_alias/);
  const aliases = new TargetingPolicy({ project_aliases: { app: "D:/Example/project" } }, WINDOWS_PLATFORM_POLICY, forbidden);
  assert.equal(aliases.resolve(undefined, "app"), "D:\\Example\\project");
});

test("Windows roots enforce case-insensitive component containment, not prefix matches", () => {
  const policy = new TargetingPolicy({ allowed_roots: ["D:\\Example\\Allowed"] }, WINDOWS_PLATFORM_POLICY, simpleDisk);
  assert.equal(policy.check("d:/example/ALLOWED/project/."), "d:\\example\\ALLOWED\\project");
  assert.equal(policy.check("D:/Example/Allowed/"), "D:\\Example\\Allowed\\");
  for (const value of [
    "D:/Example/Allowed-sibling", "D:/Example/Other", "E:/Example/Allowed",
    "D:/Example/Allowed/../Allowed", "D:/Example/Allowed/sub/../../Other",
    "D:/Example/Allowed/sub/..", "D:Example/Allowed", "//server/share",
    "\\\\?\\D:\\Example\\Allowed", "D:/Example/Allowed/space ",
    "D:/Example/Allowed/dot.", "D:/Example/Allowed/data:stream",
    "D:/Example/Allowed/NUL", "D:/Example/Allowed/COM1.txt",
    "D:/Example/Allowed/a?b", "D:/Example/Allowed/line\nfeed",
  ]) assert.throws(() => policy.check(value), /TARGETING_DENIED/, value);
  assert.throws(() => new TargetingPolicy({ allowed_roots: [] }, WINDOWS_PLATFORM_POLICY, simpleDisk).check("D:/Example"), /TARGETING_DENIED/);
});

test("canonicalization errors, links, reparse redirection, changed roots and non-directories fail closed", () => {
  const candidate = "D:\\Example\\Allowed\\project";
  const config = { allowed_roots: ["D:\\Example\\Allowed"] };
  for (const fs of [
    { ...simpleDisk, realpath: () => { throw Error("unavailable"); } },
    { ...simpleDisk, isDirectory: () => false },
    { ...simpleDisk, isLink: (value: string) => value === candidate },
    { ...simpleDisk, realpath: (value: string) => value === candidate ? "D:\\Outside" : value },
    { ...simpleDisk, realpath: () => "D:\\Outside" },
  ]) assert.throws(() => new TargetingPolicy(config, WINDOWS_PLATFORM_POLICY, fs).check(candidate), /TARGETING_DENIED/);
  let calls = 0;
  const changing = { ...simpleDisk, realpath: (value: string) => value === candidate && ++calls > 1 ? "D:\\Outside" : value };
  assert.throws(() => new TargetingPolicy(config, WINDOWS_PLATFORM_POLICY, changing).check(candidate), /TARGETING_DENIED/);
});

test("Darwin containment remains case-sensitive and uses POSIX paths", () => {
  const policy = new TargetingPolicy({ allowed_roots: ["/projects/app"] }, DARWIN_PLATFORM_POLICY, simpleDisk);
  assert.equal(policy.check("/projects/app/child"), "/projects/app/child");
  for (const value of ["/projects/App", "/projects/app-sibling", "/projects/app/../app"]) {
    assert.throws(() => policy.check(value), /TARGETING_DENIED/);
  }
});

test("targeting configuration rejects permissions, non-string aliases and malformed roots", () => {
  for (const config of [null, [], { sandbox: "read-only" }, { allowed_roots: null },
    { allowed_roots: ["relative"] }, { project_aliases: { app: { cwd: "D:/Example", sandbox: "read-only" } } },
    { project_aliases: { app: "relative" } }, { project_aliases: { "bad name": "D:/Example" } },
    { allowed_roots: Array.from({ length: 101 }, () => "D:/Example") }]) {
    assert.throws(() => new TargetingPolicy(config as never, WINDOWS_PLATFORM_POLICY, simpleDisk));
  }
  assert.deepEqual(parseTargetingConfig({}), {});
  const config = { allowed_roots: ["D:/Example"], project_aliases: { app: "D:/Example/app" } };
  const policy = new TargetingPolicy(config, WINDOWS_PLATFORM_POLICY, simpleDisk);
  config.project_aliases.app = "D:/Outside";
  assert.equal(policy.resolve(undefined, "app"), "D:\\Example\\app");
  assert.throws(() => policy.resolve("D:/Example", "app"), /mutually exclusive/);
});

function temporary(): { root: string; cleanup: () => void } {
  const base = path.resolve(process.cwd(), "_codex_tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "targeting-"));
  return {
    root,
    cleanup: () => {
      assert.ok(path.resolve(root).startsWith(base + path.sep));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("real filesystem cwd canonicalization rejects missing paths, files and junction/symlink escape", () => {
  const { root, cleanup } = temporary();
  try {
    const allowed = path.join(root, "allowed");
    const inside = path.join(allowed, "project");
    const outside = path.join(root, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(allowed, "file"), "fixture");
    const escape = path.join(allowed, "escape");
    symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
    const policy = new TargetingPolicy({ allowed_roots: [allowed], project_aliases: { escape } }, platformPolicyFor());
    assert.equal(policy.check(inside), realpathSync.native(inside));
    assert.throws(() => policy.check(outside), /TARGETING_DENIED/);
    assert.throws(() => policy.check(path.join(allowed, "missing")), /TARGETING_DENIED/);
    assert.throws(() => policy.check(path.join(allowed, "file")), /TARGETING_DENIED/);
    assert.throws(() => policy.check(escape), /TARGETING_DENIED/);
    assert.throws(() => policy.resolve(undefined, "escape"), /TARGETING_DENIED/);
    const linkedRoot = new TargetingPolicy({ allowed_roots: [escape] }, platformPolicyFor());
    assert.throws(() => linkedRoot.check(escape), /TARGETING_DENIED/);
    // Remove the link itself before recursively removing the in-dev fixture.
    rmSync(escape);
  } finally { cleanup(); }
});

test("local settings opt-in reads targeting only and reports safe bounded parse errors", () => {
  const { root, cleanup } = temporary();
  const file = path.join(root, "settings.json");
  try {
    assert.deepEqual(localTargetingConfig({}), {});
    assert.deepEqual(localTargetingConfig({ [LOCAL_SETTINGS_ENV]: "" }), {});
    assert.throws(() => localTargetingConfig({ [LOCAL_SETTINGS_ENV]: "relative" }), /absolute/);
    const targeting = { allowed_roots: [root], project_aliases: { app: root } };
    writeFileSync(file, JSON.stringify({ targeting, unrelated_setting: "not-returned" }));
    assert.deepEqual(localTargetingConfig({ [LOCAL_SETTINGS_ENV]: file }), targeting);
    for (const contents of ["[", "null", JSON.stringify({ targeting: { model: "not-allowed" } }), " ".repeat(128 * 1024 + 1)]) {
      writeFileSync(file, contents);
      assert.throws(() => localTargetingConfig({ [LOCAL_SETTINGS_ENV]: file }));
    }
    assert.throws(() => localTargetingConfig({ [LOCAL_SETTINGS_ENV]: path.join(root, "missing") }), /Unable to read/);
  } finally { cleanup(); }
});

test("Windows canonical containment requires actual directory identity despite case folding", () => {
  const sensitiveDisk = { ...simpleDisk, sameDirectory: (a: string, b: string) => a === b };
  const policy = new TargetingPolicy({ allowed_roots: ["D:\\Example\\Allowed"] }, WINDOWS_PLATFORM_POLICY, sensitiveDisk);
  assert.equal(policy.check("D:\\Example\\Allowed\\project"), "D:\\Example\\Allowed\\project");
  assert.throws(() => policy.check("D:\\Example\\allowed\\project"), /TARGETING_DENIED/);
  assert.throws(() => new TargetingPolicy({ allowed_roots: ["D:\\Example"] }, WINDOWS_PLATFORM_POLICY,
    { ...simpleDisk, sameDirectory: () => false }).check("D:\\Example\\child"), /TARGETING_DENIED/);
});
