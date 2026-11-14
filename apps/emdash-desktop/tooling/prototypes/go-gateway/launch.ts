import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A development-only example of the Electron host owning a gateway process. */
export async function launchGateway(binary: string, usageDirectory: string) {
  const child = spawn(binary, [usageDirectory], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const bootstrap = await new Promise<{ address: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Gateway did not start in time'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited before startup (${code})`));
    });
    lines.once('line', (line) => {
      clearTimeout(timer);
      try {
        const value: unknown = JSON.parse(line);
        if (
          !value ||
          typeof value !== 'object' ||
          !('address' in value) ||
          typeof value.address !== 'string' ||
          !('token' in value) ||
          typeof value.token !== 'string'
        ) {
          throw new Error('Invalid gateway startup message');
        }
        resolve({ address: value.address, token: value.token });
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
  });
  lines.close();
  return {
    ...bootstrap,
    stop: () => {
      child.kill();
    },
  };
}
