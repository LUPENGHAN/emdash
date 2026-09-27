import { Button, Field, Input, Select, Switch, Textarea, toast } from '@emdash/ui/react/primitives';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { openModal } from '@core/manifests/browser/modal-api';
import { DEFAULT_AGENT_LIBRARY_SETTINGS, type LibraryMcpServer } from '../../api';
import { ScopePicker } from './scope-picker';

/** An MCP server as the agents' own configs report it (for import). */
export type AgentConfiguredMcpServer = Omit<LibraryMcpServer, 'enabled' | 'projects'> & {
  providers: string[];
};

/**
 * Emdash's MCP library: servers every agent started in Emdash gets for its session,
 * without touching the agents' own configs. Global or limited to some projects.
 */
export function McpLibraryPanel({
  agentServers,
}: {
  agentServers: readonly AgentConfiguredMcpServer[];
}) {
  const { value, updateAsync } = useAppSettingsKey('agentLibrary');
  const settings = value ?? DEFAULT_AGENT_LIBRARY_SETTINGS;
  const servers = settings.mcpServers;
  const [editing, setEditing] = useState<LibraryMcpServer | 'new' | null>(null);

  const save = (next: LibraryMcpServer[]) => updateAsync({ ...settings, mcpServers: next });
  const missing = agentServers.filter(
    (server) => !servers.some((existing) => existing.name === server.name)
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-foreground-muted">
        Every agent started in Emdash (Claude Code, Codex and OpenCode, in the terminal or the chat)
        gets these servers for its session; the agents’ own configs stay as they are. Pi has no MCP
        support and Cursor only reads its own config.
      </p>
      {missing.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-xs">
          <span>
            {missing.length} server{missing.length === 1 ? '' : 's'} in your agents’ configs (
            {missing.map((server) => server.name).join(', ')}) {missing.length === 1 ? 'is' : 'are'}{' '}
            not in the library.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void save([
                ...servers,
                ...missing.map(({ providers: _providers, ...server }) => ({
                  ...server,
                  enabled: true,
                })),
              ]).then(() =>
                toast.success(`Imported ${missing.length} server${missing.length === 1 ? '' : 's'}`)
              )
            }
          >
            Import into the library
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {servers.map((server) =>
          editing !== 'new' && editing?.name === server.name ? (
            <li key={server.name}>
              <McpServerForm
                initial={server}
                takenNames={servers.filter((s) => s.name !== server.name).map((s) => s.name)}
                onCancel={() => setEditing(null)}
                onSave={(saved) =>
                  void save(servers.map((s) => (s.name === server.name ? saved : s))).then(() =>
                    setEditing(null)
                  )
                }
              />
            </li>
          ) : (
            <li
              key={server.name}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <Switch
                checked={server.enabled !== false}
                onCheckedChange={(enabled) =>
                  void save(servers.map((s) => (s.name === server.name ? { ...s, enabled } : s)))
                }
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{server.name}</div>
                <div className="truncate font-mono text-xs text-foreground-muted">
                  {server.transport === 'http'
                    ? server.url
                    : [server.command, ...(server.args ?? [])].join(' ')}
                </div>
              </div>
              <ScopePicker
                projects={server.projects}
                onChange={(projects) =>
                  void save(
                    servers.map((s) =>
                      s.name === server.name
                        ? { ...s, projects: projects.length ? projects : undefined }
                        : s
                    )
                  )
                }
              />
              <Button size="sm" icon variant="ghost" onClick={() => setEditing(server)}>
                <Pencil className="size-4" />
              </Button>
              <Button
                size="sm"
                icon
                variant="ghost"
                onClick={() =>
                  void (async () => {
                    const confirmed = await openModal('confirmActionModal', {
                      title: `Remove ${server.name}?`,
                      description:
                        'Agents started in Emdash stop getting it; the agents’ own configs are not changed.',
                      confirmLabel: 'Remove',
                    });
                    if (confirmed.success)
                      await save(servers.filter((s) => s.name !== server.name));
                  })()
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          )
        )}
      </ul>
      {editing === 'new' ? (
        <McpServerForm
          takenNames={servers.map((s) => s.name)}
          onCancel={() => setEditing(null)}
          onSave={(saved) => void save([...servers, saved]).then(() => setEditing(null))}
        />
      ) : (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
            <Plus className="size-4" />
            Add server
          </Button>
        </div>
      )}
    </div>
  );
}

function McpServerForm({
  initial,
  takenNames,
  onCancel,
  onSave,
}: {
  initial?: LibraryMcpServer;
  takenNames: string[];
  onCancel: () => void;
  onSave: (server: LibraryMcpServer) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial?.transport ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'));
  const [env, setEnv] = useState(pairsToText(initial?.env, '='));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [headers, setHeaders] = useState(pairsToText(initial?.headers, ': '));

  const submit = () => {
    const trimmed = name.trim();
    if (!/^[\w .-]+$/.test(trimmed))
      return toast.error('Use letters, digits, spaces, . _ or - in the name');
    if (takenNames.includes(trimmed))
      return toast.error(`There is already a server named ${trimmed}`);
    if (transport === 'stdio' && !command.trim()) return toast.error('Enter the command to run');
    if (transport === 'http' && !/^https?:\/\//.test(url.trim()))
      return toast.error('Enter an http(s) URL');
    onSave({
      name: trimmed,
      transport,
      enabled: initial?.enabled ?? true,
      projects: initial?.projects,
      ...(transport === 'stdio'
        ? {
            command: command.trim(),
            args: args
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean),
            env: textToPairs(env, '='),
          }
        : { url: url.trim(), headers: textToPairs(headers, ':') }),
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <Field.Group>
        <Field.Root>
          <Field.Label>Name</Field.Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field.Root>
        <Field.Root>
          <Field.Label>Type</Field.Label>
          <Select.Root
            value={transport}
            onValueChange={(next) => next && setTransport(next as 'stdio' | 'http')}
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value>
                {transport === 'stdio' ? 'Command (stdio)' : 'URL (HTTP)'}
              </Select.Value>
            </Select.Trigger>
            <Select.Content align="start" width="trigger">
              <Select.Item value="stdio">Command (stdio)</Select.Item>
              <Select.Item value="http">URL (HTTP)</Select.Item>
            </Select.Content>
          </Select.Root>
        </Field.Root>
        {transport === 'stdio' ? (
          <>
            <Field.Root>
              <Field.Label>Command</Field.Label>
              <Input
                value={command}
                placeholder="npx"
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field.Root>
            <Field.Root>
              <Field.Label>Arguments (one per line)</Field.Label>
              <Textarea value={args} rows={3} onChange={(event) => setArgs(event.target.value)} />
            </Field.Root>
            <Field.Root>
              <Field.Label>Environment (KEY=value per line)</Field.Label>
              <Textarea value={env} rows={2} onChange={(event) => setEnv(event.target.value)} />
            </Field.Root>
          </>
        ) : (
          <>
            <Field.Root>
              <Field.Label>URL</Field.Label>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} />
            </Field.Root>
            <Field.Root>
              <Field.Label>Headers (Name: value per line)</Field.Label>
              <Textarea
                value={headers}
                rows={2}
                onChange={(event) => setHeaders(event.target.value)}
              />
            </Field.Root>
          </>
        )}
      </Field.Group>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function pairsToText(record: Record<string, string> | undefined, separator: string): string {
  return Object.entries(record ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n');
}

function textToPairs(text: string, separator: string): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(separator);
      return index === -1
        ? null
        : ([line.slice(0, index).trim(), line.slice(index + separator.length).trim()] as const);
    })
    .filter((pair): pair is readonly [string, string] => pair !== null && pair[0].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
