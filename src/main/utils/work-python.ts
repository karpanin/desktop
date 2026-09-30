// @ts-nocheck

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from 'electron-log'
import { getInstallDir, getPythonPath, installPython, isPythonInstalled, pythonEnv } from './index'

// ─── Work Mode: Python for agent scripts ────────────────
// run_script and PDF reading use the app's own Python (python-build-
// standalone — the one the local Open WebUI server uses) in a separate
// virtual environment: nothing is installed system-wide and Open WebUI's
// packages are untouched.  It is set up once, the first time Work mode is
// used.  Scripts always run through resources/python/owui_work_runner.py,
// which enforces the project's limits with an audit hook.

export const WORK_PYTHON_PACKAGES = [
  'openpyxl',
  'python-docx',
  'python-pptx',
  'pypdf',
  'pdfplumber',
  'pandas',
  'matplotlib'
]

export type WorkPythonStatus = {
  state: 'missing' | 'installing' | 'ready' | 'failed'
  message?: string
}

let status: WorkPythonStatus = { state: 'missing' }
let installing: Promise<string> | null = null
let listener: (status: WorkPythonStatus) => void = () => {}

const setStatus = (next: WorkPythonStatus) => {
  status = next
  listener(next)
}

export const onWorkPythonStatus = (fn: (status: WorkPythonStatus) => void) => {
  listener = fn
}

const venvDir = () => path.join(getInstallDir(), 'work-python')
const venvPython = () =>
  process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python')
const markerPath = () => path.join(venvDir(), '.owui-work-packages.json')

// resources/python: the runner and the owui_work helper package
export const workPythonResourcesDir = () =>
  path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'resources', 'python')

const isReady = (): boolean => {
  try {
    const installed = JSON.parse(fs.readFileSync(markerPath(), 'utf8'))
    return fs.existsSync(venvPython()) && installed.join() === WORK_PYTHON_PACKAGES.join()
  } catch {
    return false
  }
}

export const getWorkPythonStatus = (): WorkPythonStatus => {
  if (status.state !== 'installing' && isReady()) status = { state: 'ready' }
  return status
}

// uv must never fetch its own interpreters — always use the app's Python
const toolEnv = () => pythonEnv({ UV_PYTHON_DOWNLOADS: 'never', PYTHONIOENCODING: 'utf-8' })

const runTool = (command: string, args: string[], onLine?: (line: string) => void) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: toolEnv(), windowsHide: true })
    let last = ''
    const onData = (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/)) {
        if (!line.trim()) continue
        last = line.trim()
        log.info(`[work-python] ${last}`)
        onLine?.(last)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(last || `exit code ${code}`))
    )
  })

// Set up (once) and return the environment's python.  Concurrent callers
// share one installation.
export const ensureWorkPython = (): Promise<string> => {
  if (isReady()) {
    if (status.state !== 'ready') setStatus({ state: 'ready' })
    return Promise.resolve(venvPython())
  }
  if (installing) return installing

  installing = (async () => {
    try {
      if (!isPythonInstalled()) {
        setStatus({ state: 'installing', message: 'Downloading Python…' })
        await installPython(undefined, (message) => setStatus({ state: 'installing', message }))
      }
      const basePython = getPythonPath()
      if (!fs.existsSync(venvPython())) {
        setStatus({ state: 'installing', message: 'Creating the Work environment…' })
        await runTool(basePython, ['-m', 'uv', 'venv', '--python', basePython, venvDir()])
      }
      setStatus({ state: 'installing', message: 'Installing document libraries…' })
      await runTool(
        basePython,
        ['-m', 'uv', 'pip', 'install', '--python', venvPython(), ...WORK_PYTHON_PACKAGES],
        (line) => setStatus({ state: 'installing', message: line.slice(0, 120) })
      )
      fs.writeFileSync(markerPath(), JSON.stringify(WORK_PYTHON_PACKAGES))
      setStatus({ state: 'ready' })
      log.info('[work-python] ready')
      return venvPython()
    } catch (err) {
      log.error('[work-python] setup failed:', err)
      setStatus({ state: 'failed', message: String(err?.message ?? err) })
      throw err
    } finally {
      installing = null
    }
  })()
  return installing
}

export interface WorkScriptResult {
  exit_code: number | null
  timed_out: boolean
  stdout: string
  stderr: string
  started: number
}

// Keep the end of long output — errors and final results are there
const capped = (text: string, limit: number) =>
  text.length > limit ? `… (${text.length - limit} characters cut)\n${text.slice(-limit)}` : text

// Run Python code in `root` under the guard.  `write` = the project allows
// changes; `readRoots` = extra readable folders (skills).
export const runWorkScript = async (options: {
  code: string
  root: string
  write: boolean
  readRoots?: string[]
  args?: string[]
  timeoutMs?: number
  outputLimit?: number
}): Promise<WorkScriptResult> => {
  const python = await ensureWorkPython()
  const {
    code,
    root,
    write,
    readRoots = [],
    args = [],
    timeoutMs = 120_000,
    outputLimit = 20_000
  } = options

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'owui-work-'))
  const scriptPath = path.join(tmpDir, 'script.py')
  await fs.promises.writeFile(scriptPath, code, 'utf8')
  const runner = path.join(workPythonResourcesDir(), 'owui_work_runner.py')
  const started = Date.now()

  return new Promise((resolve) => {
    const child = spawn(python, ['-X', 'utf8', runner, scriptPath, ...args], {
      cwd: root,
      windowsHide: true,
      env: pythonEnv({
        OWUI_WORK_ROOT: root,
        OWUI_WORK_WRITE: write ? '1' : '0',
        OWUI_WORK_READ_ROOTS: JSON.stringify(readRoots),
        MPLCONFIGDIR: tmpDir,
        MPLBACKEND: 'Agg',
        PYTHONIOENCODING: 'utf-8',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1'
      })
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const max = outputLimit * 4
    child.stdout.on('data', (d) => (stdout = (stdout + d.toString()).slice(-max)))
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-max)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (exitCode: number | null) => {
      clearTimeout(timer)
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      resolve({
        exit_code: exitCode,
        timed_out: timedOut,
        stdout: capped(stdout, outputLimit),
        stderr: capped(stderr, outputLimit),
        started
      })
    }
    child.on('error', (err) => {
      stderr += String(err?.message ?? err)
      finish(null)
    })
    child.on('exit', (code) => finish(code))
  })
}
