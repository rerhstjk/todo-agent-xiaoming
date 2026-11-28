export interface PushConfig {
  publicKey: string;
  subscriptions: number;
}

export interface PushTestResult {
  sent: number;
  failed: number;
}

export type PushEnableResult = "granted" | "denied" | "unsupported" | "failed";

/** 后台推送需要 Service Worker + PushManager + 通知权限；Safari 需要把页面「添加到程序坞」。 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchPushConfig(): Promise<PushConfig> {
  return requestJson<PushConfig>("/api/push/config");
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function currentRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  return (await navigator.serviceWorker.getRegistration("/")) ?? undefined;
}

/** 页面加载时检查是否已经有可用的后台订阅。 */
export async function backgroundPushReady(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const registration = await currentRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return Boolean(subscription);
  } catch {
    return false;
  }
}

/**
 * 申请权限、注册 Service Worker、订阅并上报给服务端。
 * 失败时返回 unsupported/failed，调用方退回「页面打开时才提醒」。
 */
export async function enableBackgroundPush(): Promise<PushEnableResult> {
  if (!pushSupported()) return "unsupported";
  try {
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return "denied";

    const config = await fetchPushConfig();
    if (!config.publicKey) return "failed";

    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
    }
    const json = subscription.toJSON();
    await requestJson("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: subscription.endpoint, keys: json.keys }),
    });
    return "granted";
  } catch (error) {
    console.warn("[xiaoming] 后台提醒启用失败，退回页面内提醒：", error);
    return "failed";
  }
}

export async function disableBackgroundPush(): Promise<void> {
  try {
    const registration = await currentRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await requestJson("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
    await subscription.unsubscribe();
  } catch (error) {
    console.warn("[xiaoming] 关闭后台提醒失败：", error);
  }
}

export async function sendTestPush(): Promise<PushTestResult> {
  return requestJson<PushTestResult>("/api/push/test", { method: "POST" });
}
