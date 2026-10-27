/** Process-local only. Cross-process coordination remains DEV-03 persistence responsibility. */
export class PerAuditConfirmationLock {
  private readonly tails = new Map<string, Promise<void>>();

  get pendingAuditKeyCount(): number {
    return this.tails.size;
  }

  async runExclusive<T>(auditId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(auditId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(auditId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(auditId) === tail) this.tails.delete(auditId);
    }
  }
}
