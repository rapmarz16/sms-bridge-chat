export type Role = "ADMIN" | "MEMBER";
export type DeliveryMode = "APP" | "SMS" | "BOTH";

export type Member = {
  id: string;
  displayName: string;
  phoneNumberE164?: string;
  role: Role;
  deliveryMode: DeliveryMode;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type Group = {
  id: string;
  name: string;
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

export type Message = {
  id: string;
  groupId: string;
  senderMemberId?: string;
  senderName: string;
  source: "APP" | "SMS" | "SYSTEM";
  body: string;
  replyTo?: { id: string; senderName: string; body: string };
  reactions: Reaction[];
  attachments: Array<{
    id: string;
    url: string;
    originalFilename: string;
    mimeType: string;
    size: number;
  }>;
  createdAt: string;
  deletedAt?: string;
};

export type SmsUsage = {
  used: number;
  limit: number;
  percentage: number;
  warning?: "OK" | "WARNING" | "CRITICAL" | "STOPPED";
};

export type Bootstrap = {
  currentMember: Member;
  group: Group;
  members: Member[];
  messages: Message[];
  smsUsage: SmsUsage;
  pushNotifications: {
    enabled: boolean;
    publicKey?: string;
  };
  imageUploads: {
    enabled: boolean;
    maxBytes: number;
    acceptedTypes: string[];
  };
};

export type SmsDelivery = {
  id: string;
  messageId: string;
  memberId: string;
  memberName: string;
  phoneNumber: string;
  status: string;
  providerStatus?: string;
  providerPartsCount?: number;
  attempts: number;
  lastError?: string;
  updatedAt: string;
};
