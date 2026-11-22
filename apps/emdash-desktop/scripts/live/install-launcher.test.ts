import { describe, expect, it } from 'vitest';
import { launcherInfoPlist, launcherSwiftSource } from './install-launcher';

describe('Emdash Live launcher', () => {
  it('activates the source Electron and wakes the existing LaunchAgent', () => {
    const source = launcherSwiftSource('/Users/tester/emdash');

    expect(source).toContain(
      '/Users/tester/emdash/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    );
    expect(source).toContain('application.activate');
    expect(source).toContain('launchctl(["bootstrap"');
    expect(source).toContain('launchctl(["kickstart"');
    expect(source).not.toContain('ProcessInfo.processInfo.arguments');
  });

  it('uses a launcher-only bundle identity', () => {
    const plist = launcherInfoPlist();

    expect(plist).toContain('<string>com.emdash.live.launcher</string>');
    expect(plist).toContain('<string>Emdash 实时版</string>');
    expect(plist).not.toContain('com.emdash.fork');
  });
});
