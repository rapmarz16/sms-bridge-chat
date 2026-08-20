import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { io, type Socket } from "socket.io-client";
import { api, ApiError } from "./api";
import type { Bootstrap, Member, Message, Reaction, SmsDelivery, SmsUsage } from "./types";

const REACTIONS = ["👍", "❤️", "😂", "😮"] as const;

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
  onReact
}: {
  message: Message;
  currentMember: Member;
  previous?: Message;
  onReply: (message: Message) => void;
  onReact: (message: Message, emoji: string, remove: boolean) => void;
}) {
  const mine = message.senderMemberId === currentMember.id;
  const continuation = Boolean(previous) && previous!.senderMemberId === message.senderMemberId &&
    new Date(message.createdAt).getTime() - new Date(previous!.createdAt).getTime() < 5 * 60_000;
  const grouped = useMemo(() => REACTIONS.map((emoji) => ({
    emoji,
    items: message.reactions.filter((reaction) => reaction.emoji === emoji)
  })).filter((group) => group.items.length > 0), [message.reactions]);

  return (
    <article className={`message-row ${mine ? "mine" : "theirs"} ${continuation ? "continuation" : ""}`}>
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
          <div className="message-bubble">
            {message.replyTo && (
              <button className="reply-context" type="button" title="Original message">
                <strong>{message.replyTo.senderName}</strong>
                <span>{truncate(message.replyTo.body)}</span>
              </button>
            )}
            <div className="message-body"><Markdown>{message.body}</Markdown></div>
            {message.attachments.map((attachment) => <img key={attachment.id} className="message-image" src={attachment.url} alt={attachment.originalFilename} />)}
          </div>
          <div className="message-actions">
            <button type="button" onClick={() => onReply(message)} aria-label={`Reply to ${message.senderName}`}>↩</button>
            <details>
              <summary aria-label="Add a reaction">☺</summary>
              <div className="reaction-menu">
                {REACTIONS.map((emoji) => {
                  const mineReaction = message.reactions.some((reaction) => reaction.emoji === emoji && reaction.memberId === currentMember.id);
                  return <button type="button" key={emoji} className={mineReaction ? "selected" : ""} onClick={() => onReact(message, emoji, mineReaction)}>{emoji}</button>;
                })}
              </div>
            </details>
          </div>
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
  bridge: { configured: boolean; enabled: boolean; providerParametersVerified: boolean };
};

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

function SettingsPanel({ member, onLogout }: { member: Member; onLogout: () => void }) {
  const [notifications, setNotifications] = useState(() => localStorage.getItem("bridge-notifications") === "on");
  async function toggleNotifications() {
    if (!notifications && "Notification" in window) {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
    }
    const next = !notifications;
    setNotifications(next);
    localStorage.setItem("bridge-notifications", next ? "on" : "off");
  }
  return (
    <div className="panel-section settings-panel">
      <p className="eyebrow">Your account</p><h3>Settings</h3>
      <div className="profile-card"><div className="avatar large">{initials(member.displayName)}</div><div><strong>{member.displayName}</strong><span>{member.phoneNumberE164}</span></div></div>
      <button className="setting-row" type="button" onClick={toggleNotifications}><div><strong>Message notifications</strong><span>Show an alert when the chat is in the background</span></div><i className={`switch ${notifications ? "on" : ""}`}><b /></i></button>
      <button className="danger-button" type="button" onClick={onLogout}>Log out</button>
    </div>
  );
}

function Chat({ bootstrap: initial, onUnauthenticated }: { bootstrap: Bootstrap; onUnauthenticated: () => void }) {
  const [data, setData] = useState(initial);
  const [messages, setMessages] = useState(initial.messages);
  const [composer, setComposer] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message>();
  const [panel, setPanel] = useState<"members" | "admin" | "settings" | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<Socket | undefined>(undefined);

  const refresh = useCallback(async () => {
    const next = await api<Bootstrap>("/api/bootstrap");
    setData(next);
  }, []);

  useEffect(() => {
    const socket = io({ path: "/socket.io", withCredentials: true });
    socketRef.current = socket;
    socket.on("message:new", (message: Message) => {
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      if (document.hidden && localStorage.getItem("bridge-notifications") === "on" && Notification.permission === "granted") {
        new Notification(message.senderName, { body: truncate(message.body, 120), icon: "/icon-192.png" });
      }
    });
    socket.on("reaction:added", (reaction: Reaction) => {
      setMessages((current) => current.map((message) => message.id === reaction.messageId
        ? { ...message, reactions: message.reactions.some((item) => item.id === reaction.id) ? message.reactions : [...message.reactions, reaction] }
        : message));
    });
    socket.on("reaction:removed", (event: { messageId: string; memberId: string; emoji: string }) => {
      setMessages((current) => current.map((message) => message.id === event.messageId
        ? { ...message, reactions: message.reactions.filter((item) => !(item.memberId === event.memberId && item.emoji === event.emoji)) }
        : message));
    });
    return () => { socket.close(); };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: messages.length > initial.messages.length ? "smooth" : "auto" });
  }, [messages.length, initial.messages.length]);

  async function sendMessage() {
    const body = composer.trim();
    if (!body || sending) return;
    setSending(true); setError("");
    try {
      const result = await api<{ message: Message }>("/api/messages", {
        method: "POST",
        body: JSON.stringify({ body, replyToMessageId: replyingTo?.id })
      });
      setMessages((current) => current.some((item) => item.id === result.message.id) ? current : [...current, result.message]);
      setComposer(""); setReplyingTo(undefined);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) return onUnauthenticated();
      setError(reason instanceof Error ? reason.message : "Could not send message");
    } finally { setSending(false); }
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

  async function react(message: Message, emoji: string, remove: boolean) {
    try {
      if (remove) {
        await api(`/api/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" });
      } else {
        await api(`/api/messages/${message.id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update reaction"); }
  }

  async function loadOlder() {
    const first = messages[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const result = await api<{ messages: Message[] }>(`/api/messages?before=${new Date(first.createdAt).getTime()}&limit=50`);
      setMessages((current) => [...result.messages.filter((older) => !current.some((item) => item.id === older.id)), ...current]);
    } finally { setLoadingOlder(false); }
  }

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); } finally { onUnauthenticated(); }
  }

  let lastDay = "";
  return (
    <main className="app-shell">
      <header className="chat-header">
        <div className="group-avatar" aria-hidden="true"><span>↔</span></div>
        <div className="group-copy"><h1>{data.group.name}</h1><span><i className={data.group.smsEnabled ? "online" : "paused"} /> {data.members.length} members · SMS {data.group.smsEnabled ? "connected" : "paused"}</span></div>
        <button className="header-button members-button" type="button" onClick={() => setPanel("members")} aria-label="View members">♟<span>Members</span></button>
        <button className="header-button" type="button" onClick={() => setPanel("settings")} aria-label="Open settings">•••</button>
      </header>
      {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
      <div className="message-list" ref={listRef}>
        <div className="history-start"><button type="button" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load older messages"}</button><p>Messages are stored privately on your server.</p></div>
        {messages.map((message, index) => {
          const day = dayLabel(message.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          return <div key={message.id}>{showDay && <div className="day-divider"><span>{day}</span></div>}<MessageItem message={message} previous={messages[index - 1]} currentMember={data.currentMember} onReply={(item) => { setReplyingTo(item); textareaRef.current?.focus(); }} onReact={(item, emoji, remove) => void react(item, emoji, remove)} /></div>;
        })}
      </div>
      <footer className="composer-area">
        {replyingTo && <div className="composer-reply"><div><strong>Replying to {replyingTo.senderName}</strong><span>{truncate(replyingTo.body, 120)}</span></div><button type="button" onClick={() => setReplyingTo(undefined)}>×</button></div>}
        <div className="format-bar" aria-label="Message formatting">
          <button type="button" onClick={() => wrapSelection("**")} title="Bold"><b>B</b></button>
          <button type="button" onClick={() => wrapSelection("_")} title="Italic"><i>I</i></button>
          <button type="button" onClick={() => wrapSelection("`")} title="Inline code"><span>&lt;/&gt;</span></button>
          <button type="button" onClick={() => setComposer((current) => `${current}${current && !current.endsWith("\n") ? "\n" : ""}- `)} title="List">≡</button>
          <button type="button" onClick={() => setComposer((current) => `${current}👍`)} title="Emoji">☺</button>
          <span className="format-spacer" />
          <button type="button" className="attachment-button" disabled title="Images unlock after live SMS validation">＋</button>
        </div>
        <div className="composer-row">
          <textarea ref={textareaRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={composerKeyDown} placeholder={`Message ${data.group.name}`} rows={1} maxLength={4000} aria-label="Message" />
          <button className="send-button" type="button" onClick={() => void sendMessage()} disabled={!composer.trim() || sending} aria-label="Send message">➤</button>
        </div>
        <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
      </footer>
      {panel && (
        <div className="panel-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
          <aside className="side-panel" aria-label={`${panel} panel`}>
            <header><div className="panel-tabs"><button className={panel === "members" ? "active" : ""} onClick={() => setPanel("members")}>Members</button>{data.currentMember.role === "ADMIN" && <button className={panel === "admin" ? "active" : ""} onClick={() => setPanel("admin")}>Admin</button>}<button className={panel === "settings" ? "active" : ""} onClick={() => setPanel("settings")}>Settings</button></div><button className="panel-close" type="button" onClick={() => setPanel(null)}>×</button></header>
            {panel === "members" && <MembersPanel members={data.members} />}
            {panel === "admin" && data.currentMember.role === "ADMIN" && <AdminPanel bootstrap={data} onChanged={refresh} />}
            {panel === "settings" && <SettingsPanel member={data.currentMember} onLogout={() => void logout()} />}
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
