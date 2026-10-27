import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { ApplicationError } from "../errors.js";

const OwnerSchema = z.object({ pid: z.number().int().positive(), token: z.string().uuid() }).strict();
type OwnerRecord = z.infer<typeof OwnerSchema>;

function readOwner(directory: string): OwnerRecord {
  const file = path.join(directory, "owner.json");
  try {
    const dir = lstatSync(directory); const info = lstatSync(file);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() || info.size > 4096 || readdirSync(directory).length !== 1) throw new Error();
    return OwnerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch { throw new ApplicationError("OWNER_UNCERTAIN", "Storage ownership cannot be verified."); }
}

function mechanicallyAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Atomic directory owner; PID reuse or an uncertain process state always denies recovery. */
export class InstanceOwner {
  #directory: string;
  #record: OwnerRecord;
  #released = false;
  private constructor(directory: string, record: OwnerRecord) { this.#directory = directory; this.#record = record; }

  static acquire(dataDirectory: string): InstanceOwner {
    const directory = path.join(dataDirectory, "owner.lock");
    const recovery = path.join(dataDirectory, "owner.recovery.lock");
    const claim = (): InstanceOwner => {
      mkdirSync(directory, { mode: 0o700 });
      const record = { pid: process.pid, token: randomUUID() };
      writeFileSync(path.join(directory, "owner.json"), JSON.stringify(record), { flag: "wx", mode: 0o600 });
      return new InstanceOwner(directory, record);
    };
    if (existsSync(recovery)) throw new ApplicationError("OWNER_UNCERTAIN", "Storage ownership recovery is in progress.");
    try { return claim(); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ApplicationError("OWNER_UNCERTAIN", "Storage ownership could not be acquired.");
    }
    const previous = readOwner(directory);
    if (!mechanicallyAbsent(previous.pid)) throw new ApplicationError("OWNER_BUSY", "Storage already has an owner or its status is uncertain.");
    try { mkdirSync(recovery, { mode: 0o700 }); }
    catch { throw new ApplicationError("OWNER_UNCERTAIN", "Storage ownership recovery could not be acquired."); }
    let acquired: InstanceOwner | undefined;
    try {
      const current = readOwner(directory);
      if (current.token !== previous.token || current.pid !== previous.pid || !mechanicallyAbsent(current.pid)) throw new Error();
      const retired = path.join(dataDirectory, `stale-owner.${randomUUID()}`);
      renameSync(directory, retired);
      // A competing claimant can win here; never delete or replace its new owner directory.
      acquired = claim();
      unlinkSync(path.join(retired, "owner.json")); rmdirSync(retired);
      return acquired;
    } catch {
      acquired?.release();
      throw new ApplicationError("OWNER_UNCERTAIN", "Storage ownership recovery failed closed.");
    } finally { rmdirSync(recovery); }
  }

  assertOwned(): void {
    if (this.#released) throw new ApplicationError("STORE_CLOSED", "Storage owner has been released.");
    const current = readOwner(this.#directory);
    if (current.pid !== this.#record.pid || current.token !== this.#record.token) throw new ApplicationError("OWNER_LOST", "Storage ownership was lost.");
  }

  release(): void {
    if (this.#released) return;
    this.assertOwned();
    unlinkSync(path.join(this.#directory, "owner.json")); rmdirSync(this.#directory);
    this.#released = true;
  }
}
