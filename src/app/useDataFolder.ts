import { useEffect, useState } from "react";
import { dataFolderInfo } from "../api/client";

/** The data folder's path, read while Settings is shown. */
export function useDataFolder(settingsActive: boolean): string {
  const [dataFolder, setDataFolder] = useState("");
  useEffect(() => {
    if (!settingsActive) return;
    let live = true;
    dataFolderInfo()
      .then((i) => live && setDataFolder(i.path ?? ""))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [settingsActive]);
  return dataFolder;
}
