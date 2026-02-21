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

      const doUpdate = debounce(async (statusText: string) => {
        try {
          if (statusMsgId) {
            await ctx.api.editMessageText(chatId, statusMsgId, statusText);
          } else {
            const sent = await ctx.reply(statusText);
            statusMsgId = sent.message_id;
          }
        } catch {
          const sent = await ctx.reply(statusText);
          statusMsgId = sent.message_id;
        }
      }, 3000);

      const msg: IncomingMessage = {
        userId,
        platform: "telegram",
        text,
        reply: async (replyText: string) => {
          await ctx.reply(replyText);
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
    await this.bot.api.sendMessage(Number(chatId), text);
  }
}
