/**
 * Shared presentation primitives for the HEXO app. Every screen composes
 * these instead of re-declaring the panel markup, so the prototype's look is
 * defined once (see styles.css) and themed from one token set.
 */
import type { ReactNode } from "react";

/** Elevated card with the standard header row (title + optional aside). */
export function PanelCard({
  title,
  aside,
  wide,
  children,
  testid,
}: {
  title?: string;
  aside?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
  testid?: string;
}) {
  return (
    <section
      className={`panel-card${wide ? " wide" : ""}`}
      data-testid={testid}
    >
      {title !== undefined || aside !== undefined ? (
        <div className="panel-head">
          {title !== undefined ? (
            <span className="panel-title">{title}</span>
          ) : null}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A section heading inside an existing card (no card chrome of its own). */
export function HeadRow({
  title,
  aside,
}: {
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <span className="panel-title">{title}</span>
      {aside}
    </div>
  );
}

/** Label/value readout used by the stat grids on ABOUT and EXPLORE. */
export function Stat({
  label,
  value,
  small,
  testid,
}: {
  label: string;
  value: ReactNode;
  small?: boolean;
  testid?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span
        className={`stat-value${small ? " small" : ""}`}
        data-testid={testid}
      >
        {value}
      </span>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

/** Chip in the top-bar ticker slot (cluster label, chain clock, …). */
export function Ticker({
  children,
  testid,
  title,
}: {
  children: ReactNode;
  testid?: string;
  title?: string;
}) {
  return (
    <span className="chip" data-testid={testid} title={title}>
      {children}
    </span>
  );
}
