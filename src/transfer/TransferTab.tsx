import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { errorText, isCommandError, listDatabases, listObjects, listSchemas, openConnection, schemaSnapshot } from "../api/client";
import { confirmTransfer, newJobId, planTransfer, startTransfer, transferSample } from "../api/jobs";
import type { ConnectionConfig, Group, JobEvent, JobId, ObjectPath, PassId, TransferPlan, TransferSide } from "../api/types";
import DbMark from "../components/DbMark";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { useJobs } from "../jobs/useJobs";
import ConfirmRun from "../query/ConfirmRun";
import type { TransferSeed } from "../shell/tabs";
import StepMapping, { mappingFooter } from "./StepMapping";
import StepReview from "./StepReview";
import StepRun, { type RunOutcome, type RunProgress } from "./StepRun";
import StepSource from "./StepSource";
import StepTables from "./StepTables";
import {
  SAME_SIDE,
  TARGET_CHANGED,
  type TableRow,
  type TransferState,
  buildRequest,
  confirmTitle,
  emptiedLine,
  emptyTransfer,
  failureHint,
  needsOf,
  orderParentsFirst,
  reviewSql,
  sameSide,
  setColumnType,
  sourceHint,
  structureLine,
  tabTitle,
  targetHint,
} from "./transferModel";

export const STEPS = ["Source and target", "Tables", "Type mapping", "Review SQL", "Run"] as const;

interface SourceInfo {
  version: string | null;
  tables: number;
  views: number;
  bytes: number | null;
}

interface TargetInfo {
  version: string | null;
  /** Tables in the target schema or database; null when it does not exist yet. */
  tables: number | null;
}

interface Run {
  id: JobId;
  /** The plan the run started from, for its table list and mode. */
  plan: TransferPlan;
  startedAt: number;
  progress: RunProgress | null;
  outcome: RunOutcome | null;
  /** The Core's warning (a MySQL stop lists what stays). */
  warning: string | null;
}

export interface TransferTabProps {
  seed: TransferSeed;
  /** Every Connection, across Groups: a transfer may span two. */
  connections: ConnectionConfig[];
  groups: Group[];
  /** Whether the tab is on top; hidden tabs stay mounted so a run keeps its view. */
  visible: boolean;
  /** The tab's title ("pos_live to analytics") and whether it is set up but not run. */
  onMeta(title: string, dirty: boolean): void;
  /** The job a run started, so closing the tab can ask first; null once it ended. */
  onJob?(id: JobId | null): void;
  /** Open in editor: a query tab on the target with the structure SQL. */
  onOpenInEditor?(side: TransferSide, sql: string): void;
  /** Open in the target tree: the target's branch loads again and shows the first table. */
  onOpenTarget?(path: ObjectPath & { connectionId: string }): void;
}

/** A side is complete when it names a database, and a schema on PostgreSQL. */
function complete(side: TransferSide | null, connections: ConnectionConfig[]): side is TransferSide {
  if (!side?.database) return false;
  const c = connections.find((x) => x.id === side.connectionId);
  return !!c && (c.dialect !== "postgres" || !!side.schema);
}

/** The Data Transfer tab (frame 8.1): five steps, nothing runs until Review SQL is confirmed. */
export default function TransferTab({ seed, connections, groups, onMeta, onJob, onOpenInEditor, onOpenTarget }: TransferTabProps) {
  const jobs = useJobs();
  const root = useRef<HTMLDivElement>(null);
  const sourceConn = connections.find((c) => c.id === seed.connectionId) ?? null;
  const [state, setState] = useState<TransferState>(() =>
    emptyTransfer({
      connectionId: seed.connectionId,
      database: seed.database,
      // A PostgreSQL source copies a schema; a start without one picks public.
      schema: seed.schema ?? (sourceConn?.dialect === "postgres" ? "public" : null),
    }),
  );
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  /** The request the plan was built from: a plan for an older request is stale. */
  const [planKey, setPlanKey] = useState<string | null>(null);
  /** A dialog the tab opened (Show sample) is up: the tab's keys wait. */
  const [dialogUp, setDialogUp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [ran, setRan] = useState(false);
  const firstLoad = useRef(true);

  const src = state.source;
  const tgt = state.target;
  const srcConn = connections.find((c) => c.id === src.connectionId) ?? null;
  const tgtConn = connections.find((c) => c.id === tgt?.connectionId) ?? null;
  const same = tgt !== null && complete(tgt, connections) && sameSide(src, tgt);
  const production = tgtConn?.production ?? false;
  const req = buildRequest(state, target?.tables === null);
  const reqKey = JSON.stringify(req);
  const running = run !== null && run.outcome === null;

  // The source's tables, parents first; views listed after them.
  useEffect(() => {
    if (!complete(src, connections)) return;
    let live = true;
    setLoading(true);
    setError(null);
    const { connectionId, database, schema } = src;
    (async () => {
      try {
        const version = await openConnection(connectionId).catch(() => null);
        const [objects, model] = await Promise.all([listObjects(connectionId, database, schema), schemaSnapshot(connectionId, database, schema)]);
        if (!live) return;
        const tables = objects.filter((o) => o.kind === "table");
        const views = objects.filter((o) => o.kind === "view");
        const seedTable = firstLoad.current && seed.table ? seed.table : null;
        firstLoad.current = false;
        const rows: TableRow[] = orderParentsFirst(
          tables.map((t) => t.name),
          model.refs,
        ).map((name) => {
          const o = tables.find((t) => t.name === name)!;
          return {
            name,
            view: false,
            rows: o.rows,
            bytes: o.bytes ?? null,
            needs: needsOf(name, model.refs),
            ticked: seedTable === null || seedTable === name,
            ifExists: "stop",
          };
        });
        for (const v of views) rows.push({ name: v.name, view: true, rows: null, bytes: null, needs: [], ticked: false, ifExists: "stop" });
        setState((s) => ({ ...s, tables: rows, overrides: [], choices: [], names: [] }));
        const bytes = tables.reduce((sum, t) => sum + (t.bytes ?? 0), 0);
        setSource({ version, tables: tables.length, views: views.length, bytes: bytes > 0 ? bytes : null });
      } catch (e) {
        if (live) setError(errorText(e, srcConn?.dialect));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src.connectionId, src.database, src.schema]);

  // The target's state: its version and how many tables the chosen scope holds.
  useEffect(() => {
    setTarget(null);
    if (!tgt || !complete(tgt, connections) || !tgtConn) return;
    let live = true;
    const { connectionId, database, schema } = tgt;
    (async () => {
      const version = await openConnection(connectionId).catch(() => null);
      let exists = true;
      if (tgtConn.dialect === "postgres") {
        exists = (await listSchemas(connectionId, database).catch(() => [])).some((s) => s.name === schema);
      } else if (tgtConn.dialect === "mysql") {
        exists = (await listDatabases(connectionId).catch((): string[] => [])).includes(database);
      }
      const tables = exists ? (await listObjects(connectionId, database, schema).catch(() => [])).filter((o) => o.kind === "table").length : null;
      if (live) setTarget({ version, tables });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgt?.connectionId, tgt?.database, tgt?.schema, tgtConn?.dialect]);

  // Type mapping and Review SQL show the plan the Core builds from the request as it is now.
  useEffect(() => {
    if (step !== 2 && step !== 3) return;
    let live = true;
    const key = reqKey;
    planTransfer(req).then(
      (p) => {
        if (!live) return;
        setPlan(p);
        setPlanKey(key);
        setPlanError(null);
      },
      (e) => live && setPlanError(errorText(e, tgtConn?.dialect)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, reqKey]);

  const title = tabTitle(src.database, tgt?.database || null);
  useEffect(() => {
    onMeta(title, !ran);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, ran]);

  const srcHint =
    srcConn && source ? sourceHint({ dialect: srcConn.dialect, version: source.version, tables: source.tables, views: source.views, bytes: source.bytes }) : null;
  const tgtHint =
    tgtConn && tgt && target
      ? targetHint({
          dialect: tgtConn.dialect,
          version: target.version,
          scope: tgtConn.dialect === "postgres" ? `schema ${tgt.schema}` : tgtConn.dialect === "sqlite" ? tgtConn.name : tgt.database,
          tables: target.tables,
        })
      : null;

  const ticked = state.tables.some((t) => t.ticked && !t.view);
  // A plan built from an older request (or a refused one) cannot be run or gone on from.
  const planReady = plan !== null && planError === null && planKey === reqKey;
  const blocked = planReady ? plan.blocked.length > 0 : true;
  const canNext =
    step === 0
      ? complete(tgt, connections) && !same && complete(src, connections)
      : step === 1
        ? ticked && !same
        : step === 2
          ? planReady && !blocked
          : false;

  function next() {
    if (!canNext) return;
    if (step === 1) {
      setPlan(null);
      setPlanError(null);
    }
    setNotice(null);
    setStep((s) => s + 1);
  }

  function back() {
    if (running) return;
    if (step === 4) {
      setStep(2);
      return;
    }
    if (step > 0) setStep((s) => s - 1);
  }

  function onEvent(id: JobId, e: JobEvent) {
    setRun((r) => {
      if (!r || r.id !== id) return r;
      switch (e.kind) {
        case "progress":
          return {
            ...r,
            progress: {
              table: e.table,
              rowsDone: e.tableRows ?? 0,
              rowsTotal: e.tableTotal ?? null,
              statementsDone: e.statementsDone,
              allDone: e.rowsDone,
              allTotal: e.rowsTotal,
            },
          };
        case "warning":
          return { ...r, warning: e.message };
        case "finished":
          return { ...r, outcome: { kind: "finished", rowsWritten: e.report.rowsWritten, elapsedMs: e.report.elapsedMs } };
        case "failed": {
          if (e.error.kind === "cancelled") return { ...r, outcome: { kind: "cancelled", message: r.warning, hint: null } };
          const message = [errorText(e.error, r.plan.targetDialect), r.warning].filter(Boolean).join(" ");
          return { ...r, outcome: { kind: "failed", message, hint: failureHint(message, srcConn?.name ?? "the source") } };
        }
        default:
          return r;
      }
    });
    if (e.kind === "finished" || e.kind === "failed") {
      onJob?.(null);
      if (e.kind === "finished") setRan(true);
    }
  }

  /** The Core refused the start: a changed target goes back to Review SQL with its plan. */
  async function refused(e: unknown) {
    if (isCommandError(e) && e.kind === "needsConfirmation") {
      setStep(3);
      setConfirming(true);
      return;
    }
    const text = errorText(e, tgtConn?.dialect);
    setStep(3);
    setRun(null);
    if (text === TARGET_CHANGED) {
      setNotice(TARGET_CHANGED);
      const fresh = await planTransfer(req).catch(() => null);
      if (fresh) {
        setPlan(fresh);
        setPlanKey(reqKey);
      }
    } else {
      setNotice(null);
      setError(text);
    }
  }

  async function start(pass: PassId | null) {
    if (!plan || !tgtConn) return;
    setError(null);
    const id = newJobId();
    const count = plan.copies.length || plan.tables.length;
    const track = jobs.track(id, "transfer", `Copying ${count} ${count === 1 ? "table" : "tables"} to ${tgtConn.name}`, tgtConn.id);
    onJob?.(id);
    setRun({ id, plan, startedAt: Date.now(), progress: null, outcome: null, warning: null });
    setStep(4);
    try {
      await startTransfer(id, req, plan.fingerprint, pass, (e) => {
        track(e);
        onEvent(id, e);
      });
    } catch (e) {
      // A refused start sends no final event: the job goes here.
      jobs.dismiss(id);
      onJob?.(null);
      await refused(e);
    }
  }

  function onRun() {
    if (!plan || !planReady || running || plan.blocked.length > 0) return;
    if (production) setConfirming(true);
    else void start(null);
  }

  async function onConfirmed() {
    setConfirming(false);
    try {
      await start(await confirmTransfer(req));
    } catch (e) {
      await refused(e);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // A portalled dialog's keys bubble here through React: only the tab's own keys count.
    if (confirming || dialogUp || !root.current?.contains(e.target as Node)) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (step < 3) next();
      else if (step === 3 || (step === 4 && run?.outcome && run.outcome.kind !== "finished")) onRun();
    } else if (e.key === "ArrowLeft" && e.altKey) {
      e.preventDefault();
      back();
    }
  }

  const update = (change: Partial<TransferState>) => setState((s) => ({ ...s, ...change }));

  function onType(table: string, column: string, value: string) {
    const note = plan?.mappingNotes.find((m) => m.table === table && m.column === column);
    const options = note?.kind.kind === "needsChoice" ? note.kind.options : [];
    setState((s) => setColumnType(s, table, column, value, options.includes(value)));
  }

  const tickedNames = state.tables.filter((t) => t.ticked && !t.view).map((t) => t.name);
  const outcome = run?.outcome ?? null;
  const firstCopy = run?.plan.copies[0] ?? null;

  return (
    <div ref={root} className={production && step >= 3 ? "transfer-tab prod-wash" : "transfer-tab"} onKeyDown={onKeyDown}>
      <header className="transfer-head">
        <span className="transfer-title">Data Transfer</span>
        <span className="transfer-vline" />
        <ol className="transfer-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={i === step ? "on" : i < step ? "done" : undefined}>
              {i > 0 && <Icon name="chevronRight" size={14} />}
              <span className="transfer-step-n">{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <span className="transfer-sp" />
        {srcConn && (
          <span className="transfer-pair">
            <DbMark dialect={srcConn.dialect} open size={14} label={null} />
            {srcConn.name}
            <Icon name="arrowRight" size={14} />
            {tgtConn && <DbMark dialect={tgtConn.dialect} open size={14} label={null} />}
            {tgtConn?.name ?? "..."}
          </span>
        )}
      </header>

      {step <= 1 && (
        <StepSource
          connections={connections}
          groups={groups}
          source={src}
          target={tgt}
          sourceHint={srcHint}
          targetHint={tgtHint}
          error={same ? SAME_SIDE : null}
          onSource={(s) => {
            firstLoad.current = false;
            setSource(null);
            update({ source: s, tables: [] });
          }}
          onTarget={(t) => update({ target: t })}
        />
      )}
      {error && (
        <div className="transfer-ban transfer-ban-bad" role="alert">
          <Icon name="error" size={14} />
          <span>{error}</span>
        </div>
      )}
      {step === 1 && <StepTables state={state} sourceName={srcConn?.name ?? ""} loading={loading} onChange={update} />}
      {step === 2 &&
        (plan ? (
          <StepMapping
            plan={plan}
            tables={tickedNames}
            choices={state.choices}
            error={planError}
            onType={onType}
            onName={(table, column, value) =>
              setState((s) => ({ ...s, names: [...s.names.filter((x) => !(x.table === table && x.column === column)), { table, column, value }] }))
            }
          />
        ) : planError ? (
          <div className="transfer-ban transfer-ban-bad" role="alert">
            <Icon name="error" size={14} />
            <span>{planError}</span>
          </div>
        ) : (
          <p className="transfer-hint transfer-pad">Reading both sides and mapping every column...</p>
        ))}
      {step === 3 &&
        (planError ? (
          <div className="transfer-ban transfer-ban-bad" role="alert">
            <Icon name="error" size={14} />
            <span>{planError}</span>
          </div>
        ) : planReady && plan && tgt && tgtConn ? (
          <StepReview
            plan={plan}
            target={tgtConn.name}
            batchRows={state.batchRows}
            notice={notice}
            onChangeToStop={() => update({ tables: state.tables.map((t) => (t.ifExists === "emptyFirst" ? { ...t, ifExists: "stop" } : t)) })}
            onOpenInEditor={(sql) => onOpenInEditor?.(tgt, sql)}
            sample={(table) => transferSample(req, table)}
            onDialog={setDialogUp}
          />
        ) : (
          <p className="transfer-hint transfer-pad">Building the SQL...</p>
        ))}
      {step === 4 && run && tgtConn && (
        <StepRun
          tables={run.plan.copies}
          target={tgtConn.name}
          targetDialect={run.plan.targetDialect}
          mode={run.plan.mode}
          structure={structureLine(run.plan.structure, run.plan.afterRows)}
          startedAt={run.startedAt}
          progress={run.progress}
          outcome={run.outcome}
          countsCompared={state.compareCounts}
          source={srcConn?.name}
          onOpenTarget={() =>
            tgt &&
            firstCopy &&
            onOpenTarget?.({ connectionId: tgt.connectionId, database: tgt.database, schema: tgt.schema, name: firstCopy.target.split(".").pop()!.replace(/^["`]|["`]$/g, "") })
          }
        />
      )}

      <footer className="transfer-foot">
        {step <= 1 && <span className="transfer-hint">Nothing runs until you confirm the SQL on Review SQL.</span>}
        {step === 2 && plan && <span className="transfer-hint">{mappingFooter(plan)}</span>}
        {step === 4 && running && <span className="transfer-hint">You can keep working in other tabs.</span>}
        {step === 4 && outcome && tgtConn && <span className="transfer-hint">Recorded in Query History for {tgtConn.name}.</span>}
        <span className="transfer-sp" />
        {step > 0 && step < 4 && (
          <button type="button" className="button" onClick={back}>
            Back <Kbd keys="Alt+Left" />
          </button>
        )}
        {step < 3 && (
          <button
            type="button"
            className="button button-primary"
            disabled={!canNext}
            title={step === 2 && plan && plan.blocked.length > 0 ? `Pick a type for ${plan.blocked[0]} first` : undefined}
            onClick={next}
          >
            Next: {STEPS[step + 1]} <Kbd keys="Ctrl+Enter" />
          </button>
        )}
        {step === 3 && (
          <button type="button" className={production ? "button button-prod" : "button button-primary"} disabled={!planReady || blocked} onClick={onRun}>
            {production ? "Run on PROD..." : "Run"} <Kbd keys="Ctrl+Enter" />
          </button>
        )}
        {step === 4 && running && run && (
          <button type="button" className="button" onClick={() => void jobs.cancel(run.id)}>
            {run.plan.mode === "oneTransaction" ? "Cancel and roll back" : "Cancel"}
          </button>
        )}
        {step === 4 && outcome && outcome.kind !== "finished" && (
          <>
            <button type="button" className="button" onClick={back}>
              Back to Type mapping
            </button>
            <button type="button" className={production ? "button button-prod" : "button button-primary"} onClick={onRun}>
              <Icon name="refresh" size={14} />
              Run again <Kbd keys="Ctrl+Enter" />
            </button>
          </>
        )}
      </footer>

      {confirming && plan && tgt && tgtConn && (
        <ConfirmRun
          verb="Transfer"
          verdict={{ connection: tgtConn.name, database: tgt.database }}
          dialect={tgtConn.dialect}
          group={groups.find((g) => g.id === tgtConn.groupId) ?? null}
          danger={plan.emptied.length > 0}
          warnings={[emptiedLine(plan.emptied, tgtConn.name)].filter((w): w is string => w !== null)}
          job={{
            title: confirmTitle(
              plan.structure,
              plan.afterRows,
              plan.copies.every((c) => c.rowsHint !== null) ? plan.copies.reduce((s, c) => s + (c.rowsHint ?? 0), 0) : null,
              plan.copies.length,
              srcConn?.name ?? "the source",
            ),
            counts: `${plan.structure.length + plan.afterRows.length} statements change the structure; ${plan.copies.length} ${plan.copies.length === 1 ? "table's rows are" : "tables' rows are"} copied in batches of ${state.batchRows.toLocaleString("en-US")}.`,
            shapes: [
              ...(plan.structure.length > 0 ? [{ kind: "exact" as const, line: 0, text: reviewSql(plan.structure, []) }] : []),
              ...plan.copies.map((c) => {
                const rows = c.rowsHint ?? state.batchRows;
                return {
                  kind: "shape" as const,
                  line: 0,
                  shape: { head: `${c.insertHead} VALUES`, firstRows: [], rowsPerStatement: state.batchRows, statements: Math.max(1, Math.ceil(rows / state.batchRows)), rows },
                };
              }),
              ...(plan.afterRows.length > 0 ? [{ kind: "exact" as const, line: 0, text: reviewSql([], plan.afterRows).replace(/^\n?-- The rows are copied here\n\n/, "") }] : []),
            ],
          }}
          onRun={() => void onConfirmed()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
