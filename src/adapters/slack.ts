// src/adapters/slack.ts
import { App } from "@slack/bolt";
import type { ChatAdapter, IncomingMessage, AdapterStatus } from "./types";
import { logger } from "../logger";
import { debounce } from "./debounce";

export class SlackAdapter implements ChatAdapter {
  private app: App;
  private onMessage?: (msg: IncomingMessage) => void;
  private started = false;
  private startedAt?: string;

  constructor() {
    this.app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    });
  }

  private buildMessage(
    userId: string,
    text: string,
    say: (text: string) => Promise<any>,
    channel: string
  ): IncomingMessage {
    let statusMsgTs: string | undefined;

    const doUpdate = debounce(async (statusText: string) => {
      if (statusMsgTs) {
        try {
          await this.app.client.chat.update({
            channel,
            ts: statusMsgTs,
            text: statusText,
          });
        } catch (err) {
          logger.warn("slack status update failed", { error: String(err) });
          const result = await say(statusText);
          if (result && "ts" in result) statusMsgTs = result.ts;
        }
      } else {
        const result = await say(statusText);
        if (result && "ts" in result) statusMsgTs = result.ts;
      }
    }, 3000);

    return {
      userId,
      platform: "slack",
      text,
      reply: async (replyText: string) => {
        await say(replyText);
      },
      updateStatus: doUpdate,
    };
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;

    // Listen for DMs
    this.app.message(async ({ message, say }) => {
      if (message.subtype) return;
      if (!("text" in message) || !message.text) return;
      if (!("user" in message) || !message.user) return;

      const msg = this.buildMessage(
        `slack:${message.user}`,
        message.text,
        say,
        message.channel
      );
      logger.info("slack message received", { userId: msg.userId, text: message.text.slice(0, 100) });
      this.onMessage?.(msg);
    });

    // Listen for app mentions in channels
    this.app.event("app_mention", async ({ event, say }) => {
      const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      const msg = this.buildMessage(
        `slack:${event.user}`,
        text,
        say,
        event.channel
      );
      logger.info("slack mention received", { userId: msg.userId, text: text.slice(0, 100) });
      this.onMessage?.(msg);
    });

    await this.app.start();
    this.started = true;
    this.startedAt = new Date().toISOString();
    logger.info("slack adapter started");
  }

  getStatus(): AdapterStatus {
    return {
      name: "slack",
      type: "chat",
      status: this.started ? "connected" : "disconnected",
      startedAt: this.startedAt,
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.app.stop();
    logger.info("slack adapter stopped");
  }

  async sendToUser(userId: string, text: string): Promise<void> {
    const slackUserId = userId.replace("slack:", "");
    try {
      const result = await this.app.client.conversations.open({
        users: slackUserId,
      });
      if (result.channel?.id) {
        await this.app.client.chat.postMessage({
          channel: result.channel.id,
          text,
        });
      }
    } catch (err) {
      logger.error("failed to send DM", { userId, error: String(err) });
    }
  }
}
