// Icon credits (spec 6+ section 7): each packed icon set, its licence and its source. The text comes from the
// pack, so it is shown as plain text only, and only an https source becomes a link (ruling P9).
import { Fragment, useEffect, useState } from "react";
import { errorText, iconSets, openUrl } from "../api/client";
import type { IconEntry, IconSet } from "../api/types";
import Dialog from "../components/Dialog";
import { iconEntries } from "./icons";

/** The URL when it is a plain https address, else null (shown as text). */
export function httpsUrl(source: string): string | null {
  try {
    const u = new URL(source.trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** The licence name (CC-BY-SA-4.0) when a logo's own licence is share-alike, else null: the adapted file must carry it on. */
function shareAlike(licence: string | null): string | null {
  const name = licence?.split(",")[0].trim() ?? "";
  return /^CC-BY-SA-/.test(name) ? name : null;
}

/**
 * An https source as a link the system browser opens: the webview never navigates or opens a window of its own,
 * so the click goes to the Core, which checks the address again.
 */
function Source({ source, onFailed }: { source: string; onFailed(text: string | null): void }) {
  const href = httpsUrl(source);
  if (!href) return <p className="icon-credits-source">{source}</p>;
  return (
    <p className="icon-credits-source">
      <a
        href={href}
        rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault();
          // A new try clears the last failure.
          onFailed(null);
          openUrl(href).catch((err: unknown) => onFailed(errorText(err)));
        }}
      >
        {source}
      </a>
    </p>
  );
}

export default function IconCredits({ onClose }: { onClose(): void }) {
  const [sets, setSets] = useState<IconSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why the last link did not open. */
  const [linkError, setLinkError] = useState<string | null>(null);
  /** Brand logos that carry a licence of their own, by set. */
  const [own, setOwn] = useState<Map<string, IconEntry[]>>(new Map());

  useEffect(() => {
    let live = true;
    iconSets().then(
      (s) => live && setSets(s),
      (e: unknown) => live && setError(errorText(e)),
    );
    iconEntries().then(
      (entries) => {
        if (!live) return;
        const by = new Map<string, IconEntry[]>();
        for (const e of entries) if (e.licence) by.set(e.set, [...(by.get(e.set) ?? []), e]);
        setOwn(by);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <Dialog title="Icon credits" onClose={onClose} size="model">
      <div className="icon-credits">
        {linkError !== null && (
          <div role="alert">
            <p>Couldn't open the link.</p>
            <p className="muted">{linkError}</p>
          </div>
        )}
        {error !== null ? (
          <div role="alert">
            <p>Couldn't read the icon credits.</p>
            <p className="muted">{error}</p>
          </div>
        ) : sets === null ? (
          <p className="muted">Reading the icon sets</p>
        ) : (
          sets.map((s) => (
            <section key={s.id} className="icon-credits-set" aria-label={s.title}>
              <h3>{s.title}</h3>
              <p>{s.licence}</p>
              <Source source={s.source} onFailed={setLinkError} />
              {s.note && <p>{s.note}</p>}
              {s.changes && <p>{`Changed: ${s.changes}`}</p>}
              {(own.get(s.id) ?? []).map((e) => (
                <Fragment key={e.name}>
                  <p>{`${e.name}: ${e.licence}`}</p>
                  {shareAlike(e.licence) && (
                    <p>{`${e.name}: ${s.changes.charAt(0).toLowerCase()}${s.changes.slice(1)} This adapted file is shared under the same licence, ${shareAlike(e.licence)}.`}</p>
                  )}
                </Fragment>
              ))}
              {s.notice && <pre className="icon-credits-notice">{s.notice}</pre>}
            </section>
          ))
        )}
      </div>
    </Dialog>
  );
}
