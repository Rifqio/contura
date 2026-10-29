import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { aiKnownModels } from "../api/client";
import { aiSettingsChanged } from "../api/changes";
import type { GroupId, ModelList } from "../api/types";

/**
 * The models known without the network for the Group, read again when the settings, the current model or a
 * fetched listing (Settings "Fetch again") are saved anywhere, so the picker's rows never wait for a restart.
 */
export function useKnownModels(groupId: GroupId | null): [ModelList | null, Dispatch<SetStateAction<ModelList | null>>] {
  const [models, setModels] = useState<ModelList | null>(null);
  useEffect(() => {
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      aiKnownModels(groupId).then(
        (l) => live && mine === seq && setModels(l),
        () => live && mine === seq && setModels(null),
      );
    };
    load();
    const off = aiSettingsChanged.on(load);
    return () => {
      live = false;
      off();
    };
  }, [groupId]);
  return [models, setModels];
}
