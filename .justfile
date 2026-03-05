@help:
  just -l

@monitor:
	npx tsx scripts/monitor.ts

@restart:
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw

@logs *args:
	npx tsx scripts/agent-log.ts {{args}}

@active:
	container ls | grep nanoclaw-agent || echo "No active agents"

@tasks *args:
  npx tsx scripts/tasks.ts {{args}}

@groups *args:
  npx tsx scripts/groups.ts {{args}}

@mounts *args:
  npx tsx scripts/mounts.ts {{args}}
