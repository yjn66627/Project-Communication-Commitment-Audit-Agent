# SECURITY_EXCLUSIONS

This public-source candidate deliberately excludes:

- `.env`, Provider credentials, provider configuration JSON, DPAPI material, tokens, and local control files.
- SQLite databases, WAL/SHM files, database backups, audit rows, raw conversation inputs, and raw report exports.
- All Windows user-profile or private-data directory paths.
- Checkpoints, logs, rollback snapshots, ZIP archives, patches, and manifests from the historical delivery tree.
- `node_modules`, `.next`, Next Standalone output, packaged Node.js runtime, installers, native Sharp/libvips files, and vendored third-party code.
- Existing UI screenshots and browser captures. Their associated evidence contains local private paths, and the captured report material was not independently verified as synthetic-only for public display.
- Tests with credential-shaped synthetic sentinel strings, phone-shaped sample digits, or an illustrative local database path. They exercise security and privacy cases but can be confused with live credentials or personal data by repository scanners. The omitted test filenames are listed only in the private delivery evidence, not in this public repository.
- GitHub Actions, release workflows, Docker files, binary releases, and deployment configuration.

The staged source was copied from the frozen Source Authority file set and scanned independently. The exclusions above do not waive the unresolved binary distribution license gate.

