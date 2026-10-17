import TitleBar from "../components/TitleBar";

export default function StartupFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  // The bare title bar as on the launch screen, so the window can still be moved and closed.
  return (
    <div className="app">
      <TitleBar>{null}</TitleBar>
      <div className="app-message" role="alert">
        <p className="error-text">{message}</p>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </div>
      <div className="app-status" aria-hidden="true" />
    </div>
  );
}
