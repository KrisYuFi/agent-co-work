import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
appendFileSync('/tmp/p11/stop.log', JSON.stringify({ t: Date.now(), input: JSON.parse(input || '{}') }) + '\n')
if (existsSync('/tmp/p11/marker')) process.exit(0)
writeFileSync('/tmp/p11/marker', '1')
console.log(JSON.stringify({ decision: 'block', reason: 'P11_STOP_BLOCK：请先调用 mcp__probe__probe_ping 工具一次，然后回复 WAKE_OK。' }))
process.exit(0)
