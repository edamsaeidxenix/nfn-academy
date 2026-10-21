# NFN Academy app

Football academy management web app for NFN Academy (Milandhoo, Maldives). Mobile-first. Currency MVR.

## Structure
- Everything is in one file: `football-academy.html` (HTML, CSS and JavaScript together, no build step).
- JavaScript is wrapped in one IIFE at the bottom of the file.
- UI is rendered with template strings: `render()` picks a view (`viewHome`, `viewSchedule`, `viewAttendance`, `viewSquad`, `viewProgress`, `viewFees`, plus detail views like `viewSession`, `viewPlayer`, `viewEvent`).
- All clicks go through one delegated handler: buttons use `data-act="..."` and a `switch(a)` handles them.
- Forms open in one `<dialog id="sheet">` via `openSheet(html, onSubmit)`.

## Data
- Collections live in `data.<name>` (see `COLS`): players, sessions, assessments, schedules, payments, charges, coaches, salaries, coachPrivate, programs, programTemplates, events, appUsers.
- Writes go through `put(col, id, obj)`, `remove(col, id)`, `putMany(col, entries)` and `saveSettings()`.
- On claude.ai the data store is `window.claude.use("db")`. Outside claude.ai there is no `window.claude`, so the app falls back to `localStorage` (key `football-academy-v1`) on that browser only.
- `window.claude.use("downloads")` (file export) and `window.claude.use("user")` (app owner check) also only exist on claude.ai.

## Accounts and roles
- App-level login with username and password (PBKDF2 hashes in `appUsers`). Roles: admin and coach.
- Coaches are limited to their coach profile's age groups (`scope()`) and to permission switches (`PERMS`, `can()`, `PERM_REQ`).
- Admin-only actions are listed in `ADMIN_ACTS`.

## Conventions
- Keep it mobile-first and test at 360px and 390px widths.
- Colours are CSS variables on `:root` with dark-mode values; don't hard-code colours in components.
- Plain, friendly UI text. No jargon for users.
- Don't remove or rename stored fields; existing academy data must keep working.

## Planned
- Move hosting to our own domain (Netlify) with Firebase (Firestore + Authentication) replacing `window.claude` features.
