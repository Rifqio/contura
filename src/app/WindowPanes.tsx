import type { ComponentProps, MutableRefObject } from "react";
import type { ConnectionConfig, GroupId } from "../api/types";
import Home from "../components/Home";
import FlowTab from "../flow/FlowTab";
import SchemaBuilder from "../schema/SchemaBuilder";
import SettingsView from "../settings/SettingsView";
import { type SettingsSection, type WindowTab, tabKey } from "../shell/tabs";

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
    onSection(section: SettingsSection): void;
    onConnectionSaved(): void;
  };
  schema: {
    onClose(key: string): void;
    closeRef(id: string): MutableRefObject<(() => void) | null>;
    onPathChange(id: string, path: string): void;
    ask: ComponentProps<typeof SchemaBuilder>["ask"];
    sourceConnection(id: string): ComponentProps<typeof SchemaBuilder>["sourceConnection"];
  };
}

/** The window tabs (Home, Settings, Schema Models, diagrams) as panes of the work area. */
export default function WindowPanes({ windowTabs, activeKey, home, settings, schema }: Props) {
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
                sectionRequest={t.seq}
                onSection={(section) => settings.onSection(section)}
                groupId={settings.groupId}
                groupName={settings.groupName}
                connections={settings.connections}
                onConnectionSaved={() => settings.onConnectionSaved()}
              />
            </div>
          );
        }
        if (t.kind === "flow") {
          return (
            <div key={key} className="work-pane schema-main" data-flow-name={t.name} hidden={key !== activeKey}>
              <FlowTab name={t.name} />
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
            />
          </div>
        );
      })}
    </>
  );
}
