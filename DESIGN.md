# DESIGN.md — UI/UX system for classgame

> The single source of truth for visual + interaction conventions.
> Agents touching view code MUST consult this first.

## Tokens

| Token            | Value             | Use                     |
| ---------------- | ----------------- | ----------------------- |
| `color.bg`       | `#0b0c0f`         | page background         |
| `color.fg`       | `#e7e9ee`         | primary text            |
| `color.muted`    | `#8a8f9c`         | secondary text          |
| `color.accent`   | `#7c8cff`         | interactive / focus     |
| `color.danger`   | `#ff5d6c`         | destructive             |
| `radius.sm`      | `6px`             | inputs, small cards     |
| `radius.md`      | `10px`            | cards, modals           |
| `space.unit`     | `4px`             | base spacing grid       |
| `font.sans`      | system stack      | body & UI               |
| `font.mono`      | ui-monospace      | code, IDs               |

## Components — contract

### Button
- variants: `primary | secondary | ghost | danger`
- sizes: `sm | md` (md is default)
- always reachable by keyboard; visible focus ring `2px solid color.accent`
- loading state replaces children with spinner — width stays stable

### Input
- label is **never** placeholder-only
- error renders below in `color.danger`, with `aria-describedby` wired

### Card
- padding `space.unit * 4`, radius `radius.md`
- no shadow; uses a 1px `color.muted` border at 24% opacity

## Layout rules

- 8px baseline grid (`space.unit * 2`)
- content max-width `1180px`
- side padding clamps `clamp(16px, 4vw, 32px)`

## Interaction rules

- destructive actions confirm (`danger` variant + 1.5s hold-to-confirm OR modal)
- toasts top-right, 4s, auto-dismiss; never use for errors that block work
- forms validate on blur, never on each keystroke

## Don'ts

- no inline color literals in components — use tokens
- no `<div onClick>` — use `<button>` or `<a>`
- no emoji in product UI unless a designer signs off
