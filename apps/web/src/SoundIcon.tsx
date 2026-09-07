/**
 * Speaker glyph traced from the Figma topbar (node 119:5989, 17×16): a
 * filled body and one arc. Muted keeps the body and swaps the arc for a
 * slash. Shared by the topbar and the drawer footer so the two stay equal.
 */
type Props = {
  on: boolean;
};

export function SoundIcon({ on }: Props) {
  return (
    <svg width="17" height="16" viewBox="0 0 17 16" aria-hidden="true">
      <path d="M1.7 5.5h2.9l4.75-3.45v11.9L4.6 10.5H1.7z" fill="var(--accent-text)" />
      {on ? (
        <path
          d="M12.9 5.6c1.4 1.2 1.4 3.6 0 4.8"
          stroke="var(--accent-text)"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      ) : (
        <line
          x1="11"
          y1="4"
          x2="15.5"
          y2="12"
          stroke="var(--text-muted)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
