# Architecture

Embedded Workbench is a thin VS Code front-end over a project-local PlatformIO
environment. The extension never installs global tools; everything lives in the
opened workspace folder (`.venv`, `.platformio`, `projects/`).

## Module layout

```
src/
├── extension.ts      entry point: activate/deactivate only
├── workbench.ts      composition root: workspace state, tree providers, terminals,
│                     build/flash/monitor actions, PlatformIO context
├── commands.ts       single command registration table (id -> handler)
├── wizards.ts        multi-step UI flows: new project, add environment, device -> project
├── features.ts       focused feature handlers: cache sizes, version checks, navigation,
│                     project deletion, clipboard helpers
├── statusbar.ts      status bar item
├── core/             pure logic, no `vscode` import (testable in plain Node)
│   ├── bootstrap.ts  create .venv + pinned PlatformIO
│   ├── pio.ts        locate/run pio, environment
│   ├── repo.ts       workspace + project model (projects/*/platformio.ini)
│   ├── scaffold.ts   project wizard data + file generation
│   ├── ports.ts      serial enumeration via pio
│   ├── esptool.ts    chip detection / esptool install
│   ├── sources.ts    source file discovery
│   ├── sizes.ts      cache/build size accounting
│   ├── versions.ts   version lock checks
│   └── ...
├── trees/            tree data providers (projects, devices, cache, versions)
└── test/             Node tests importing only `core/*` (no VS Code runtime)
```

## Dependency direction

```
extension.ts
   └─ workbench.ts ──► commands.ts ──► wizards.ts / features.ts
          │                 │
          └────────► core/* and trees/*
```

- `core/*` must not import `vscode`; it is covered by `npm test`.
- `wizards.ts` and `features.ts` receive the `Workbench` instance (state + helpers)
  and never hold their own module-level state.
- Command IDs live in `package.json` and are wired exactly once in `commands.ts`.

## Quality gates

```powershell
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (flat config)
npm run test        # Node smoke tests over core modules
npm run test:activation  # load dist/extension.js with a stubbed vscode API
npm run format:check# Prettier
npm run check       # typecheck + lint + test + build + activation smoke + format
```

CI (`.github/workflows/ci.yml`) runs `npm run check` and packages the VSIX as an
artifact on every push/PR. Tagged releases (`v*`) are published by
`.github/workflows/release.yml`.

## Design rules

1. No parent-directory traversal: the extension only operates inside the opened
   workspace folder.
2. All PlatformIO invocations go through `core/pio.ts` with `PLATFORMIO_CORE_DIR`
   pointing at the project-local cache.
3. Long-running work uses VS Code terminals (build/flash/monitor) so users can
   inspect logs; short work uses `runPio` with timeouts.
4. User-facing strings stay in Chinese; code, comments and docs are English.
