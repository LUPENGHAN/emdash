import { Dialog } from '@emdash/ui/react/primitives';
import { AppWindow, PanelsTopLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { openModal, useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import type { RemoteServer } from '../api';
import { openComputerWindow, switchComputer } from './computer-switch';

function ChoiceButton({
  icon,
  title,
  description,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-md border border-border px-3 py-3 text-left hover:bg-background-1 disabled:opacity-50"
    >
      <span className="mt-0.5 shrink-0 text-foreground-muted">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs text-foreground-muted">{description}</span>
      </span>
    </button>
  );
}

function OpenComputerModal({ server }: { server: RemoteServer }) {
  const { complete } = useModalController('openComputerModal');
  const [busy, setBusy] = useState(false);
  const choose = (where: 'here' | 'window') => {
    setBusy(true);
    complete({ where });
    if (where === 'here') void switchComputer(server.id, server.name);
    else void openComputerWindow(server.id, server.name);
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>
          Open <span translate="no">{server.name}</span>
        </Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-2">
          <ChoiceButton
            icon={<PanelsTopLeft className="size-5" />}
            title="In this window"
            description="This window switches to that computer."
            disabled={busy}
            onClick={() => choose('here')}
          />
          <ChoiceButton
            icon={<AppWindow className="size-5" />}
            title="In a new window"
            description="This window stays as it is; a new one opens on that computer."
            disabled={busy}
            onClick={() => choose('window')}
          />
        </div>
      </Dialog.Body>
    </>
  );
}

export const openComputerModal = defineModal<{ where: 'here' | 'window' }>()({
  id: 'openComputerModal',
  component: OpenComputerModal,
});

/** Asks whether to open the computer here or in a new window. */
export function chooseComputerWindow(server: RemoteServer): void {
  void openModal('openComputerModal', { server });
}
