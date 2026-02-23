import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { ChatAdapter, IncomingMessage } from "./types";
import { logger } from "../logger";
import { debounce } from "./debounce";

export class DiscordAdapter implements ChatAdapter {
  private client: Client;
  private token: string;
  private onMessage?: (msg: IncomingMessage) => void;

  constructor(token: string) {
    if (!token) throw new Error("Discord bot token is required");
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;

    this.client.on("messageCreate", async (discordMsg: Message) => {
      if (discordMsg.author.bot) return;

      // Respond to DMs or @mentions
      const isDM = !discordMsg.guild;
      const isMention = discordMsg.mentions.has(this.client.user!);
      if (!isDM && !isMention) return;

      let text = discordMsg.content;
      if (isMention) {
        text = text.replace(/<@!?\d+>/g, "").trim();
      }
      if (!text) return;

      const userId = `discord:${discordMsg.author.id}`;
      let statusMsg: Message | undefined;

      const doUpdate = debounce(async (statusText: string) => {
        try {
          if (statusMsg) {
            await statusMsg.edit(statusText);
          } else {
            statusMsg = await discordMsg.channel.send(statusText);
          }
        } catch (err) {
          logger.warn("discord status update failed", { error: String(err) });
          statusMsg = await discordMsg.channel.send(statusText);
        }
      }, 3000);

      const msg: IncomingMessage = {
        userId,
        platform: "discord",
        text,
        reply: async (replyText: string) => {
          await discordMsg.channel.send(replyText);
        },
        updateStatus: doUpdate,
      };

      logger.info("discord message received", { userId, text: text.slice(0, 100) });
      this.onMessage?.(msg);
    });

    await this.client.login(this.token);
    logger.info("discord adapter started");
  }

  async stop(): Promise<void> {
    this.client.destroy();
    logger.info("discord adapter stopped");
  }

  async sendToUser(userId: string, text: string): Promise<void> {
    const discordId = userId.replace("discord:", "");
    try {
      const user = await this.client.users.fetch(discordId);
      await user.send(text);
    } catch (err) {
      logger.error("failed to send DM", { userId, error: String(err) });
    }
  }
}
