// A data flow node: process, data store or outside party. Modern is the pastel card with an icon tile, the
// name, the kind in words and the id on the right; Classic is the Gane-Sarson shape (frame 6+.2).
import Icon, { type IconName } from "../../components/Icon";
import { type NodeBaseProps, NodeShell } from "./parts";

export type DfdNodeKind = "process" | "store" | "external";

const WORDS: Record<DfdNodeKind, string> = { process: "Process", store: "Data store", external: "Outside party" };
const ICON: Record<DfdNodeKind, IconName> = { process: "gear", store: "database", external: "user" };

export interface DfdNodeProps extends NodeBaseProps {
  kind: DfdNodeKind;
  /** `schema.table` on a store, shown with a link icon. */
  table?: string;
}

/** The second line: the linked table, or the kind in words. */
function Sub({ kind, table }: { kind: DfdNodeKind; table?: string }) {
  return (
    <span className="fnode-sub">
      {table ? (
        <>
          <Icon name="link" size={14} />
          {table}
        </>
      ) : (
        WORDS[kind]
      )}
    </span>
  );
}

function Modern({ kind, name, id, table }: DfdNodeProps) {
  return (
    <>
      <span className="fnode-tile">
        <Icon name={ICON[kind]} />
      </span>
      <span className="fnode-text">
        <span className="fnode-name">{name}</span>
        <Sub kind={kind} table={table} />
      </span>
      {id && <span className="fnode-id">{id}</span>}
    </>
  );
}

function Classic({ kind, name, id, table }: DfdNodeProps) {
  if (kind === "process") {
    // The id band on top, then the name.
    return (
      <>
        <span className="fnode-band">
          <Icon name="gear" size={14} />
          <span className="fnode-id">{id ?? ""}</span>
        </span>
        <span className="fnode-name">{name}</span>
      </>
    );
  }
  if (kind === "store") {
    // Open on the right, with the id cell on the left even before the store has an id.
    return (
      <>
        <span className="fnode-id">{id ?? ""}</span>
        <span className="fnode-text">
          <span className="fnode-name">{name}</span>
          {table && <Sub kind={kind} table={table} />}
        </span>
      </>
    );
  }
  return (
    <>
      <Icon name="user" size={14} />
      <span className="fnode-name">{name}</span>
      {id && <span className="fnode-id">{id}</span>}
    </>
  );
}

export default function DfdNode(props: DfdNodeProps) {
  const { kind, name, style, selected, state } = props;
  return (
    <NodeShell kind={kind} family="dfd" look={style} selected={selected} name={name} state={state} label={`${WORDS[kind]} ${name}`}>
      {style === "classic" ? <Classic {...props} /> : <Modern {...props} />}
    </NodeShell>
  );
}
