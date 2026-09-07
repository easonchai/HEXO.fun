/**
 * Phone bet drawer: the vaul bottom sheet wrapping the existing control
 * panel (`children`, props unchanged — spec.md "Drawer") plus a footer row
 * with the sound and theme toggles copied from the topbar. Controlled from
 * App's `drawerOpen` state; closing (swipe, backdrop, Escape, confirmed
 * deploy, own-Position win takeover) is all `onOpenChange(false)` or a
 * parent effect setting the same state.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Drawer } from "vaul";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  soundOn: boolean;
  onToggleSound: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  children: ReactNode;
};

export function BetDrawer({
  open,
  onOpenChange,
  soundOn,
  onToggleSound,
  theme,
  onToggleTheme,
  children,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Reopens scrolled to the top (spec.md "Drawer").
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open]);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay
          className="bet-drawer-overlay"
          data-testid="bet-drawer-overlay"
        />
        <Drawer.Content
          className="bet-drawer-content"
          data-testid="bet-drawer"
        >
          <Drawer.Handle className="bet-drawer-handle" />
          <Drawer.Title className="bet-drawer-title">
            Place a position
          </Drawer.Title>
          <Drawer.Description className="bet-drawer-title">
            Amount, tiles, deploy and vault controls
          </Drawer.Description>
          <div className="bet-drawer-body" ref={bodyRef}>
            {children}
            <div className="bet-drawer-toggles">
              <button
                type="button"
                className="toggle"
                data-testid="drawer-sound-toggle"
                onClick={onToggleSound}
                aria-pressed={soundOn}
              >
                <svg width="17" height="16" viewBox="0 0 20 18" aria-hidden="true">
                  <path d="M2 6h4l5-4v14l-5-4H2z" fill="var(--primary)" />
                  {soundOn ? (
                    <path
                      d="M14 5c1.5 1 2.4 2.4 2.4 4s-.9 3-2.4 4"
                      stroke="var(--primary)"
                      strokeWidth="2.2"
                      fill="none"
                      strokeLinecap="round"
                    />
                  ) : (
                    <line
                      x1="13"
                      y1="4"
                      x2="18"
                      y2="14"
                      stroke="#94a3b8"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </button>
              <button
                type="button"
                className="toggle"
                data-testid="drawer-theme-toggle"
                onClick={onToggleTheme}
                aria-pressed={theme === "dark"}
              >
                {theme === "dark" ? "☀" : "☾"}
                <span className="toggle-label">
                  {theme === "dark" ? "LIGHT" : "DARK"}
                </span>
              </button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
