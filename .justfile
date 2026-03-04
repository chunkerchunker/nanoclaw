@monitor:
	npx tsx scripts/monitor.ts

@restart:
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw

@logs *args:
	npx tsx scripts/agent-log.ts {{args}}