/**
 * Offline sanity check for the frontend.
 *
 * The sandbox this was written in had no npm registry, so `vite build` could
 * not run. This covers the failure mode that a build would have caught and a
 * human reviewer would not: importing a name that the target module does not
 * actually export. It also flags exports nothing imports, which is how dead
 * code accumulates.
 *
 * Run with: node check-imports.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'

const ROOT = resolve(import.meta.dirname, 'src')

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.jsx?$/.test(full) ? [full] : []
  })
}

const files = walk(ROOT)
const exportsByFile = new Map()
const importsByFile = new Map()

// Strip comments and string/template literals so their contents can't be
// mistaken for code. Good enough for import/export lines, which are always at
// the top level and never inside a string in this codebase.
function scrub(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

for (const file of files) {
  const src = scrub(readFileSync(file, 'utf8'))

  const names = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1])
  }
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default')
  exportsByFile.set(file, names)

  const imports = []
  for (const m of src.matchAll(/import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, clause, spec] = m
    if (!spec.startsWith('.')) continue

    const named = clause.match(/\{([\s\S]*?)\}/)
    const defaultName = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, '').trim()

    if (defaultName) imports.push({ spec, name: 'default', as: defaultName })
    if (named) {
      for (const part of named[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (name) imports.push({ spec, name, as: name })
      }
    }
  }
  importsByFile.set(file, imports)
}

const problems = []
const used = new Set()

for (const [file, imports] of importsByFile) {
  for (const { spec, name } of imports) {
    const target = resolve(dirname(file), spec)
    if (!exportsByFile.has(target)) {
      problems.push(`${relative(ROOT, file)}: cannot resolve "${spec}"`)
      continue
    }
    used.add(`${target}::${name}`)
    if (!exportsByFile.get(target).has(name)) {
      problems.push(
        `${relative(ROOT, file)}: imports { ${name} } from "${spec}" — not exported there`,
      )
    }
  }
}

const unused = []
for (const [file, names] of exportsByFile) {
  for (const name of names) {
    // main.jsx is the Vite entry point; nothing imports it.
    if (file.endsWith('main.jsx')) continue
    if (!used.has(`${file}::${name}`)) unused.push(`${relative(ROOT, file)} → ${name}`)
  }
}

// Brace/paren/bracket balance via a real character scanner.
//
// A regex-based strip is not good enough here: stripping single-quoted strings
// before double-quoted ones makes the apostrophe in placeholder="you'll" open a
// phantom string that swallows every brace until the next apostrophe in the
// file. This walks the source once, tracking which construct it is inside, and
// reports the line where depth first goes wrong rather than just a total.
function checkBalance(src) {
  const pairs = { '}': '{', ')': '(', ']': '[' }
  const stack = []
  let line = 1
  let i = 0
  // Template literals can nest: `a${ `b${c}` }d`. Track the brace depth at
  // which each template's ${...} began so we know when we're back in text.
  const templates = []

  const prevMeaningful = () => {
    for (let k = i - 1; k >= 0; k--) {
      if (!/\s/.test(src[k])) return src[k]
    }
    return ''
  }

  // Index just past a regex literal starting at `start`, or -1 if it doesn't
  // terminate on the same line — in which case it was never a regex. Looks
  // ahead without moving `i`, so a wrong guess costs nothing.
  const regexEnd = (start) => {
    let k = start + 1
    let inClass = false
    while (k < src.length) {
      const c = src[k]
      if (c === '\\') { k += 2; continue }
      if (c === '\n') return -1
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        k++
        while (k < src.length && /[a-z]/.test(src[k])) k++ // flags
        return k
      }
      k++
    }
    return -1
  }

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    // Regex literal vs. division vs. JSX. Use an allowlist of characters after
    // which a value is expected, not a denylist: with a denylist, the '/' in
    // '</div>' and '/>' reads as a regex start, and the bogus scan then eats to
    // end of line. Both real regexes in this codebase sit right after a '('.
    if (ch === '/' && '(,=:[!&|?;+{'.includes(prevMeaningful())) {
      const end = regexEnd(i)
      if (end !== -1) {
        i = end
        continue
      }
      // Not a regex after all — fall through and treat '/' as ordinary.
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        else if (src[i] === '\n') line++
        i++
      }
      i++
      continue
    }
    if (ch === '`') {
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '\n') { line++; i++; continue }
        if (src[i] === '`') { i++; break }
        if (src[i] === '$' && src[i + 1] === '{') {
          templates.push(stack.length)
          stack.push({ ch: '{', line })
          i += 2
          break
        }
        i++
      }
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      stack.push({ ch, line })
      i++
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      const top = stack.pop()
      if (!top) return { line, message: `stray '${ch}'` }
      if (top.ch !== pairs[ch]) {
        return { line, message: `'${ch}' closes '${top.ch}' opened on line ${top.line}` }
      }
      i++
      // Closing the brace that ended a ${...} puts us back inside template text.
      if (ch === '}' && templates.length && templates[templates.length - 1] === stack.length) {
        templates.pop()
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue }
          if (src[i] === '\n') { line++; i++; continue }
          if (src[i] === '`') { i++; break }
          if (src[i] === '$' && src[i + 1] === '{') {
            templates.push(stack.length)
            stack.push({ ch: '{', line })
            i += 2
            break
          }
          i++
        }
      }
      continue
    }
    i++
  }

  if (stack.length) {
    const top = stack[stack.length - 1]
    return { line: top.line, message: `'${top.ch}' opened here is never closed` }
  }
  return null
}

for (const file of files) {
  const issue = checkBalance(readFileSync(file, 'utf8'))
  if (issue) problems.push(`${relative(ROOT, file)}:${issue.line}: ${issue.message}`)
}

console.log(`Checked ${files.length} files.\n`)
if (problems.length) {
  console.log('PROBLEMS')
  problems.forEach((p) => console.log('  ✗ ' + p))
} else {
  console.log('✓ every relative import resolves to a real export')
  console.log('✓ braces, parens and brackets balance in every file')
}
if (unused.length) {
  console.log('\nExported but never imported (dead code candidates)')
  unused.forEach((u) => console.log('  · ' + u))
}
process.exit(problems.length ? 1 : 0)
