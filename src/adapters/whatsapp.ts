// src/adapters/whatsapp.ts
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "baileys";
import type { ChatAdapter, IncomingMessage } from "./types";
import { logger } from "../logger";

export class WhatsAppAdapter implements ChatAdapter {
  private sock: WASocket | null = null;
  private onMessage?: (msg: IncomingMessage) => void;
  private authDir: string;

  constructor(authDir: string = "./auth/whatsapp") {
    this.authDir = authDir;
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          logger.warn("whatsapp disconnected, reconnecting...", { statusCode });
          this.start(onMessage);
        } else {
          logger.error("whatsapp logged out");
        }
      } else if (connection === "open") {
        logger.info("whatsapp adapter connected");
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages }) => {
      for (const waMsg of messages) {
        if (!waMsg.message || waMsg.key.fromMe) continue;

        const text =
          waMsg.message.conversation ||
          waMsg.message.extendedTextMessage?.text;
        if (!text) continue;

        const jid = waMsg.key.remoteJid;
        if (!jid) continue;

        const phone = jid.split("@")[0];
        const userId = `whatsapp:${phone}`;

        // Batch status updates: at most once per 10 seconds
        let lastSentAt = 0;
        let pendingStatus: string | null = null;
        let batchTimer: ReturnType<typeof setTimeout> | null = null;

        const flushStatus = async () => {
          if (pendingStatus && this.sock) {
            await this.sock.sendMessage(jid, { text: pendingStatus });
            lastSentAt = Date.now();
            pendingStatus = null;
          }
          batchTimer = null;
        };

        const msg: IncomingMessage = {
          userId,
          platform: "whatsapp",
          text,
          reply: async (replyText: string) => {
            // Flush any pending status before sending final reply
            if (batchTimer) {
              clearTimeout(batchTimer);
              batchTimer = null;
              pendingStatus = null;
            }
            await this.sock?.sendMessage(jid, { text: replyText });
          },
          updateStatus: async (statusText: string) => {
            pendingStatus = statusText;
            const elapsed = Date.now() - lastSentAt;
            if (elapsed >= 10_000) {
              await flushStatus();
            } else if (!batchTimer) {
              batchTimer = setTimeout(flushStatus, 10_000 - elapsed);
            }
          },
        };

        logger.info("whatsapp message received", {
          userId,
          text: text.slice(0, 100),
        });
        this.onMessage?.(msg);
      }
    });
  }

  async stop(): Promise<void> {
    this.sock?.end(undefined);
    this.sock = null;
    logger.info("whatsapp adapter stopped");
  }

  async sendToUser(userId: string, text: string): Promise<void> {
    const phone = userId.replace("whatsapp:", "");
    const jid = `${phone}@s.whatsapp.net`;
    await this.sock?.sendMessage(jid, { text });
  }
}
