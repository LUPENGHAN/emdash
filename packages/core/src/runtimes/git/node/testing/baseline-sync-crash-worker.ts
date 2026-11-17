import { ok } from '@emdash/shared';
import { localBranchRefSchema } from '#runtimes/git/api';
import { GitRuntime } from '#runtimes/git/node/git-runtime';
import { hostPath } from '#runtimes/git/node/testing/paths';
import { createBoundExec, type BoundExec } from '#services/exec/api';

/** Native child-process fault fixture: the parent kills this process at the reported boundary. */
const [repository, stage] = process.argv.slice(2);
if (!repository || !['after-fetch', 'after-merge', 'complete'].includes(stage ?? ''))
  throw new Error('Expected a fixture checkout and crash boundary.');

function wrap(exec: BoundExec): BoundExec {
  const execute = exec.exec.bind(exec);
  const withCwd = exec.withCwd.bind(exec);
  exec.withCwd = (cwd) => wrap(withCwd(cwd));
  exec.exec = async (args, options) => {
    const result = await execute(args, options);
    if (
      (stage === 'after-fetch' && args[0] === 'fetch') ||
      (stage === 'after-merge' && args.includes('merge'))
    ) {
      process.send?.({ phase: stage });
      setInterval(() => {}, 1000);
      await new Promise<void>(() => {});
    }
    return result;
  };
  return exec;
}

const runtime = new GitRuntime({
  exec: wrap(createBoundExec({ file: 'git', cwd: repository })),
  watcher: {
    watch: () => ({ ready: async () => ok(undefined), release: async () => {} }),
    dispose: async () => {},
  },
});
try {
  const result = await runtime.checkout.syncBaseline(
    {
      checkout: hostPath(repository),
      remote: 'upstream',
      upstreamRef: localBranchRefSchema.parse('refs/heads/develop'),
      baselineRef: localBranchRefSchema.parse('refs/heads/develop'),
    },
    { jobId: 'crash-fixture', signal: new AbortController().signal, progress: () => {} }
  );
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('Missing fixture IPC channel'));
    process.send({ phase: 'complete', result }, (error) => (error ? reject(error) : resolve()));
  });
} finally {
  await runtime.dispose();
  process.disconnect?.();
}
