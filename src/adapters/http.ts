import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { EventAdapter, IncomingEvent, IncomingMessage, ChatAdapter, AdapterStatus } from "./types";
import type { TraceStore } from "../trace";
import type { TaskQueue } from "../queue";
import type { SessionStore } from "../sessions";
import { logger } from "../logger";

interface PendingChat {
  status: "pending" | "completed";
  replies: string[];
  statusText?: string;
  sseControllers: ReadableStreamDefaultController[];
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class HttpApiAdapter implements EventAdapter {
  private port: number;
  private apiKey: string;
  private trace: TraceStore;
  private queue: TaskQueue | null;
  private sessions: SessionStore | null;
  private server?: ReturnType<typeof Bun.serve>;
  private onEvent?: (event: IncomingEvent) => void;
  private onMessage?: (msg: IncomingMessage) => void;
  private chats = new Map<string, PendingChat>();
  private webUiHtml: string;
  private traceUiHtml: string;
  private statusUiHtml: string;
  private publicDir: string;
  private chatAdapters: ChatAdapter[] = [];
  private eventAdapters: EventAdapter[] = [];
  private startedAt?: string;

  private hostname: string;

  constructor(port: number, apiKey: string, trace: TraceStore, queue?: TaskQueue, sessions?: SessionStore, hostname?: string) {
    this.port = port;
    this.apiKey = apiKey;
    this.hostname = hostname || "0.0.0.0";
    this.trace = trace;
    this.queue = queue || null;
    this.sessions = sessions || null;
    const publicDir = resolve(import.meta.dir, "../../public");
    this.publicDir = publicDir;
    try {
      this.webUiHtml = readFileSync(join(publicDir, "index.html"), "utf-8");
    } catch {
      this.webUiHtml = "<html><body><p>Web UI not found. Place public/index.html in project root.</p></body></html>";
    }
    try {
      this.traceUiHtml = readFileSync(join(publicDir, "trace.html"), "utf-8");
    } catch {
      this.traceUiHtml = "<html><body><p>Trace viewer not found. Place public/trace.html in project root.</p></body></html>";
    }
    try {
      this.statusUiHtml = readFileSync(join(publicDir, "status.html"), "utf-8");
    } catch {
      this.statusUiHtml = "<html><body><p>Status page not found. Place public/status.html in project root.</p></body></html>";
    }
  }

  /** Set the chat message handler so web UI messages go through the full chat pipeline */
  setMessageHandler(handler: (msg: IncomingMessage) => void): void {
    this.onMessage = handler;
  }

  /** Register all adapters so the status page can query them */
  setAdapters(chat: ChatAdapter[], event: EventAdapter[]): void {
    this.chatAdapters = chat;
    this.eventAdapters = event;
  }

  getStatus(): AdapterStatus {
    return {
      name: "http",
      type: "event",
      status: this.server ? "connected" : "disconnected",
      startedAt: this.startedAt,
      details: { port: this.port },
    };
  }

  async start(onEvent: (event: IncomingEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    const self = this;

    this.server = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      idleTimeout: 255, // SSE connections need to stay open for long-running tasks
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;

        // Web UI — no auth required
        if (path === "/" || path === "/index.html") {
          return new Response(self.webUiHtml, {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (path === "/trace" || path === "/trace.html") {
          return new Response(self.traceUiHtml, {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (path === "/status" || path === "/status.html") {
          return new Response(self.statusUiHtml, {
            headers: { "Content-Type": "text/html" },
          });
        }

        // Auth check for API routes
        if (path.startsWith("/api/")) {
          const key = req.headers.get("X-API-Key") || url.searchParams.get("key");
          if (!key || !safeEqual(key, self.apiKey)) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
        }

        // GET /api/status — adapter health + queue stats
        if (path === "/api/status" && req.method === "GET") {
          const adapterStatuses: AdapterStatus[] = [];
          for (const a of self.chatAdapters) {
            adapterStatuses.push(a.getStatus?.() ?? { name: a.constructor.name, type: "chat", status: "unknown" });
          }
          for (const a of self.eventAdapters) {
            adapterStatuses.push(a.getStatus?.() ?? { name: a.constructor.name, type: "event", status: "unknown" });
          }
          const queueStats = self.queue?.stats() ?? { pending: 0, running: 0, completed: 0, failed: 0 };
          return Response.json({
            adapters: adapterStatuses,
            queue: queueStats,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          });
        }

        // GET /api/tasks — list recent tasks
        if (path === "/api/tasks" && req.method === "GET") {
          if (!self.queue) {
            return Response.json({ error: "Task queue not available" }, { status: 503 });
          }
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100);
          const status = url.searchParams.get("status") || undefined;
          const tasks = self.queue.listRecent(limit, status);
          return Response.json(tasks.map((t) => ({
            id: t.id,
            userId: t.userId,
            repo: t.repo,
            prompt: t.prompt,
            status: t.status,
            result: t.result && t.result.length > 300 ? t.result.slice(0, 300) + "..." : t.result,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
          })));
        }

        // POST /api/message — submit a chat message (full chat pipeline)
        if (path === "/api/message" && req.method === "POST") {
          let body: { text: string };
          try {
            body = await req.json() as { text: string };
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }
          if (!body || typeof body.text !== "string" || body.text.trim().length === 0) {
            return Response.json({ error: "Missing or invalid 'text' field" }, { status: 400 });
          }
          if (body.text.length > 50000) {
            return Response.json({ error: "Message too long (max 50000 chars)" }, { status: 400 });
          }
          const chatId = crypto.randomUUID();
          const userId = "http:web";

          const chat: PendingChat = { status: "pending", replies: [], sseControllers: [] };
          self.chats.set(chatId, chat);

          function notifySSE(data: object) {
            const payload = JSON.stringify(data);
            for (const ctrl of chat.sseControllers) {
              try { ctrl.enqueue(`data: ${payload}\n\n`); } catch {}
            }
          }

          if (self.onMessage) {
            // Route through full chat handler (commands, session, repo resolution, etc.)
            let closeTimer: ReturnType<typeof setTimeout> | null = null;
            const msg: IncomingMessage = {
              userId,
              platform: "http",
              text: body.text,
              reply: async (text: string) => {
                chat.replies.push(text);
                chat.status = "completed";
                notifySSE({ status: "completed", result: chat.replies.join("\n\n") });
                // Delay closing SSE to allow multiple split replies to arrive
                if (closeTimer) clearTimeout(closeTimer);
                closeTimer = setTimeout(() => {
                  for (const ctrl of chat.sseControllers) {
                    try { ctrl.close(); } catch {}
                  }
                  chat.sseControllers = [];
                  setTimeout(() => self.chats.delete(chatId), 5 * 60 * 1000);
                }, 500);
              },
              updateStatus: async (text: string) => {
                chat.statusText = text;
                notifySSE({ status: "pending", statusText: text });
              },
            };
            self.onMessage(msg);
          } else {
            // Fallback to event handler
            const event: IncomingEvent = {
              eventId: chatId,
              userId,
              platform: "http",
              source: { type: "http", requestId: chatId },
              text: body.text,
            };
            self.onEvent?.(event);
          }

          return Response.json({ eventId: chatId }, { status: 202 });
        }

        // GET /api/message/:id/stream — SSE stream
        const streamMatch = path.match(/^\/api\/message\/([^/]+)\/stream$/);
        if (streamMatch && req.method === "GET") {
          const chatId = streamMatch[1];
          const chat = self.chats.get(chatId);
          if (!chat) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }

          let sseController: ReadableStreamDefaultController;
          const stream = new ReadableStream({
            start(controller) {
              sseController = controller;
              chat.sseControllers.push(controller);
              // Send current state immediately
              const data = JSON.stringify({
                status: chat.status,
                result: chat.replies.length > 0 ? chat.replies.join("\n\n") : undefined,
                statusText: chat.statusText,
              });
              controller.enqueue(`data: ${data}\n\n`);
            },
            cancel() {
              const idx = chat.sseControllers.indexOf(sseController);
              if (idx >= 0) chat.sseControllers.splice(idx, 1);
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        // GET /api/message/:id — poll status
        const getMatch = path.match(/^\/api\/message\/([^/]+)$/);
        if (getMatch && req.method === "GET") {
          const chatId = getMatch[1];
          const chat = self.chats.get(chatId);
          if (!chat) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({
            status: chat.status,
            result: chat.replies.length > 0 ? chat.replies.join("\n\n") : undefined,
          });
        }

        // GET /api/trace/:taskId — trace events for a task
        const traceMatch = path.match(/^\/api\/trace\/([^/]+)$/);
        if (traceMatch && req.method === "GET") {
          const taskId = traceMatch[1];
          const events = self.trace.getByTask(taskId);
          return Response.json(events);
        }

        // GET /api/history/:userId — chat history for a user
        const historyMatch = path.match(/^\/api\/history\/([^/]+)$/);
        if (historyMatch && req.method === "GET") {
          if (!self.sessions) {
            return Response.json({ error: "Sessions not available" }, { status: 503 });
          }
          const userId = decodeURIComponent(historyMatch[1]);
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "50") || 50, 200);
          const history = self.sessions.getHistory(userId, limit);
          return Response.json(history);
        }

        // Static files from public/
        const MIME: Record<string, string> = { ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".css": "text/css", ".js": "application/javascript" };
        const ext = extname(path);
        if (ext && MIME[ext]) {
          const filePath = resolve(self.publicDir, "." + path);
          if (!filePath.startsWith(self.publicDir + "/")) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          if (existsSync(filePath)) {
            const data = readFileSync(filePath);
            return new Response(data, { headers: { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=3600" } });
          }
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    this.startedAt = new Date().toISOString();
    logger.info("http api adapter started", { port: this.port });
  }

  async stop(): Promise<void> {
    this.server?.stop();
    logger.info("http api adapter stopped");
  }

  async respondToEvent(eventId: string, text: string): Promise<void> {
    const chat = this.chats.get(eventId);
    if (!chat) return;

    chat.status = "completed";
    chat.replies.push(text);

    // Notify SSE listeners
    const data = JSON.stringify({ status: "completed", result: chat.replies.join("\n\n") });
    for (const controller of chat.sseControllers) {
      try {
        controller.enqueue(`data: ${data}\n\n`);
        controller.close();
      } catch (err) {
        logger.debug("sse enqueue failed", { eventId, error: String(err) });
      }
    }
    chat.sseControllers = [];

    // Clean up after 5 minutes
    setTimeout(() => this.chats.delete(eventId), 5 * 60 * 1000);
  }

  /** Called by index.ts to push status updates to SSE clients */
  updateEventStatus(eventId: string, statusText: string): void {
    const chat = this.chats.get(eventId);
    if (!chat) return;
    chat.statusText = statusText;

    const data = JSON.stringify({ status: "pending", statusText });
    for (const controller of chat.sseControllers) {
      try {
        controller.enqueue(`data: ${data}\n\n`);
      } catch (err) {
        logger.debug("sse status update failed", { eventId, error: String(err) });
      }
    }
  }
}
