import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties } from "react";
import { groupImage } from "../api/client";
import { GROUP_COLORS, type Group, type GroupColor, type GroupId } from "../api/types";
import { pngDataUrl } from "./groupImage";

/** The Groups' 64 px pictures as data URLs, read once and shared by every Group square. */
export interface GroupImages {
  images: ReadonlyMap<GroupId, string>;
  /** Sets a Group's picture, or clears it with null. */
  set(id: GroupId, url: string | null): void;
}

const GroupImagesContext = createContext<GroupImages>({ images: new Map(), set: () => {} });
export const GroupImagesProvider = GroupImagesContext.Provider;
export const useGroupImages = () => useContext(GroupImagesContext);

/** The picture cache for the app: loads each Group's image once when the list says it has one. */
export function useGroupImageCache(groups: Group[]): GroupImages {
  const [images, setImages] = useState<ReadonlyMap<GroupId, string>>(new Map());
  const set = useCallback((id: GroupId, url: string | null) => {
    setImages((m) => {
      const next = new Map(m);
      if (url) next.set(id, url);
      else next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => {
    let live = true;
    // A Group without a picture, or gone, forgets it.
    setImages((m) => {
      const keep = new Map([...m].filter(([id]) => groups.some((g) => g.id === id && g.hasImage)));
      return keep.size === m.size ? m : keep;
    });
    for (const g of groups) {
      if (!g.hasImage || images.has(g.id)) continue;
      groupImage(g.id)
        .then((b64) => live && b64 && set(g.id, pngDataUrl(b64)))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // The cache itself is read only to skip what is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, set]);
  return useMemo(() => ({ images, set }), [images, set]);
}

interface Props {
  name: string;
  /** Null (Ungrouped) or an unknown name draws the empty ringed square. */
  color: GroupColor | null;
  /** 16 in the tree and switcher, 20 on the Home cards. */
  size?: 16 | 20;
  /** The Group's picture as a data URL; it replaces the letter. */
  image?: string | null;
  /** The Group's id, to find its picture in the cache when `image` is not given. */
  id?: GroupId;
}

/**
 * `--group` and `--group-tint` for a container tied to a Group's Connection, so
 * its parts (the active tab's underline) can draw in the Group hue. Undefined
 * when there is no Group or the colour is unknown.
 */
export function groupStyle(color: GroupColor | null | undefined): CSSProperties | undefined {
  if (!color || !GROUP_COLORS.includes(color)) return undefined;
  return { "--group": `var(--c-group-${color})`, "--group-tint": `var(--c-group-${color}-tint)` } as CSSProperties;
}

/** The Group's initial square: the one place its colour appears. */
export default function GroupBadge({ name, color, size = 16, image, id }: Props) {
  const cached = useGroupImages().images;
  const picture = image ?? (id ? cached.get(id) : undefined);
  const sizeClass = size === 20 ? "group-badge group-badge-20" : "group-badge";
  if (picture) {
    return (
      <span className={`${sizeClass} group-badge-image`} aria-hidden="true">
        <img src={picture} alt="" aria-hidden="true" draggable={false} />
      </span>
    );
  }
  if (color === null || !GROUP_COLORS.includes(color)) {
    return <span className={`${sizeClass} group-badge-empty`} aria-hidden="true" />;
  }
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "";
  const style = { "--group": `var(--c-group-${color})` } as CSSProperties;
  return (
    <span className={sizeClass} style={style} aria-hidden="true">
      {initial}
    </span>
  );
}
