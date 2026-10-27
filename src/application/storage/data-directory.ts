import path from "node:path";
import process from "node:process";
import { lstatSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ApplicationError, assertServerRuntime } from "../errors.js";

export const APPLICATION_DIRECTORY_NAME = "ProjectCommunicationCommitmentAuditAgent";

export function resolveApplicationDataDirectory(
  environment: Readonly<{ LOCALAPPDATA?: string }> = { LOCALAPPDATA: process.env.LOCALAPPDATA },
  platform: string = process.platform,
): string {
  assertServerRuntime();
  const base = environment.LOCALAPPDATA;
  if (platform !== "win32" || !base || !path.win32.isAbsolute(base) || !/^[A-Za-z]:[\\/]/.test(base)) {
    throw new ApplicationError("PRIVATE_DIRECTORY_UNAVAILABLE", "A local Windows user data directory is required.");
  }
  return path.win32.join(path.win32.normalize(base), APPLICATION_DIRECTORY_NAME);
}

/** Set an exact protected Windows ACL: current user + SYSTEM, inherited by DB/lock/backup children. */
export function preparePrivateDataDirectory(directory: string): void {
  assertServerRuntime();
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid directory.");
    const script = [
      "$ErrorActionPreference='Stop'",
      "$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
      "$acl.SetOwner($user)",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
      "$prop=[System.Security.AccessControl.PropagationFlags]::None",
      "$allow=[System.Security.AccessControl.AccessControlType]::Allow",
      "$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
      "foreach($sid in @($user,$system)) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,$prop,$allow); $acl.AddAccessRule($rule) }",
      "[System.IO.Directory]::SetAccessControl($env:DEV06_PRIVATE_DIRECTORY,$acl)",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, DEV06_PRIVATE_DIRECTORY: directory }, stdio: "ignore", windowsHide: true,
    });
  } catch {
    throw new ApplicationError("PRIVATE_DIRECTORY_DENIED", "The private storage directory could not be secured.");
  }
}
