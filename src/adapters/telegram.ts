import { Bot } from "grammy";
import type { ChatAdapter, IncomingMessage, AdapterStatus } from "./types";
import { logger } from "../logger";
import { debounce } from "./debounce";

/** Convert simple markdown (*bold*, `code`, ```blocks```) to Telegram HTML */
function mdToHtml(text: string): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return html
    // Code blocks first (```lang\n...\n```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre>$2</pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold **text** or *text*
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
        if (statusText === lastStatusText) return; // skip unchanged text
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
          // Delete status message and send a new one so the user gets a notification
          if (statusMsgId) {
            try {
              await ctx.api.deleteMessage(chatId, statusMsgId);
            } catch (err) {
              logger.debug("telegram status delete failed", { error: String(err) });
            }
            statusMsgId = undefined;
          }
          await ctx.reply(mdToHtml(replyText), { parse_mode: "HTML" });
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
    const chatId = userId.replace("telegram:", "");
    await this.bot.api.sendMessage(Number(chatId), mdToHtml(text), { parse_mode: "HTML" });
  }
}
