import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDirectory = fileURLToPath(new URL("../../../ap-backend/", import.meta.url));

export function exportLiveReportBrowserFixture(outputPath) {
  const args = ["exportLiveReportBrowserFixture", "--no-daemon", "--console=plain"];
  const executable = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : path.join(backendDirectory, "gradlew");
  const executableArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `gradlew.bat ${args.join(" ")}`]
    : args;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, executableArgs, {
      cwd: backendDirectory,
      env: { ...process.env, AP_LIVE_REPORT_FIXTURE_OUTPUT: outputPath },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`Live report fixture export failed (${code}).\n${output}`)));
  });
}
