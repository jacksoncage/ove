import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventAdapter, IncomingEvent } from "./types";
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
  private server?: ReturnType<typeof Bun.serve>;
  private onEvent?: (event: IncomingEvent) => void;
  private events = new Map<string, PendingEvent>();
  private webUiHtml: string;

  constructor(port: number, apiKey: string) {
    this.port = port;
    this.apiKey = apiKey;
    try {
      this.webUiHtml = readFileSync(join(import.meta.dir, "../../public/index.html"), "utf-8");
    } catch {
      this.webUiHtml = "<html><body><p>Web UI not found. Place public/index.html in project root.</p></body></html>";
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

        // Auth check for API routes
        if (path.startsWith("/api/")) {
          const key = req.headers.get("X-API-Key") || url.searchParams.get("key");
          if (key !== self.apiKey) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
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

          const stream = new ReadableStream({
            start(controller) {
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
              const idx = pending.sseControllers.indexOf(controller);
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
