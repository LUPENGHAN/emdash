import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Real adapter protocol driver for the gateway integration tests. */
export function startAcpTestClient(
  adapter: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  nativeArgs?: string[]
) {
  const child = spawn(nativeArgs ? adapter : process.execPath, nativeArgs ?? [adapter], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-3000);
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let value: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string; data?: unknown };
    };
    try {
      value = JSON.parse(line);
    } catch {
      for (const request of pending.values()) {
        request.reject(new Error('ACP process returned non-JSON output'));
      }
      pending.clear();
      child.kill();
      return;
    }
    if (value.method && value.id !== undefined) {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: value.id,
          result: { outcome: { outcome: 'cancelled' } },
        }) + '\n'
      );
    } else if (value.id !== undefined) {
      const request = pending.get(value.id);
      if (request) {
        pending.delete(value.id);
        if (value.error)
          request.reject(
            new Error(`${value.error.message}: ${JSON.stringify(value.error.data)}; ${diagnostics}`)
          );
        else request.resolve(value.result);
      }
    }
  });
  child.on('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  child.on('exit', () => {
    for (const request of pending.values()) request.reject(new Error('ACP adapter exited'));
    pending.clear();
    lines.close();
  });
  return {
    call(method: string, params: unknown): Promise<unknown> {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP ${method} timed out`));
        }, 30000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    },
  };
}
