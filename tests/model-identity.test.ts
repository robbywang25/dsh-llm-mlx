import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyModelIdentity } from '../src/runtime.js'

const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`
}

async function fixture(health: unknown, ids: unknown): Promise<string> {
  return endpoint((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url === '/health' ? health : ids))
  })
}

const models = (...ids: string[]) => ({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) })

describe('declared model identity', () => {
  it('matches the loaded MLX-VLM path even when cached alternatives are listed', async () => {
    const base = await fixture({ status: 'healthy', loaded_model: '/models/qwen/4-bit' },
      models('/models/qwen/4-bit', '/models/other/4-bit', 'example/cached-model'))
    expect(await verifyModelIdentity(base, '/models/qwen/4-bit')).toBe('matched')
  })

  it('rejects a different loaded model even when the desired model appears in the cache list', async () => {
    const base = await fixture({ status: 'healthy', loaded_model: '/models/other/4-bit' },
      models('/models/qwen/4-bit', '/models/other/4-bit'))
    expect(await verifyModelIdentity(base, '/models/qwen/4-bit')).toBe('mismatched')
  })

  it('does not mistake downloaded models for a loaded VLM model', async () => {
    const base = await fixture({ status: 'healthy', loaded_model: null }, models('/models/qwen'))
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
  })

  it('recognizes the unique MLX-LM local default beside cached Hub repo IDs', async () => {
    const base = await fixture({ status: 'ok' }, models('example/cached-model', '/models/qwen'))
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('matched')
  })

  it('refuses an ambiguous local default without active-model metadata', async () => {
    const base = await fixture({ status: 'ok' }, models('/models/qwen', '/models/other'))
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
  })

  it('uses the whole path instead of an identical quantization folder name', async () => {
    const base = await fixture({ status: 'ok' }, models('/models/other/4-bit'))
    expect(await verifyModelIdentity(base, '/models/qwen/4-bit')).toBe('mismatched')
  })

  it('resolves local symlinks before comparing model paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mlx-identity-'))
    directories.push(dir)
    const model = join(dir, 'actual-model')
    const alias = join(dir, 'selected-model')
    await mkdir(model)
    await symlink(model, alias)
    const base = await fixture({ status: 'healthy', loaded_model: model }, models(model))
    expect(await verifyModelIdentity(base, alias)).toBe('matched')
  })

  it.each([{}, { data: [{}] }, { data: [{ id: 12 }] }, { data: [{ id: '/models/qwen\n' }] }])(
    'refuses malformed model metadata', async body => {
      const base = await fixture({ status: 'healthy', loaded_model: '/models/qwen' }, body)
      expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
    })

  it('requires the active model to be represented by the models endpoint', async () => {
    const base = await fixture({ status: 'healthy', loaded_model: '/models/qwen' }, models('/models/other'))
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
  })

  it('rejects oversized metadata rather than accumulating an unbounded response', async () => {
    const base = await fixture({ status: 'ok', padding: 'x'.repeat(65_536) }, models('/models/qwen'))
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
  })

  it('does not follow metadata redirects', async () => {
    let followed = false
    const base = await endpoint((request, response) => {
      if (request.url === '/redirected') { followed = true; response.end('{}'); return }
      response.writeHead(302, { location: '/redirected' })
      response.end()
    })
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
    expect(followed).toBe(false)
  })

  it('bounds metadata response time when the server never finishes the body', async () => {
    const base = await endpoint((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{')
    })
    expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
  })

  it.each(['http://example.invalid/v1', 'https://127.0.0.1/v1', 'http://127.0.0.1/v1?redirect=1']) (
    'refuses endpoints outside the fixed loopback contract', async base => {
      expect(await verifyModelIdentity(base, '/models/qwen')).toBe('unavailable')
    })
})
