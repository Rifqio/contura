import { DIALECT_LABEL } from "../api/client";
import type { DialectKind } from "../api/types";

export default function DialectTag({ dialect }: { dialect: DialectKind }) {
  return <span className="dialect-tag">{DIALECT_LABEL[dialect]}</span>;
}
