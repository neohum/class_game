# lat.md — Agent Lattice for classgame

> A *map* of this repo for the agents. Keep it short, factual, and current.
> When you delete or move a top-level directory, update this file in the same commit.

## Top-level layout

```
.
├── app/          # (e.g. routes, pages)
├── lib/          # shared business logic
├── scripts/      # one-shot CLI scripts
├── tests/        # automated tests
├── docs/         # spec, design, runbooks
└── .claude/      # agent definitions, commands, settings
```

## Module ownership

| Path             | Purpose                       | Owner    | Touched by                          |
| ---------------- | ----------------------------- | -------- | ----------------------------------- |
| `app/`           | _routes / pages / UI shells_  | _human_  | architect (UI), typist (handlers)   |
| `lib/`           | _domain logic, server-only_   | _human_  | architect, typist                   |
| `scripts/`       | _one-shot CLIs_               | _human_  | typist                              |
| `tests/`         | _unit + integration_          | _human_  | architect (design), typist (cases)  |
| `docs/`          | _planning / design / runbook_ | _human_  | researcher (synthesis), architect   |

## Dependency edges (high-signal only)

- `app/*` → `lib/*` (UI consumes domain — never the other way)
- `lib/server/*` is `server-only` — never imported from `app/(client)`
- `scripts/*` may import `lib/*` but not `app/*`

## External integrations

| System    | Where it lives        | Notes                       |
| --------- | --------------------- | --------------------------- |
| _GitHub_  | `lib/integrations/gh` | _PAT in `GITHUB_TOKEN` env_ |
| _DB_      | `lib/db`              | _drizzle schema in `…`_     |

## Don't-touch list

- `…` — frozen, requires sign-off
