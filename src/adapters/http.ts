import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventAdapter, IncomingEvent } from "./types";
import type { TraceStore } from "../trace";
import type { TaskQueue } from "../queue";
import { logger } from "../logger";

interface PendingEvent {
  status: "pending" | "completed";
  result?: string;
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
  private events = new Map<string, PendingEvent>();
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

        // POST /api/message — submit a task
        if (path === "/api/message" && req.method === "POST") {
          const body = await req.json() as { text: string; userId?: string };
          const eventId = crypto.randomUUID();
          const userId = body.userId || "http:anon";

          self.events.set(eventId, { status: "pending", sseControllers: [] });

          const event: IncomingEvent = {
            eventId,
            userId,
            platform: "http",
            source: { type: "http", requestId: eventId },
            text: body.text,
          };

          self.onEvent?.(event);
          return Response.json({ eventId }, { status: 202 });
        }

        // GET /api/message/:id/stream — SSE stream
        const streamMatch = path.match(/^\/api\/message\/([^/]+)\/stream$/);
        if (streamMatch && req.method === "GET") {
          const eventId = streamMatch[1];
          const pending = self.events.get(eventId);
          if (!pending) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }

          let sseController: ReadableStreamDefaultController;
          const stream = new ReadableStream({
            start(controller) {
              sseController = controller;
              pending.sseControllers.push(controller);
              // Send current state immediately
              const data = JSON.stringify({
                status: pending.status,
                result: pending.result,
                statusText: pending.statusText,
              });
              controller.enqueue(`data: ${data}\n\n`);
            },
            cancel() {
              const idx = pending.sseControllers.indexOf(sseController);
              if (idx >= 0) pending.sseControllers.splice(idx, 1);
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
          const eventId = getMatch[1];
          const pending = self.events.get(eventId);
          if (!pending) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({
            status: pending.status,
            result: pending.result,
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
    const pending = this.events.get(eventId);
    if (!pending) return;

    pending.status = "completed";
    pending.result = text;

    // Notify SSE listeners
    const data = JSON.stringify({ status: "completed", result: text });
    for (const controller of pending.sseControllers) {
      try {
        controller.enqueue(`data: ${data}\n\n`);
        controller.close();
      } catch (err) {
        logger.debug("sse enqueue failed", { eventId, error: String(err) });
      }
    }
    pending.sseControllers = [];

    // Clean up event after 5 minutes
    setTimeout(() => this.events.delete(eventId), 5 * 60 * 1000);
  }

  /** Called by index.ts to push status updates to SSE clients */
  updateEventStatus(eventId: string, statusText: string): void {
    const pending = this.events.get(eventId);
    if (!pending) return;
    pending.statusText = statusText;

    const data = JSON.stringify({ status: "pending", statusText });
    for (const controller of pending.sseControllers) {
      try {
        controller.enqueue(`data: ${data}\n\n`);
      } catch (err) {
        logger.debug("sse status update failed", { eventId, error: String(err) });
      }
    }
  }
}
