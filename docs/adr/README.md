# Truevine Voice - architecture decision records

Each file in this directory records one architectural decision in the format
recommended by Michael Nygard's ADR process.

Naming: `NNNN-short-kebab-title.md`, numbered sequentially and never reused.

## Index

| #                                                | Decision                                         | Status   |
| ------------------------------------------------ | ------------------------------------------------ | -------- |
| [0001](./0001-modular-monolith.md)               | Start as a modular monolith                      | Accepted |
| [0002](./0002-runtime-and-toolchain-versions.md) | Node, TypeScript and framework version policy    | Accepted |
| [0003](./0003-postgresql-system-of-record.md)    | PostgreSQL is the system of record; Redis is not | Accepted |

## When to write an ADR

Write one when a decision is hard to reverse, affects more than one workspace,
or would be surprising to a future reader without context. Do not write one for
routine implementation choices.
