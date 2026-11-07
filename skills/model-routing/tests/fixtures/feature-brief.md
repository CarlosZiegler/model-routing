Work only in the worktree given by --repo.
Goal: add a `--since <date>` option to the `export` command of the CLI so users can export only orders created on or after that date.
Scope: src/commands/export.ts, src/lib/orders.ts and their tests.
Constraints: keep the existing CSV columns; dates are ISO 8601 (YYYY-MM-DD); invalid dates exit with code 2 and a clear message.
Non-goals: no new output formats, no changes to the import command.
Proof: npm test passes, including new tests for a valid date, an invalid date, and no --since.
Output: the diff summary and the test output.
