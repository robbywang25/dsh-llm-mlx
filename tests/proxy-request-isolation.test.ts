import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'

it('rejects malformed request URLs without terminating the compiled proxy host', async () => {
  const moduleUrl = new URL('../lib/index.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    import { once } from 'node:events';
    import { startCcSwitchCompatibilityProxy } from ${JSON.stringify(moduleUrl)};
    let forwarded = 0;
    const upstream = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ forwarded: ++forwarded, path: request.url }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const proxy = await startCcSwitchCompatibilityProxy(
      'http://127.0.0.1:' + upstream.address().port + '/v1', 0,
      { info() {}, warn() {} }
    );
    console.log(JSON.stringify({ endpoint: proxy.endpoint }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(3000) })
    const endpoint = new URL(JSON.parse(String(line)).endpoint as string)
    const malformed = await new Promise<{ status: number | undefined, body: string }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: endpoint.port, path: 'http://[invalid',
        signal: AbortSignal.timeout(3000),
      }, response => {
        let body = ''
        response.setEncoding('utf8').on('data', chunk => { body += chunk })
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode, body }))
      })
      req.once('error', reject)
      req.end()
    })
    expect(malformed).toEqual({
      status: 400,
      body: JSON.stringify({ error: 'invalid local compatibility request URL' }),
    })
    const valid = await fetch(`${endpoint.href}/models?synthetic=1`, { signal: AbortSignal.timeout(3000) })
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ forwarded: 1, path: '/v1/models?synthetic=1' })
    expect(child.exitCode).toBeNull()
    expect(stderr).toBe('')
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
})
