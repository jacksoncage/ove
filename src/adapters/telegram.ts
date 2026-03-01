import { Bot } from "grammy";
import type { ChatAdapter, IncomingMessage, AdapterStatus } from "./types";
import { logger } from "../logger";
import { debounce } from "./debounce";

const TELEGRAM_LIMIT = 4096;

function splitHtml(html: string): string[] {
  if (html.length <= TELEGRAM_LIMIT) return [html];
  const parts: string[] = [];
  let remaining = html;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_LIMIT) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_LIMIT);
    if (splitAt < TELEGRAM_LIMIT * 0.5) splitAt = TELEGRAM_LIMIT;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return parts;
}

function mdToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre>$2</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<b>$1</b>');
}

export class TelegramAdapter implements ChatAdapter {
  private bot: Bot;
  private onMessage?: (msg: IncomingMessage) => void;
  private started = false;
  private startedAt?: string;

  constructor(token: string) {
    if (!token) throw new Error("Telegram bot token is required");
    this.bot = new Bot(token);
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;

    this.bot.on("message:text", (ctx) => {
      const chatId = ctx.chat.id;
      const userId = `telegram:${ctx.from.id}`;
      const text = ctx.message.text;
      let statusMsgId: number | undefined;
      let lastStatusText: string | undefined;

      const doUpdate = debounce(async (statusText: string) => {
        if (statusText === lastStatusText) return;
        lastStatusText = statusText;
        const html = mdToHtml(statusText);
        try {
          if (statusMsgId) {
            await ctx.api.editMessageText(chatId, statusMsgId, html, { parse_mode: "HTML" });
          } else {
            const sent = await ctx.reply(html, { parse_mode: "HTML" });
            statusMsgId = sent.message_id;
          }
        } catch (err) {
          logger.warn("telegram status update failed", { error: String(err) });
        }
      }, 3000);

      const msg: IncomingMessage = {
        userId,
        platform: "telegram",
        text,
        reply: async (replyText: string) => {
          if (statusMsgId) {
            try {
              await ctx.api.deleteMessage(chatId, statusMsgId);
            } catch (err) {
              logger.debug("telegram status delete failed", { error: String(err) });
            }
            statusMsgId = undefined;
          }
          const html = mdToHtml(replyText);
          for (const chunk of splitHtml(html)) {
            await ctx.reply(chunk, { parse_mode: "HTML" });
          }
        },
        updateStatus: doUpdate,
      };

      logger.info("telegram message received", { userId, text: text.slice(0, 100) });
      this.onMessage?.(msg);
    });

    this.bot.start();
    this.started = true;
    this.startedAt = new Date().toISOString();
    logger.info("telegram adapter started");
  }

  getStatus(): AdapterStatus {
    return {
      name: "telegram",
      type: "chat",
      status: this.started ? "connected" : "disconnected",
      startedAt: this.startedAt,
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.bot.stop();
    logger.info("telegram adapter stopped");
  }

  async sendToUser(userId: string, text: string): Promise<void> {
    const chatId = Number(userId.replace("telegram:", ""));
    const html = mdToHtml(text);
    for (const chunk of splitHtml(html)) {
      await this.bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    }
  }
}
