# image-resizer · task-batch-progress · secondary
delay 900
prompt batch CLI on 2k+ images shows no progress; users think it hung. add a streaming bar.
delay 700
status running surveying current batch loop
read src/cli/commands/batch.ts
delay 500
result 96 lines · plain for-await-of loop
delay 700
read src/lib/progress.ts
delay 500
result 0 — no module yet
delay 1100
heading Plan
type 1. add tiny progress module · ETA + bytes/s · no deps
delay 200
type 2. wire from batch.ts via async iterator
delay 200
type 3. tty-only · pipe-friendly fallback to NDJSON lines
delay 800
write src/lib/progress.ts
delay 1600
result Created · 78 lines · ANSI bar + NDJSON dual output
delay 700
edit src/cli/commands/batch.ts
delay 1400
result Updated 2 chunks · counters wired
delay 800
status waiting may I overwrite the existing examples/ output dir for the demo?
wait
status running running on the 2304-image fixture
bash node dist/cli.js batch --in fixtures/wedding/ --out /tmp/out --width 1600
delay 2600
result 2304/2304 · 1m 24s · 27.4 MB/s
delay 700
status done progress bar live · pipe fallback verified with `| jq`
delay 5000
clear
