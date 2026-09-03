/** The six textile symbols (cross, bullseye, square, clover, squircle, star). */
export const SYMBOL_COUNT = 6;

export const TEXTILE_SYMBOLS: {
  sym: number;
  viewBox: string;
  art: React.ReactNode;
}[] = [
  {
    sym: 0,
    viewBox: "0 0 20 20",
    art: (
      <path
        d="M3.5 3.5 L16.5 16.5 M16.5 3.5 L3.5 16.5"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
        fill="none"
      />
    ),
  },
  {
    sym: 1,
    viewBox: "0 0 20 20",
    art: (
      <>
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
        />
        <circle cx="10" cy="10" r="3.4" fill="currentColor" />
      </>
    ),
  },
  {
    sym: 2,
    viewBox: "0 0 20 20",
    art: (
      <>
        <rect
          x="2"
          y="2"
          width="16"
          height="16"
          rx="3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
        />
        <rect x="7" y="7" width="6" height="6" rx="1.2" fill="currentColor" />
      </>
    ),
  },
  {
    sym: 3,
    viewBox: "0 0 20 20",
    art: (
      <>
        <rect
          x="2.5"
          y="7"
          width="15"
          height="6"
          rx="2.2"
          fill="currentColor"
        />
        <rect
          x="7"
          y="2.5"
          width="6"
          height="15"
          rx="2.2"
          fill="currentColor"
        />
        <circle cx="10" cy="10" r="2" fill="#E8E9ED" />
      </>
    ),
  },
  {
    sym: 4,
    viewBox: "0 0 20 20",
    art: (
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M6.5 2 h7 a4.5 4.5 0 0 1 4.5 4.5 v7 a4.5 4.5 0 0 1 -4.5 4.5 h-7 a4.5 4.5 0 0 1 -4.5 -4.5 v-7 a4.5 4.5 0 0 1 4.5 -4.5 z M10 5.6 a4.4 4.4 0 1 0 0 8.8 a4.4 4.4 0 1 0 0 -8.8 z"
      />
    ),
  },
  {
    sym: 5,
    viewBox: "0 0 20 20",
    art: (
      <polygon
        points="10,2.4 12.35,7 17.5,7.7 13.8,11.3 14.7,16.4 10,13.9 5.3,16.4 6.2,11.3 2.5,7.7 7.65,7"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    ),
  },
];

export function Textile({ sym, size = 20 }: { sym: number; size?: number }) {
  const entry =
    TEXTILE_SYMBOLS[((sym % SYMBOL_COUNT) + SYMBOL_COUNT) % SYMBOL_COUNT]!;
  return (
    <svg
      width={size}
      height={size}
      viewBox={entry.viewBox}
      style={{ display: "block" }}
    >
      {entry.art}
    </svg>
  );
}
