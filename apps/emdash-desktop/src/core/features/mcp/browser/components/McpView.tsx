import { LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { PageLayout } from '@emdash/ui/react/patterns';
import React from 'react';
import { McpLibraryPanel } from '@core/features/agent-library/contributions/browser/mcp-library-panel';
import { McpPanel } from '@core/features/mcp/contributions/browser/McpPanel';
import { useInstalledMcpServersLiveModel } from '../live-model-hooks';

export const McpView: React.FC = () => {
  const { data: agentServers } = useInstalledMcpServersLiveModel(LOCAL_HOST_REF);
  return (
    <div className="flex flex-col gap-8 text-foreground">
      <PageLayout.Header
        sticky
        title="MCP"
        description="Servers Emdash gives the agents it starts"
      />
      <McpLibraryPanel agentServers={agentServers} />
      <McpPanel
        host={LOCAL_HOST_REF}
        header={{
          title: 'In the agents’ own configs',
          description:
            'What each agent loads on its own, also outside Emdash. Import them above to manage them in one place.',
        }}
      />
    </div>
  );
};
