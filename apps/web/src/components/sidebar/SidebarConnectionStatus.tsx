import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";

function phaseLabel(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Disconnected";
    default:
      return "Offline";
  }
}

/** The primary environment's name and live connection state, for the sidebar footer. */
export function SidebarConnectionStatus() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primary = environments.find(
    (environment) => environment.environmentId === primaryEnvironmentId,
  );
  if (!primary) return null;
  const phase = primary.connection.phase;
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs text-sidebar-muted-foreground">
      <ConnectionStatusDot
        dotClassName={connectionPhaseDotClassName(phase)}
        pingClassName={connectionPhasePingClassName(phase)}
      />
      <span className="truncate">{primary.label}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0">{phaseLabel(phase)}</span>
    </div>
  );
}
