/**
 * Shared <details> accordion (referral-page ticket 06), pulled out of the
 * About page's original FAQ: one row per item, native Enter/Space toggling
 * for free. `numbered` adds the Figma referral FAQ's index digit and lime
 * open-state (styles.css); About's plain FAQ omits it and keeps its exact
 * original look. The answer renders as a `<p>` when it's a plain string (so
 * About stays a real `<p>`, matching e2e/about.spec.ts) or a `<div>` when a
 * caller needs richer markup, such as the referral FAQ's answers 2 and 4
 * (spec.md "Copy"), which keep their lists.
 */
import type { ReactNode } from "react";

export interface FaqItem {
  readonly q: string;
  readonly a: ReactNode;
}

type Props = {
  items: readonly FaqItem[];
  itemClassName: string;
  numbered?: boolean;
};

export function Faq({ items, itemClassName, numbered = false }: Props) {
  return (
    <>
      {items.map((item, i) => (
        <details key={item.q} className={itemClassName}>
          <summary>
            {numbered ? (
              <span className={`${itemClassName}-q`}>
                <span className={`${itemClassName}-num`}>{i + 1}</span>
                {item.q}
              </span>
            ) : (
              item.q
            )}
          </summary>
          {typeof item.a === "string" ? (
            <p className={`${itemClassName}-body`}>{item.a}</p>
          ) : (
            <div className={`${itemClassName}-body`}>{item.a}</div>
          )}
        </details>
      ))}
    </>
  );
}
