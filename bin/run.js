#!/usr/bin/env node
const opener = require('opener')
const node = process.execPath
const fs = require('fs')
const fg = require('foreground-child')
const spawn = require('child_process').spawn
const nycBin = require.resolve(
  'nyc/' + require('nyc/package.json').bin.nyc
)
const glob = require('glob')
const isexe = require('isexe')
const yaml = require('tap-yaml')
const path = require('path')
const exists = require('fs-exists-cached').sync
const os = require('os')
const isTTY = process.stdin.isTTY || process.env._TAP_IS_TTY === '1'
const tsNode = require.resolve(
  'ts-node/' + require('ts-node/package.json').bin['ts-node']
)
const esm = require.resolve('esm')
const jsx = require.resolve('./jsx.js')
const mkdirp = require('mkdirp')

const defaultFiles = options => new Promise((res, rej) => {
  const findit = require('findit')
  const good = strToRegExp(options['test-regex'])
  const bad = strToRegExp(options['test-ignore'])
  const fileFilter = f => {
    const parts = f.split(/\\|\//)
    return good.test(f) &&
      !bad.test(f) &&
      !parts.includes('node_modules') &&
      !parts.includes('tap-snapshots') &&
      !parts.includes('.git') &&
      !parts.includes('.hg')
  }

  const addFile = files => f => fileFilter(f) && files.push(f)

  // search in any folder that isn't node_modules, .git, or tap-snapshots
  // these can get pretty huge, so just walking them at all is costly
  fs.readdir(process.cwd(), (er, entries) => {
    Promise.all(entries.filter(entry =>
      !/^(node_modules|tap-snapshots|.git|.hg)$/.test(entry)
    ).map(entry => new Promise((res, rej) => {
      fs.lstat(entry, (er, stat) => {
        // It's pretty unusual to have a file in cwd you can't even stat
        /* istanbul ignore next */
        if (er)
          return rej(er)
        if (stat.isFile())
          return res(fileFilter(entry) ? [entry] : [])
        if (!stat.isDirectory())
          return res([])
        const finder = findit(entry)
        const files = []
        finder.on('file', addFile(files))
        finder.on('end', () => res(files))
        finder.on('error', er => rej(er))
      })
    }))).then(a => res(a.reduce((a, i) => a.concat(i), []))).catch(rej)
  })
})

const main = async options => {
  if (require.main !== module)
    return

  // tell chalk if we want color or not.
  if (!options.color)
    process.env.FORCE_COLOR = '0'
  else
    process.env.FORCE_COLOR = '1'

  const rc = parseRcFile(options.rcfile)
  for (let i in rc) {
    if (!options._.explicit.has(i))
      options[i] = rc[i]
  }

  const pj = parsePackageJson()
  for (let i in pj) {
    if (!options._.explicit.has(i))
      options[i] = pj[i]
  }

  if (options.reporter === null)
    options.reporter = options.color ? 'new' : 'tap'

  if (options['dump-config']) {
    console.log(yaml.stringify(Object.keys(options).filter(k =>
      k !== 'dump-config' && k !== '_' && !/^[A-Z_]+$/.test(k)
    ).sort().reduce((set, k) =>
      (set[k] = options[k], set), {})))
    return
  }

  if (options.versions) {
    return console.log(yaml.stringify({
      tap: require('../package.json').version,
      'tap-parser': require('tap-parser/package.json').version,
      nyc: require('nyc/package.json').version,
      'tap-yaml': require('tap-yaml/package.json').version,
      treport: require('treport/package.json').version,
      tcompare: require('tcompare/package.json').version,
    }))
  }

  if (options.version)
    return console.log(require('../package.json').version)

  if (options['parser-version'])
    return console.log(require('tap-parser/package.json').version)

  if (options['nyc-version'])
    return console.log(require('nyc/package.json').version)

  if (options['nyc-help'])
    return nycHelp()

  process.stdout.on('error', er => {
    /* istanbul ignore else */
    if (er.code === 'EPIPE')
      process.exit()
    else
      throw er
  })

  options.grep = options.grep.map(strToRegExp)

  // this is only testable by escaping from the covered environment
  /* istanbul ignore next */
  if ((options._.explicit.has('coverage-report') ||
       options._.explicit.has('check-coverage')) &&
      options._.length === 0)
    return runCoverageReportOnly(options)

  try {
    if (options._.length === 0 && isTTY)
      options._.push.apply(options._, await defaultFiles(options))
  } catch (er) {
    return require('../lib/tap.js').threw(er)
  }

  options.files = globFiles(options._)

  if (options.files.length === 0 && !isTTY)
    options.files.push('-')

  if (options['output-dir'] !== null)
    mkdirp.sync(options['output-dir'])

  if (options.files.length === 1 && options.files[0] === '-') {
    setupTapEnv(options)
    stdinOnly(options)
    return
  }

  /* istanbul ignore next */
  if (options.coverage && !process.env.NYC_CONFIG)
    respawnWithCoverage(options)
  else {
    setupTapEnv(options)
    runTests(options)
  }
}

/* istanbul ignore next */
const nycReporter = options =>
  options['coverage-report'] === 'html' ? 'lcov'
  : (options['coverage-report'] || 'text')

/* istanbul ignore next */
const runNyc = (cmd, programArgs, options, spawnOpts) => {
  const reporter = nycReporter(options)

  const args = [
    nycBin,
    ...cmd,
    ...(options['show-process-tree'] ? ['--show-process-tree'] : []),
    '--cache=true',
    '--branches=' + options.branches,
    '--functions=' + options.functions,
    '--lines=' + options.lines,
    '--statements=' + options.statements,
    '--reporter=' + reporter,
    ...options['nyc-arg'],
  ]
  if (options['check-coverage'])
    args.push('--check-coverage')

  args.push.apply(args, programArgs)

  if (spawnOpts)
    return fg(node, args, spawnOpts)

  // fake it
  process.argv = [
    node,
    ...args,
  ]
  require(nycBin)

  if (reporter === 'lcov' && options.browser)
    process.on('exit', () => openHtmlCoverageReport(options))
}

/* istanbul ignore next */
const runCoverageReportOnly = options => runNyc(['report'], [], options)

/* istanbul ignore next */
const pipeToCoveralls = options => {

  const reporter = runNyc(['report'], [], {
    ...options,
    'coverage-report': 'text-lcov'
  }, {
    stdio: [0, 'pipe', 2]
  })
  reporter.removeAllListeners('close')

  /* istanbul ignore next */
  const bin = process.env.__TAP_COVERALLS_TEST__
    || require.resolve('coveralls/bin/coveralls.js')

  const ca = fg(node, [bin], { stdio: ['pipe', 1, 2] })
  reporter.stdout.pipe(ca.stdin)
}

/* istanbul ignore next */
const respawnWithCoverage = options => {
  runNyc([], [
    '--',
    node,
    ...process.execArgv,
    ...process.argv.slice(1)
  ], options)
}

/* istanbul ignore next */
const openHtmlCoverageReport = (options, code, signal) => {
  opener('coverage/lcov-report/index.html')
  if (signal) {
    setTimeout(() => {}, 200)
    process.kill(process.pid, signal)
  } else if (code) {
    process.exitCode = code
  }
}

const nycHelp = _ => fg(node, [nycBin, '--help'])

// export for easier testing
const setupTapEnv = exports.setupTapEnv = options => {
  process.env.TAP_TIMEOUT = options.timeout
  if (options.color)
    process.env.TAP_COLORS = '1'
  else
    process.env.TAP_COLORS = '0'

  if (options.snapshot)
    process.env.TAP_SNAPSHOT = '1'

  if (options.bail)
    process.env.TAP_BAIL = '1'

  if (options.invert)
    process.env.TAP_GREP_INVERT = '1'

  if (options.grep.length)
    process.env.TAP_GREP = options.grep.map(p => p.toString())
      .join('\n')

  if (options.only)
    process.env.TAP_ONLY = '1'
}

const globFiles = files => Array.from(files.reduce((acc, f) =>
  acc.concat(f === '-' ? f : glob.sync(f, { nonull: true })), [])
  .reduce((set, f) => {
    set.add(f)
    return set
  }, new Set()))

const makeReporter = options =>
  new (require('tap-mocha-reporter'))(options.reporter)

const stdinOnly = options => {
  // if we didn't specify any files, then just passthrough
  // to the reporter, so we don't get '/dev/stdin' in the suite list.
  // We have to pause() before piping to switch streams2 into old-mode
  /* istanbul ignore next */
  if (options.reporter === 'new') {
    // XXX add a stdinOnly() method that doesn't make stdin a subtest
    const tap = require('../lib/tap.js')
    require('treport')(tap)
    tap.stdin()
    tap.end()
  } else {
    process.stdin.pause()
    const reporter = makeReporter(options)
    process.stdin.pipe(reporter)
    if (options['output-file'] !== null)
      process.stdin.pipe(fs.createWriteStream(options['output-file']))
    process.stdin.resume()
  }

  if (options['output-file'] !== null)
    process.stdin.pipe(fs.createWriteStream(options['output-file']))
  if (options['output-dir'] !== null)
    process.stdin.pipe(fs.createWriteStream(options['output-dir'] +
      '/stdin.tap'))
  process.stdin.resume()
}

const readSaveFile = options => {
  if (options.save)
    try {
      const s = fs.readFileSync(options.save, 'utf8').trim()
      if (s)
        return s.split('\n')
    } catch (er) {}

  return null
}

const saveFails = (options, tap) => {
  if (!options.save)
    return

  let fails = []
  const successes = []
  tap.on('result', res => {
    // we will continue to re-run todo tests, even though they're
    // not technically "failures".
    if (!res.ok && !res.extra.skip)
      fails.push(res.extra.file)
    else
      successes.push(res.extra.file)
  })

  const save = () => {
    fails = fails.reduce((set, f) => {
      f = f.replace(/\\/g, '/')
      if (set.indexOf(f) === -1)
        set.push(f)
      return set
    }, [])

    if (!fails.length)
      try {
        fs.unlinkSync(options.save)
      } catch (er) {}
    else
      try {
        fs.writeFileSync(options.save, fails.join('\n') + '\n')
      } catch (er) {}
  }

  tap.on('bailout', reason => {
    // add any pending test files to the fails list.
    fails.push.apply(fails, options.files.filter(file =>
      successes.indexOf(file) === -1))
    save()
  })

  tap.on('end', save)
}

const filterFiles = (files, saved, parallelOk) =>
  files.filter(file =>
    path.basename(file) === 'tap-parallel-ok' ?
      ((parallelOk[path.resolve(path.dirname(file))] = true), false)
    : path.basename(file) === 'tap-parallel-not-ok' ?
      parallelOk[path.resolve(path.dirname(file))] = false
    : onSavedList(saved, file)
  )

// check if the file is on the list, or if it's a parent dir of
// any items that are on the list.
const onSavedList = (saved, file) =>
  !saved || !saved.length ? true
  : saved.indexOf(file) !== -1 ? true
  : saved.some(f => f.indexOf(file + '/') === 0)

const isParallelOk = (parallelOk, file) => {
  const dir = path.resolve(path.dirname(file))
  return (dir in parallelOk) ? parallelOk[dir]
    : exists(dir + '/tap-parallel-ok')
    ? parallelOk[dir] = true
    : exists(dir + '/tap-parallel-not-ok')
    ? parallelOk[dir] = false
    : dir.length >= process.cwd().length
    ? isParallelOk(parallelOk, dir)
    : true
}

const runAllFiles = (options, saved, tap) => {
  let doStdin = false
  let parallelOk = Object.create(null)

  if (options['output-dir'] !== null) {
    tap.on('spawn', t => {
      const dir = options['output-dir'] + '/' + path.dirname(t.name)
      mkdirp.sync(dir)
      const file = dir + '/' + path.basename(t.name) + '.tap'
      t.proc.stdout.pipe(fs.createWriteStream(file))
    })
    tap.on('stdin', t => {
      const file = options['output-dir'] + '/stdin.tap'
      t.stream.pipe(fs.createWriteStream(file))
    })
  }

  options.files = filterFiles(options.files, saved, parallelOk)
  let tapChildId = 0

  if (options.files.length === 0 && !doStdin) {
    tap.test('no tests specified', t => t.threw(new Error('no tests specified!')))
  }

  for (let i = 0; i < options.files.length; i++) {
    const opt = {}
    const file = options.files[i]

    // Pick up stdin after all the other files are handled.
    if (file === '-') {
      doStdin = true
      continue
    }

    let st
    try {
      st = fs.statSync(file)
    } catch (er) {
      tap.test(file, t => t.threw(er))
      continue
    }

    if (options.timeout)
      opt.timeout = options.timeout * 1000

    opt.file = file
    opt.childId = tapChildId++
    if (st.isDirectory()) {
      const dir = filterFiles(fs.readdirSync(file).map(f =>
        file.replace(/[\/\\]+$/, '') + '/' + f), saved, parallelOk)
      options.files.splice(i, 1, ...dir)
      i--
    } else {
      if (options.jobs > 1)
        opt.buffered = isParallelOk(parallelOk, file) !== false

      if (file.match(/\.m?js$/)) {
        const args = [
          ...(options.esm ? ['-r', esm] : []),
          ...options['node-arg'],
          file,
          ...options['test-arg']
        ]
        tap.spawn(node, args, opt, file)
      } else if (file.match(/\.ts$/)) {
        const args = [
          ...options['node-arg'],
          file,
          ...options['test-arg']
        ]
        tap.spawn(tsNode, args, opt, file)
      } else if (file.match(/\.jsx$/)) {
        const args = [
          ...(options['node-arg']),
          jsx,
          file,
          ...(options['test-arg']),
        ]
        tap.spawn(node, args, opt, file)
      } else if (file.match(/\.tsx$/)) {
        const args = [
          '--compiler-options={"jsx":"react"}',
          ...(options['node-arg']),
          file,
          ...(options['test-arg']),
        ]
        tap.spawn(tsNode, args, opt, file)
      } if (isexe.sync(options.files[i]))
        tap.spawn(options.files[i], options['test-arg'], opt, file)
    }
  }

  if (doStdin)
    tap.stdin()
}

const runTests = options => {
  const saved = readSaveFile(options)

  // At this point, we know we need to use the tap root,
  // because there are 1 or more files to spawn.
  const tap = require('../lib/tap.js')
  if (options.comments) {
    const onComment = c => {
      if (!c.match(/^# (time=[0-9\.]+m?s|Subtest(: .+)?)\n$/))
        console.error(c.substr(2).trim())
    }
    const onChild = p => {
      p.on('comment', onComment)
      p.on('child', onChild)
    }
    tap.parser.on('comment', onComment)
    tap.parser.on('child', onChild)
  }

  tap.runOnly = false

  // greps are passed to children, but not the runner itself
  tap.grep = []
  tap.jobs = options.jobs
  tap.patchProcess()

  // if not -Rtap, then output what the user wants.
  // otherwise just dump to stdout
  /* istanbul ignore next */
  if (options.reporter === 'new') {
    // use the new reporter
    require('treport')(tap)
  } else
    tap.pipe(options.reporter === 'tap' ? process.stdout: makeReporter(options))


  // need to replay the first version line, because the previous
  // line will have flushed it out to stdout or the reporter already.
  if (options['output-file'] !== null)
    tap.pipe(fs.createWriteStream(options['output-file'])).write('TAP version 13\n')

  saveFails(options, tap)

  runAllFiles(options, saved, tap)

  tap.end()
}

const parsePackageJson = () => {
  try {
    return JSON.parse(fs.readFileSync('package.json', 'utf8')).tap || {}
  } catch (er) {
    return {}
  }
}

const parseRcFile = path => {
  try {
    const contents = fs.readFileSync(path, 'utf8')
    return yaml.parse(contents) || {}
  } catch (er) {
    // if no dotfile exists, or invalid yaml, fail gracefully
    return {}
  }
}

const strToRegExp = g => {
  const p = g.match(/^\/(.*)\/([a-z]*)$/)
  g = p ? p[1] : g
  const flags = p ? p[2] : ''
  return new RegExp(g, flags)
}

require('./jack.js')(main)
