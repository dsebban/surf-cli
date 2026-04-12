/**
 * Bridge module: spawns the Bun WebView worker for Gemini queries.
 *
 * Handles:
 *  - Bun executable detection
 *  - Eligibility checks (--with-page is not supported by the headless worker)
 *  - Worker spawn + stdin/stdout JSON protocol
 *  - Structured errors
 */

const { execFileSync, spawn } = require("child_process");
const path = require("path");

// ============================================================================
// Bun detection
// ============================================================================

let _bunPath = undefined; // cache

function detectBunPath() {
  if (_bunPath !== undefined) return _bunPath;
  try {
    const out = execFileSync("which", ["bun"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    _bunPath = out || null;
  } catch {
    _bunPath = null;
  }
  return _bunPath;
}

// ============================================================================
// Eligibility
// ============================================================================

/**
 * Check whether the given CLI args are eligible for the Bun path.
 *
 * @param {object} args - Parsed tool args from CLI
 * @returns {{ eligible: boolean, reason?: string }}
 */
function isBunGeminiEligible(args) {
  if (args.withPage || args["with-page"]) {
    return { eligible: false, reason: "with_page" };
  }
  if (process.platform === "win32") {
    return { eligible: false, reason: "unsupported_platform" };
  }
  if (args.profile && process.platform !== "darwin") {
    return { eligible: false, reason: "profile_unsupported_platform" };
  }
  const bun = detectBunPath();
  if (!bun) {
    return { eligible: false, reason: "bun_not_found" };
  }
  return { eligible: true };
}

// ============================================================================
// Worker protocol
// ============================================================================

/**
 * Build the worker request payload from CLI-parsed args.
 *
 * @param {object} args
 * @param {string} args.query       - User prompt
 * @param {string} [args.model]     - Model name
 * @param {string} [args.file]      - Absolute file path
 * @param {string} [args.generateImage] - Absolute output path for generated image
 * @param {string} [args.editImage] - Absolute path to image to edit
 * @param {string} [args.output]    - Explicit output path
 * @param {string} [args.youtube]   - YouTube URL
 * @param {string} [args.aspectRatio] - Aspect ratio
 * @param {number} [args.timeout]   - Timeout in **seconds** (CLI convention)
 * @returns {object}
 */
function buildWorkerRequest(args) {
  // CLI --timeout is always in seconds; always multiply by 1000.
  // Cap at 24h (86400s) to catch accidental ms values passed directly.
  const MAX_TIMEOUT_S = 86400;
  let timeoutMs = 300000;
  if (args.timeout != null && args.timeout > 0) {
    const secs = Math.min(Number(args.timeout), MAX_TIMEOUT_S);
    timeoutMs = secs * 1000;
  }
  return {
    prompt: args.query || "",
    model: args.model || undefined,
    file: args.file || null,
    generateImage: args.generateImage || args["generate-image"] || null,
    editImage: args.editImage || args["edit-image"] || null,
    output: args.output || null,
    youtube: args.youtube || null,
    aspectRatio: args.aspectRatio || args["aspect-ratio"] || null,
    timeoutMs,
    profileEmail: args.profile || null,
  };
}

// ============================================================================
// Spawn
// ============================================================================

/**
 * Run the Gemini Bun worker.
 *
 * @param {object} args - CLI-parsed tool args
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Kill worker after this many ms
 * @returns {Promise<{ ok: true, result: object } | { ok: false, error: string, code: string }>}
 */
async function runGeminiViaBun(args, opts = {}) {
  const bunPath = detectBunPath();
  if (!bunPath) {
    return {
      ok: false,
      code: "bun_not_found",
      error: "Bun executable not found. Install Bun for headless Gemini.",
    };
  }

  const workerPath = path.join(__dirname, "gemini-bun-worker.ts");
  const request = buildWorkerRequest(args);
  const timeoutMs = opts.timeoutMs || request.timeoutMs || 300000;

  return new Promise((resolve) => {
    let resolved = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(bunPath, [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      timeout: timeoutMs + 5000, // give worker 5s grace beyond its internal timeout
    });

    // Send request
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      // Forward worker diagnostics to CLI stderr
      process.stderr.write(chunk);
    });

    const killTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill("SIGKILL"); } catch {}
        resolve({
          ok: false,
          code: "timeout",
          error: `Bun worker killed after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs + 5000);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      resolve({
        ok: false,
        code: "spawn_failed",
        error: `Failed to spawn Bun worker: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);

      // Parse worker response from stdout
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];

      if (!lastLine) {
        resolve({
          ok: false,
          code: "protocol_error",
          error: `Bun worker produced no output (exit ${code}). stderr: ${stderr.slice(0, 300)}`,
        });
        return;
      }

      try {
        const response = JSON.parse(lastLine);
        if (response.ok === true && response.result) {
          resolve({ ok: true, result: response.result });
        } else if (response.ok === false) {
          resolve({
            ok: false,
            code: response.code || "unknown",
            error: response.error || "Bun worker error",
          });
        } else {
          resolve({
            ok: false,
            code: "protocol_error",
            error: `Unexpected worker response shape: ${lastLine.slice(0, 200)}`,
          });
        }
      } catch (parseErr) {
        resolve({
          ok: false,
          code: "protocol_error",
          error: `Failed to parse worker JSON: ${parseErr.message}. Output: ${lastLine.slice(0, 200)}`,
        });
      }
    });
  });
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  isBunGeminiEligible,
  runGeminiViaBun,
  detectBunPath,
  buildWorkerRequest,
};
