import { EventEmitter } from "node:events";
import type { ChatMessage, Reaction } from "./domain.js";

export type AppEvents = {
  message: [ChatMessage];
  reaction: [Reaction];
  "reaction:removed": [{ messageId: string; memberId: string; emoji: string }];
};

export class ChatEventBus extends EventEmitter<AppEvents> {}
