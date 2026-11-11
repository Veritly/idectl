export function browsers(text: string, parent: number) {
  const rows = text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }]
  })
  const family = new Set([parent])
  for (let count = 0; count < rows.length; count++) {
    const size = family.size
    rows.filter((row) => family.has(row.parent)).forEach((row) => family.add(row.pid))
    if (size === family.size) break
  }
  return rows.flatMap((row) => {
    if (!family.has(row.pid) || /(?:^|\s)--type=/.test(row.command)) return []
    if (!/(?:^|\/)(?:chrome|chromium|chrome-headless-shell)(?:\s|$)/i.test(row.command)) return []
    if (!/(?:^|\s)--remote-debugging-port=/.test(row.command)) return []
    const profile = row.command.match(/(?:^|\s)--user-data-dir=(.+?)(?=\s+--|\s+about:|$)/)?.[1]
    if (!profile) return []
    return [{ pid: row.pid, profile }]
  })
}
