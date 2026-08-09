# Brand — Legate

_Status: set, adapted from Cleanverse's own site design (2026-08-09)_

Legate runs on Cleanverse's real compliance infrastructure — the visual identity now signals that directly rather than looking like a generic dark-mode crypto app. Source: `C:\Users\ritik\Downloads\cleanverse-com-design.md` (a design-system extraction of cleanverse.com), adapted for Legate's own product surface rather than copied verbatim.

## Palette

| Token | Value | Role |
|---|---|---|
| Background / Card / Popover | `#FFFFFF` | Flat white surfaces, no elevation |
| Foreground / body text | `#000000` | Primary text, full contrast |
| Primary (button fill) | `#000000` | Black fill — Cleanverse's own primary CTA treatment |
| Primary foreground | `#FFFFFF` | White text on black fill |
| Muted foreground | `#495464` | Cleanverse's own specified "Secondary Gray" — used for de-emphasized text (7.7:1 on white, comfortably AA) |
| Accent (hover tint) | `#FDECE3` (light tint of `#F8651C`) | Subtle hover background, not full-saturation — see contrast note below |
| Accent foreground | `#000000` | Black text on the light tint |
| Ring / focus | `#F8651C` | Cleanverse's "Compliance Orange" — focus rings, judged under non-text contrast (3:1), not body-text contrast |
| Destructive | `#DC2626` (standard red) | Deliberately **not** the brand orange — a destructive action needs to read as distinct from "this is our brand color," not blend into it |
| Border / input | `#E5E5E5` | Neutral light gray for general borders — Cleanverse's own spec scopes the orange border specifically to buttons, not global layout borders |

**One real, checked constraint, not assumed:** Cleanverse's own accent colors (`#F8651C`, `#FF4000`) both land at only ~3.0–3.5:1 contrast against white — comfortably passing WCAG AA's 3:1 threshold for large text, borders, and focus rings (non-text contrast), but **failing** the 4.5:1 threshold for body text. So the orange is used here for borders, button fills' companion accents, and focus rings — never as small/body text color. Muted text uses Cleanverse's own specified `#495464` instead, which does pass at 7.7:1.

## Typography

- **Primary: Poppins** (`next/font/google`), replacing the previous Geist Sans — matches Cleanverse's single-font system across headings and body.
- **Monospace: kept as-is** (Geist Mono) for addresses, tx hashes, and code — Cleanverse's own spec doesn't evidence a monospace choice, and Legate's mono usage (wallet addresses, payment IDs) is a real, distinct need regardless of brand.

## Surface treatment

- **No shadows.** Depth comes from the `ring-1 ring-foreground/10` treatment shadcn's Card already uses, or borders — not `box-shadow`. Matches Cleanverse's own explicit "avoid soft material-style depth" principle. (Confirmed before touching anything: none of Legate's existing page-level components used shadows already — only the Select dropdown and an active Tab indicator do, both legitimate floating/state UI, left untouched.)
- **Radius:** base `0.5rem` (8px), matching Cleanverse's own explicit button-radius spec and applied consistently via the existing `--radius` cascade (cards/inputs scale off the same token) rather than forcing a literal 0px everywhere, which would look harsh on real interactive surfaces a marketing site doesn't have to contend with.
- **Primary button signature:** black fill, white text, visible `#F8651C` border, 8px radius — Cleanverse's own described primary CTA treatment, applied to `Button`'s `default` variant.

## What this replaces

The previous theme was a dark navy+brass palette (`#0F1B2D`/`#C9A24B`), documented in `globals.css` as a deliberate "institutional, not memecoin" choice tied to `legate-icon.svg`. That reasoning was sound on its own, but a direct visual alignment with Cleanverse — the real infrastructure this product is built on — is a stronger signal for this submission, and was an explicit, considered choice, not a default.
