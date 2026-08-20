import { EventEmitter } from "node:events";
import type { ChatMessage, Reaction } from "./domain.js";

export type AppEvents = {
  message: [ChatMessage];
  "message:deleted": [{ messageId: string; groupId: string; deletedAt: string }];
  reaction: [Reaction];
  "reaction:removed": [{ messageId: string; memberId: string; emoji: string }];
};

export class ChatEventBus extends EventEmitter<AppEvents> {}
