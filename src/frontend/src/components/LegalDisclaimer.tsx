/** NAK legal disclaimer — shared wording across all NAK websites. */
export function LegalDisclaimer() {
  return (
    <section
      aria-labelledby="nak-legal-heading"
      data-ocid="footer.legal_disclaimer"
      className="mx-auto max-w-6xl px-4 pt-6 text-xs leading-relaxed text-muted-foreground sm:px-6"
    >
      <h2
        id="nak-legal-heading"
        className="mb-2 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-foreground/80"
      >
        Legal Disclaimer
      </h2>
      <p className="mb-2">
        NAK (New Age Kapital) is a nonprofit organization that holds the
        intellectual property behind its projects. Our mission is to advance the
        world by every lawful means available to us.
      </p>
      <p className="mb-2">
        The NAK token is not an investment. It is not designed or intended to
        appreciate in value, and NAK makes no promise of profit, return, or
        yield of any kind. Nothing on this site is financial, investment, legal,
        or tax advice. All products and services are provided "as is," without
        warranties of any kind, and you use them at your own risk.
      </p>
      <p>© 2026 NAK New Age Kapital. All rights reserved.</p>
    </section>
  );
}
