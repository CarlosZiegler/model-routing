# agy (Antigravity CLI) headless reference

Verified 2026-11-07 on `agy 1.5.2` (macOS arm64, `~/.local/bin/agy`, a single 206 MB Mach-O, no symlink, no bundled README).
"Tested" = I ran it. "Docs" = official page only. "Unverified" = neither.
Test cost: quota was 96% (Gemini 5h) and 94% (Argon weekly) halfway through the ~60 small calls, and 95% / 93% at the end. The first half was not measured.

## 1. The four commands

All four: write the brief to a file first, run from the repo or worktree root (cwd = workspace), keep `</dev/null`, always set `--print-timeout`.

### A. Review / plan (read-only, Argon high)

```bash
cd "$REPO" && agy -p "$(cat "$BRIEF")" --model gemini-4-argon-high --mode plan \
  --settings '{"permissions":{"allow":["command(git diff)","command(git log)","command(git show)","command(git status)","command(git grep)","command(git ls-files)","command(rg)","command(grep)","command(ls)","command(cat)","command(head)","command(tail)","command(sed -n)","command(wc)","command(find)","command(jq)"]}}' \
  --output-format json --print-timeout 30m </dev/null >"$BRIEF.json" 2>"$BRIEF.err"
```

- Reads inside cwd and any `--add-dir` need no rule. Add `--add-dir <dir>` (or `read_file(<dir>)`) for other trees.
- The brief must say: "Answer directly in chat. Do not write a plan document. Only these commands are allowed: ...; any other command ends your run."
- Plan mode never edits workspace files (tested: `write_file` and `>` redirects are denied).

### B. Build in a worktree (Argon medium)

Preferred, scoped (tested, stays inside cwd):

```bash
cd "$WORKTREE" && agy -p "$(cat "$BRIEF")" --model gemini-4-argon-medium --mode accept-edits \
  --settings '{"permissions":{"allow":["command(git status)","command(git diff)","command(git add)","command(git commit)","command(<proof cmd, e.g. npm test>)"]}}' \
  --output-format json --print-timeout 45m </dev/null >"$BRIEF.json" 2>"$BRIEF.err"
```

Fallback, only in a disposable worktree: replace `--mode accept-edits --settings ...` with `--dangerously-skip-permissions`.
It does not stay inside cwd (section 5).

### C. Bulk read / extraction (Flash low)

```bash
cd "$DIR" && agy -p "$(cat "$BRIEF")" --model gemini-3.8-flash-low --mode plan \
  --output-format json --print-timeout 10m </dev/null >"$BRIEF.json" 2>"$BRIEF.err"
```

Keep the brief under about 150 KB: longer prompts are silently truncated (gotcha 4).
Add `command(...)` allows only if the task needs shell reads.

### D. JSON for the ledger

```bash
jq -c '{id:.conversation_id, status, finished_reason, error, denied:((.denied_actions//[])|map(.display_name)),
        secs:.duration_seconds, turns:.num_turns, usage}' "$BRIEF.json"
# quota before/after (free, no model call):
agy -p /usage --output-format json | jq -c '[.command.data.groups[] | {g:.name, b:[.buckets[]|{id,remaining_fraction,reset_time}]}]'
```

Run `/usage` before and after the lane and log the delta. The JSON has no cost or rate-limit fields.
A run counts as clean only if `status=="SUCCESS"`, `denied==[]`, `finished_reason` is null and `.response` is non-empty.

## 2. Flags (from `agy --help`, tested where noted)

| flag | what it does |
|---|---|
| `-p` / `--print` / `--prompt <text>` | One headless prompt. `-p -` sends the literal text "-" (tested). |
| `--model <id>` | An id from `agy models`. An unknown id gives exit 1 and prints the model list. |
| `--effort low\|medium\|high\|xhigh\|max` | See section 3. Conflicts with suffixed ids. |
| `--mode accept-edits\|auto\|plan` | Tested: `plan`, `accept-edits`. Unverified: `auto`. |
| `--output-format text\|json\|stream-json` | Default text. |
| `--input-format text\|stream-json` | `stream-json` needs `--output-format stream-json` (docs). Unverified. |
| `--json-schema <json\|path>` | Adds `structured_output` and `json_schema` to the JSON (docs). Unverified. |
| `--print-timeout <dur>` | Default `0s` = no limit. Tested with `2s`: exit 3 (section 4). |
| `--settings <json\|path>` | Session-only settings.json keys, inline or as a file. In `--help` only, not on any docs page. |
| `--add-dir <dir>` | Repeatable. Adds a workspace dir. Tested: `read_file` outside cwd then works. |
| `--sandbox` | Terminal sandbox. Did not block outside writes or network (tested with skip-permissions). |
| `--dangerously-skip-permissions` | Approves everything. Init reports `permission_mode: always-proceed`. |
| `--conversation <id>` / `-c` | Resume by id, or the most recent. Each call is a new process. |
| `--agent <name>` | Unknown name: exit 1 (changelog). |
| `--disable-slash-commands` | Disables slash and skill expansion in print mode. |
| `--project`, `--new-project`, `--log-file`, `--remote-agent`, `--remote-control` | Not needed headless. Default project is `default-cli-project`. |

Subcommands: `acp`, `agent(s)`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin(s)`, `remote-control`, `update`.
Slash commands that the CLI answers itself work as prompts: `agy -p /usage` (alias `/quota`) and `agy -p /credits` (tested).

## 3. Models and effort (tested, `agy models`)

Ids: `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-{low,medium,high}`, `claude-sonnet-5-5-{low,medium,high}`, `gpt-oss-120b-medium`.

- Effort is part of the suffixed id. `--model gemini-3.8-flash-low --effort high` fails with "conflicts with --effort" (exit 1, `status:ERROR`).
- Use either the suffixed id alone, or a base id plus `--effort`. Both are accepted.
- Accepted effort values per base id:

| base id | accepted `--effort` |
|---|---|
| `gemini-4-argon` | low, medium, high |
| `gemini-3.8-flash` | low, medium, high |
| `claude-opus-5-5` | low, medium, high |
| `claude-sonnet-5-5` | low, medium, high |
| `gpt-oss-120b` | medium |

- `xhigh` and `max` are named in `--help` and the reference page but rejected for every base id (`has no "max" effort (available: ...)`).
- Quota groups (`/usage`): "Gemini Models" (Flash and Pro), "Claude and GPT models" (Opus, Sonnet, GPT-OSS), and "Gemini 4 Argon" (its own weekly bucket). Each of the first two has a weekly and a 5h bucket.
- Observed latency: flash-low 2–5 s for "say ok", argon-high about 17 s for a one-file read. Every call carries about 16k input tokens of system prompt.

## 4. Output, exit codes, failures

JSON envelope (tested). The top-level keys are `conversation_id, status, response, duration_seconds, num_turns, usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`, plus these optional keys:
- `denied_actions: [{action, display_name}]`, present when a tool was soft-denied, e.g. `{"action":"command","display_name":"RunCommand"}`.
- `error` (string) and `finished_reason` on failure (see below).
- `structured_output` and `json_schema` with `--json-schema` (docs).
- Status values from the docs: SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING.

`stream-json` (NDJSON, tested):
- `init` carries `{cwd, tools[], permission_mode, model}`.
- Each `step_update` carries `{step_index, state, step_type, tool_name, tool_info{parameters, output, error{type, message}}, usage}`.
- `result` has the same shape as the JSON envelope.
- Use it to audit which tools actually ran.

| situation | exit | stdout / stderr |
|---|---|---|
| success | 0 | |
| soft-denied tool (headless can't prompt) | 0 | `status:SUCCESS`, `response:""`, `denied_actions` set. stderr: `jetski: no output produced — a tool required the "command" permission ... Add an allow-rule under permissions.allow`. |
| bad `--model` or `--effort`, effort/model conflict | 1 | `status:ERROR`, `error` text, `conversation_id:""`. stderr `error: invalid model selection (...)`. |
| `--print-timeout` expired | 3 | `status:ERROR`, `finished_reason:"print_timeout"`, partial or empty `response`. stderr: `[agy] print timeout after 2s ...` and `AGY_ERROR: {"short_error":...,"status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}`. |
| model/agent API failure mid-turn | 3 (changelog 1.4.x/1.5.0) | `AGY_ERROR: {...}` on stderr with canonical status, HTTP/gRPC code and `retryable`. Not reproduced. |
| quota exhausted | not reproduced | Changelog: "reaching your individual quota is reported right away instead of being retried". 429/5xx on some models are retried and honour `Retry-After`. Exact text and code are unverified; parse the `AGY_ERROR` stderr line and call `/usage`. |
| unauthenticated, no TTY | docs: non-zero, `authentication required` | Unverified. |

## 5. Permissions

- Headless = `request-review`. Reads inside the workspace are free. Writes, commands and anything outside the workspace need an allow rule.
- Anything else is soft-denied, and the first denial ended every run I tried, with an empty answer. It does not skip the step and carry on.
- Rule format: `action(target)`, with no space before the parenthesis. Lists are `allow`, `ask`, `deny`; deny beats ask beats allow (docs). Rules go in `--settings '{"permissions":{"allow":[...]}}'` (tested) or in `~/.gemini/antigravity-cli/settings.json` (docs).

| rule | meaning (tested unless noted) |
|---|---|
| `read_file(<dir>)` | **Recursive**: the dir, its direct children and everything below it. Use this form. |
| `read_file(<dir>/)` | Same as above. |
| `read_file(<dir>/x.txt)` | That file only. |
| `read_file(<dir>/**)`, `read_file(<dir>/*)` | **Do not use.** Direct children are denied (`<dir>/x.txt` denied) and only nested files (`<dir>/deep/y.txt`) pass. This is why `<dir>/**` "seemed to work". |
| `write_file(<path>)` | Docs: also implies `read_file` on that path. Unverified. |
| `command(<prefix>)` | Word-by-word prefix, e.g. `command(git diff)`, `command(sed -n)`. |
| `command(regex:<pat>)`, `command(*)`, `mcp(server/tool)`, `read_url(domain)`, `execute_url(domain)` | Docs only. Unverified. |

Command rule behaviour:
- `command(ls)` and `command(grep)` worked on a directory outside the workspace with no `read_file` rule. **Command allows are not path-scoped**, so `command(cat)` can read any file the OS user can, including secrets. Never allow `cat`, `find` or `grep` for untrusted briefs without a content boundary.
- `ls sub && cat sub/a.txt | wc -l` ran with `ls`, `cat` and `wc` allowed. Compounds need every part allowed.
- `echo hi > f` was denied even with `command(echo)` allowed: redirections defeat prefix matching (docs: also `$(...)`, backticks and brace expansion).
- Verified build lane with these allows: `git status`, `git add`, `git commit` plus a workspace write. It committed and could not write outside cwd.

Tool names (tested, from `stream-json` events):
- Runtime calls are `read_file`, `write_file` and `run_command`. The permission actions are `read_file`, `write_file` and `command`.
- `init.tools` also advertises `list_dir`, `grep_search`, `find_by_name` and `view_file`. In 1.5.2 print mode the model said `list_dir` and `grep_search` were "not registered". Over about 8 attempts on flash low, medium and high in plan and accept-edits mode it never called them. It listed and searched with `run_command` (`ls`, `find`, `grep`).
- A review therefore needs `command(ls)`, `command(grep)` or `command(rg)`. A `read_file`-only allowlist cannot list or grep.
- I could not confirm that rules named `list_dir(...)` or `grep_search(...)` do anything.
- In plan mode, task-style prompts make the model `write_file` a plan artifact under `~/.gemini/antigravity-cli/brain/<conversation>/` and answer "click Proceed". That write is allowed without a rule.

Modes (tested):
- `plan`: no workspace writes, no commands unless allowed.
- `accept-edits`: workspace writes auto-approved, commands still need rules, a write outside cwd is denied and ends the run.
- `--dangerously-skip-permissions`:
  - It wrote a file outside cwd, ran `touch` outside cwd and ran `git add && git commit`, all without prompting.
  - With `--sandbox` added, `touch` outside cwd and `curl https://example.com` (HTTP 200) still worked.
  - Since 1.5.2 it denies commands on a system denylist and, in `-p`, anything an enterprise admin marks for review. I did not test either.

## 6. Workspace and prompt delivery

- Workspace = the process cwd (`init.cwd` matched the shell cwd, including from a subfolder). `--add-dir` adds more (tested).
- Outside the workspace, `read_file` is denied unless `--add-dir`, a `read_file(<dir>)` rule or skip-permissions applies. The model even tried `~/.gemini/antigravity-cli/settings.json` and was denied.
- `-p "$(cat file)"` works: 400 KB passed, 900 KB passed, 1.5 MB fails in the shell (`argument list too long`, macOS ARG_MAX about 1 MB).
- **Truncation:** at about 180–195 KB (about 42k prompt tokens) the rest is silently dropped, with no warning and exit 0.
  - Tested with markers every 16 KB: the last one seen was at 178 KB, and the same cut happened for stdin and for the argument.
  - 150 KB was intact. Keep briefs under about 150 KB. This was measured on flash-low only.
- Stdin: `echo "..." | agy --model X --output-format json` (no `-p`) uses stdin as the prompt (tested).
  - `-p "text"` plus piped stdin ignores the stdin.
  - `-p -` is the literal "-".
  - For `--input-format stream-json`, see the docs (one `{"event":"user","message":{"content":"..."}}` per line).

## 7. Gotchas

1. A clean exit 0 is not a clean run. Check `denied_actions` and a non-empty `response`.
2. Models reach for `run_command` first, even for `ls`. List allowed commands in the brief and say "any other command ends your run".
3. In plan mode, phrase the brief as a question or review and add "answer in chat, no plan document". Otherwise the answer is a `plan.md` link.
4. Silent prompt truncation at about 190 KB (section 6).
5. `--effort` conflicts with suffixed ids. `xhigh` and `max` are rejected everywhere. `gpt-oss-120b` only takes medium.
6. Always pass `--print-timeout`. Since 1.5.0, no timeout means it waits for background tasks with no limit. A timeout exits 3 with a partial answer, not 0.
7. `command(...)` allows are global, not path-scoped. `read_file(<dir>)` is recursive; `<dir>/**` is not.
8. `--dangerously-skip-permissions` and `--sandbox` do not contain writes or network (tested). Use it only in a disposable worktree with no secrets, then review `git status` and the diff.
9. Each call spawns a conversation under `~/.gemini/antigravity-cli/` (conversations, brain, log) and about 16k tokens of fixed input. Leave that store alone.
10. Check quota with `agy -p /usage` before a long lane. Individual-quota errors are not retried.
11. Version drift: `antigravity-first` was written at 1.4.12. This file is for 1.5.2. 1.5.0 changed `--print-timeout` behaviour and exit codes, so re-check after `agy update`.
12. User-level Gemini hooks (`~/.gemini/config/hooks.json`) and a `~/.gemini/GEMINI.md`, if present, showed no effect on runs on the test machine, but whether hooks fire headless was not tested.
13. The Gemini CLI headless page documents a different product: `--yolo`, `--approval-mode`, a `stats` object and a `{type,message,code}` error. None of it applies to agy.

## 8. Not verified

- `--mode auto` (needs the terminal sandbox, personal account only per docs).
- Real quota-exhaustion text and exit code (not triggered).
- `--json-schema`, `--input-format stream-json`.
- `deny`/`ask` lists and `regex:` rules (docs only).
- Whether `--settings` merges with or replaces `~/.gemini/antigravity-cli/settings.json` (the file had no `permissions` key, so it was moot).
- Whether `list_dir` and `grep_search` are callable in other models or modes.
- The truncation limit on Argon and Claude models.
- Behaviour when unauthenticated.

## 9. Sources (all read 2026-11-07; no page shows a date or version)

- `agy --help`, `agy help <sub>`, `agy models`, `agy changelog` (1.4.9 to 1.5.2), `agy -p /usage`.
- Bundled docs: `~/.gemini/antigravity-cli/builtin/skills/{automation,antigravity_guide,agy-customizations}` (permission grant syntax `command(...)`, `read_file(...)`, `write_file(...)`, `mcp(...)`, `read_url(...)`, `execute_url(...)`).
- Config files read by key names only: `~/.gemini/settings.json`, `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/config/*.json`.
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/modes/
- https://antigravity.google/docs/permissions?tab=cli
- https://antigravity.google/docs/settings?tab=cli
- https://antigravity.google/docs/features?tab=cli (redirected from `/docs/cli/features`)
- https://antigravity.google/docs/cli/best-practices
- https://google-gemini.github.io/gemini-cli/docs/cli/headless.html (Gemini CLI, a different product)
