import { appendFileSync } from 'node:fs'
let input = ''
process.stdin.setEncoding('utf8')
for await (const c of process.stdin) input += c
appendFileSync('/tmp/p11/stop.log', JSON.stringify({ t: Date.now(), which: process.argv[2] ?? '?', ev: JSON.parse(input || '{}').hook_event_name }) + '\n')
process.exit(0)
