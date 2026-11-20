# Aiwah Minutes — UI design rules

Applies to every Aiwah screen (onboarding, shell, home, meetings, settings, the call pop-up).
Upstream Meetily screens that are not redesigned yet keep their `components/ui-legacy/` parts.

## Building blocks

- **Liro components first** (`@/components/ui/<slug>`, Tailwind v4, installed through the Liro
  MCP + shadcn CLI). Installed: alert, auth, avatar, avatar-stack, badge, button, checkbox,
  conversation-history, dialog, drawer, dropdown-menu, empty-states, field, input, kbd, loader,
  otp-input, password-strength, popover, profile-menu, progress, progress-circle,
  segmented-control, select, settings-page, sidebar, state, stepper, switch, tabs, tag-input,
  tooltip, voice-orb. Read each file's exported props before use; do not edit Liro files.
- Never import from `@/components/ui-legacy/*` in new Aiwah code.
- Backend calls only through `@/lib/aiwah/api.ts` (add to it rather than calling `invoke` ad hoc).
- Platform marks: `PlatformIcon` from `@/components/aiwah/PlatformIcon`.
- Icons: `lucide-react` (1.x). Class merging: `cn` from `@/lib/utils`.
- Toasts: `sonner` (`toast.success / error / message`), already mounted in the main window.

## Look

- Brand: teal primary (`bg-primary`, `text-primary`, `#009E85`), ink text (`text-foreground`),
  slate secondary text (`text-muted-foreground`), page `bg-background` (#F8FAFC), surfaces
  `bg-card` with `border border-border` hairlines, `rounded-xl` cards, `shadow-float` for floating.
- Type: Inter for UI (`font-sans`, default), Manrope for page titles (`font-display`).
  Liro type scale: `text-title` (15px) for card titles, `text-body` (13.5px) body, `text-sub`,
  `text-meta` (11.5px) for metadata. Page titles: `font-display text-2xl font-semibold tracking-tight`.
- Calm and dense, like Linear / Granola: generous whitespace between groups, tight within groups,
  one primary action per view, secondary actions as `variant="ghost"` or `"outline"`.
- Motion: subtle (150–250 ms), `framer-motion` only where it explains a change (enter/exit of
  the pop-up, list reordering). Respect `prefers-reduced-motion`.
- Red is reserved for "recording is live" and destructive actions. Do not use red for normal
  record buttons in idle state; use primary teal.

## Copy

- Plain, short, sentence case. Say what happens: "Start recording", "Not now", "Stop".
- Never blame the user. Errors say what to do next.
- Recording consent: whenever recording starts, remind once: "Let everyone know this call is recorded."

## Accessibility

- Every icon-only button has a label (`IconButton label=…` or `aria-label`).
- Keyboard: Escape dismisses the pop-up; Enter triggers its primary action.
- Contrast: body text on white ≥ 4.5:1 (use `text-muted-foreground`, never lighter greys).
