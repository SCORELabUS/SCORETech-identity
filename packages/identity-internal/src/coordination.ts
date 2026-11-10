import { spawn } from 'node:child_process';

/** Kernel lock shared by the API and reconciler. Parent death closes stdin and
 * releases the lock; no expiring lease can admit two in-flight operations. */
export function acquireAuthorizationLock(file?: string): Promise<() => void> {
  if (!file) return Promise.resolve(() => undefined); // isolated unit fixtures
  return new Promise((resolve, reject) => {
    const holder = spawn(
      'flock',
      [
        '--exclusive',
        file,
        process.execPath,
        '-e',
        "process.stdout.write('locked');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let acquired = false;
    const timer = setTimeout(() => {
      holder.stdin.destroy();
      holder.kill();
      reject(new Error('Authorization coordination timed out. Retry the operation.'));
    }, 30000);
    holder.once('error', () => {
      holder.stdin.destroy();
      clearTimeout(timer);
      reject(new Error('Authorization coordination is unavailable.'));
    });
    holder.once('exit', () => {
      clearTimeout(timer);
      if (!acquired) reject(new Error('Authorization coordination is unavailable.'));
    });
    holder.stdout.once('data', () => {
      acquired = true;
      clearTimeout(timer);
      let released = false;
      resolve(() => {
        if (!released) {
          released = true;
          holder.stdin.end();
        }
      });
    });
    holder.stdin.on('error', () => undefined);
  });
}
