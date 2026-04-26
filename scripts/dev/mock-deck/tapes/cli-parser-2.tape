# cli-parser · task-add-shell-completion · secondary
delay 1000
prompt add bash + zsh completion for the new subcommand tree; share a single source of truth
delay 700
status running scanning subcommand surface
read src/cli/commands/index.ts
delay 500
result 18 commands · 7 with subcommands
delay 700
read src/cli/registry.ts
delay 600
result registry exposes describe() per command
delay 1000
heading Design
type   single source: registry.list() → completion table
delay 250
type   bash: emit complete -F via _cli_parser
delay 250
type   zsh:  emit compdef _cli_parser via #compdef
delay 800
write src/cli/completion/bash.ts
delay 1500
result Created · emits 142-line _cli_parser function
delay 700
write src/cli/completion/zsh.ts
delay 1400
result Created · uses _arguments / _values
delay 700
edit src/cli/commands/completion.ts
delay 1300
result Updated · `completion --shell bash|zsh` wired to writers
delay 700
status waiting want me to also generate fish completion?
wait
status running fish completion deferred · finalizing tests
bash bun test src/cli/completion/
delay 2000
result ✓ 11 pass · 0 fail · 220 ms
delay 600
status done shell completion ready for review
delay 5000
clear
