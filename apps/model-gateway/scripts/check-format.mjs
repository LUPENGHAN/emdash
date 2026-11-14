import { execFileSync } from 'node:child_process';
const output = execFileSync('gofmt', ['-l', 'main.go', 'main_test.go', 'internal/gateway'], {
  encoding: 'utf8',
});
if (output.trim()) {
  process.stderr.write(output);
  process.exitCode = 1;
}
