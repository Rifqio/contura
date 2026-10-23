import { useEffect, useState } from "react";
import { secretStoreKind } from "../api/client";
import type { SecretStoreKind } from "../api/types";

/**
 * What a secret field says when this run keeps secrets only until Contura closes, or null
 * when they go to the keyring. `what` is the thing being kept: passwords or the API key.
 */
export function sessionSecretsText(kind: SecretStoreKind | null, what: "passwords" | "key"): string | null {
  if (kind === null || kind === "keyring") return null;
  const kept = what === "passwords" ? "passwords are kept" : "the API key is kept";
  const them = what === "passwords" ? "them" : "it";
  return kind === "noAnswer"
    ? `The keyring did not answer, so ${kept} only until Contura closes. Restart Contura to try the keyring again.`
    : `No keyring service was found, so ${kept} only until Contura closes. Install GNOME Keyring or KeePassXC to save ${them}.`;
}

/** Where secrets go for this run: the OS keyring, or memory until Contura closes. Null until known or if unknown. */
export function useSecretStoreKind(): SecretStoreKind | null {
  const [kind, setKind] = useState<SecretStoreKind | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => secretStoreKind())
      .then((k) => live && setKind(k))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return kind;
}
