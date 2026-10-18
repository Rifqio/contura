import type { ReactNode } from "react";
import Icon from "./Icon";

interface Props {
  children: ReactNode;
  /** A button after the text, such as Add WHERE. */
  action?: ReactNode;
  className?: string;
}

/** A warning that sits above SQL about to run: the warning icon, the sentence, an optional action. */
export default function WarningBanner({ children, action, className }: Props) {
  return (
    <div className={["warning-banner", className].filter(Boolean).join(" ")} role="alert">
      <Icon name="warning" />
      <p>{children}</p>
      {action}
    </div>
  );
}
