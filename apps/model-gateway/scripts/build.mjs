import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root, env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} failed (${result.status})`);
};
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false
  );
const targetArg = process.argv.indexOf('--target');
const target =
  (targetArg >= 0 ? process.argv[targetArg + 1] : undefined) ??
  process.env.EMDASH_GATEWAY_TARGET ??
  `${process.platform}-${process.arch}`;
const [platform, arch] = target.split('-');
const goos = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
const goarch = { arm64: 'arm64', x64: 'amd64' }[arch];
if (!goos || !goarch) throw new Error(`Unsupported gateway target: ${target}`);
const dist = join(root, 'dist');
const targetDir = join(
  dist,
  `${{ darwin: 'mac', win32: 'win', linux: 'linux' }[platform]}-${arch}`
);
await mkdir(targetDir, { recursive: true });
run(
  'go',
  [
    'build',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    join(targetDir, platform === 'win32' ? 'model-gateway.exe' : 'model-gateway'),
    '.',
  ],
  root,
  { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' }
);
const sdk = JSON.parse(
  execFileSync('go', ['list', '-m', '-json', 'github.com/router-for-me/CLIProxyAPI/v8'], {
    cwd: root,
    encoding: 'utf8',
  })
);
await cp(join(sdk.Dir, 'LICENSE'), join(dist, 'cliproxy.LICENSE'));
const notices = [];
const includeNotices = async (dir, label) => {
  if (!(await exists(dir))) return;
  for (const name of await readdir(dir)) {
    if (!/^(licen[sc]e|copying|notice|copyright)([._-]|$)/i.test(name)) continue;
    const contents = await readFile(join(dir, name), 'utf8').catch(() => '');
    if (contents) notices.push(`${label}\n${name}\n\n${contents}`);
  }
};
const modules = execFileSync('go', ['list', '-m', '-json', 'all'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split(/\n(?=\{)/)
  .map(JSON.parse);
for (const module of modules) {
  const resolved = module.Replace ?? module;
  if (resolved.Dir && !module.Main)
    await includeNotices(resolved.Dir, `${resolved.Path} ${resolved.Version}`);
}
await includeNotices(
  execFileSync('go', ['env', 'GOROOT'], { cwd: root, encoding: 'utf8' }).trim(),
  'Go runtime'
);
await writeFile(
  join(dist, 'THIRD-PARTY-NOTICES.txt'),
  notices.join('\n\n' + '='.repeat(80) + '\n\n')
);
console.log(`Model gateway resources built for ${target}`);
