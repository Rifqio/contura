/** Live templates: type the name, press Tab. Bodies use CodeMirror snippet fields. */
export const DBML_TEMPLATES: { name: "Table" | "Ref" | "Enum"; body: string }[] = [
  { name: "Table", body: "Table ${1:name} {\n  id integer [pk, increment]\n  ${2}\n}" },
  { name: "Ref", body: "Ref: ${1:table}.${2:column} > ${3:table}.${4:column}" },
  { name: "Enum", body: "Enum ${1:name} {\n  ${2:value}\n}" },
];
