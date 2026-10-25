// A cloud service: a 48 px tile showing the provider's icon unchanged, with the name under it (frame 6+.5).
// General and brand icons draw black, so they sit on a light plate in both themes; a provider icon brings its own
// coloured square and draws without one. Icons come from the pack as data: or blob: URLs and render only as an
// <img>, so nothing inside an icon can run (ruling P7). The four ports sit on the tile.
import Icon from "../../components/Icon";
import { type NodeBaseProps, NodeShell } from "./parts";

export interface ServiceNodeProps extends NodeBaseProps {
  /** The icon as a data: or blob: image URL; anything else is not drawn. */
  icon?: string;
  /** The `icon:` names no icon in the pack: a dashed cube tile instead. */
  unknownIcon?: boolean;
  /** The light plate behind the icon; false for a provider icon. */
  plate?: boolean;
}

const SAFE_SRC = /^(?:data:image\/|blob:)/;

export default function ServiceNode({ name, id, icon, unknownIcon, plate = true, style, selected, state, color }: ServiceNodeProps) {
  const src = !unknownIcon && icon && SAFE_SRC.test(icon) ? icon : null;
  const tile = unknownIcon ? "fnode-tile fnode-tile-unknown" : plate ? "fnode-tile" : "fnode-tile fnode-tile-bare";
  return (
    <NodeShell kind="service" family="service" look={style} selected={selected} name={name} state={state} color={color} label={`Service ${name}`}>
      {(ports) => (
        <>
          <span className={tile}>
            {src && <img src={src} alt="" draggable={false} />}
            {unknownIcon && <Icon name="cube" size={20} />}
            {ports}
          </span>
          <span className="fnode-name">{name}</span>
          {id && <span className="fnode-id">{id}</span>}
        </>
      )}
    </NodeShell>
  );
}
