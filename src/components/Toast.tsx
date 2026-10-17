import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Icon, { type IconName } from "./Icon";

export interface ToastSpec {
  kind: "info" | "success" | "readOnly" | "error";
  text: ReactNode;
  action?: { label: string; run(): void };
}

interface Api {
  show(t: ToastSpec): void;
}

const ICONS: Record<ToastSpec["kind"], IconName> = {
  info: "info",
  success: "check",
  readOnly: "lock",
  error: "alert",
};
/** How long each kind stays; errors stay until closed. */
const STAYS: Record<ToastSpec["kind"], number | null> = {
  info: 4000,
  readOnly: 4000,
  success: 3000,
  error: null,
};

const ToastContext = createContext<Api>({ show: () => {} });

/** The one toast for the app: a new one replaces the old. */
export function useToast(): Api {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);
  const show = useCallback((t: ToastSpec) => {
    clearTimeout(timer.current);
    setToast(t);
    const ms = STAYS[t.kind];
    if (ms !== null) timer.current = setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast && (
        <div
          className={`toast toast-${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
        >
          <Icon name={ICONS[toast.kind]} className="toast-icon" />
          <span className="toast-text">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const { run } = toast.action!;
                close();
                run();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
