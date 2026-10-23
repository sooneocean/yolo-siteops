import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const LIVE_WORDPRESS_WRITER_LOCK = '/tmp/yololab-wordpress-writer.lock';

export interface WriterLockOptions {
  /** True only for the yololab.net live compatibility lock. Other live sites use a configured, site-specific lockPath. */
  production: boolean;
  lockPath?: string;
}

export class WriterLockHeldError extends Error {
  readonly code = 'writer_lock_held';

  constructor(lockPath: string) {
    super(`WordPress writer lock already exists at ${lockPath}`);
    this.name = 'WriterLockHeldError';
  }
}

export async function acquireWriterLock(label: string, options: WriterLockOptions): Promise<() => Promise<void>> {
  const lockPath = options.production ? LIVE_WORDPRESS_WRITER_LOCK : (options.lockPath ?? LIVE_WORDPRESS_WRITER_LOCK);
  if (options.production && options.lockPath && options.lockPath !== LIVE_WORDPRESS_WRITER_LOCK) {
    throw new Error(`Production WordPress writer lock must be ${LIVE_WORDPRESS_WRITER_LOCK}`);
  }

  const token = crypto.randomUUID();
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WriterLockHeldError(lockPath);
    throw error;
  }

  const metadata = { pid: process.pid, label, token, acquiredAt: new Date().toISOString() };
  try {
    await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await fs.rmdir(lockPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const held = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { token?: string };
      if (held.token === token) await fs.rm(lockPath, { recursive: true, force: true });
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  };
}
