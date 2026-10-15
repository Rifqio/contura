# Themes are swappable token sets

DB View ships one default Theme (Flat minimal) plus 18 alternates the user can switch to in Settings. To keep that affordable, every component is styled only through design tokens (CSS custom properties named in DESIGN.md), and a Theme is a set of values for those tokens, plus at most a small, scoped stylesheet for effects tokens can't express (bevels, scanlines, blur). No component hard-codes a colour, radius or font. That rules out styling components directly with literal values, the easy path, because it would make every alternate Theme a fork of the component code.

Alternate Themes load their stylesheet and any bundled font only when selected, so they cost nothing against the memory budget (ADR 0003) while unused. DB View never fetches fonts from the network.
