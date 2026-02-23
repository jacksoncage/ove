import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventAdapter, IncomingEvent, IncomingMessage } from "./types";
import type { TraceStore } from "../trace";
import type { TaskQueue } from "../queue";
import { logger } from "../logger";

interface PendingChat {
  status: "pending" | "completed";
  replies: string[];
  statusText?: string;
  sseControllers: ReadableStreamDefaultController[];
}

export class HttpApiAdapter implements EventAdapter {
  private port: number;
  private apiKey: string;
  private trace: TraceStore;
  private queue: TaskQueue | null;
  private server?: ReturnType<typeof Bun.serve>;
  private onEvent?: (event: IncomingEvent) => void;
  private onMessage?: (msg: IncomingMessage) => void;
  private chats = new Map<string, PendingChat>();
  private webUiHtml: string;
  private traceUiHtml: string;

  constructor(port: number, apiKey: string, trace: TraceStore, queue?: TaskQueue) {
    this.port = port;
    this.apiKey = apiKey;
    this.trace = trace;
    this.queue = queue || null;
    const publicDir = join(import.meta.dir, "../../public");
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
  }

  /** Set the chat message handler so web UI messages go through the full chat pipeline */
  setMessageHandler(handler: (msg: IncomingMessage) => void): void {
    this.onMessage = handler;
  }

  async start(onEvent: (event: IncomingEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    const self = this;

    this.server = Bun.serve({
      port: this.port,
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

        // Auth check for API routes
        if (path.startsWith("/api/")) {
          const key = req.headers.get("X-API-Key") || url.searchParams.get("key");
          if (key !== self.apiKey) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
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
          const body = await req.json() as { text: string; userId?: string };
          const chatId = crypto.randomUUID();
          const userId = body.userId || "http:web";

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

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

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
