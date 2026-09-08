import { spawnSync } from "node:child_process";

let executable;
let args;

if (process.platform === "win32") {
  executable = "powershell.exe";
  args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "windows\\test-tray.ps1",
  ];
} else if (process.platform === "darwin") {
  executable = process.execPath;
  args = ["--test", "dist/test/launcher.test.js"];
} else {
  throw new Error(
    `Unsupported platform ${process.platform}; platform tests require Windows or macOS`,
  );
}

const result = spawnSync(executable, args, {
  cwd: process.cwd(),
  shell: false,
  stdio: "inherit",
  ...(process.platform === "win32" ? { windowsHide: true } : {}),
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
