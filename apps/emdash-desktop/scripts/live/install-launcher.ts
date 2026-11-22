import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER_PATH = '/Applications/Emdash Live.app';
const LAUNCH_AGENT_LABEL = 'com.emdash.live';

function swiftString(value: string): string {
  return JSON.stringify(value);
}

export function launcherSwiftSource(repoRoot: string): string {
  const electronExecutable = join(
    repoRoot,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  );

  return `import AppKit
import Foundation

let expectedExecutable = ${swiftString(electronExecutable)}
let launchAgentLabel = ${swiftString(LAUNCH_AGENT_LABEL)}
let launchAgentPlist = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/LaunchAgents/\\(launchAgentLabel).plist").path
let launchDomain = "gui/\\(getuid())"
let serviceTarget = "\\(launchDomain)/\\(launchAgentLabel)"

@discardableResult
func launchctl(_ arguments: [String]) -> Int32 {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
  process.arguments = arguments
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  do {
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  } catch {
    return 127
  }
}

func runningLiveApp() -> NSRunningApplication? {
  NSWorkspace.shared.runningApplications.first { application in
    application.executableURL?.standardizedFileURL.path == expectedExecutable
  }
}

@discardableResult
func activateLiveApp() -> Bool {
  guard let application = runningLiveApp() else { return false }
  return application.activate(options: [.activateAllWindows])
}

if activateLiveApp() {
  exit(EXIT_SUCCESS)
}

if launchctl(["print", serviceTarget]) != 0 {
  guard FileManager.default.fileExists(atPath: launchAgentPlist) else {
    NSApplication.shared.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "无法启动 Emdash 实时版"
    alert.informativeText = "没有找到实时服务配置：\\n\\(launchAgentPlist)\\n\\n请在 Emdash 源码仓库重新运行 pnpm live:install-launcher。"
    alert.alertStyle = .critical
    alert.runModal()
    exit(EXIT_FAILURE)
  }
  _ = launchctl(["bootstrap", launchDomain, launchAgentPlist])
}

_ = launchctl(["kickstart", serviceTarget])

let deadline = Date().addingTimeInterval(30)
while Date() < deadline {
  if activateLiveApp() {
    exit(EXIT_SUCCESS)
  }
  RunLoop.current.run(until: Date().addingTimeInterval(0.2))
}

NSApplication.shared.setActivationPolicy(.regular)
NSApp.activate(ignoringOtherApps: true)
let alert = NSAlert()
alert.messageText = "Emdash 实时版启动超时"
alert.informativeText = "实时服务已经唤醒，但 30 秒内没有发现源码应用窗口。请运行 pnpm live:status 查看状态。"
alert.alertStyle = .warning
alert.runModal()
exit(EXIT_FAILURE)
`;
}

export function launcherInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Emdash 实时版</string>
  <key>CFBundleExecutable</key>
  <string>EmdashLiveLauncher</string>
  <key>CFBundleIconFile</key>
  <string>EmdashLive.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.emdash.live.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Emdash Live</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

export function installLiveLauncher(repoRoot: string, targetPath = LAUNCHER_PATH): void {
  if (process.platform !== 'darwin') {
    throw new Error('Emdash Live 快速启动器只支持 macOS。');
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'emdash-live-launcher-'));
  const bundle = join(temporaryRoot, 'Emdash Live.app');
  const contents = join(bundle, 'Contents');
  const macOS = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');
  const swiftPath = join(temporaryRoot, 'EmdashLiveLauncher.swift');
  const executable = join(macOS, 'EmdashLiveLauncher');
  const iconSource = join(
    repoRoot,
    'apps/emdash-desktop/src/assets/images/emdash/emdash-canary.icns'
  );

  try {
    mkdirSync(macOS, { recursive: true });
    mkdirSync(resources, { recursive: true });
    writeFileSync(swiftPath, launcherSwiftSource(repoRoot));
    writeFileSync(join(contents, 'Info.plist'), launcherInfoPlist());
    if (existsSync(iconSource)) cpSync(iconSource, join(resources, 'EmdashLive.icns'));

    execFileSync(
      'xcrun',
      ['swiftc', swiftPath, '-framework', 'AppKit', '-o', executable],
      { stdio: 'inherit' }
    );
    chmodSync(executable, 0o755);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], {
      stdio: 'inherit',
    });

    // This bundle is generated entirely from this script. Replacing this exact target is safe and
    // avoids Launch Services retaining an obsolete executable after a launcher update.
    rmSync(targetPath, { recursive: true, force: true });
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(bundle, targetPath, { recursive: true, preserveTimestamps: true });
    execFileSync('codesign', ['--verify', '--deep', '--strict', targetPath], {
      stdio: 'inherit',
    });
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', targetPath]
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    installLiveLauncher(repoRoot);
    console.log(`已安装 ${LAUNCHER_PATH}`);
    console.log('可以从“应用程序”打开，也可以拖到 Dock；它只会激活同一个源码实时版。');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
