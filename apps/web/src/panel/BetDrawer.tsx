/**
 * Phone bet drawer: the vaul bottom sheet wrapping the existing control
 * panel (`children`, props unchanged — spec.md "Drawer") plus a footer row
 * with the sound toggle the topbar hides at phone width. Controlled from
 * App's `drawerOpen` state; closing (swipe, backdrop, Escape, confirmed
 * deploy, own-Position win takeover) is all `onOpenChange(false)` or a
 * parent effect setting the same state.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Drawer } from "vaul";

import { SoundIcon } from "../SoundIcon.js";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  soundOn: boolean;
  onToggleSound: () => void;
  children: ReactNode;
};

export function BetDrawer({
  open,
  onOpenChange,
  soundOn,
  onToggleSound,
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
        <Drawer.Content className="bet-drawer-content" data-testid="bet-drawer">
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
                className="sound-toggle"
                data-testid="drawer-sound-toggle"
                onClick={onToggleSound}
                aria-pressed={soundOn}
                aria-label="Sound"
              >
                <SoundIcon on={soundOn} />
              </button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
