export type Role = "ADMIN" | "MEMBER";
export type DeliveryMode = "APP" | "SMS" | "BOTH";
export type MessageSource = "APP" | "SMS" | "SYSTEM";
export type SmsDeliveryStatus =
  | "PENDING"
  | "SENDING"
  | "ACCEPTED"
  | "FAILED"
  | "SKIPPED"
  | "SKIPPED_LIMIT";

export type Member = {
  id: string;
  displayName: string;
  phoneNumberE164?: string;
  role: Role;
  deliveryMode: DeliveryMode;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Group = {
  id: string;
  name: string;
  smsDid?: string;
  smsEnabled: boolean;
  createdAt: string;
};

export type Reaction = {
  id: string;
  messageId: string;
  memberId: string;
  memberName: string;
  emoji: string;
  createdAt: string;
};

export type ReplySummary = {
  id: string;
  senderName: string;
  body: string;
};

export type Attachment = {
  id: string;
  messageId: string;
  type: "IMAGE";
  url: string;
  originalFilename: string;
  mimeType: string;
  size: number;
};

export type ChatMessage = {
  id: string;
  groupId: string;
  senderMemberId?: string;
  senderName: string;
  source: MessageSource;
  body: string;
  replyTo?: ReplySummary;
  reactions: Reaction[];
  attachments: Attachment[];
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
};

export type SmsDelivery = {
  id: string;
  messageId: string;
  memberId: string;
  memberName: string;
  phoneNumber: string;
  provider: string;
  providerMessageId?: string;
  status: SmsDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};
