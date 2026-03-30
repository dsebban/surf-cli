/**
 * Shared Gemini helpers used by both legacy HTTP path and Bun WebView worker.
 * Pure sync functions — no state, no I/O.
 */

// ============================================================================
// Constants
// ============================================================================

const GEMINI_APP_URL = "https://gemini.google.com/app";

// ---------------------------------------------------------------------------
// Auth cookie allow-lists (shared by legacy HTTP path + Bun WebView worker)
// ---------------------------------------------------------------------------

const REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

const ALL_COOKIE_NAMES = [
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "NID",
  "AEC",
  "SOCS",
  "__Secure-BUCKET",
  "__Secure-ENID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PAPISID",
  "SIDCC",
];

const DEFAULT_GEMINI_MODEL = "gemini-3-pro";

const SUPPORTED_GEMINI_MODELS = [
  "gemini-3-pro",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";

// Best-effort only — these private IDs may drift.
// Use SURF_GEMINI_MODEL_HEADERS env to override.
const MODEL_HEADERS = {
  "gemini-3-pro": '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]',
  "gemini-2.5-pro": '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]',
  "gemini-2.5-flash": '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]',
};

const MODEL_HEADER_OVERRIDES = (() => {
  try {
    const p = JSON.parse(process.env.SURF_GEMINI_MODEL_HEADERS || "");
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
})();

// ============================================================================
// Model Resolution
// ============================================================================

/**
 * Resolve requested model to a known Gemini model string.
 * For HTTP transport: falls back to DEFAULT_GEMINI_MODEL if unknown.
 * For UI/headless transport: pass-through unknown names so trySelectModel can attempt UI selection.
 * Use resolveGeminiModelForUI() in headless workers.
 */
function resolveGeminiModel(model) {
  if (!model) return DEFAULT_GEMINI_MODEL;
  const m = String(model).trim().toLowerCase();
  if (MODEL_HEADER_OVERRIDES[m] || MODEL_HEADERS[m]) return m;
  return DEFAULT_GEMINI_MODEL;
}

/**
 * Resolve model for headless/UI mode.
 * Known models are normalised; unknown model names are passed through as-is
 * so the UI model picker can attempt to select them (e.g. gemini-3.1-pro-preview).
 */
function resolveGeminiModelForUI(model) {
  if (!model) return DEFAULT_GEMINI_MODEL;
  const m = String(model).trim().toLowerCase();
  // Known models: normalise
  if (MODEL_HEADER_OVERRIDES[m] || MODEL_HEADERS[m]) return m;
  // Unknown: pass through raw (UI picker will attempt best-effort match)
  return String(model).trim();
}

/**
 * Return ordered list of model header candidates for HTTP transport.
 * [requested-header, fallback-header, null (no-header)]
 */
function getModelHeaderCandidates(model) {
  const get = (m) => MODEL_HEADER_OVERRIDES[m] || MODEL_HEADERS[m] || null;
  const seen = new Set();
  const out = [];
  for (const h of [
    get(model),
    model !== DEFAULT_GEMINI_MODEL ? get(DEFAULT_GEMINI_MODEL) : null,
    null,
  ]) {
    const k = h ?? "__none__";
    if (!seen.has(k)) {
      seen.add(k);
      out.push(h);
    }
  }
  return out;
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build the full Gemini prompt from user input + options.
 *
 * @param {object} opts
 * @param {string} opts.prompt       - User prompt text
 * @param {string} [opts.youtube]    - YouTube URL to append
 * @param {string} [opts.aspectRatio]- Aspect ratio suffix (e.g. "1:1")
 * @param {string} [opts.generateImage] - Truthy → prefix with "Generate an image:"
 * @param {string} [opts.editImage]  - Truthy → treat as edit (no prefix)
 * @returns {string}
 */
function buildGeminiPrompt(opts) {
  let prompt = opts.prompt || "";

  if (opts.aspectRatio && (opts.generateImage || opts.editImage)) {
    prompt = `${prompt} (aspect ratio: ${opts.aspectRatio})`;
  }
  if (opts.youtube) {
    prompt = `${prompt}\n\nYouTube video: ${opts.youtube}`;
  }
  if (opts.generateImage && !opts.editImage) {
    prompt = `Generate an image: ${prompt}`;
  }

  return prompt;
}

// ============================================================================
// Image URL Helpers
// ============================================================================

/**
 * Ensure a gg-dl image URL has a full-size parameter.
 */
function ensureFullSizeImageUrl(url) {
  if (url.includes("=s")) return url;
  return `${url}=s2048`;
}

/**
 * Extract unique gg-dl image URLs from raw text.
 */
function extractGgdlUrls(rawText) {
  const matches =
    rawText.match(
      /https:\/\/lh3\.googleusercontent\.com\/gg-dl\/[^\s"']+/g,
    ) ?? [];
  const seen = new Set();
  const urls = [];
  for (const match of matches) {
    if (!seen.has(match)) {
      seen.add(match);
      urls.push(match);
    }
  }
  return urls;
}

// ============================================================================
// Output Path Resolution
// ============================================================================

/**
 * Resolve the output path for image save operations.
 *
 * @param {object} opts
 * @param {string} [opts.output]        - Explicit --output path
 * @param {string} [opts.generateImage] - --generate-image path
 * @param {string} [opts.editImage]     - --edit-image path (implies editing)
 * @returns {string}
 */
function resolveImageOutputPath(opts) {
  if (opts.output) return opts.output;
  if (opts.generateImage) return opts.generateImage;
  return "edited.png";
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  GEMINI_APP_URL,
  DEFAULT_GEMINI_MODEL,
  SUPPORTED_GEMINI_MODELS,
  MODEL_HEADER_NAME,
  MODEL_HEADERS,
  MODEL_HEADER_OVERRIDES,
  resolveGeminiModel,
  resolveGeminiModelForUI,
  getModelHeaderCandidates,
  buildGeminiPrompt,
  ensureFullSizeImageUrl,
  extractGgdlUrls,
  resolveImageOutputPath,
  REQUIRED_COOKIES,
  ALL_COOKIE_NAMES,
};
