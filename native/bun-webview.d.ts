/**
 * Ambient type declarations for Bun.WebView (canary API).
 * These are minimal types to support the gemini-bun-worker without
 * pulling a full Bun type migration into the repo.
 */

declare namespace Bun {
  interface WebViewOptions {
    /** Run without visible window. */
    headless?: boolean;
    /** Browser backend — "chrome" enables CDP access. */
    backend?: "chrome" | "webkit";
  }

  class WebView {
    constructor(options?: WebViewOptions);

    /** Current page URL. */
    url: string;
    /** Current page title. */
    title: string;
    /** Whether the page is currently loading. */
    loading: boolean;

    /** Called when navigation succeeds. */
    onNavigated: ((url: string) => void) | null;
    /** Called when navigation fails. */
    onNavigationFailed: ((error: unknown) => void) | null;

    /** Navigate to a URL. Resolves when the page starts loading. */
    navigate(url: string): Promise<void>;

    /**
     * Evaluate JavaScript in the page context.
     * Returns the serialized result of the expression.
     */
    evaluate(expression: string): Promise<unknown>;

    /** Type text as keyboard input to the focused element. */
    type(text: string): Promise<void>;

    /** Press a single key (e.g. "Enter", "Escape", "Tab"). */
    press(key: string): Promise<void>;

    /** Click at coordinates or the current cursor position. */
    click(x?: number, y?: number): Promise<void>;

    /** Scroll by delta amounts. */
    scroll(deltaX: number, deltaY: number): Promise<void>;

    /** Scroll to a CSS selector. */
    scrollTo(selector: string): Promise<void>;

    /** Resize the viewport. */
    resize(width: number, height: number): Promise<void>;

    /** Take a screenshot. Returns a Blob. */
    screenshot(): Promise<Blob>;

    /**
     * Execute a Chrome DevTools Protocol command.
     * Requires `backend: "chrome"` in constructor.
     */
    cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;

    /** Navigate back. */
    goBack(): Promise<void>;
    /** Navigate forward. */
    goForward(): Promise<void>;
    /** Reload the page. */
    reload(): Promise<void>;

    /** Close this WebView instance. */
    close(): void;

    /**
     * Listen for CDP domain events (requires the domain to be enabled first).
     * Events are dispatched as MessageEvent with:
     *   - event.type  = CDP method name (e.g. "Page.fileChooserOpened")
     *   - event.data  = parsed CDP params object
     *
     * Example CDP events:
     *   "Page.fileChooserOpened"  → { frameId: string, mode: string, backendNodeId: number }
     *   "Network.requestWillBeSent" → { requestId, request, ... }
     */
    addEventListener(event: string, handler: (event: { data?: any; [key: string]: any }) => void): void;
    removeEventListener(event: string, handler: (event: { data?: any; [key: string]: any }) => void): void;

    /** Close all WebView instances. */
    static closeAll(): void;
  }

  const stdin: {
    text(): Promise<string>;
  };

  function write(path: string, data: unknown): Promise<number>;
  function file(path: string): { arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> };
}

// Minimal bun:sqlite types for the profile auth module
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    query(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): void;
    };
    close(): void;
  }
}
