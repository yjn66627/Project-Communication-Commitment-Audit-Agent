import process from "node:process";

/** Safe application error: never attach raw inputs, salt, paths or original exceptions. */
export class ApplicationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function assertServerRuntime(): void {
  if (typeof window !== "undefined" || process.release.name !== "node") {
    throw new ApplicationError("SERVER_ONLY", "Application storage is available only on the local server.");
  }
}
