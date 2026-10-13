import { Button, Checkbox, toast } from '@emdash/ui/react/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAgentsClient } from '@core/features/agents/api/browser/client';
import { invalidateAppSettingsKey } from '@core/features/settings/api/browser/app-settings-client';
import { describeProvider, type ModelProvider, type ProviderImportPreview } from '../api';

type ImportFile = { token: string; providers: ProviderImportPreview[]; skipped: number };

/** Export and import buttons for API providers, each opening a panel to choose which ones. */
export function ProviderTransfer({ providers }: { providers: ModelProvider[] }) {
  const [mode, setMode] = useState<'export' | ImportFile | null>(null);

  const chooseImportFile = async () => {
    try {
      const file = await (await getAgentsClient()).readModelProvidersImport({});
      if (file) setMode(file);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-3">
      {mode === null ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={providers.length === 0}
            onClick={() => setMode('export')}
          >
            Export…
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void chooseImportFile()}>
            Import…
          </Button>
        </div>
      ) : mode === 'export' ? (
        <ExportPanel providers={providers} onDone={() => setMode(null)} />
      ) : (
        <ImportPanel file={mode} onDone={() => setMode(null)} />
      )}
    </div>
  );
}

function ExportPanel({ providers, onDone }: { providers: ModelProvider[]; onDone: () => void }) {
  const [selected, setSelected] = useState(() => providers.map((provider) => provider.id));
  const [includeKeys, setIncludeKeys] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const result = await (
        await getAgentsClient()
      ).exportModelProviders({ providerIds: selected, includeKeys });
      if (result.path) {
        toast.success(
          result.count === 1 ? 'Exported 1 provider' : `Exported ${result.count} providers`
        );
        onDone();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium text-foreground">Export providers</p>
      <ChoiceList
        items={providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          details: [describeProvider(provider), `Models: ${provider.models.length}`],
        }))}
        selected={selected}
        onChange={setSelected}
      />
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={includeKeys}
          onCheckedChange={(checked) => setIncludeKeys(checked === true)}
        />
        <span>
          Include API keys
          <span className="block text-xs text-foreground-muted">
            The file holds them in plain text: anyone with it can use them. Keep it private.
          </span>
        </span>
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || selected.length === 0} onClick={() => void run()}>
          Export
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ImportPanel({ file, onDone }: { file: ImportFile; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => file.providers.map((provider) => provider.id));
  const anyKey = file.providers.some((provider) => provider.hasKey);
  const [includeKeys, setIncludeKeys] = useState(anyKey);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const result = await (
        await getAgentsClient()
      ).importModelProviders({ token: file.token, providerIds: selected, includeKeys });
      invalidateAppSettingsKey('modelProviders');
      await queryClient.invalidateQueries({ queryKey: ['modelProviderKeyStatus'] });
      toast.success(
        result.imported === 1 ? 'Imported 1 provider' : `Imported ${result.imported} providers`
      );
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium text-foreground">Import providers</p>
      <ChoiceList
        items={file.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          details: [
            provider.description,
            `Models: ${provider.models}`,
            provider.hasKey ? 'Key included' : 'No key',
            provider.exists ? 'Replaces the existing one' : null,
          ],
          warning: provider.previousUrl
            ? includeKeys && provider.hasKey
              ? `Moves from ${provider.previousUrl}`
              : `Moves from ${provider.previousUrl}; its saved key is removed`
            : null,
        }))}
        selected={selected}
        onChange={setSelected}
      />
      {file.skipped > 0 ? (
        <p className="text-xs text-foreground-muted">
          {file.skipped === 1
            ? '1 entry could not be read and is left out.'
            : `${file.skipped} entries could not be read and are left out.`}
        </p>
      ) : null}
      {anyKey ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={includeKeys}
            onCheckedChange={(checked) => setIncludeKeys(checked === true)}
          />
          Import API keys into the keychain
        </label>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || selected.length === 0} onClick={() => void run()}>
          Import
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ChoiceList({
  items,
  selected,
  onChange,
}: {
  items: { id: string; name: string; details: (string | null)[]; warning?: string | null }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const allSelected = items.length > 0 && items.every((item) => selected.includes(item.id));
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 px-2 py-1 text-xs text-foreground-muted">
        <Checkbox
          checked={allSelected}
          onCheckedChange={(checked) => onChange(checked === true ? items.map((i) => i.id) : [])}
        />
        Select all
      </label>
      <ul className="max-h-72 overflow-y-auto rounded-md border border-border">
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex items-start gap-2 px-2 py-1.5 hover:bg-background-1">
              <Checkbox
                checked={selected.includes(item.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...new Set([...selected, item.id])]
                      : selected.filter((id) => id !== item.id)
                  )
                }
              />
              <span className="min-w-0">
                <span className="block truncate text-sm text-foreground">{item.name}</span>
                {item.details
                  .filter((detail): detail is string => Boolean(detail))
                  .map((detail) => (
                    <span key={detail} className="mr-2 text-xs text-foreground-muted">
                      {detail}
                    </span>
                  ))}
                {item.warning ? (
                  <span className="block text-xs text-foreground-destructive">{item.warning}</span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
