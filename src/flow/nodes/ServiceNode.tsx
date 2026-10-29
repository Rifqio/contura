// A cloud service: a 48 px tile showing the provider's icon unchanged, with the name under it.
// An icon is inked for the theme by the Core and draws bare at the tile's full size; a service with no icon keeps
// the plain plate. Icons come from the pack as data: or blob: URLs and render only as an
// <img>, so nothing inside an icon can run. The four ports sit on the tile.
import Icon from "../../components/Icon";
import { type NodeBaseProps, NodeShell } from "./parts";

export interface ServiceNodeProps extends NodeBaseProps {
  /** The icon as a data: or blob: image URL; anything else is not drawn. */
  icon?: string;
  /** The `icon:` names no icon in the pack: a dashed cube tile instead. */
  unknownIcon?: boolean;
  /** A pale logo on light: a hairline in the text colour keeps it visible. */
  iconOutline?: boolean;
}

const SAFE_SRC = /^(?:data:image\/|blob:)/;

export default function ServiceNode({ name, id, icon, unknownIcon, iconOutline, style, selected, state, color }: ServiceNodeProps) {
  const src = !unknownIcon && icon && SAFE_SRC.test(icon) ? icon : null;
  const tile = unknownIcon ? "fnode-tile fnode-tile-unknown" : src ? "fnode-tile fnode-tile-bare" : "fnode-tile";
  return (
    <NodeShell kind="service" family="service" look={style} selected={selected} name={name} state={state} color={color} label={`Service ${name}`}>
      {(ports) => (
        <>
          <span className={tile}>
            {src && <img className={iconOutline ? "icon-hairline" : undefined} src={src} alt="" draggable={false} />}
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
