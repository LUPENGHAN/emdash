import { UsageStatsButton } from '@core/features/usage-stats/contributions/browser/usage-stats-button';
import { SidebarRecoveryControls } from '@core/features/workbench/browser/sidebar-recovery-controls';
import { WindowControls } from '@core/features/workbench/browser/window-controls';
import { useWorkspaceLayoutContext } from '@core/features/workbench/contributions/browser/layout-provider';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { cn } from '@core/primitives/styling/browser/cn';

const platform = detectPlatformContext().os;
// Only the desktop window has traffic lights; the same UI in a browser (remote access,
// where an iPad also reports itself as a Mac) has none to clear room for.
const hasTrafficLights =
  platform === 'mac' && typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent);
// Window controls drive the computer's own window: never from a browser (an Android
// phone reports itself as Linux), where they would close Emdash on the computer.
const isLinux =
  platform === 'linux' &&
  typeof navigator !== 'undefined' &&
  /Electron\//.test(navigator.userAgent);

export function BorderlessTitlebar() {
  const { isLeftOpen, toggleLeftSidebar } = useWorkspaceLayoutContext();

  return (
    <header
      data-borderless-titlebar
      className={cn(
        'absolute inset-x-0 top-0 z-20 flex h-10 items-center bg-background [-webkit-app-region:drag]',
        !isLeftOpen && hasTrafficLights && 'pl-18',
        isLinux ? 'pr-0' : 'pr-2'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        {!isLeftOpen && <SidebarRecoveryControls onShowSidebar={toggleLeftSidebar} />}
      </div>
      <UsageStatsButton />
      {isLinux && <WindowControls />}
    </header>
  );
}
