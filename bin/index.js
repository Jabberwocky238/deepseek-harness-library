#!/usr/bin/env node

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import * as yaml from 'js-yaml'
import { start } from '../lib/index.js'

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
})

const schema = yaml.JSON_SCHEMA.extend(JsExpr)

function usage() {
  console.log(`Usage:
  jwcordis start [--config cordis.yml]
  jwcordis build [--config cordis.yml] [--outfile app.js]`)
}

function options(args) {
  const result = { config: 'cordis.yml', outfile: 'app.js' }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--config' || flag === '--outfile') {
      const value = args[++index]
      if (!value) throw new Error(`${flag} requires a value`)
      result[flag.slice(2)] = value
    } else if (flag === '--help' || flag === '-h') {
      usage()
      process.exit(0)
    } else {
      throw new Error(`unknown option: ${flag}`)
    }
  }
  return result
}

function bundleEntries(entries) {
  const imports = []
  const visit = (items) => items.map((entry) => {
    const output = { ...entry }
    if (output.group && Array.isArray(output.config)) {
      output.config = visit(output.config)
      return output
    }
    const binding = `plugin${imports.length}`
    imports.push({ binding, specifier: output.name })
    output.name = `cordis:bundle-${imports.length - 1}`
    return output
  })
  return { entries: visit(entries), imports }
}

async function buildApp({ config, outfile }) {
  const cwd = process.cwd()
  const filename = resolve(cwd, config)
  const parsed = yaml.load(await readFile(filename, 'utf8'), { schema })
  if (!Array.isArray(parsed)) throw new TypeError(`${config}: top-level config must be a list`)

  const bundled = bundleEntries(parsed)
  const imports = bundled.imports
    .map(({ binding, specifier }) => `import * as ${binding} from ${JSON.stringify(specifier)}`)
    .join('\n')
  const registrations = bundled.imports
    .map(({ binding }, index) => `ctx.loader.builtins[${JSON.stringify(`bundle-${index}`)}] = ${binding}`)
    .join('\n')
  const source = `
import { Context, Loader } from '@jabberwocky238/cordis'
import { pathToFileURL } from 'node:url'
${imports}

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Loader)
${registrations}
await ctx.loader.root.update(${JSON.stringify(bundled.entries)})
export default ctx
`

  await build({
    stdin: { contents: source, resolveDir: cwd, sourcefile: 'jwcordis-build-entry.js' },
    outfile: resolve(cwd, outfile),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: false,
    logLevel: 'info',
  })
}

const args = process.argv.slice(2)
const command = args[0]?.startsWith('-') || args.length === 0 ? 'start' : args.shift()

try {
  const config = options(args)
  if (command === 'start') {
    await start({ config: config.config })
  } else if (command === 'build') {
    await buildApp(config)
  } else if (command === 'help') {
    usage()
  } else {
    throw new Error(`unknown command: ${command}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
