import { useEffect, useMemo, useRef, useState } from "react";
import { aiSettings } from "../api/client";
import type { ConnectionConfig, GroupId } from "../api/types";
import type { AskContext, AskKit } from "../assistant/context";
import type { Place } from "../shell/tabs";
import { answerText } from "./queryTabRefs";

/** The inline Ask's settings and "open in chat" seed for the Group being worked in. */
export function useAskKit(opts: {
  groupId: GroupId | null;
  settingsActive: boolean;
  activeKey: string | null;
  place: Place;
  connections: ConnectionConfig[];
  /** "Open in chat": App opens the panel. */
  openPanel(): void;
  /** App: openSettings("ai"). */
  openAiSettings(): void;
  /** "Open in new tab" on an answer's SQL: App opens a query tab with the text. */
  openQuery(connectionId: string | null, text: string, database: string | null): void;
}): { askKit: AskKit; chatSeed: { question: string; context: AskContext } | undefined } {
  const { groupId, settingsActive, activeKey, place, connections } = opts;
  /** A question carried into the panel by "Open in chat"; it ends when you move to another tab or place. */
  const [chatSeed, setChatSeed] = useState<{ question: string; context: AskContext } | undefined>(undefined);
  const [askSettings, setAskSettings] = useState({ inlineAsk: true, errorAsk: true });
  useEffect(() => {
    if (settingsActive) return;
    let live = true;
    aiSettings(groupId)
      .then((v) => live && setAskSettings({ inlineAsk: v.settings.inlineAsk, errorAsk: v.settings.errorAsk }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [groupId, settingsActive]);
  useEffect(() => setChatSeed(undefined), [activeKey, place]);
  // A question kept from before an access change must not outlive it.
  useEffect(() => setChatSeed(undefined), [settingsActive, connections]);
  const actions = useRef({ openPanel: opts.openPanel, openAiSettings: opts.openAiSettings, openQuery: opts.openQuery });
  actions.current.openPanel = opts.openPanel;
  actions.current.openAiSettings = opts.openAiSettings;
  actions.current.openQuery = opts.openQuery;
  const askKit = useMemo<AskKit>(
    () => ({
      groupId,
      inlineAsk: askSettings.inlineAsk,
      errorAsk: askSettings.errorAsk,
      onOpenInChat: (seed) => {
        setChatSeed({ ...seed });
        actions.current.openPanel();
      },
      onOpenSettings: () => actions.current.openAiSettings(),
      onOpenInNewTab: (sql, connection) =>
        actions.current.openQuery(connection?.id ?? null, answerText(sql), connection?.database ?? null),
    }),
    [groupId, askSettings],
  );
  return { askKit, chatSeed };
}
