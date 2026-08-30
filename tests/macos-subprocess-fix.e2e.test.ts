import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import MacOsDesktopSubprocessRuntime from '../src/macos-subprocess-fix.js'

let context: Context | undefined
const tempDirectories: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function runTerminal(argv: readonly string[], cwd: string): Promise<{
  output: string
  outcome: SubprocessOutcome
}> {
  context = new Context()
  await context.plugin(MacOsDesktopSubprocessRuntime)

  const terminal = await context.subprocess.spawnTerminal({
    argv,
    cwd,
    rows: 40,
    cols: 160,
    graceMs: 1_000,
  })
  let output = ''
  terminal.output.on('data', chunk => {
    output += chunk.toString()
  })
  const ended = new Promise<void>((resolve, reject) => {
    terminal.output.once('end', resolve)
    terminal.output.once('error', reject)
  })
  const outcome = await terminal.done
  await ended
  return { output, outcome }
}

describe.skipIf(process.platform !== 'darwin')('macOS Desktop subprocess replacement', () => {
  it('starts a PTY through the plugin-local node-pty helper', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-mlx-pty-fix-'))
    tempDirectories.push(cwd)

    const result = await runTerminal(['/bin/bash', '--noprofile', '--norc', '-c', 'pwd'], cwd)

    expect(result.outcome).toEqual({ exitCode: 0, signal: null })
    expect(result.output.trim()).toBe(cwd)
  })

  it('runs a Read Only Seatbelt PTY and still denies writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-mlx-pty-read-only-'))
    tempDirectories.push(cwd)
    const deniedPath = join(cwd, 'denied.txt')
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      '(allow file-write* (literal "/dev/null"))',
    ].join(' ')

    const result = await runTerminal([
      '/usr/bin/sandbox-exec',
      '-p', profile,
      '--',
      '/bin/bash', '--noprofile', '--norc', '-c',
      `pwd; printf denied > ${JSON.stringify(deniedPath)}`,
    ], cwd)

    expect(result.outcome.exitCode).not.toBe(0)
    expect(result.output).toContain(cwd)
    expect(result.output).toContain('Operation not permitted')
    expect(existsSync(deniedPath)).toBe(false)
  })
})
