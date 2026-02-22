import { Bot } from "grammy";
import type { ChatAdapter, IncomingMessage } from "./types";
import { logger } from "../logger";

function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as any as T;
}

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
        } catch {
          // Edit may fail if content unchanged or message too old — ignore
        }
      }, 3000);

      const msg: IncomingMessage = {
        userId,
        platform: "telegram",
        text,
        reply: async (replyText: string) => {
          // Replace the status message with the first reply, then send new messages for the rest
          if (statusMsgId) {
            try {
              await ctx.api.editMessageText(chatId, statusMsgId, mdToHtml(replyText), { parse_mode: "HTML" });
              statusMsgId = undefined;
              return;
            } catch {
              // Edit failed (message too old, etc.) — fall through to send new
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
    logger.info("telegram adapter started");
  }

  async stop(): Promise<void> {
    this.bot.stop();
    logger.info("telegram adapter stopped");
  }

  async sendToUser(userId: string, text: string): Promise<void> {
    const chatId = userId.replace("telegram:", "");
    await this.bot.api.sendMessage(Number(chatId), mdToHtml(text), { parse_mode: "HTML" });
  }
}
