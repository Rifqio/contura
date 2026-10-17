import { type MutableRefObject, useRef } from "react";
import type { RunOutcome } from "../query/QueryTab";
import type { SqlEditorApi } from "../query/SqlEditor";

export type RunFn = (sql: string) => Promise<RunOutcome>;

/** An answer's SQL as it goes into the editor: one statement, ended with a semicolon and a new line. */
export function answerText(sql: string): string {
  return `${sql.trimEnd().replace(/;$/, "")};\n`;
}

/** The editor and runner refs of each query tab, by tab id. */
export function useQueryTabRefs() {
  const editorRefs = useRef(new Map<string, MutableRefObject<SqlEditorApi | null>>());
  const runRefs = useRef(new Map<string, MutableRefObject<RunFn | null>>());

  function runRef(id: string): MutableRefObject<RunFn | null> {
    let r = runRefs.current.get(id);
    if (!r) {
      r = { current: null };
      runRefs.current.set(id, r);
    }
    return r;
  }

  function editorRef(id: string): MutableRefObject<SqlEditorApi | null> {
    let r = editorRefs.current.get(id);
    if (!r) {
      r = { current: null };
      editorRefs.current.set(id, r);
    }
    return r;
  }

  return {
    editorRef,
    runRef,
    editor: (id: string): SqlEditorApi | null => editorRefs.current.get(id)?.current ?? null,
    runner: (id: string): RunFn | null => runRefs.current.get(id)?.current ?? null,
    forget(id: string) {
      editorRefs.current.delete(id);
      runRefs.current.delete(id);
    },
    clear() {
      editorRefs.current.clear();
      runRefs.current.clear();
    },
  };
}
