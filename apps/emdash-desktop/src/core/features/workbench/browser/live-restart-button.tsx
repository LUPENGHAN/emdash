import { Button, Tooltip, toast } from '@emdash/ui/react/primitives';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { IS_LIVE } from '@core/primitives/app-identity/api/app-identity';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';

/** Immediately replaces the current live Electron process with the latest source build. */
export function LiveRestartButton() {
  if (!IS_LIVE) return null;
  return <LiveRestartControl />;
}

function LiveRestartControl() {
  const [restarting, setRestarting] = useState(false);
  const openConfirm = useOpenModal('confirmActionModal');

  const restart = async () => {
    if (restarting) return;
    const confirmation = await openConfirm({
      title: '立即完整重启 Emdash？',
      description:
        '当前窗口会立即关闭，正在运行的 Agent 和终端会被中断。现有 Supervisor 会在旧进程完全退出后启动唯一的新实例，并加载最新代码。',
      confirmLabel: '立即重启',
      cancelLabel: '取消',
      variant: 'destructive',
    });
    if (!confirmation.success) return;
    setRestarting(true);
    try {
      const result = await (await getHostClient()).controlLiveRuntime({ action: 'restart' });
      if (!result.success) throw new Error(result.error);
      toast.success('正在完整重启 Emdash');
    } catch (error) {
      setRestarting(false);
      toast.error('完整重启失败', { description: String(error) });
    }
  };

  return (
    <Tooltip.Root>
      <Tooltip.Trigger>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0 [-webkit-app-region:no-drag]"
          aria-label="立即完整重启"
          disabled={restarting}
          onClick={() => void restart()}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{restarting ? '正在完整重启…' : '立即完整重启'}</Tooltip.Content>
    </Tooltip.Root>
  );
}
