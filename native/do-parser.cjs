/**
 * Parser for surf `do` workflow commands
 * 
 * Parses newline-separated commands into structured step arrays:
 * 
 * Input:
 *   'chatgpt "Draft release notes"
 *    gemini "Make them shorter"'
 * 
 * Output:
 *   [
 *     { cmd: 'chatgpt', args: { query: 'Draft release notes' } },
 *     { cmd: 'gemini', args: { query: 'Make them shorter' } }
 *   ]
 */

// Aliases mapping (matches cli.cjs)
const ALIASES = {};

// Primary argument mapping for positional args (matches cli.cjs)
const PRIMARY_ARG_MAP = {
  gemini: "query",
  chatgpt: "query",
  "chatgpt.reply": "conversationId",
  "chatgpt.chats": "conversationId",
};

/**
 * Tokenize a command line, respecting single and double quotes
 * @param {string} line - Single line to tokenize
 * @returns {string[]} - Array of tokens
 */
function tokenize(line) {
  const tokens = [];
  let current = '';
  let inQuote = null;
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    
    if (inQuote) {
      if (ch === inQuote) {
        // End of quoted string
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      // Start of quoted string
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      // Whitespace separator
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  
  // Don't forget last token
  if (current) {
    tokens.push(current);
  }
  
  return tokens;
}

function splitCommands(input, separator) {
  const parts = [];
  let current = "";
  let inQuote = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}

function hasUnquotedPipe(input) {
  return splitCommands(input, "|").length > 1;
}

/**
 * Parse a single command line into a step object
 * @param {string} line - Single command line
 * @returns {{ cmd: string, args: object } | null}
 */
function parseCommandLine(line) {
  const tokens = tokenize(line);
  if (tokens.length === 0) return null;
  
  // Get command and apply alias
  let cmd = tokens[0];
  cmd = ALIASES[cmd] || cmd;
  
  const args = {};
  let i = 1;
  
  // Handle first positional argument based on command type
  if (i < tokens.length && !tokens[i].startsWith('--')) {
    const firstArg = tokens[i];
    
    const primaryKey = PRIMARY_ARG_MAP[cmd];
    if (primaryKey) {
      args[primaryKey] = firstArg;
      i++;
    }
    if (cmd === "chatgpt.reply" && i < tokens.length && !tokens[i].startsWith("--")) {
      args.prompt = tokens[i];
      i++;
    }
  }
  
  // Parse --flag value pairs
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next && !next.startsWith('--')) {
        // Flag with value
        let val = next;
        // Type coercion
        if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
        else if (/^-?\d+\.\d+$/.test(val)) val = parseFloat(val);
        args[key] = val;
        i += 2;
      } else {
        // Boolean flag
        args[key] = true;
        i++;
      }
    } else {
      // Skip unrecognized positional (shouldn't happen normally)
      i++;
    }
  }
  
  return { cmd, args };
}

/**
 * Parse a workflow string into step array
 * Supports pipe-separated (inline) or newline-separated (file) commands
 * @param {string} input - Workflow string
 * @returns {Array<{ cmd: string, args: object }>}
 */
function parseDoCommands(input) {
  // Determine separator: use unquoted pipe if present, otherwise newlines.
  // Newlines are preferred for prompts that contain literal pipe characters.
  const hasPipe = hasUnquotedPipe(input);
  const separator = hasPipe ? '|' : '\n';
  
  // Also handle literal \n for backwards compatibility
  const normalized = hasPipe ? input : input.replace(/\\n/g, '\n');
  
  return splitCommands(normalized, separator)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => parseCommandLine(line))
    .filter(step => step !== null);
}

module.exports = { 
  parseDoCommands, 
  parseCommandLine, 
  splitCommands,
  hasUnquotedPipe,
  tokenize,
  ALIASES,
  PRIMARY_ARG_MAP
};
