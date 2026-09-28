/**
 * Ticket 02 (feature-gates): the gated-feature card. Sized by its parent
 * (absolute inset 0 over a `position: relative` wrapper), so whatever it
 * covers keeps its footprint and blurs beneath it instead of being pulled
 * out of the layout. Same modal-bg + blur pairing as Arena's `.takeover`.
 */
export function ComingSoon() {
  return (
    <div className="coming-soon" data-testid="coming-soon">
      <span className="coming-soon-text">COMING SOON</span>
    </div>
  );
}
