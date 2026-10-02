# nostr-talk-builder

**会話コンパイラ** — 複数ペルソナの台本を 1 画面で編集し、本物の署名済み Nostr イベント（kind 11 ルート + kind 1111 コメント）として出力するアプリ。LINE トーク画像生成器の UX だが、偽造画像ではなく実イベント。

パイプライン: `台本(Script) → ドラフト(unsigned) → 一括署名 → IR(kind 11 + 1111) → 発行`

Built on the [applestack-devin](https://github.com/dragobit/applestack-devin) template (a Devin-hardened fork of [hzrd149/applestack](https://github.com/hzrd149/applestack)). `AGENTS.md` is the authoritative guide for commands and app wiring — keep it accurate as the repo evolves.

## Stack

- **React 19** — hooks, concurrent rendering, ref-as-prop
- **Tailwind CSS v4** — CSS-first config via `@tailwindcss/vite` (no `tailwind.config.ts`); theme tokens in `src/index.css`
- **Vite** — dev server on port **8080**, production builds to `dist/`
- **shadcn/ui** — accessible components on Radix UI (`src/components/ui`)
- **Applesauce v6 + RxJS** — reactive Nostr SDK: `EventStore`, `RelayPool`, models, loaders
- **nostr-tools** — event signing, verification, NIP-19 codecs
- **TypeScript** (strict) — `npm run dev` / `npm test` / `npm run build` via npm

## Quick start

```bash
git clone https://github.com/dragobit/applestack-devin.git
cd applestack-devin
npm install
npm run dev        # http://localhost:8080
```

```bash
npm test           # tsc + eslint + vitest + production build (same as CI)
npm run build      # vite build -> dist/ (+ copies index.html to 404.html for SPA routing)
npm run format     # prettier
```

## Working with Devin

The repo is designed so an agent can navigate it without prior context:

- `AGENTS.md` documents commands, provider wiring, lint rules, and deploy setup.
- `.agents/skills/` contains loadable feature skills (NWC, zaps, onchain Bitcoin, Capacitor, theming, NIP-19 routing, nostr-encryption, and more). Each `SKILL.md` explains what to copy into `src/` and how to wire it.
- `src/services/` holds global state as persisted RxJS `BehaviorSubject`s — there is no React `AppContext`. Read state in components with `use$` from `src/hooks/use$.ts`.

## Key structure

- `src/App.tsx` — provider wiring only (Unhead, `EventStoreProvider`, `AccountsProvider`, `ActionsProvider`, tooltip, toaster, `ThemeSync`).
- `src/AppRouter.tsx` — routes; the `/:nip19` catch-all handles NIP-19 identifiers.
- `src/services/nostr.ts` — global `EventStore` + `RelayPool`, event verification (gift-wrap kinds 1059/21059 get hash-only verification), `publish()`, and loaders (events, addresses, reactions, zaps).
- `src/services/settings.ts` — persisted settings subjects: `extraRelays`, `lookupRelays`, `theme` (`"light" | "dark" | "system"`), and the `persist()` helper for new settings.
- `src/services/accounts.ts`, `src/services/actions.ts` — account manager and action runner.
- `src/hooks/` — `use$` (RxJS subscription), `useAccount`, `useActiveAccount` helpers, `useUser`, `useProfile`, `useTimeline`, `usePublish`, `useToast`, `useIsMobile`, `useLocalStorage`, `useLoginActions`, `useEventStore`, `useAction`.
- `src/factories/`, `src/operations/` — custom event factories and applesauce factory operations.
- `src/test/` — `setup.ts` (jsdom mocks + `fake-indexeddb/auto`), `TestApp` wrapper, examples.

## Testing

Vitest + Testing Library under jsdom. `src/test/setup.ts` mocks `matchMedia`, `scrollTo`, `IntersectionObserver`, `ResizeObserver`, and provides a fake IndexedDB (required because `src/services/cache.ts` loads `window.nostrdb.js` at module scope). Write tests against the `TestApp` wrapper — see `src/App.test.tsx` and the `testing` skill.

## Lint rules

ESLint (flat config) plus repo-local rules in `eslint-rules/`: no placeholder comments, no fixme warnings, no unused disable directives, no inline scripts in HTML, no `any`, `cause` required on rethrown errors, and no `setState` in effects.

## Deploy

Two GitHub workflows ship with the repo; **nsite is the default target**.

### nsite (NIP-5A) — `deploy-nsite.yml`

Runs on pushes to `master` (and `main`, for forks that rename the default branch) and on `workflow_dispatch`. Builds `dist/` and publishes it as an [nsite](https://nsite.lol): files go to Blossom as blobs, then a kind `15128` manifest maps paths to hashes. Live at `https://<site-npub>.nsite.lol` and other public gateways.

Setup:

1. Generate a dedicated keypair for the site (its npub is the site address).
2. Add the nsec (or hex key) as the **`NSITE_NSEC`** repository secret (Settings → Secrets and variables → Actions).
3. Optionally set `NSITE_RELAYS` and `NSITE_BLOSSOM_SERVERS` repository variables to override the default publish relays / upload servers.

The deploy step skips itself with a notice when `NSITE_NSEC` is not set. Locally, `npm run deploy` does the same thing and stores a generated keypair in `.env.nostr-deploy.local` (gitignored — never commit it).

### GitHub Pages — `deploy.yml`

Disabled by default so it doesn't race nsite. Enable it either by:

- running the workflow manually from the Actions tab (`workflow_dispatch`), or
- setting the `DEPLOY_GH_PAGES` repository variable to `true`.

The build copies `dist/index.html` to `dist/404.html` for SPA fallback routing.

## License

Same as upstream applestack.
