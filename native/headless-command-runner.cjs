const { spawn } = require("node:child_process");
const path = require("node:path");

const CLI_PATH = path.join(__dirname, "cli.cjs");
const DEFAULT_RUNNER_TIMEOUT_MS = 60 * 60 * 1000;
const SUPPORTED_HEADLESS_COMMANDS = new Set([
  "chatgpt",
  "gemini",
  "chatgpt.chats",
  "chatgpt.reply",
]);

function optionName(key) {
  return String(key)
    .replace(/_/g, "-")
    .replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function appendOption(argv, key, value) {
  if (value === undefined || value === null || value === false) return;
  const flag = `--${optionName(key)}`;
  if (value === true) {
    argv.push(flag);
    return;
  }
  if (Array.isArray(value)) {
    argv.push(flag, value.join(","));
    return;
  }
  argv.push(flag, String(value));
}

function buildCliArgs(command, args = {}, options = {}) {
  if (!SUPPORTED_HEADLESS_COMMANDS.has(command)) {
    throw new Error(`Command "${command}" is not supported by the headless-only workflow runtime.`);
  }

  const argv = [command];
  const consumed = new Set();
  const consume = (key) => {
    consumed.add(key);
    return args[key];
  };

  if (command === "chatgpt" || command === "gemini") {
    const query = consume("query");
    const promptArg = consume("prompt");
    const prompt = query ?? promptArg;
    if (prompt !== undefined) argv.push(String(prompt));
  } else if (command === "chatgpt.chats") {
    const camelConversationId = consume("conversationId");
    const kebabConversationId = consume("conversation-id");
    const conversationId = camelConversationId ?? kebabConversationId;
    if (conversationId !== undefined) argv.push(String(conversationId));
  } else if (command === "chatgpt.reply") {
    const camelConversationId = consume("conversationId");
    const kebabConversationId = consume("conversation-id");
    const conversationId = camelConversationId ?? kebabConversationId;
    const promptArg = consume("prompt");
    const query = consume("query");
    const prompt = promptArg ?? query;
    if (conversationId !== undefined) argv.push(String(conversationId));
    if (prompt !== undefined) argv.push(String(prompt));
  }

  for (const [key, value] of Object.entries(args || {})) {
    if (consumed.has(key)) continue;
    appendOption(argv, key, value);
  }

  if (options.json !== false && !argv.includes("--json")) {
    argv.push("--json");
  }

  return argv;
}

function parseJsonOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { text: trimmed };
  }
}

function resolveRunnerTimeoutMs(args = {}, options = {}) {
  if (options.timeoutMs === false || options.timeoutMs === 0) return 0;
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) return options.timeoutMs;
  const requestSeconds = Number(args.timeout);
  if (Number.isFinite(requestSeconds) && requestSeconds > 0) {
    return (requestSeconds + 30) * 1000;
  }
  return DEFAULT_RUNNER_TIMEOUT_MS;
}

function runSurfHeadlessCommand(command, args = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let argv;
    try {
      argv = buildCliArgs(command, args, { json: options.json });
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = resolveRunnerTimeoutMs(args, options);
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        const error = new Error(`${command} failed: runner timed out after ${timeoutMs}ms`);
        error.code = "runner_timeout";
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }, timeoutMs)
      : null;
    const clearRunnerTimeout = () => {
      if (timeout) clearTimeout(timeout);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (options.onStdout) options.onStdout(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.onStderr) options.onStderr(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearRunnerTimeout();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearRunnerTimeout();
      if (code === 0) {
        resolve({
          command,
          args: argv,
          stdout,
          stderr,
          result: options.json === false ? stdout : parseJsonOutput(stdout),
        });
        return;
      }

      const detail = stderr.trim() || stdout.trim() || (signal ? `killed by ${signal}` : `exit code ${code}`);
      const error = new Error(`${command} failed: ${detail}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

module.exports = {
  DEFAULT_RUNNER_TIMEOUT_MS,
  SUPPORTED_HEADLESS_COMMANDS,
  buildCliArgs,
  resolveRunnerTimeoutMs,
  runSurfHeadlessCommand,
};
