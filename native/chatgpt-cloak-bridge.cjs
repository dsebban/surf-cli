/**
 * ChatGPT CloakBrowser Bridge
 *
 * Node.js module that spawns the CloakBrowser worker (.mjs) and
 * communicates via stdin/stdout JSON-lines protocol.
 */

const { spawn } = require("child_process");
const { existsSync } = require("fs");
const { join, dirname } = require("path");

const WORKER_PATH = join(__dirname, "chatgpt-cloak-worker.mjs");

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

/**
 * Check if CloakBrowser is available.
 * CloakBrowser is ESM-only so require.resolve() fails — we probe for the
 * package directory instead.
 */
function isCloakBrowserAvailable() {
  try {
    // Walk up from this file to find node_modules/cloakbrowser
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "node_modules", "cloakbrowser", "package.json"))) return true;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Run a ChatGPT query via the CloakBrowser worker process.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt          Prompt text
 * @param {string}  [opts.model]          Model identifier
 * @param {string}  [opts.file]           File path to attach
 * @param {string}  [opts.profile]        Chrome profile email for cookie auth
 * @param {string}  [opts.generateImage]  Save path for generated image
 * @param {number}  [opts.timeout=120]    Seconds
 * @param {Function} onProgress           ({ step, total, message }) => void
 * @returns {Promise<{ response:string, model:string, tookMs:number, imagePath:string|null, partial:boolean, backend:string }>}
 */
async function queryWithCloakBrowser(opts, onProgress = () => {}) {
  const { model, file, profile, timeout = 120 } = opts;
  const prompt = opts.prompt || opts.query || "";
  const generateImage = opts["generate-image"] || opts.generateImage || null;

  if (!isCloakBrowserAvailable()) {
    throw Object.assign(
      new Error("CloakBrowser not installed. Run: npm install cloakbrowser playwright-core"),
      { code: "cloakbrowser_not_installed" }
    );
  }

  if (!existsSync(WORKER_PATH)) {
    throw Object.assign(
      new Error("CloakBrowser worker not found: " + WORKER_PATH),
      { code: "worker_not_found" }
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    // Spawn worker — use same Node.js as the CLI
    const worker = spawn(process.execPath, [WORKER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLOAK_HEADLESS: process.env.CLOAK_HEADLESS ?? "1",
        CLOAK_HUMANIZE: process.env.CLOAK_HUMANIZE ?? "1",
      },
    });

    // Timeout
    const timeoutMs = timeout * 1000;
    const timer = setTimeout(() => {
      worker.kill("SIGTERM");
      settle(reject, Object.assign(
        new Error(`CloakBrowser worker killed after ${timeoutMs}ms`),
        { code: "timeout" }
      ));
    }, timeoutMs);

    // Stdout protocol
    let stdoutBuf = "";
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          switch (msg.type) {
            case "progress":
              onProgress(msg);
              break;
            case "success":
              settle(resolve, {
                response: msg.response || msg.text || "",
                model: msg.model,
                tookMs: msg.tookMs || msg.durationMs || 0,
                imagePath: msg.imagePath || null,
                partial: !!msg.partial,
                backend: msg.backend || "cloak",
              });
              break;
            case "error":
              settle(reject, Object.assign(new Error(msg.message), { code: msg.code }));
              break;
            case "log":
              if (process.env.SURF_DEBUG) {
                process.stderr.write(`[cloak:${msg.level}] ${msg.message}\n`);
              }
              break;
          }
        } catch {
          // non-JSON — ignore
        }
      }
    });

    // Stderr — forward download progress
    worker.stderr.setEncoding("utf8");
    worker.stderr.on("data", (chunk) => {
      if (chunk.includes("[cloakbrowser]")) {
        process.stderr.write(chunk);
      }
    });

    // Exit
    worker.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (signal) {
        settle(reject, Object.assign(
          new Error(`CloakBrowser worker killed by ${signal}`),
          { code: "worker_killed", signal }
        ));
      } else {
        settle(reject, Object.assign(
          new Error(`CloakBrowser worker exited ${code} without result`),
          { code: "worker_exit", exitCode: code }
        ));
      }
    });

    // Send query — worker reads one query then exits
    worker.stdin.write(JSON.stringify({
      type: "query",
      prompt, model, file, profile, timeout, generateImage,
    }) + "\n");
    // Don't end stdin — worker exits after processing
  });
}

module.exports = { isCloakBrowserAvailable, queryWithCloakBrowser };
