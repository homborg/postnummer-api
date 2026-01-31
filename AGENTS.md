# AGENTS.md

Instructions for AI coding agents working on this codebase.

## Project Overview

Danish postal code lookup API built with:
- **Runtime**: Cloudflare Workers
- **Framework**: Effect-TS with @effect/platform
- **Database**: Cloudflare D1 (SQLite)
- **Package Manager**: pnpm

## Quality Commands

```bash
pnpm run typecheck   # TypeScript type checking (tsc --noEmit)
pnpm run lint        # Linting with oxlint
pnpm run lint:fix    # Auto-fix linting issues
pnpm run dev         # Start development server
pnpm run deploy      # Deploy to Cloudflare Workers
```

Always run `pnpm run typecheck` and `pnpm run lint` after making changes.

## Effect-TS Import Convention

**Use subpath imports, not barrel imports:**

```typescript
// ✅ Correct - subpath imports
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import { pipe } from "effect/Function";

// ❌ Incorrect - barrel imports
import { Effect, Option, Schema } from "effect";
```

This is enforced by oxlint via the `no-restricted-imports` rule.

## Linting Configuration

Oxlint is configured in `.oxlintrc.json` with Effect-friendly settings:
- `require-yield`: disabled (Effect generators don't always yield in outer wrappers)
- `no-unused-vars`: allows `_` prefix for intentionally unused bindings
- `no-restricted-imports`: enforces subpath imports from `effect` package

## Code Style

- Use `Effect.gen(function* () { ... })` for effectful code
- Use `pipe()` for composing operations
- Prefix unused variables with `_` (e.g., `function* (_) { ... }`)
- Follow existing patterns in `src/effect/` for new Effect code
