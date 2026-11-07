# AI Portfolio — design system

Source: user-requested ui-ux-pro-max skill, installed from nextlevelbuilder/ui-ux-pro-max-skill. Search scripts run locally; no private content entered in queries.

## Verified matches and interpretation

- Initial `developer portfolio technical minimal --design-system` returned an off-topic FAQ pattern; it was rejected.
- Narrowed `personal portfolio --design-system` matched portfolio storytelling, monochrome/blue (#2563EB), light surfaces and bold hierarchy. Used the palette and narrative hierarchy; raw brutalist edges and handwritten typography are unsuitable for a professional AI portfolio and were not applied.
- `technical developer --domain typography` matched Developer Mono: IBM Plex Sans + JetBrains Mono. Use sans for readable headings/body and mono for compact labels, indexes and code. Font files are self-hosted through Fontsource.
- `responsive navigation focus --stack nextjs` recommended next/link and responsive layout. Use current-page semantics and keyboard-operable mobile disclosure.

## Product direction

Public: technical editorial portfolio; strong personal introduction, clear selected-work grid, authentic database content, evidence-linked assistant, simple Resume access. No fabricated metrics, biography, testimonials, availability or projects.
Admin: compact workspace with dark grouped sidebar, clear page hierarchy, readable forms and separate states for upload, AI analysis, draft saving and publication.

## Tokens

- Canvas #F5F7FB, surface #FFFFFF, ink #142033, muted #536176.
- Primary #2459D3, primary hover #1947B4, pale primary #EDF3FF.
- Sidebar #101D33, sidebar text #D3DEEE, selected #244B8B.
- Border #DCE3EE; interactive boundary #8290A4; danger #B42335; success #176B49.
- Font body/heading IBM Plex Sans; metadata/code JetBrains Mono.
- Spacing rhythm 4/8px; containers up to 1200px; radii 8/14/20px.
- Body 16px and line height 1.65; fluid display headings; text measure <=72ch.
- Controls >=44px, visible focus, native semantics, wrapping labels, explicit active state.

## Motion and responsive behavior

Small opacity/background transitions only; no parallax, auto-playing loops, hidden-on-scroll content or mandatory animation library. Respect prefers-reduced-motion.
Check 375/768/1024/1440px. Mobile public header uses an inline disclosure; admin sidebar becomes grouped wrapping navigation. No offscreen overlay or focus trap. Tables and code scroll within their own containers.

## Delivery boundary

No auth/database/RAG changes. No cloud content edits. Resume remains explicit activation/publication; analysis failure cannot conceal the route back to files. Visual checks and tests are recorded in docs/design-refresh.md.
