import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { io, type Socket } from "socket.io-client";
import { api, ApiError } from "./api";
import { disableWebPush, enableWebPush, supportsWebPush, syncWebPush, webPushIsEnabled, type PushConfiguration } from "./push";
import type { Bootstrap, Member, Message, Reaction, SmsDelivery, SmsUsage } from "./types";

const REACTIONS = ["👍", "❤️", "😂", "😮"] as const;
const COMMON_EMOJIS = ["😀", "😂", "😍", "🥰", "👍", "👏", "🙏", "🎉", "❤️", "🔥", "✅", "😮", "😢", "🤔", "🙌", "💯"] as const;

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(date);
}

function truncate(value: string, length = 90): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Copy is unavailable in this browser");
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss error">×</button>
    </div>
  );
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [phone, setPhone] = useState("");
  const [challengeId, setChallengeId] = useState<string>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submitPhone(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await api<{ challengeId: string }>("/api/auth/request-otp", {
        method: "POST", body: JSON.stringify({ phone })
      });
      setChallengeId(result.challengeId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send a code");
    } finally { setBusy(false); }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!challengeId) return;
    setBusy(true); setError("");
    try {
      await api("/api/auth/verify-otp", {
        method: "POST", body: JSON.stringify({ challengeId, code })
      });
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not verify that code");
    } finally { setBusy(false); }
  }

  return (
    <main className="login-page">
      <section className="login-brand" aria-label="SMS Bridge Chat introduction">
        <div className="brand-mark" aria-hidden="true"><span>↔</span></div>
        <p className="eyebrow">Private by invitation</p>
        <h1>Everyone’s in the chat.</h1>
        <p className="login-subtitle">A modern family conversation that still works for anyone who only has text messaging.</p>
        <div className="transport-line" aria-hidden="true">
          <span>APP</span><i /><b>SMS Bridge</b><i /><span>SMS</span>
        </div>
      </section>
      <section className="login-card">
        {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
        {!challengeId ? (
          <form onSubmit={submitPhone}>
            <p className="step-count">Step 1 of 2</p>
            <h2>Welcome back</h2>
            <p>Enter the mobile number your group administrator added.</p>
            <label htmlFor="phone">Mobile number</label>
            <input id="phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="(416) 555-0123" value={phone} onChange={(event) => setPhone(event.target.value)} required autoFocus />
            <button className="primary-button" disabled={busy}>{busy ? "Sending…" : "Text me a code"}</button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <p className="step-count">Step 2 of 2</p>
            <h2>Check your messages</h2>
            <p>Enter the six-digit code sent to <strong>{phone}</strong>.</p>
            <label htmlFor="code">Verification code</label>
            <input id="code" className="otp-input" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required autoFocus />
            <button className="primary-button" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Open the chat"}</button>
            <button type="button" className="text-button" onClick={() => { setChallengeId(undefined); setCode(""); }}>Use a different number</button>
          </form>
        )}
        <p className="login-footnote">No password to remember. Access is limited to numbers already in this private group.</p>
      </section>
    </main>
  );
}

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml>{children}</ReactMarkdown>;
}

function MessageItem({
  message,
  currentMember,
  previous,
  onReply,
  onReact,
  onDelete,
  onCopy
}: {
  message: Message;
  currentMember: Member;
  previous?: Message;
  onReply: (message: Message) => void;
  onReact: (message: Message, emoji: string, remove: boolean) => void;
  onDelete: (message: Message) => void;
  onCopy: (message: Message) => void;
}) {
  const mine = message.senderMemberId === currentMember.id;
  const canDelete = !message.deletedAt && (currentMember.role === "ADMIN" || (mine && message.source === "APP"));
  const continuation = Boolean(previous) && previous!.senderMemberId === message.senderMemberId &&
    new Date(message.createdAt).getTime() - new Date(previous!.createdAt).getTime() < 5 * 60_000;
  const grouped = useMemo(() => REACTIONS.map((emoji) => ({
    emoji,
    items: message.reactions.filter((reaction) => reaction.emoji === emoji)
  })).filter((group) => group.items.length > 0), [message.reactions]);

  return (
    <article id={`message-${message.id}`} className={`message-row ${mine ? "mine" : "theirs"} ${continuation ? "continuation" : ""}`}>
      {!mine && !continuation && <div className="avatar" aria-hidden="true">{initials(message.senderName)}</div>}
      <div className="message-column">
        {!continuation && (
          <div className="message-meta">
            <strong>{mine ? "You" : message.senderName}</strong>
            {message.source === "SMS" && <span className="source-pill">via SMS</span>}
            <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
          </div>
        )}
        <div className="bubble-wrap">
          <div className={`message-bubble ${message.deletedAt ? "deleted" : ""}`}>
            {message.replyTo && (
              <button className="reply-context" type="button" title="Original message">
                <strong>{message.replyTo.senderName}</strong>
                <span>{truncate(message.replyTo.body)}</span>
              </button>
            )}
            {(message.deletedAt || message.body) && <div className="message-body">{message.deletedAt ? <em>Message removed</em> : <Markdown>{message.body}</Markdown>}</div>}
            {message.attachments.map((attachment) => (
              <a key={attachment.id} className="message-image-link" href={attachment.url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.originalFilename}`}>
                <img className="message-image" src={attachment.url} alt={attachment.originalFilename} loading="lazy" />
              </a>
            ))}
          </div>
          {!message.deletedAt && (
            <div className="message-actions" aria-label={`Actions for ${message.senderName}'s message`}>
              <button type="button" onClick={() => onReply(message)} aria-label={`Reply to ${message.senderName}`} title="Reply"><span aria-hidden="true">↩</span></button>
              <details>
                <summary aria-label="Add a reaction" title="React"><span aria-hidden="true">☺</span></summary>
                <div className="reaction-menu">
                  {REACTIONS.map((emoji) => {
                    const mineReaction = message.reactions.some((reaction) => reaction.emoji === emoji && reaction.memberId === currentMember.id);
                    return <button type="button" key={emoji} className={mineReaction ? "selected" : ""} aria-label={`${mineReaction ? "Remove" : "Add"} ${emoji} reaction`} onClick={(event) => { onReact(message, emoji, mineReaction); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{emoji}</button>;
                  })}
                </div>
              </details>
              <button type="button" onClick={() => onCopy(message)} aria-label="Copy message" title="Copy"><span aria-hidden="true">⧉</span></button>
              {canDelete && <button type="button" className="delete-message" onClick={() => onDelete(message)} aria-label={`Delete message from ${message.senderName}`} title="Delete message"><span aria-hidden="true">⌫</span></button>}
            </div>
          )}
        </div>
        {grouped.length > 0 && (
          <div className="reaction-row">
            {grouped.map((group) => {
              const mineReaction = group.items.some((reaction) => reaction.memberId === currentMember.id);
              return (
                <button type="button" key={group.emoji} className={mineReaction ? "selected" : ""} title={group.items.map((item) => item.memberName).join(", ")} onClick={() => onReact(message, group.emoji, mineReaction)}>
                  {group.emoji} <span>{group.items.length}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}

function MembersPanel({ members }: { members: Member[] }) {
  return (
    <div className="panel-section">
      <div className="section-heading"><div><p className="eyebrow">{members.length} active</p><h3>Group members</h3></div></div>
      <div className="member-list">
        {members.map((member) => (
          <div className="member-row" key={member.id}>
            <div className="avatar">{initials(member.displayName)}</div>
            <div><strong>{member.displayName}</strong><span>{member.role === "ADMIN" ? "Administrator" : "Member"}</span></div>
            <span className={`mode-pill mode-${member.deliveryMode.toLowerCase()}`}>{member.deliveryMode}</span>
          </div>
        ))}
      </div>
      <p className="privacy-note">Phone numbers are only visible to group administrators.</p>
    </div>
  );
}

type AdminStatus = {
  usage: SmsUsage;
  failures: SmsDelivery[];
  recentEvents: Array<{
    id: string;
    eventType: string;
    maskedPhone?: string;
    details?: Record<string, unknown>;
    createdAt: string;
  }>;
  bridge: { configured: boolean; enabled: boolean; provider: "voipms" | "android_gateway"; providerParametersVerified: boolean };
  gateway?: {
    status: "pass" | "warn" | "fail" | "stale" | "unknown";
    stale: boolean;
    version?: string;
    batteryLevel?: number;
    charging?: boolean;
    connectionAvailable?: boolean;
    cellularType?: number;
    carrierName?: string;
    lastSeenAt?: string;
    lastPingAt?: string;
    lastAppStartedAt?: string;
  };
};

function smsEventDescription(event: AdminStatus["recentEvents"][number]): string {
  const labels: Record<string, string> = {
    ANDROID_SMS_ACCEPTED: "Inbound SMS added to the chat",
    ANDROID_SMS_DUPLICATE: "Duplicate inbound SMS safely ignored",
    ANDROID_WEBHOOK_AUTH_FAILED: "Gateway callback signature rejected",
    ANDROID_WEBHOOK_WRONG_DEVICE: "Callback ignored from an unexpected device",
    ANDROID_WEBHOOK_WRONG_SIM: "Callback ignored from an unexpected SIM",
    ANDROID_SMS_MISSING_SENDER: "Inbound SMS did not include a sender number",
    ANDROID_CONFIGURED_SIM_MISSING: "Configured SIM was not found on the phone",
    ANDROID_SIM_NUMBER_MISMATCH: "Gateway SIM phone number does not match configuration",
    SMS_UNKNOWN_NUMBER: "Inbound SMS ignored because the sender is not an active member",
    SMS_INVALID_SENDER: "Inbound SMS sender number could not be normalized",
    SMS_INVALID_MESSAGE: "Inbound SMS was empty or exceeded the message limit",
    SMS_BRIDGE_DISABLED: "Inbound SMS ignored because the bridge is paused",
    WEBHOOK_WRONG_DID: "Inbound SMS targeted a different gateway number"
  };
  return `${labels[event.eventType] ?? event.eventType.replaceAll("_", " ").toLowerCase()}${event.maskedPhone ? ` · ${event.maskedPhone}` : ""}`;
}

function gatewaySummary(gateway: NonNullable<AdminStatus["gateway"]>): string {
  const details: string[] = [];
  if (gateway.batteryLevel != null) details.push(`${Math.round(gateway.batteryLevel)}% battery${gateway.charging ? ", connected to power" : ""}`);
  if (gateway.connectionAvailable === false) details.push("network unavailable");
  if (gateway.lastSeenAt) {
    details.push(`last check-in ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(gateway.lastSeenAt))}`);
  }
  return details.length > 0 ? details.join(" · ") : "Waiting for the phone's first signed heartbeat.";
}

function AdminPanel({ bootstrap, onChanged }: { bootstrap: Bootstrap; onChanged: () => Promise<void> }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [status, setStatus] = useState<AdminStatus>();
  const [editing, setEditing] = useState<Member>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [memberResult, smsResult] = await Promise.all([
        api<{ members: Member[] }>("/api/admin/members"),
        api<AdminStatus>("/api/admin/sms")
      ]);
      setMembers(memberResult.members); setStatus(smsResult);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load administration"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      displayName: String(form.get("displayName") ?? ""),
      phoneNumber: String(form.get("phoneNumber") ?? ""),
      role: String(form.get("role") ?? "MEMBER"),
      deliveryMode: String(form.get("deliveryMode") ?? "APP")
    };
    try {
      await api(editing ? `/api/admin/members/${editing.id}` : "/api/admin/members", {
        method: editing ? "PATCH" : "POST", body: JSON.stringify(payload)
      });
      setEditing(undefined); setAdding(false); await load(); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save member"); }
    finally { setBusy(false); }
  }

  async function setActive(member: Member, active: boolean) {
    if (!active && !window.confirm(`Deactivate ${member.displayName}? They will be signed out and their SMS will no longer enter the group.`)) return;
    try {
      await api(`/api/admin/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      await load(); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update member"); }
  }

  async function toggleBridge() {
    if (!status) return;
    try {
      await api("/api/admin/group/sms", { method: "PATCH", body: JSON.stringify({ enabled: !status.bridge.enabled }) });
      await load(); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not change the SMS bridge"); }
  }

  return (
    <div className="panel-section admin-panel">
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
      <div className="section-heading">
        <div><p className="eyebrow">Controls</p><h3>Administration</h3></div>
        <button className="small-button" type="button" onClick={() => { setAdding(true); setEditing(undefined); }}>+ Add member</button>
      </div>
      {status && (
        <section className={`usage-card ${status.usage.percentage >= 95 ? "danger" : status.usage.percentage >= 80 ? "warning" : ""}`}>
          <div className="usage-top"><div><span>SMS today</span><strong>{status.usage.used} <small>/ {status.usage.limit}</small></strong></div><button type="button" className={`switch ${status.bridge.enabled ? "on" : ""}`} onClick={toggleBridge} aria-pressed={status.bridge.enabled}><i /></button></div>
          <div className="meter"><i style={{ width: `${Math.min(100, status.usage.percentage)}%` }} /></div>
          <p>{!status.bridge.configured ? "Provider credentials are not enabled." : !status.bridge.providerParametersVerified ? "Provider parameters still need portal verification." : status.bridge.enabled ? "Bridge is accepting inbound messages and sending queued deliveries." : "Bridge paused. Canonical chat continues normally."}</p>
        </section>
      )}
      {status?.gateway && (
        <section className={`gateway-card gateway-${status.gateway.status}`}>
          <div className="gateway-top">
            <div><span>Android SMS gateway</span><strong>{status.gateway.carrierName ?? "SIM phone"}</strong></div>
            <b>{status.gateway.status}</b>
          </div>
          <p>{gatewaySummary(status.gateway)}</p>
        </section>
      )}
      <div className="admin-member-list">
        {members.map((member) => (
          <div className={`admin-member ${!member.active ? "inactive" : ""}`} key={member.id}>
            <div className="avatar">{initials(member.displayName)}</div>
            <div className="admin-member-copy"><strong>{member.displayName}</strong><span>{member.phoneNumberE164} · {member.deliveryMode}</span></div>
            <button className="icon-button" type="button" onClick={() => { setEditing(member); setAdding(false); }} aria-label={`Edit ${member.displayName}`}>✎</button>
            <button className="icon-button" type="button" onClick={() => void setActive(member, !member.active)} aria-label={member.active ? `Deactivate ${member.displayName}` : `Reactivate ${member.displayName}`}>{member.active ? "○" : "↺"}</button>
          </div>
        ))}
      </div>
      {status && status.failures.length > 0 && (
        <section className="failure-list">
          <h4>Recent delivery failures</h4>
          {status.failures.map((failure) => (
            <div key={failure.id}><div><strong>{failure.memberName}</strong><span>{failure.lastError ?? failure.status}</span></div><button type="button" onClick={async () => { await api(`/api/admin/sms/${failure.id}/retry`, { method: "POST" }); await load(); }}>Retry</button></div>
          ))}
        </section>
      )}
      {status && status.recentEvents.length > 0 && (
        <section className="event-list">
          <h4>Recent inbound diagnostics</h4>
          {status.recentEvents.slice(0, 10).map((event) => (
            <div key={event.id}>
              <span>{smsEventDescription(event)}</span>
              <time dateTime={event.createdAt}>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(event.createdAt))}</time>
            </div>
          ))}
        </section>
      )}
      {(adding || editing) && (
        <div className="inline-dialog">
          <form onSubmit={saveMember}>
            <div className="dialog-heading"><h4>{editing ? "Edit member" : "Add member"}</h4><button type="button" onClick={() => { setEditing(undefined); setAdding(false); }}>×</button></div>
            <label>Name<input name="displayName" defaultValue={editing?.displayName} required maxLength={80} /></label>
            <label>Mobile number<input name="phoneNumber" type="tel" defaultValue={editing?.phoneNumberE164} required /></label>
            <div className="field-grid">
              <label>Access<select name="role" defaultValue={editing?.role ?? "MEMBER"}><option value="MEMBER">Member</option><option value="ADMIN">Administrator</option></select></label>
              <label>Delivery<select name="deliveryMode" defaultValue={editing?.deliveryMode ?? "APP"}><option value="APP">App only</option><option value="SMS">SMS only</option><option value="BOTH">App + SMS</option></select></label>
            </div>
            <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save member"}</button>
          </form>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ member, pushConfiguration, onLogout }: { member: Member; pushConfiguration: PushConfiguration; onLogout: () => void }) {
  const [notifications, setNotifications] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notificationError, setNotificationError] = useState("");

  useEffect(() => {
    localStorage.removeItem("bridge-notifications");
    if (!pushConfiguration.enabled || !supportsWebPush()) {
      setChecking(false);
      return;
    }
    void webPushIsEnabled()
      .then(setNotifications)
      .catch(() => setNotifications(false))
      .finally(() => setChecking(false));
  }, [pushConfiguration.enabled]);

  async function toggleNotifications() {
    if (busy) return;
    setBusy(true);
    setNotificationError("");
    try {
      if (notifications) await disableWebPush();
      else await enableWebPush(pushConfiguration);
      setNotifications(!notifications);
    } catch (reason) {
      setNotificationError(reason instanceof Error ? reason.message : "Could not change notification settings");
    } finally {
      setBusy(false);
    }
  }

  const notificationDescription = !pushConfiguration.enabled
    ? "The server administrator must configure Web Push first"
    : !supportsWebPush()
      ? "This browser does not support background notifications"
      : notifications
        ? "Alerts will appear when the chat is backgrounded or closed"
        : "Show Android alerts when the chat is backgrounded or closed";

  return (
    <div className="panel-section settings-panel">
      <p className="eyebrow">Your account</p><h3>Settings</h3>
      <div className="profile-card"><div className="avatar large">{initials(member.displayName)}</div><div><strong>{member.displayName}</strong><span>{member.phoneNumberE164}</span></div></div>
      {notificationError && <ErrorBanner message={notificationError} onDismiss={() => setNotificationError("")} />}
      <button className="setting-row" type="button" onClick={() => void toggleNotifications()} disabled={checking || busy || !pushConfiguration.enabled || !supportsWebPush()} aria-pressed={notifications}>
        <div><strong>Background notifications</strong><span>{checking ? "Checking this device…" : notificationDescription}</span></div>
        <i className={`switch ${notifications ? "on" : ""}`}><b /></i>
      </button>
      <button className="danger-button" type="button" onClick={onLogout}>Log out</button>
    </div>
  );
}

function Chat({ bootstrap: initial, onUnauthenticated }: { bootstrap: Bootstrap; onUnauthenticated: () => void }) {
  const draftKey = `sms-bridge-chat:draft:${initial.group.id}:${initial.currentMember.id}`;
  const [data, setData] = useState(initial);
  const [messages, setMessages] = useState(initial.messages);
  const [composer, setComposer] = useState(() => {
    try { return localStorage.getItem(draftKey) ?? ""; }
    catch { return ""; }
  });
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [panel, setPanel] = useState<"members" | "admin" | "settings" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [photo, setPhoto] = useState<File>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<Socket | undefined>(undefined);
  const atBottomRef = useRef(true);
  const searchOpenRef = useRef(false);
  const photoPreview = useMemo(() => photo ? URL.createObjectURL(photo) : undefined, [photo]);
  const normalizedSearch = searchQuery.trim();
  const searchActive = searchOpen && normalizedSearch.length >= 2;
  const visibleMessages = searchActive ? searchResults : messages;

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior });
    atBottomRef.current = true;
    setAtBottom(true);
    setNewMessageCount(0);
  }, []);

  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  useEffect(() => {
    try {
      if (composer) localStorage.setItem(draftKey, composer);
      else localStorage.removeItem(draftKey);
    } catch { /* Draft recovery is best-effort on restricted browsers. */ }
  }, [composer, draftKey]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (!searchActive) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timeout = window.setTimeout(() => {
      void api<{ messages: Message[] }>(`/api/messages/search?q=${encodeURIComponent(normalizedSearch)}&limit=50`, { signal: controller.signal })
        .then((result) => setSearchResults(result.messages))
        .catch((reason) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError(reason instanceof Error ? reason.message : "Could not search messages");
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [normalizedSearch, searchActive]);

  const refresh = useCallback(async () => {
    const next = await api<Bootstrap>("/api/bootstrap");
    setData(next);
    setMessages((current) => {
      const merged = new Map(current.map((message) => [message.id, message]));
      for (const message of next.messages) merged.set(message.id, message);
      return [...merged.values()].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
  }, []);

  useEffect(() => {
    void syncWebPush(data.pushNotifications).catch(() => undefined);
  }, [data.pushNotifications.enabled, data.pushNotifications.publicKey]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const receivePushMessage = (event: MessageEvent) => {
      if (event.data?.type === "push:message") void refresh();
    };
    navigator.serviceWorker.addEventListener("message", receivePushMessage);
    return () => navigator.serviceWorker.removeEventListener("message", receivePushMessage);
  }, [refresh]);

  useEffect(() => {
    const socket = io({ path: "/socket.io", withCredentials: true });
    socketRef.current = socket;
    socket.on("message:new", (message: Message) => {
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      if (atBottomRef.current && !searchOpenRef.current) requestAnimationFrame(() => scrollToLatest());
      else setNewMessageCount((current) => current + 1);
    });
    socket.on("reaction:added", (reaction: Reaction) => {
      const update = (current: Message[]) => current.map((message) => message.id === reaction.messageId
        ? { ...message, reactions: message.reactions.some((item) => item.id === reaction.id) ? message.reactions : [...message.reactions, reaction] }
        : message);
      setMessages(update);
      setSearchResults(update);
    });
    socket.on("reaction:removed", (event: { messageId: string; memberId: string; emoji: string }) => {
      const update = (current: Message[]) => current.map((message) => message.id === event.messageId
        ? { ...message, reactions: message.reactions.filter((item) => !(item.memberId === event.memberId && item.emoji === event.emoji)) }
        : message);
      setMessages(update);
      setSearchResults(update);
    });
    socket.on("message:deleted", (event: { messageId: string; deletedAt: string }) => {
      const update = (current: Message[]) => current.map((message) => {
        if (message.id === event.messageId) return { ...message, body: "Message removed", deletedAt: event.deletedAt, reactions: [], attachments: [] };
        if (message.replyTo?.id === event.messageId) return { ...message, replyTo: { ...message.replyTo, body: "Message removed" } };
        return message;
      });
      setMessages(update);
      setSearchResults(update);
    });
    return () => { socket.close(); };
  }, [scrollToLatest]);

  useEffect(() => {
    requestAnimationFrame(() => scrollToLatest("auto"));
  }, [scrollToLatest]);

  function handleMessageScroll() {
    const list = listRef.current;
    if (!list) return;
    const nextAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    atBottomRef.current = nextAtBottom;
    setAtBottom(nextAtBottom);
    if (nextAtBottom) setNewMessageCount(0);
  }

  async function sendMessage() {
    const body = composer.trim();
    if ((!body && !photo) || sending) return;
    setSending(true); setError("");
    try {
      let result: { message: Message };
      if (photo) {
        const form = new FormData();
        form.append("body", body);
        if (replyingTo) form.append("replyToMessageId", replyingTo.id);
        form.append("image", photo, photo.name);
        result = await api<{ message: Message }>("/api/messages/images", { method: "POST", body: form });
      } else {
        result = await api<{ message: Message }>("/api/messages", {
          method: "POST",
          body: JSON.stringify({ body, replyToMessageId: replyingTo?.id })
        });
      }
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message]);
      setComposer(""); setPhoto(undefined); setReplyingTo(undefined); setEmojiOpen(false); setSearchOpen(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
      requestAnimationFrame(() => scrollToLatest());
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) return onUnauthenticated();
      setError(reason instanceof Error ? reason.message : "Could not send message");
    } finally { setSending(false); }
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected) return;
    if (!data.imageUploads.acceptedTypes.includes(selected.type.toLowerCase())) {
      setError("Choose a JPEG, PNG, WebP, or AVIF photo");
      return;
    }
    if (selected.size > data.imageUploads.maxBytes) {
      setError(`Photo must be ${Math.floor(data.imageUploads.maxBytes / 1024 / 1024)} MB or smaller`);
      return;
    }
    setError("");
    setPhoto(selected);
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  }

  function wrapSelection(before: string, after = before) {
    const target = textareaRef.current;
    if (!target) return;
    const start = target.selectionStart; const end = target.selectionEnd;
    const selected = composer.slice(start, end) || "text";
    setComposer(`${composer.slice(0, start)}${before}${selected}${after}${composer.slice(end)}`);
    requestAnimationFrame(() => { target.focus(); target.setSelectionRange(start + before.length, start + before.length + selected.length); });
  }

  function addEmoji(emoji: string) {
    const target = textareaRef.current;
    const start = target?.selectionStart ?? composer.length;
    const end = target?.selectionEnd ?? composer.length;
    setComposer(`${composer.slice(0, start)}${emoji}${composer.slice(end)}`);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  async function copyMessage(message: Message) {
    const attachmentUrls = message.attachments.map((attachment) => new URL(attachment.url, window.location.origin).href);
    const content = [message.body, ...attachmentUrls].filter(Boolean).join("\n");
    try {
      await copyText(content);
      setNotice("Message copied");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not copy message");
    }
  }

  async function react(message: Message, emoji: string, remove: boolean) {
    try {
      if (remove) {
        await api(`/api/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" });
      } else {
        await api(`/api/messages/${message.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update reaction"); }
  }

  async function deleteMessage(message: Message) {
    const warning = message.source === "SMS" || data.group.smsEnabled
      ? "Remove this message from the app? Any SMS copies already sent cannot be recalled."
      : "Remove this message from the chat?";
    if (!window.confirm(warning)) return;
    try {
      const result = await api<{ message: Message }>(`/api/messages/${message.id}`, { method: "DELETE" });
      const update = (current: Message[]) => current.map((item) => {
        if (item.id === result.message.id) return result.message;
        if (item.replyTo?.id === result.message.id) return { ...item, replyTo: { ...item.replyTo, body: "Message removed" } };
        return item;
      });
      setMessages(update);
      setSearchResults(update);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete message");
    }
  }

  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    const list = listRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    const previousTop = list?.scrollTop ?? 0;
    setLoadingOlder(true);
    try {
      const result = await api<{ messages: Message[] }>(`/api/messages?before=${new Date(first.createdAt).getTime()}&limit=50`);
      setMessages((current) => [...result.messages.filter((older) => !current.some((item) => item.id === older.id)), ...current]);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (list) list.scrollTop = previousTop + list.scrollHeight - previousHeight;
      }));
    } finally { setLoadingOlder(false); }
  }

  function toggleSearch() {
    setSearchOpen((current) => {
      const next = !current;
      if (!next) {
        setSearchQuery("");
        setSearchResults([]);
        requestAnimationFrame(() => scrollToLatest("auto"));
      }
      return next;
    });
  }

  async function logout() {
    try {
      await disableWebPush().catch(() => undefined);
      await api("/api/auth/logout", { method: "POST" });
    } finally { onUnauthenticated(); }
  }

  let lastDay = "";
  return (
    <main className="app-shell">
      <header className="chat-header">
        <div className="group-avatar" aria-hidden="true"><span>↔</span></div>
        <div className="group-copy"><h1>{data.group.name}</h1><span><i className={data.group.smsEnabled ? "online" : "paused"} /> {data.members.length} members · SMS {data.group.smsEnabled ? "connected" : "paused"}</span></div>
        <button className={`header-button ${searchOpen ? "active" : ""}`} type="button" onClick={toggleSearch} aria-label={searchOpen ? "Close message search" : "Search messages"} aria-pressed={searchOpen} title="Search messages"><span aria-hidden="true">⌕</span></button>
        <button className="header-button members-button" type="button" onClick={() => setPanel("members")} aria-label="View members">♟<span>Members</span></button>
        <button className="header-button" type="button" onClick={() => setPanel("settings")} aria-label="Open settings">•••</button>
      </header>
      <div className="chat-tools">
        {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
        {searchOpen && (
          <div className="search-bar" role="search">
            <span aria-hidden="true">⌕</span>
            <input ref={searchInputRef} type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search messages or people" aria-label="Search messages or people" maxLength={100} />
            {searching && <span className="search-spinner" role="status" aria-label="Searching" />}
            <button type="button" onClick={toggleSearch} aria-label="Close search">×</button>
          </div>
        )}
      </div>
      <div className="message-pane">
        <div className="message-list" ref={listRef} onScroll={handleMessageScroll}>
          {searchOpen ? (
            <div className="search-status" role="status">
              {normalizedSearch.length < 2 ? "Enter at least two characters" : searching ? "Searching…" : `${searchResults.length} ${searchResults.length === 1 ? "result" : "results"}`}
            </div>
          ) : (
            <div className="history-start"><button type="button" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load older messages"}</button><p>Messages are stored privately on your server.</p></div>
          )}
          {searchActive && !searching && searchResults.length === 0 && <div className="empty-search"><strong>No messages found</strong><span>Try another word or sender name.</span></div>}
          {visibleMessages.map((message, index) => {
            const day = dayLabel(message.createdAt);
            const showDay = day !== lastDay;
            lastDay = day;
            return (
              <div key={message.id}>
                {showDay && <div className="day-divider"><span>{day}</span></div>}
                <MessageItem
                  message={message}
                  previous={visibleMessages[index - 1]}
                  currentMember={data.currentMember}
                  onReply={(item) => { setReplyingTo(item); setSearchOpen(false); setSearchQuery(""); requestAnimationFrame(() => textareaRef.current?.focus()); }}
                  onReact={(item, emoji, remove) => void react(item, emoji, remove)}
                  onDelete={(item) => void deleteMessage(item)}
                  onCopy={(item) => void copyMessage(item)}
                />
              </div>
            );
          })}
        </div>
        {!searchActive && !atBottom && (
          <button className="jump-latest" type="button" onClick={() => scrollToLatest()}>
            <span aria-hidden="true">↓</span>{newMessageCount > 0 ? `${newMessageCount} new` : "Latest"}
          </button>
        )}
      </div>
      <footer className="composer-area">
        {replyingTo && <div className="composer-reply"><div><strong>Replying to {replyingTo.senderName}</strong><span>{truncate(replyingTo.body || "Photo", 120)}</span></div><button type="button" onClick={() => setReplyingTo(undefined)}>×</button></div>}
        {photo && photoPreview && (
          <div className="photo-preview">
            <img src={photoPreview} alt="Selected attachment preview" />
            <div><strong>{photo.name}</strong><span>{(photo.size / 1024 / 1024).toFixed(1)} MB · converted privately to WebP</span></div>
            <button type="button" onClick={() => setPhoto(undefined)} aria-label="Remove selected photo">×</button>
          </div>
        )}
        <div className="format-bar" aria-label="Message formatting">
          <button type="button" onClick={() => wrapSelection("**")} title="Bold" aria-label="Bold"><b>B</b></button>
          <button type="button" onClick={() => wrapSelection("_")} title="Italic" aria-label="Italic"><i>I</i></button>
          <button type="button" onClick={() => wrapSelection("`")} title="Inline code" aria-label="Inline code"><span>&lt;/&gt;</span></button>
          <button type="button" onClick={() => setComposer((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}- `)} title="Bulleted list" aria-label="Bulleted list">≡</button>
          <div className="emoji-picker">
            <button type="button" className={emojiOpen ? "active" : ""} onClick={() => setEmojiOpen((current) => !current)} title="Emoji" aria-label="Choose an emoji" aria-expanded={emojiOpen}>☺</button>
            {emojiOpen && (
              <div className="emoji-grid" role="dialog" aria-label="Choose an emoji">
                {COMMON_EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => addEmoji(emoji)} aria-label={`Insert ${emoji}`}>{emoji}</button>)}
              </div>
            )}
          </div>
          <span className="format-spacer" />
          <input ref={photoInputRef} className="visually-hidden" type="file" accept={data.imageUploads.acceptedTypes.join(",")} onChange={choosePhoto} />
          <button type="button" className="attachment-button" disabled={!data.imageUploads.enabled || sending} onClick={() => photoInputRef.current?.click()} title="Attach a photo" aria-label="Attach a photo">＋</button>
        </div>
        <div className="composer-row">
          <textarea ref={textareaRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={composerKeyDown} placeholder={`Message ${data.group.name}`} rows={1} maxLength={4000} aria-label="Message" />
          <button className="send-button" type="button" onClick={() => void sendMessage()} disabled={(!composer.trim() && !photo) || sending} aria-label="Send message">➤</button>
        </div>
        <span className="composer-hint">{composer ? "Draft saved on this device" : "Enter to send · Shift + Enter for a new line"}</span>
      </footer>
      {notice && <div className="toast" role="status">{notice}</div>}
      {panel && (
        <div className="panel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
          <aside className="side-panel" aria-label={`${panel} panel`}>
            <header><div className="panel-tabs"><button className={panel === "members" ? "active" : ""} onClick={() => setPanel("members")}>Members</button>{data.currentMember.role === "ADMIN" && <button className={panel === "admin" ? "active" : ""} onClick={() => setPanel("admin")}>Admin</button>}<button className={panel === "settings" ? "active" : ""} onClick={() => setPanel("settings")}>Settings</button></div><button className="panel-close" type="button" onClick={() => setPanel(null)}>×</button></header>
            {panel === "members" && <MembersPanel members={data.members} />}
            {panel === "admin" && data.currentMember.role === "ADMIN" && <AdminPanel bootstrap={data} onChanged={refresh} />}
            {panel === "settings" && <SettingsPanel member={data.currentMember} pushConfiguration={data.pushNotifications} onLogout={() => void logout()} />}
          </aside>
        </div>
      )}
    </main>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setBootstrap(await api<Bootstrap>("/api/bootstrap")); setSignedOut(false); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { setBootstrap(undefined); setSignedOut(true); }
      else { setBootstrap(undefined); setSignedOut(true); }
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="loading-screen"><div className="brand-mark"><span>↔</span></div><p>Opening your chat…</p></div>;
  if (!bootstrap || signedOut) return <Login onAuthenticated={() => void load()} />;
  return <Chat bootstrap={bootstrap} onUnauthenticated={() => { setBootstrap(undefined); setSignedOut(true); }} />;
}
