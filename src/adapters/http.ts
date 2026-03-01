import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventAdapter, IncomingEvent, IncomingMessage, ChatAdapter, AdapterStatus, EventSource } from "./types";
import { parseMention } from "./github";
import type { TraceStore } from "../trace";
import type { TaskQueue } from "../queue";
import type { SessionStore } from "../sessions";
import { logger } from "../logger";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".css": "text/css",
  ".js": "application/javascript",
};

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

function verifyGitHubSignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

function loadHtml(path: string, fallbackName: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return `<html><body><p>${fallbackName} not found. Place public/${fallbackName} in project root.</p></body></html>`;
  }
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
  private htmlPages: Record<string, string>;
  private publicDir: string;
  private chatAdapters: ChatAdapter[] = [];
  private eventAdapters: EventAdapter[] = [];
  private startedAt?: string;
  private githubWebhookSecret: string;
  private botName: string;
  private runningProcesses: Map<string, { abort: AbortController; task: any }> | null = null;

  private hostname: string;

  /** Register the running processes map so the cancel endpoint can abort running tasks */
  setRunningProcesses(processes: Map<string, { abort: AbortController; task: any }>): void {
    this.runningProcesses = processes;
  }

  constructor(port: number, apiKey: string, trace: TraceStore, queue?: TaskQueue, sessions?: SessionStore, hostname?: string, githubWebhookSecret?: string, botName?: string) {
    this.port = port;
    this.apiKey = apiKey;
    this.hostname = hostname || "0.0.0.0";
    this.trace = trace;
    this.queue = queue || null;
    this.sessions = sessions || null;
    this.githubWebhookSecret = githubWebhookSecret || process.env.GITHUB_WEBHOOK_SECRET || "";
    this.botName = botName || process.env.GITHUB_BOT_NAME || "ove";
    this.publicDir = resolve(import.meta.dir, "../../public");
    this.htmlPages = {
      "/": "index.html",
      "/index.html": "index.html",
      "/trace": "trace.html",
      "/trace.html": "trace.html",
      "/status": "status.html",
      "/status.html": "status.html",
      "/metrics": "metrics.html",
      "/metrics.html": "metrics.html",
    };
    for (const [route, file] of Object.entries(this.htmlPages)) {
      this.htmlPages[route] = loadHtml(join(this.publicDir, file), file);
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

  private collectAdapterStatuses(): AdapterStatus[] {
    const statuses: AdapterStatus[] = [];
    for (const a of this.chatAdapters) {
      statuses.push(a.getStatus?.() ?? { name: a.constructor.name, type: "chat", status: "unknown" });
    }
    for (const a of this.eventAdapters) {
      statuses.push(a.getStatus?.() ?? { name: a.constructor.name, type: "event", status: "unknown" });
    }
    return statuses;
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

        // Web UI pages — no auth required
        const htmlPage = self.htmlPages[path];
        if (htmlPage) {
          return new Response(htmlPage, { headers: { "Content-Type": "text/html" } });
        }

        // POST /api/webhooks/github — GitHub webhook with HMAC-SHA256 signature validation
        if (path === "/api/webhooks/github" && req.method === "POST") {
          if (!self.githubWebhookSecret) {
            return Response.json({ error: "GitHub webhook secret not configured" }, { status: 500 });
          }

          const signature = req.headers.get("X-Hub-Signature-256");
          if (!signature) {
            return Response.json({ error: "Missing signature" }, { status: 401 });
          }

          const rawBody = await req.text();
          if (rawBody.length > 1_048_576) {
            return Response.json({ error: "Payload too large (max 1MB)" }, { status: 413 });
          }
          if (!verifyGitHubSignature(self.githubWebhookSecret, rawBody, signature)) {
            return Response.json({ error: "Invalid signature" }, { status: 401 });
          }

          const githubEvent = req.headers.get("X-GitHub-Event");
          if (githubEvent !== "issue_comment" && githubEvent !== "pull_request_review_comment") {
            return Response.json({ ok: true, skipped: true, reason: `Unsupported event: ${githubEvent}` });
          }

          let payload: any;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }

          // Only process created comments
          if (payload.action !== "created") {
            return Response.json({ ok: true, skipped: true, reason: `Ignored action: ${payload.action}` });
          }

          const comment = payload.comment;
          if (!comment?.body || !comment?.user?.login) {
            return Response.json({ error: "Missing comment data" }, { status: 400 });
          }

          // Skip bot's own comments to prevent infinite loops
          if (comment.user.login === self.botName) {
            return Response.json({ ok: true, skipped: true, reason: "Own comment" });
          }

          const repoFullName = payload.repository?.full_name;
          if (!repoFullName) {
            return Response.json({ error: "Missing repository data" }, { status: 400 });
          }

          // Parse @mention — same logic as github.ts polling adapter
          const text = parseMention(comment.body, self.botName);
          if (!text) {
            return Response.json({ ok: true, skipped: true, reason: "No mention found" });
          }

          const isPR = githubEvent === "pull_request_review_comment" || !!payload.issue?.pull_request;
          const sourceType: "issue" | "pr" = isPR ? "pr" : "issue";
          const number: number = githubEvent === "pull_request_review_comment"
            ? payload.pull_request?.number
            : payload.issue?.number;

          if (!number) {
            return Response.json({ error: "Could not determine issue/PR number" }, { status: 400 });
          }

          const source: EventSource = { type: sourceType, repo: repoFullName, number };
          const eventId = `github:${repoFullName}:${sourceType}:${number}`;

          const event: IncomingEvent = {
            eventId,
            userId: `github:${comment.user.login}`,
            platform: "github",
            source,
            text,
          };

          logger.info("github webhook event received", {
            repo: repoFullName,
            user: comment.user.login,
            event: githubEvent,
            number,
          });

          self.onEvent?.(event);
          return Response.json({ ok: true, eventId });
        }

        // Auth check for API routes
        if (path.startsWith("/api/")) {
          const key = req.headers.get("X-API-Key") || url.searchParams.get("key");
          if (!key || !safeEqual(key, self.apiKey)) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
        }

        // POST /api/webhooks/generic — generic webhook with API key auth
        if (path === "/api/webhooks/generic" && req.method === "POST") {
          let body: { repo: string; text: string; userId?: string };
          try {
            const rawBody = await req.text();
            if (rawBody.length > 1_048_576) {
              return Response.json({ error: "Payload too large (max 1MB)" }, { status: 413 });
            }
            body = JSON.parse(rawBody) as { repo: string; text: string; userId?: string };
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
          }

          if (!body || typeof body.repo !== "string" || !body.repo.trim()) {
            return Response.json({ error: "Missing or invalid 'repo' field" }, { status: 400 });
          }
          if (typeof body.text !== "string" || !body.text.trim()) {
            return Response.json({ error: "Missing or invalid 'text' field" }, { status: 400 });
          }

          const userId = (body.userId && typeof body.userId === "string") ? body.userId : "webhook:generic";
          const eventId = `webhook:${crypto.randomUUID()}`;

          const source: EventSource = { type: "http", requestId: eventId, repo: body.repo.trim() };
          const event: IncomingEvent = {
            eventId,
            userId,
            platform: "webhook",
            source,
            text: body.text.trim(),
          };

          logger.info("generic webhook event received", {
            repo: body.repo,
            userId,
            textLength: body.text.length,
          });

          self.onEvent?.(event);
          return Response.json({ ok: true, eventId }, { status: 202 });
        }

        // GET /api/status — adapter health + queue stats
        if (path === "/api/status" && req.method === "GET") {
          const queueStats = self.queue?.stats() ?? { pending: 0, running: 0, completed: 0, failed: 0 };
          return Response.json({
            adapters: self.collectAdapterStatuses(),
            queue: queueStats,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          });
        }

        // GET /api/metrics — aggregated metrics
        if (path === "/api/metrics" && req.method === "GET") {
          if (!self.queue) {
            return Response.json({ error: "Task queue not available" }, { status: 503 });
          }
          return Response.json({
            ...self.queue.metrics(),
            adapters: self.collectAdapterStatuses(),
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
            priority: t.priority,
            result: t.result && t.result.length > 300 ? t.result.slice(0, 300) + "..." : t.result,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
          })));
        }

        // POST /api/tasks/:id/cancel — cancel a running or pending task
        const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
        if (cancelMatch && req.method === "POST") {
          if (!self.queue) {
            return Response.json({ error: "Task queue not available" }, { status: 503 });
          }
          const taskId = cancelMatch[1];
          const task = self.queue.get(taskId);
          if (!task) {
            return Response.json({ error: "Task not found" }, { status: 404 });
          }
          if (task.status !== "running" && task.status !== "pending") {
            return Response.json({ error: "Task is not cancellable", status: task.status }, { status: 409 });
          }

          if (task.status === "running") {
            self.runningProcesses?.get(taskId)?.abort.abort();
          }

          self.queue.cancel(taskId);
          return Response.json({ ok: true, taskId: task.id, cancelled: true });
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

          if (self.onMessage) {
            let closeTimer: ReturnType<typeof setTimeout> | null = null;
            const msg: IncomingMessage = {
              userId,
              platform: "http",
              text: body.text,
              reply: async (text: string) => {
                chat.replies.push(text);
                chat.status = "completed";
                self.broadcastSSE(chat, { status: "completed", result: chat.replies.join("\n\n") });
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
                self.broadcastSSE(chat, { status: "pending", statusText: text });
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

  private broadcastSSE(chat: PendingChat, data: object): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const controller of chat.sseControllers) {
      try { controller.enqueue(payload); } catch {}
    }
  }

  async respondToEvent(eventId: string, text: string): Promise<void> {
    const chat = this.chats.get(eventId);
    if (!chat) return;

    chat.status = "completed";
    chat.replies.push(text);
    this.broadcastSSE(chat, { status: "completed", result: chat.replies.join("\n\n") });

    for (const controller of chat.sseControllers) {
      try { controller.close(); } catch {}
    }
    chat.sseControllers = [];
    setTimeout(() => this.chats.delete(eventId), 5 * 60 * 1000);
  }

  updateEventStatus(eventId: string, statusText: string): void {
    const chat = this.chats.get(eventId);
    if (!chat) return;
    chat.statusText = statusText;
    this.broadcastSSE(chat, { status: "pending", statusText });
  }
}
