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
  private phoneNumber?: string;
  private allowedChats: Set<string>;
  private reconnectAttempt = 0;
  private sentByBot = new Set<string>();

  constructor(opts: { authDir?: string; phoneNumber?: string; allowedChats?: string[] } = {}) {
    this.authDir = opts.authDir ?? "./auth/whatsapp";
    this.phoneNumber = opts.phoneNumber;
    this.allowedChats = new Set(opts.allowedChats ?? []);
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
    });

    this.sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;

    this.sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      // Request pairing code when server is ready (sends qr event)
      if (qr && this.phoneNumber && !pairingRequested) {
        pairingRequested = true;
        try {
          const phone = this.phoneNumber.replace(/[^0-9]/g, "");
          const code = await this.sock!.requestPairingCode(phone);
          logger.info(`whatsapp pairing code: ${code}`, { phone });
          console.log(`\n  WhatsApp pairing code: ${code}`);
          console.log(`  Enter this code on your phone: WhatsApp → Linked Devices → Link a Device\n`);
        } catch (err) {
          logger.error("failed to request pairing code", { error: String(err) });
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          this.reconnectAttempt++;
          const delay = Math.min(2000 * this.reconnectAttempt, 30_000);
          logger.warn("whatsapp disconnected, reconnecting...", { statusCode, delay });
          setTimeout(() => this.start(onMessage), delay);
        } else {
          logger.error("whatsapp logged out");
        }
      } else if (connection === "open") {
        this.reconnectAttempt = 0;
        logger.info("whatsapp adapter connected");
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages }) => {
      for (const waMsg of messages) {
        if (!waMsg.message) continue;

        // Skip messages sent by the bot (replies/status updates)
        const msgId = waMsg.key.id;
        if (msgId && this.sentByBot.has(msgId)) {
          this.sentByBot.delete(msgId);
          continue;
        }

        // Skip messages from others (not our phone) — we only process our own commands
        if (!waMsg.key.fromMe) continue;

        // Only process messages in whitelisted chats (if configured)
        if (this.allowedChats.size > 0) {
          const jid = waMsg.key.remoteJid;
          if (!jid) continue;
          const chatId = jid.split("@")[0];
          if (!this.allowedChats.has(jid) && !this.allowedChats.has(chatId)) continue;
        }

        const text =
          waMsg.message.conversation ||
          waMsg.message.extendedTextMessage?.text;
        if (!text) continue;

        const jid = waMsg.key.remoteJid;
        if (!jid) continue;

        // For fromMe messages, use our configured phone number
        const phone = waMsg.key.fromMe
          ? (this.phoneNumber?.replace(/[^0-9]/g, "") ?? jid.split("@")[0])
          : jid.split("@")[0];
        const userId = `whatsapp:${phone}`;

        // Batch status updates: at most once per 10 seconds
        let lastSentAt = 0;
        let pendingStatus: string | null = null;
        let batchTimer: ReturnType<typeof setTimeout> | null = null;

        const flushStatus = async () => {
          if (pendingStatus && this.sock) {
            const sent = await this.sock.sendMessage(jid, { text: pendingStatus });
            if (sent?.key?.id) this.sentByBot.add(sent.key.id);
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
            const sent = await this.sock?.sendMessage(jid, { text: replyText });
            if (sent?.key?.id) this.sentByBot.add(sent.key.id);
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
    const sent = await this.sock?.sendMessage(jid, { text });
    if (sent?.key?.id) this.sentByBot.add(sent.key.id);
  }
}
