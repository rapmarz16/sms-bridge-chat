import { api } from "./api";

export type PushConfiguration = {
  enabled: boolean;
  publicKey?: string;
};

export function supportsWebPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!supportsWebPush()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("The browser returned an incomplete notification subscription");
  }
  await api("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: json.keys
    })
  });
}

export async function webPushIsEnabled(): Promise<boolean> {
  return Boolean(await currentSubscription());
}

export async function enableWebPush(configuration: PushConfiguration): Promise<void> {
  if (!configuration.enabled || !configuration.publicKey) {
    throw new Error("Background notifications are not configured on the server");
  }
  if (!supportsWebPush()) throw new Error("This browser does not support background notifications");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked. Allow them in Android or browser site settings, then try again.");
  }
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  let created = false;
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(configuration.publicKey)
    });
    created = true;
  }
  try {
    await saveSubscription(subscription);
  } catch (error) {
    if (created) await subscription.unsubscribe();
    throw error;
  }
}

export async function syncWebPush(configuration: PushConfiguration): Promise<void> {
  if (!configuration.enabled || !supportsWebPush()) return;
  const subscription = await currentSubscription();
  if (subscription) await saveSubscription(subscription);
}

export async function disableWebPush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  try {
    await api("/api/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
  } catch {
    // Unsubscribe locally even if the server cannot be reached. A later
    // delivery receives 404/410 and removes the now-stale server record.
  } finally {
    await subscription.unsubscribe();
  }
}
