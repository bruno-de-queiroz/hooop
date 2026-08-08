"use client";
import { SelectedSessionProvider } from "./SelectedSessionProvider";
import { SessionsProvider } from "./SessionsProvider";
import { CommandsProvider } from "./CommandsProvider";
import { ActiveSessionProvider } from "./ActiveSessionProvider";
import { UnseenProvider } from "./UnseenProvider";
import { NotificationsProvider } from "./NotificationsProvider";
import { RevocationOverlay } from "../components/RevocationOverlay";

/**
 * Single mount point for the orchestration layer. Nesting order reflects
 * dependency: ActiveSession needs both Selected and Sessions; Sessions
 * needs Selected (so deleteSession can clear the URL).
 *
 * Anything that reads or writes session state — sidebar, frame,
 * autocomplete — sits inside this provider tree.
 */
export function DashboardProviders({ children }: { children: React.ReactNode }) {
  return (
    <SelectedSessionProvider>
      <UnseenProvider>
        <NotificationsProvider>
          <SessionsProvider>
            <CommandsProvider>
              <ActiveSessionProvider>
                {children}
                <RevocationOverlay />
              </ActiveSessionProvider>
            </CommandsProvider>
          </SessionsProvider>
        </NotificationsProvider>
      </UnseenProvider>
    </SelectedSessionProvider>
  );
}
