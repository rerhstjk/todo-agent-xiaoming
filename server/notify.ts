import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface LocalNotification {
  title: string;
  body: string;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 服务端所在电脑的系统通知：Web Push 走不通（例如国内网络连不上 FCM）时兜底，
 * 页面关掉以后仍然能在右上角弹出横幅。只支持 macOS / Linux，失败时返回 false。
 */
export async function notifyLocal({ title, body }: LocalNotification): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await run("osascript", [
        "-e",
        `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
      ]);
      return true;
    }
    if (process.platform === "linux") {
      await run("notify-send", [title, body]);
      return true;
    }
    return false;
  } catch (error) {
    console.warn("[xiaoming] 本机通知发送失败：", error instanceof Error ? error.message : error);
    return false;
  }
}
