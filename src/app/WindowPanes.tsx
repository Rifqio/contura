import type { ComponentProps, MutableRefObject } from "react";
import type { ConnectionConfig, Group, GroupId, JobId } from "../api/types";
import Home from "../components/Home";
import FlowTab from "../flow/FlowTab";
import SchemaBuilder from "../schema/SchemaBuilder";
import SettingsView from "../settings/SettingsView";
import TransferTab from "../transfer/TransferTab";
import CompareTab from "../compare/CompareTab";
import { type AiPage, type SettingsSection, type WindowTab, tabKey } from "../shell/tabs";

/** Home's props, built in App; `active` is set here from the tab on top. */
export type HomeProps = Omit<ComponentProps<typeof Home>, "active">;

interface Props {
  windowTabs: WindowTab[];
  activeKey: string | null;
  home: HomeProps;
  settings: {
    groupId: GroupId | null;
    groupName: string | null;
    connections: ConnectionConfig[];
    onSection(section: SettingsSection, aiPage?: AiPage): void;
    onConnectionSaved(): void;
    onShowGuide(): void;
  };
  schema: {
    onClose(key: string): void;
    closeRef(id: string): MutableRefObject<(() => void) | null>;
    onPathChange(id: string, path: string): void;
    ask: ComponentProps<typeof SchemaBuilder>["ask"];
    sourceConnection(id: string): ComponentProps<typeof SchemaBuilder>["sourceConnection"];
    onApplyToConnection: ComponentProps<typeof SchemaBuilder>["onApplyToConnection"];
  };
  transfer: {
    /** Every Connection and Group: a transfer may span two Groups. */
    connections: ConnectionConfig[];
    groups: Group[];
    onMeta(id: string, title: string, dirty: boolean): void;
    onJob(id: string, job: JobId | null): void;
    onOpenInEditor: ComponentProps<typeof TransferTab>["onOpenInEditor"];
    onOpenTarget: ComponentProps<typeof TransferTab>["onOpenTarget"];
  };
  flow: {
    /** The AI settings at the tools table, from a diagram assistant's tool-off note. */
    onOpenSettings(): void;
  };
  compare: {
    /** Every Connection and Group: a compare may span two Groups. */
    connections: ConnectionConfig[];
    groups: Group[];
    onMeta(id: string, title: string, connectionId: string | null): void;
    onOpenInEditor: ComponentProps<typeof CompareTab>["onOpenInEditor"];
    onApplied: ComponentProps<typeof CompareTab>["onApplied"];
    onJob(id: string, job: JobId | null): void;
  };
}

/** The window tabs (Home, Settings, Schema Models, diagrams) as panes of the work area. */
export default function WindowPanes({ windowTabs, activeKey, home, settings, schema, transfer, flow, compare }: Props) {
  return (
    <>
      {windowTabs.map((t) => {
        const key = tabKey(t);
        if (t.kind === "home") {
          return (
            <div key={key} className="work-pane home-main" hidden={key !== activeKey}>
              <Home {...home} active={key === activeKey} />
            </div>
          );
        }
        if (t.kind === "settings") {
          return (
            <div key={key} className="work-pane settings-main" hidden={key !== activeKey}>
              <SettingsView
                section={t.section}
                aiPage={t.aiPage}
                sectionRequest={t.seq}
                row={t.row}
                onSection={(section, aiPage) => settings.onSection(section, aiPage)}
                groupId={settings.groupId}
                groupName={settings.groupName}
                connections={settings.connections}
                onConnectionSaved={() => settings.onConnectionSaved()}
                onShowGuide={() => settings.onShowGuide()}
              />
            </div>
          );
        }
        if (t.kind === "flow") {
          return (
            <div key={key} className="work-pane schema-main" data-flow-name={t.name} hidden={key !== activeKey}>
              <FlowTab name={t.name} active={key === activeKey} onOpenSettings={flow.onOpenSettings} />
            </div>
          );
        }
        if (t.kind === "transfer") {
          // Stays mounted while hidden, so a running transfer keeps its view.
          return (
            <div key={key} className="work-pane transfer-main" hidden={key !== activeKey}>
              <TransferTab
                seed={t.seed}
                connections={transfer.connections}
                groups={transfer.groups}
                visible={key === activeKey}
                onMeta={(title, dirty) => transfer.onMeta(t.id, title, dirty)}
                onJob={(job) => transfer.onJob(t.id, job)}
                onOpenInEditor={transfer.onOpenInEditor}
                onOpenTarget={transfer.onOpenTarget}
              />
            </div>
          );
        }
        if (t.kind === "compare") {
          // Stays mounted while hidden, so a running Apply keeps its view.
          return (
            <div key={key} className="work-pane compare-main" hidden={key !== activeKey}>
              <CompareTab
                seed={t.seed}
                connections={compare.connections}
                groups={compare.groups}
                visible={key === activeKey}
                onMeta={(title, connectionId) => compare.onMeta(t.id, title, connectionId)}
                onOpenInEditor={compare.onOpenInEditor}
                onApplied={compare.onApplied}
                onJob={(job) => compare.onJob(t.id, job)}
              />
            </div>
          );
        }
        return (
          <div key={key} className="work-pane schema-main" hidden={key !== activeKey}>
            <SchemaBuilder
              doc={t.doc}
              onClose={() => schema.onClose(key)}
              closeRef={schema.closeRef(t.id)}
              onPathChange={(path) => schema.onPathChange(t.id, path)}
              ask={schema.ask}
              sourceConnection={schema.sourceConnection(t.id)}
              onApplyToConnection={schema.onApplyToConnection}
            />
          </div>
        );
      })}
    </>
  );
}
