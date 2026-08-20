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

export type AttachmentInput = {
  id: string;
  type: "IMAGE";
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  providerUrl?: string;
};

export type StoredAttachment = AttachmentInput & {
  messageId: string;
  groupId: string;
  deleted: boolean;
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
  providerStatus?: string;
  providerPartsCount?: number;
  status: SmsDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SmsGatewayHealth = {
  provider: string;
  deviceId: string;
  status: "pass" | "warn" | "fail" | "unknown";
  version?: string;
  batteryLevel?: number;
  charging?: boolean;
  connectionAvailable?: boolean;
  cellularType?: number;
  carrierName?: string;
  lastEventAt: string;
  lastPingAt?: string;
  lastAppStartedAt?: string;
  updatedAt: string;
};

export type PushSubscriptionRecord = {
  id: string;
  memberId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: number;
  failureCount: number;
  lastSuccessAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SecurityEvent = {
  id: string;
  eventType: string;
  maskedPhone?: string;
  details?: Record<string, unknown>;
  createdAt: string;
};
