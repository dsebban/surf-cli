/**
 * CDP stealth patches for Bun headless WebView workers.
 *
 * Reduces bot-detection fingerprints by patching navigator properties,
 * user-agent, plugins, and permissions before target-site navigation.
 *
 * Call applyCdpStealth(wv) once, AFTER about:blank + cookie injection,
 * BEFORE navigating to the target site.
 */

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Strip "Headless" from Chrome user-agent string.
 * "HeadlessChrome/146.0.0.0" → "Chrome/146.0.0.0"
 */
function stripHeadlessFromUserAgent(ua) {
  if (!ua || typeof ua !== "string") return ua;
  return ua.replace(/HeadlessChrome\//g, "Chrome/");
}

/**
 * Resolve stealth locale from optional override or system default.
 * Returns { acceptLanguage, languages }.
 */
function resolveStealthLocale(locale) {
  let base = locale;
  if (!base) {
    try {
      base = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {}
  }
  if (!base) base = "en-US";

  // Normalize _ to -
  base = base.replace(/_/g, "-");

  // Build ordered language list
  const languages = [base];
  const dash = base.indexOf("-");
  if (dash > 0) {
    const short = base.slice(0, dash);
    if (!languages.includes(short)) languages.push(short);
  }
  // Always include en-US/en as fallback if not already present
  if (!languages.includes("en-US") && !languages.includes("en")) {
    languages.push("en-US", "en");
  } else if (languages.includes("en-US") && !languages.includes("en")) {
    languages.push("en");
  } else if (!languages.includes("en-US") && languages.includes("en")) {
    // keep as-is
  }

  const acceptLanguage = languages.join(",");
  return { acceptLanguage, languages };
}

/**
 * Map Node process.platform to navigator.platform string.
 */
function resolveNavigatorPlatform(nodePlatform) {
  const p = nodePlatform || process.platform;
  switch (p) {
    case "darwin": return "MacIntel";
    case "linux": return "Linux x86_64";
    case "win32": return "Win32";
    default: return "Linux x86_64";
  }
}

/**
 * Build the stealth init script that runs before page JS.
 *
 * @param {{ languages: string[], platform: string }} opts
 * @returns {string} Self-invoking JS script source
 */
function buildStealthInitScript({ languages, platform }) {
  const langsJson = JSON.stringify(languages);
  const platJson = JSON.stringify(platform);

  return `(function() {
  // 1. Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', {
    get: function() { return undefined; },
    configurable: true
  });

  // 2. Override languages
  Object.defineProperty(navigator, 'languages', {
    get: function() { return ${langsJson}; },
    configurable: true
  });

  // 3. Override platform
  Object.defineProperty(navigator, 'platform', {
    get: function() { return ${platJson}; },
    configurable: true
  });

  // 4. Fake plugins (headless has 0)
  var fakePlugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 }
  ];
  fakePlugins.item = function(i) { return this[i] || null; };
  fakePlugins.namedItem = function(name) {
    for (var i = 0; i < this.length; i++) { if (this[i].name === name) return this[i]; }
    return null;
  };
  fakePlugins.refresh = function() {};
  Object.defineProperty(navigator, 'plugins', {
    get: function() { return fakePlugins; },
    configurable: true
  });

  // 5. Ensure window.chrome / chrome.runtime
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
      id: undefined
    };
  }

  // 6. Permissions.query — intercept notifications only
  if (window.Permissions && window.Permissions.prototype.query) {
    var origQuery = window.Permissions.prototype.query;
    window.Permissions.prototype.query = function(params) {
      if (params && params.name === 'notifications') {
        var state = (typeof Notification !== 'undefined' && Notification.permission) || 'prompt';
        return Promise.resolve({ state: state, onchange: null });
      }
      return origQuery.call(this, params);
    };
  }

  // 7. Remove cdc_ markers (ChromeDriver detection)
  var keys = Object.keys(window);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('cdc_') === 0 || keys[i].indexOf('__cdc_') === 0) {
      try { delete window[keys[i]]; } catch(e) {}
    }
  }
})();`;
}

// ============================================================================
// Async CDP applicator
// ============================================================================

/**
 * Apply CDP stealth setup to a WebView.
 *
 * Must be called on about:blank, AFTER cookie injection, BEFORE target navigation.
 * Tolerates UA override failure but throws on script injection failure.
 *
 * @param {object} wv - Bun WebView instance with .cdp() method
 * @param {object} [opts]
 * @param {string} [opts.locale] - Override locale (default: system)
 * @returns {Promise<{ userAgent: string|null, acceptLanguage: string, languages: string[], platform: string, uaOverrideApplied: boolean, initScriptApplied: boolean }>}
 */
async function applyCdpStealth(wv, opts) {
  const { acceptLanguage, languages } = resolveStealthLocale(opts && opts.locale);
  const platform = resolveNavigatorPlatform();

  let userAgent = null;
  let uaOverrideApplied = false;

  // 1. Page.enable (required for addScriptToEvaluateOnNewDocument)
  await wv.cdp("Page.enable");

  // 2. Get current UA and strip headless marker (best-effort)
  try {
    const version = await wv.cdp("Browser.getVersion");
    if (version && version.userAgent) {
      userAgent = stripHeadlessFromUserAgent(version.userAgent);
    }
  } catch (_) {
    // Browser.getVersion not available — skip UA override
  }

  // 3. Override UA if we got one
  if (userAgent) {
    try {
      await wv.cdp("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage,
        platform,
      });
      uaOverrideApplied = true;
    } catch (_) {
      // Emulation.setUserAgentOverride not available — skip
    }
  }

  // 4. Inject stealth init script (must succeed)
  const script = buildStealthInitScript({ languages, platform });
  await wv.cdp("Page.addScriptToEvaluateOnNewDocument", { source: script });

  return {
    userAgent,
    acceptLanguage,
    languages,
    platform,
    uaOverrideApplied,
    initScriptApplied: true,
  };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  applyCdpStealth,
  stripHeadlessFromUserAgent,
  resolveStealthLocale,
  resolveNavigatorPlatform,
  buildStealthInitScript,
};
