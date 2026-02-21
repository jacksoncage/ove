export interface IncomingMessage {
  userId: string;
  platform: string;
  text: string;
  reply: (text: string) => Promise<void>;
  updateStatus: (text: string) => Promise<void>;
}

export interface ChatAdapter {
  start(onMessage: (msg: IncomingMessage) => void): Promise<void>;
  stop(): Promise<void>;
  sendToUser?(userId: string, text: string): Promise<void>;
}

export type EventSource =
  | { type: "issue"; repo: string; number: number }
  | { type: "pr"; repo: string; number: number }
  | { type: "http"; requestId: string };

export interface IncomingEvent {
  eventId: string;
  userId: string;
  platform: string;
  source: EventSource;
  text: string;
}

export interface EventAdapter {
  start(onEvent: (event: IncomingEvent) => void): Promise<void>;
  stop(): Promise<void>;
  respondToEvent(eventId: string, text: string): Promise<void>;
}
