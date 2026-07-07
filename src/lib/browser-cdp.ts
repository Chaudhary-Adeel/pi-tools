// browser-cdp.ts — zero-dependency CDP client over a hand-rolled WebSocket.
//
// Connects to a running Chromium-based browser's remote debugging port
// (default 9222) and speaks the Chrome DevTools Protocol.
//
// No Playwright, Puppeteer, or ws library — just Node built-ins.

import { connect, type Socket } from "node:net";

// ── types ──────────────────────────────────────────────────────────────────

export interface CDPTarget {
  id: string;
  url: string;
  title: string;
  type?: string;
  webSocketDebuggerUrl: string;
}

interface WSCallbacks {
  onMessage: (data: string) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}

// ── minimal WebSocket client ───────────────────────────────────────────────

class MiniWS {
  private socket: Socket | null = null;
  private buffer = "";
  private callbacks!: WSCallbacks;
  private closed = false;
  private handshakeDone = false;

  connect(wsUrl: string, cbs: WSCallbacks): Promise<void> {
    this.callbacks = cbs;
    const url = new URL(wsUrl);
    const host = url.hostname;
    const actualPort = parseInt(url.port, 10) || 80;
    const path = url.pathname + url.search;

    return new Promise((resolve, reject) => {
      let handshakeBuf = "";

      const sock = connect({ host, port: actualPort }, () => {
        // Send WebSocket upgrade request
        const key = Buffer.from(
          Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
        ).toString("base64");

        const req = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${actualPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");

        sock.write(req);
      });

      sock.on("data", (data: Buffer) => {
        if (!this.handshakeDone) {
          handshakeBuf += data.toString("binary");
          const headerEnd = handshakeBuf.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            if (handshakeBuf.length > 16384) {
              reject(new Error("WebSocket handshake response too large"));
              sock.destroy();
            }
            return;
          }
          const statusLine = handshakeBuf.slice(0, handshakeBuf.indexOf("\r\n"));
          if (!/^HTTP\/1\.[01] 101/.test(statusLine)) {
            reject(new Error(`WebSocket handshake failed: ${statusLine}`));
            sock.destroy();
            return;
          }
          this.handshakeDone = true;
          this.socket = sock;
          // Frames may arrive in the same packet as the handshake headers.
          this.buffer = handshakeBuf.slice(headerEnd + 4);
          resolve();
          if (this.buffer) this.drain();
          return;
        }
        this.buffer += data.toString("binary");
        this.drain();
      });

      sock.on("close", () => {
        this.closed = true;
        this.callbacks.onClose();
      });

      sock.on("error", (err) => {
        if (!this.handshakeDone) {
          reject(err);
        } else {
          this.callbacks.onError(err);
        }
      });
    });
  }

  send(data: string): void {
    if (!this.socket || this.closed) return;
    const payload = Buffer.from(data, "utf8");
    const frame = this.frameText(payload);
    this.socket.write(frame);
  }

  close(): void {
    if (this.socket && !this.closed) {
      this.closed = true;
      // Close frame: 0x88 + empty payload
      const frame = Buffer.from([0x88, 0x00]);
      this.socket.write(frame);
      this.socket.end();
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  // ── frame parsing ──────────────────────────────────────────────────────

  private drain(): void {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer.charCodeAt(0);
      const opcode = b0 & 0x0f;

      const b1 = this.buffer.charCodeAt(1);
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen =
          (this.buffer.charCodeAt(2) << 8) | this.buffer.charCodeAt(3);
        headerLen = 4;
      } else if (payloadLen === 127) {
        // 64-bit length: bytes 2..9 big-endian. Messages never exceed 2^32,
        // so the upper 4 bytes (2..5) are zero — the length is in bytes 6..9.
        if (this.buffer.length < 10) return;
        payloadLen = 0;
        for (let i = 6; i < 10; i++) {
          payloadLen = payloadLen * 256 + this.buffer.charCodeAt(i);
        }
        headerLen = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = headerLen + maskLen + payloadLen;
      if (this.buffer.length < totalLen) return;

      let payload: string;
      if (masked) {
        const mask = [
          this.buffer.charCodeAt(headerLen),
          this.buffer.charCodeAt(headerLen + 1),
          this.buffer.charCodeAt(headerLen + 2),
          this.buffer.charCodeAt(headerLen + 3),
        ];
        const start = headerLen + 4;
        const chars: string[] = [];
        for (let i = 0; i < payloadLen; i++) {
          chars.push(
            String.fromCharCode(
              this.buffer.charCodeAt(start + i) ^ mask[i % 4]!,
            ),
          );
        }
        payload = chars.join("");
      } else {
        const start = headerLen;
        payload = this.buffer.slice(start, start + payloadLen);
      }

      this.buffer = this.buffer.slice(totalLen);

      if (opcode === 0x1 || opcode === 0x0) {
        this.callbacks.onMessage(payload);
      } else if (opcode === 0x9) {
        // Ping — reply with a pong echoing the payload.
        this.socket?.write(this.framePong(Buffer.from(payload, "binary")));
      } else if (opcode === 0x8) {
        // Close frame — acknowledge and stop.
        this.close();
        return;
      }
      // Other control frames (pong, etc.) are consumed and ignored.
    }
  }

  private framePong(payload: Buffer): Buffer {
    // Pong: FIN=1 opcode=0xA, client frames must be masked.
    const frame = this.frameText(payload);
    frame[0] = 0x8a;
    return frame;
  }

  private frameText(payload: Buffer): Buffer {
    const len = payload.length;
    const chunks: Buffer[] = [];

    // Byte 0: FIN=1, RSV=0, Opcode=0x1 (text)
    chunks.push(Buffer.from([0x81]));

    // Byte 1+: MASK=1 + length
    if (len < 126) {
      chunks.push(Buffer.from([0x80 | len]));
    } else if (len < 65536) {
      chunks.push(Buffer.from([0x80 | 126, (len >> 8) & 0xff, len & 0xff]));
    } else {
      chunks.push(
        Buffer.from([
          0x80 | 127,
          0, 0, 0, 0, // upper 4 bytes
          (len >> 24) & 0xff,
          (len >> 16) & 0xff,
          (len >> 8) & 0xff,
          len & 0xff,
        ]),
      );
    }

    // Masking key (4 random bytes)
    const mask = Buffer.from(
      Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)),
    );
    chunks.push(mask);

    // Masked payload
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i]! ^ mask[i % 4]!;
    }
    chunks.push(masked);

    return Buffer.concat(chunks);
  }
}

// ── CDP client ─────────────────────────────────────────────────────────────

export interface ConsoleEntry {
  type: "log" | "warn" | "error" | "info" | "debug";
  text: string;
  timestamp: number;
}

export interface SnapshotNode {
  role: string;
  name: string;
  children?: SnapshotNode[];
  value?: string;
  description?: string;
}

export class CDPClient {
  private ws: MiniWS | null = null;
  private msgId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<string, Array<(params: unknown) => void>>();
  private consoleMessages: ConsoleEntry[] = [];
  private defaultPort: number;

  constructor(port = 9222) {
    this.defaultPort = port;
  }

  // ── connection ──────────────────────────────────────────────────────────

  async connect(port?: number): Promise<CDPTarget> {
    const p = port ?? this.defaultPort;

    // Discover targets via HTTP
    const targets = await this.fetchJSON<CDPTarget[]>(
      `http://localhost:${p}/json`,
    );

    // Pick the first page target (non-service-worker, non-extension)
    const page =
      targets.find(
        (t) =>
          t.type === "page" &&
          !t.url.startsWith("devtools://") &&
          !t.url.startsWith("chrome-extension://"),
      ) ?? targets[0];

    if (!page || !page.webSocketDebuggerUrl) {
      throw new Error(
        `No debuggable page found on port ${p}. Open Chrome with --remote-debugging-port=${p}`,
      );
    }

    this.ws = new MiniWS();
    await this.ws.connect(page.webSocketDebuggerUrl, {
      onMessage: (data) => this.handleMessage(data),
      onClose: () => {
        this.ws = null;
        this.rejectAll(new Error("CDP connection closed"));
      },
      onError: () => {},
    });

    // Enable key domains
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Accessibility.enable");

    // Listen for console messages
    this.on("Runtime.consoleAPICalled", (params: unknown) => {
      const p = params as {
        type: string;
        args: Array<{ value?: string; description?: string }>;
        timestamp: number;
      };
      const text = p.args
        .map((a) => a.value ?? a.description ?? "")
        .join(" ");
      this.consoleMessages.push({
        type: (p.type as ConsoleEntry["type"]) ?? "log",
        text,
        timestamp: p.timestamp,
      });
      // Keep only last 500
      if (this.consoleMessages.length > 500) {
        this.consoleMessages = this.consoleMessages.slice(-500);
      }
    });

    // Listen for exceptions
    this.on("Runtime.exceptionThrown", (params: unknown) => {
      const p = params as {
        exceptionDetails: { text?: string; exception?: { description?: string } };
        timestamp: number;
      };
      const text =
        p.exceptionDetails?.text ??
        p.exceptionDetails?.exception?.description ??
        "Unknown error";
      this.consoleMessages.push({
        type: "error",
        text: `[Uncaught] ${text}`,
        timestamp: p.timestamp,
      });
    });

    return page;
  }

  isConnected(): boolean {
    return this.ws !== null && !this.ws.isClosed();
  }

  async ensureConnected(port?: number): Promise<void> {
    if (this.isConnected()) return;
    await this.connect(port);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  // ── CDP commands ────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    // Wait briefly for the page to start loading
    await this.wait(500);
  }

  async snapshot(maxDepth = 4): Promise<string> {
    const tree = (await this.send("Accessibility.getFullAXTree", {
      depth: maxDepth,
    })) as { nodes: Array<Record<string, unknown>> };

    if (!tree?.nodes || tree.nodes.length === 0) {
      return "(empty page — no accessibility tree available)";
    }

    const nodes = tree.nodes as Array<{
      nodeId: string;
      ignored: boolean;
      role?: { value: string };
      name?: { value: string };
      value?: { value: string };
      description?: { value: string };
      childIds?: string[];
      backendDOMNodeId?: number;
      properties?: Array<{ name: string; value?: { value: string } }>;
    }>;

    // Build a map for traversal
    const nodeMap = new Map<string, (typeof nodes)[number]>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);

    // Find root node
    const rootNode = nodes.find(
      (n) => n.role?.value === "RootWebArea" || n.role?.value === "WebArea",
    );
    if (!rootNode) {
      // Just dump all non-ignored nodes
      const lines: string[] = [];
      for (const n of nodes) {
        if (n.ignored) continue;
        const role = n.role?.value ?? "?";
        const name = n.name?.value ?? "";
        const val = n.value?.value ?? "";
        const parts = [role];
        if (name) parts.push(`"${name}"`);
        if (val) parts.push(`="${val}"`);
        lines.push(parts.join(" "));
      }
      return truncateResult(lines.join("\n"));
    }

    const lines: string[] = [];
    const renderNode = (nodeId: string, indent: number) => {
      const n = nodeMap.get(nodeId);
      if (!n) return;
      if (n.ignored) {
        // Ignored wrappers (role "none") still parent the real content —
        // descend through them without printing or consuming depth.
        for (const childId of n.childIds ?? []) renderNode(childId, indent);
        return;
      }

      const role = n.role?.value ?? "?";
      const name = n.name?.value ?? "";
      const val = n.value?.value ?? "";

      let line = "  ".repeat(indent) + role;
      if (name) line += ` "${name}"`;
      if (val) line += ` = "${val}"`;

      lines.push(line);

      if (n.childIds && indent < maxDepth) {
        for (const childId of n.childIds) {
          renderNode(childId, indent + 1);
        }
      }
    };

    renderNode(rootNode.nodeId, 0);
    return truncateResult(lines.join("\n"));
  }

  async click(selector: string): Promise<void> {
    // Get the element position via DOM + Runtime
    const doc = (await this.send("DOM.getDocument", { depth: 1 })) as {
      root: { nodeId: number };
    };
    // Try querySelector first, then fall back to text search
    let nodeId: number | null = null;

    // Try CSS selector
    try {
      const selResult = (await this.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId: number };
      if (selResult.nodeId) nodeId = selResult.nodeId;
    } catch {
      // Not a valid CSS selector or not found
    }

    // Fallback: search by text content
    if (!nodeId) {
      const search = (await this.send("DOM.performSearch", {
        query: selector,
        includeUserAgentShadowDOM: true,
      })) as { searchId: string; resultCount: number };

      if (search.resultCount > 0) {
        const results = (await this.send("DOM.getSearchResults", {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: 1, // exclusive upper bound — 0 is an invalid empty range
        })) as { nodeIds: number[] };
        if (results.nodeIds[0] != null) nodeId = results.nodeIds[0];
        await this.send("DOM.discardSearchResults", {
          searchId: search.searchId,
        });
      }
    }

    if (!nodeId) {
      throw new Error(`Element not found: "${selector}"`);
    }

    // Get box model for click coordinates
    const box = (await this.send("DOM.getBoxModel", { nodeId })) as {
      model: { content: number[] };
    };
    if (!box?.model?.content) {
      throw new Error(`Cannot click element "${selector}" — no box model`);
    }

    // content = [x1, y1, x2, y1, x2, y2, x1, y2]
    const x = (box.model.content[0]! + box.model.content[2]!) / 2;
    const y = (box.model.content[1]! + box.model.content[5]!) / 2;

    await this.clickPoint(x, y);
  }

  async clickPoint(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async type(selector: string, text: string): Promise<void> {
    // Focus the element first
    const doc = (await this.send("DOM.getDocument", { depth: 1 })) as {
      root: { nodeId: number };
    };
    const selResult = (await this.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    })) as { nodeId: number };

    if (!selResult.nodeId) {
      throw new Error(`Element not found: "${selector}"`);
    }

    // Focus
    await this.send("DOM.focus", { nodeId: selResult.nodeId });

    // Select all text (to replace)
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 65,
      modifiers: 2, // Ctrl
      key: "a",
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
      key: "a",
    });

    // Type the text
    await this.send("Input.insertText", { text });

    // Dispatch a change event
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 13,
      key: "Enter",
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 13,
      key: "Enter",
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result: { value?: unknown; description?: string; type: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (result.exceptionDetails) {
      const err =
        result.exceptionDetails.text ??
        result.exceptionDetails.exception?.description ??
        "Unknown error";
      return { error: err };
    }

    if (result.result.type === "undefined") return undefined;
    if (result.result.value !== undefined) return result.result.value;
    return result.result.description ?? result.result.type;
  }

  async screenshot(): Promise<string> {
    // Returns base64 PNG
    const result = (await this.send("Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    return result.data;
  }

  getConsoleMessages(since?: number): ConsoleEntry[] {
    if (since != null) {
      return this.consoleMessages.filter((m) => m.timestamp > since);
    }
    return [...this.consoleMessages];
  }

  clearConsole(): void {
    this.consoleMessages = [];
  }

  // ── internals ───────────────────────────────────────────────────────────

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.isClosed()) {
        reject(new Error("Not connected to browser"));
        return;
      }
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, method, params });
      this.ws.send(msg);
    });
  }

  private on(event: string, handler: (params: unknown) => void): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };

      if (msg.id != null) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        const handlers = this.eventHandlers.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params);
        }
      }
    } catch {
      // ignore malformed messages
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private async fetchJSON<T>(url: string): Promise<T> {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp.json() as Promise<T>;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function truncateResult(text: string, max = 15_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.3));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n... [${omitted} chars truncated] ...\n\n${tail}`;
}
