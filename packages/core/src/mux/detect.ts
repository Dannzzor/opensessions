import type { MuxProvider } from "../contracts/mux";
import { TmuxProvider } from "./tmux";

/**
 * Auto-detect the terminal multiplexer from environment variables.
 * Returns the appropriate MuxProvider, or null if none detected.
 *
 * Detection order:
 * 1. $TMUX → TmuxProvider
 * 2. $ZELLIJ_SESSION_NAME → (future ZellijProvider)
 *
 * Users can override by passing their own MuxProvider.
 */
export function detectMux(): MuxProvider | null {
  if (process.env.TMUX) {
    return new TmuxProvider();
  }

  if (process.env.ZELLIJ_SESSION_NAME) {
    // Placeholder — community can implement ZellijProvider
    console.error(
      "Zellij detected but no ZellijProvider available yet. " +
      "See CONTRACTS.md for how to implement one.",
    );
    return null;
  }

  return null;
}
