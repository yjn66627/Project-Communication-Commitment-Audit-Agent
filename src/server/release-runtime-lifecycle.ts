import process from "node:process";
import { closeSharedApplicationStore } from "./application-store.js";

type ReleaseMessage = { type?: unknown };
type ReleaseGlobal = typeof globalThis & { [key: symbol]: boolean | undefined };
const registrationKey = Symbol.for("dev08.release.runtime.lifecycle.registered.v1");
const globalState = globalThis as ReleaseGlobal;

if (!globalState[registrationKey]) {
  globalState[registrationKey] = true;
  let closing: Promise<void> | undefined;
  const requestClose = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      await closeSharedApplicationStore();
      const exit = (): void => process.exit(0);
      if (typeof process.send === "function" && process.connected) {
        process.send({ type: "STOPPED" }, exit);
      } else {
        exit();
      }
    })();
    void closing.catch(() => {
      process.stderr.write("本地数据尚未完成安全关闭；请保持应用运行并稍后重试停止。\n");
      closing = undefined;
    });
    return closing;
  };

  process.on("message", (message: ReleaseMessage) => {
    if (message && message.type === "STOP") void requestClose();
  });
  process.on("SIGINT", () => { void requestClose(); });
  process.on("SIGTERM", () => { void requestClose(); });
}
