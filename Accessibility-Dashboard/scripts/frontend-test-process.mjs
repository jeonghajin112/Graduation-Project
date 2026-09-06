import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";

function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const stop = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
      stop.once("error", () => { child.kill("SIGKILL"); resolve(); });
      stop.once("close", () => resolve());
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") child.kill("SIGKILL");
  }
  return Promise.resolve();
}

export async function runTestProcess(scriptPath, { cwd, env, timeoutMs, signal, logPath, verbose = false }) {
  const startedAt = performance.now();
  const log = openSync(logPath, "w");
  let child;
  let timer;
  let stopReason = null;
  let stopping = null;
  let outputError = null;
  const stop = (reason) => {
    stopReason ??= reason;
    stopping ??= stopProcessTree(child);
  };
  const onAbort = () => stop("interrupted");

  try {
    if (signal?.aborted) return { status: "interrupted", durationMs: 0, code: null, signal: null };
    const outcome = new Promise((resolve) => {
      child = spawn(process.execPath, [scriptPath], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
      for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream.on("data", (chunk) => {
          try {
            writeSync(log, chunk);
            if (verbose) destination.write(chunk);
          } catch (error) {
            outputError = error;
            stop("error");
          }
        });
      }
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      // Wait for stdout/stderr to drain before closing the log and publishing a result.
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => stop("timed_out"), timeoutMs);
    const result = await outcome;
    await stopping;
    return {
      ...result,
      ...(outputError ? { error: outputError.message } : {}),
      status: stopReason ?? (result.error ? "error" : result.code === 0 ? "passed" : "failed"),
      durationMs: Math.round(performance.now() - startedAt)
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    closeSync(log);
  }
}
