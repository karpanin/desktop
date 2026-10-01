// @ts-nocheck

import { spawn } from 'child_process'
import os from 'os'
import path from 'path'

// ─── Work Mode: terminal commands ───────────────────────
// run_command runs PowerShell on Windows and bash on macOS / Linux in the
// project folder.  Like Claude Code / Cowork permissions, every command is
// parsed and classified before it runs:
//
//   read     — known read-only commands on paths inside the project:
//              run without asking in every mode
//   write    — known commands that change files inside the project:
//              follow the project mode (ask / autonomous / read-only)
//   risky    — network, paths outside the project, running programs or
//              scripts, eval-like constructs, package managers, process
//              control, unknown commands: always ask, even in autonomous
//              mode or after "allow for this chat"
//   blocked  — admin and system commands: never run
//
// This is a policy layer, not a sandbox: it can't see what a program does
// once allowed.  Unknown commands are therefore risky by default.

export type ShellDialect = 'powershell' | 'bash'
export type CommandLevel = 'read' | 'write' | 'risky' | 'blocked'
export type RiskReason =
  | 'writes'
  | 'outside'
  | 'network'
  | 'complex'
  | 'program'
  | 'packages'
  | 'process'
  | 'unknown'
  | 'project-root'

export interface CommandCheck {
  level: CommandLevel
  reasons: RiskReason[]
  blocked?: string // the command that is never allowed
}

export const shellDialect = (): ShellDialect =>
  process.platform === 'win32' ? 'powershell' : 'bash'
export const shellName = (): string =>
  process.platform === 'win32'
    ? 'Windows PowerShell'
    : process.platform === 'darwin'
      ? 'bash (macOS)'
      : 'bash'

const LEVELS: CommandLevel[] = ['read', 'write', 'risky', 'blocked']
const higher = (a: CommandLevel, b: CommandLevel) =>
  LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b

// ── Command tables ──────────────────────────────────────

const set = (s: string) => new Set(s.trim().split(/\s+/))

const BASH = {
  read: set(`ls ll dir cat head tail less more wc grep egrep fgrep rg ag find file stat du df pwd echo printf
    which whereis type sort uniq cut tr diff cmp comm tree date cal basename dirname realpath readlink md5sum
    sha1sum sha256sum sha512sum shasum md5 column nl fold fmt rev tac paste join jq xxd hexdump od strings test [
    true false sleep seq printenv whoami id uname hostname ps cd pushd popd sed awk pdfinfo pdftotext mdls`),
  write:
    set(`mkdir touch cp mv rm rmdir ln chmod tar zip unzip gzip gunzip bzip2 bunzip2 xz unxz 7z 7za split
    truncate iconv pandoc magick convert ffmpeg soffice libreoffice dos2unix unix2dos patch tee`),
  network: set(
    `curl wget ssh scp sftp rsync nc ncat netcat telnet ftp ping nslookup dig host traceroute mail`
  ),
  program:
    set(`python python3 py node deno bun ruby perl php java lua rscript osascript bash sh zsh fish dash ksh
    csh tcsh pwsh powershell eval exec source . xargs env nohup timeout watch open xdg-open screen tmux nice time`),
  packages: set(
    `pip pip3 npm npx pnpm yarn brew apt apt-get yum dnf pacman snap gem cargo go conda uv pipx`
  ),
  process: set(`kill killall pkill renice disown`),
  blocked:
    set(`sudo su doas shutdown reboot halt poweroff fdisk parted dd diskutil launchctl systemctl service
    crontab at mount umount passwd useradd userdel usermod visudo iptables ufw csrutil spctl chown chgrp defaults
    security`)
}

const PS = {
  // aliases and native tools; Verb-Noun cmdlets are classified by verb below
  read: set(`ls dir gci cat type gc sls pwd gl echo write sort select where ? % foreach measure fl ft fw oh cd sl
    chdir pushd popd gi gp gu findstr where.exe tree whoami hostname date`),
  write:
    set(`cp copy cpi mv move mi rm del erase rd rmdir ri ni md mkdir ren rni sc ac tee tar attrib robocopy
    xcopy expand compact`),
  network: set(
    `iwr irm curl wget curl.exe wget.exe tnc ping nslookup ssh scp ftp bitsadmin certutil`
  ),
  program:
    set(`iex start saps icm ii cmd cmd.exe powershell powershell.exe pwsh pwsh.exe python python.exe py
    py.exe node node.exe wscript cscript mshta rundll32 regsvr32 bash wsl wsl.exe & .`),
  packages: set(`winget choco scoop pip npm msiexec`),
  process: set(`kill spps taskkill`),
  blocked:
    set(`shutdown runas format diskpart bcdedit vssadmin schtasks sc.exe reg reg.exe net net.exe takeown
    icacls cipher wmic`)
}

// Cmdlets by verb (Get-ChildItem, Remove-Item, …)
const PS_READ_VERBS =
  set(`get test measure select sort where format convertfrom convertto compare group resolve
  split join read`)
const PS_WRITE_VERBS =
  set(`set new remove move copy rename clear add out export expand compress write mkdir
  rename`)
const PS_READ_CMDLETS =
  set(`out-string out-null out-host write-output write-host write-verbose write-warning
  write-information foreach-object where-object import-csv import-clixml get-filehash`)
const PS_NETWORK_CMDLETS =
  set(`invoke-webrequest invoke-restmethod start-bitstransfer test-netconnection
  test-connection resolve-dnsname send-mailmessage`)
const PS_PROGRAM_CMDLETS =
  set(`invoke-expression start-process invoke-command invoke-item add-type new-object
  start-job import-module set-alias new-alias register-objectevent enter-pssession new-pssession`)
const PS_PACKAGE_CMDLETS =
  set(`install-module install-package install-script update-module uninstall-module
  register-psrepository`)
const PS_PROCESS_CMDLETS = set(`stop-process wait-process debug-process`)
const PS_BLOCKED_CMDLETS =
  set(`stop-computer restart-computer format-volume clear-disk initialize-disk
  remove-partition set-executionpolicy set-mppreference add-mppreference remove-mppreference register-scheduledtask
  unregister-scheduledtask new-service set-service stop-service remove-service new-localuser set-localuser
  add-localgroupmember disable-computerrestore checkpoint-computer set-itemproperty-registry`)

const DELETE_COMMANDS = set(`rm rmdir remove-item del erase rd ri`)

// ── Tokenizer ───────────────────────────────────────────

type Token =
  | { t: 'word'; v: string; quoted: boolean }
  | { t: 'op'; v: string }
  | { t: 'redirect'; v: string }
  | { t: 'group'; v: string }

class TooComplex extends Error {}

const tokenize = (
  command: string,
  dialect: ShellDialect
): { tokens: Token[]; complex: boolean } => {
  const tokens: Token[] = []
  let cur = ''
  let quoted = false
  let complex = false
  const push = () => {
    if (cur !== '' || quoted) tokens.push({ t: 'word', v: cur, quoted })
    cur = ''
    quoted = false
  }
  const escapeChar = dialect === 'bash' ? '\\' : '`'

  for (let i = 0; i < command.length; ) {
    const c = command[i]
    const two = command.slice(i, i + 2)

    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) throw new TooComplex('unterminated quote')
      cur += command.slice(i + 1, end)
      quoted = true
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < command.length && command[j] !== '"') {
        if (command[j] === escapeChar) {
          text += command[j + 1] ?? ''
          j += 2
          continue
        }
        if (command.startsWith('$(', j) || (dialect === 'bash' && command[j] === '`'))
          complex = true
        text += command[j++]
      }
      if (j >= command.length) throw new TooComplex('unterminated quote')
      cur += text
      quoted = true
      i = j + 1
      continue
    }
    if (c === escapeChar) {
      cur += command[i + 1] ?? ''
      i += 2
      continue
    }
    if (dialect === 'bash' && c === '`') {
      complex = true
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      push()
      tokens.push({ t: 'op', v: ';' })
      i++
      continue
    }
    if (/\s/.test(c)) {
      push()
      i++
      continue
    }
    if (two === '$(' || two === '<(' || two === '>(' || two === '@(' || two === '${') {
      // command substitution / subexpression / process substitution
      if (two !== '@(' && two !== '${') complex = true
      push()
      tokens.push({ t: 'group', v: '(' })
      i += 2
      continue
    }
    if (two === '&&' || two === '||') {
      push()
      tokens.push({ t: 'op', v: two })
      i += 2
      continue
    }
    // Redirections: >, >>, 2>, 2>>, &>, *>, 2>&1, >&2, <
    const prefixed = cur === '' && /[\d*&]/.test(c) && command[i + 1] === '>'
    if (c === '>' || c === '<' || prefixed) {
      const m = command.slice(i).match(/^[\d*&]?(>>?|<)(&\d)?/)
      push()
      tokens.push({ t: 'redirect', v: m[0] })
      i += m[0].length
      continue
    }
    if (c === '|' || c === ';') {
      push()
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    if (c === '&') {
      push()
      // bash: background; PowerShell: call operator
      if (dialect === 'powershell') tokens.push({ t: 'word', v: '&', quoted: false })
      else tokens.push({ t: 'op', v: '&' })
      i++
      continue
    }
    if ('{}()'.includes(c)) {
      push()
      tokens.push({ t: 'group', v: c })
      i++
      continue
    }
    cur += c
    i++
  }
  push()
  return { tokens, complex }
}

// ── Paths ───────────────────────────────────────────────

const NULL_DEVICES = new Set(['/dev/null', 'nul', '$null', '/dev/stdout', '/dev/stderr'])

const samePathCase = process.platform === 'win32' || process.platform === 'darwin'
const inside = (root: string, target: string) => {
  const rel = path.relative(
    samePathCase ? root.toLowerCase() : root,
    samePathCase ? target.toLowerCase() : target
  )
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const HOME_VARS =
  /^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%)(?=$|[\\/])/i

// Resolve a word that looks like a path; null when it doesn't look like one
const resolvePathWord = (word: string, root: string, dialect: ShellDialect): string | null => {
  let w = word.replace(/^-{1,2}[\w-]+[:=]/, '') // --output=file, -Path:file
  if (!w || NULL_DEVICES.has(w.toLowerCase())) return null
  const home = os.homedir()
  if (HOME_VARS.test(w)) w = w.replace(HOME_VARS, home)
  else if (
    /^\$env:(SystemRoot|windir|ProgramFiles|ProgramData|APPDATA|LOCALAPPDATA|TEMP|TMP)/i.test(w)
  ) {
    return '/' // system locations: always outside
  }
  const looksLikePath =
    w.startsWith('/') ||
    w.startsWith('\\') ||
    /^[a-zA-Z]:([\\/]|$)/.test(w) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(w) ||
    w === home ||
    w.startsWith(home)
  if (!looksLikePath) return null
  // Windows paths on posix and vice versa: treat drive/UNC paths as absolute
  if (dialect === 'powershell' || /^[a-zA-Z]:|^\\\\/.test(w)) return path.win32.resolve(root, w)
  return path.resolve(root, w)
}

// ── Classification ──────────────────────────────────────

const normalizeName = (word: string, dialect: ShellDialect) => {
  let name = word.toLowerCase()
  if (dialect === 'bash') name = name.replace(/^.*\//, '')
  return name
}

const isScriptPath = (word: string) =>
  /[\\/]/.test(word) || /\.(sh|ps1|bat|cmd|exe|com|vbs|js|py)$/i.test(word)

export const classifyCommand = (
  command: string,
  options: { dialect?: ShellDialect; root: string; readRoots?: string[] }
): CommandCheck => {
  const dialect = options.dialect ?? shellDialect()
  const root = options.root
  const readable = [root, ...(options.readRoots ?? [])]
  let level: CommandLevel = 'read'
  const reasons = new Set<RiskReason>()
  const raise = (to: CommandLevel, reason?: RiskReason) => {
    level = higher(level, to)
    if (reason) reasons.add(reason)
  }

  let parsed: { tokens: Token[]; complex: boolean }
  try {
    parsed = tokenize(command, dialect)
  } catch {
    return { level: 'risky', reasons: ['complex'] }
  }
  if (parsed.complex) raise('risky', 'complex')

  // Split into simple commands: a new one starts after an operator or at a
  // group boundary (PowerShell script blocks, subexpressions, subshells)
  const segments: string[][] = []
  const literalStarts = new Set<string[]>() // segments that start with a quoted string
  const redirects: string[] = []
  let current: string[] = []
  const tokens = parsed.tokens
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.t === 'word') {
      if (current.length === 0 && token.quoted) literalStarts.add(current)
      current.push(token.v)
    } else if (token.t === 'redirect') {
      const target = tokens[i + 1]
      if (token.v.startsWith('<')) {
        if (target?.t === 'word') current.push(target.v) // input file: path-checked as an argument
        i++
        continue
      }
      if (/&\d$/.test(token.v)) continue // 2>&1
      if (target?.t === 'word') {
        redirects.push(target.v)
        i++
      }
    } else {
      if (current.length) segments.push(current)
      current = []
    }
  }
  if (current.length) segments.push(current)

  // Output redirected to a file changes files
  for (const target of redirects) {
    if (NULL_DEVICES.has(target.toLowerCase())) continue
    raise('write', 'writes')
    const resolved = resolvePathWord(target, root, dialect)
    if (resolved && !inside(root, resolved)) raise('risky', 'outside')
  }

  let blocked: string | undefined

  for (const words of segments) {
    let index = 0
    // bash: VAR=value prefixes
    if (dialect === 'bash')
      while (index < words.length && /^[A-Za-z_]\w*=/.test(words[index])) index++
    if (index >= words.length) continue
    const raw = words[index]
    const name = normalizeName(raw, dialect)
    const args = words.slice(index + 1)
    let commandLevel: CommandLevel

    if (dialect === 'bash') {
      if (BASH.blocked.has(name) || name.startsWith('mkfs')) {
        blocked ??= name
        commandLevel = 'blocked'
      } else if (BASH.network.has(name)) ((commandLevel = 'risky'), reasons.add('network'))
      else if (BASH.program.has(name)) ((commandLevel = 'risky'), reasons.add('program'))
      else if (BASH.packages.has(name)) ((commandLevel = 'risky'), reasons.add('packages'))
      else if (BASH.process.has(name)) ((commandLevel = 'risky'), reasons.add('process'))
      else if (name === 'git') {
        const sub = args.find((a) => !a.startsWith('-')) ?? ''
        if (['fetch', 'pull', 'push', 'clone', 'submodule', 'ls-remote'].includes(sub))
          ((commandLevel = 'risky'), reasons.add('network'))
        else if (
          [
            'status',
            'log',
            'diff',
            'show',
            'ls-files',
            'blame',
            'rev-parse',
            'describe',
            'shortlog',
            'grep'
          ].includes(sub) ||
          (['branch', 'tag', 'remote', 'stash'].includes(sub) &&
            args.filter((a) => a !== sub && !/^-(v|l|a|-list)$/.test(a)).length === 0) ||
          (sub === 'config' && args.some((a) => /^(--get|--list|-l)$/.test(a)))
        )
          commandLevel = 'read'
        else ((commandLevel = 'write'), reasons.add('writes'))
      } else if (name === 'find') {
        if (args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)))
          ((commandLevel = 'risky'), reasons.add('program'))
        else if (args.some((a) => /^-(delete|fprint|fprintf|fls)$/.test(a)))
          ((commandLevel = 'write'), reasons.add('writes'))
        else commandLevel = 'read'
      } else if (name === 'sed') {
        commandLevel = args.some((a) => /^-[a-z]*i/.test(a) || a === '--in-place')
          ? 'write'
          : 'read'
        if (commandLevel === 'write') reasons.add('writes')
      } else if (name === 'awk') {
        if (args.some((a) => /system\s*\(|\|\s*getline|print[^;]*>|printf[^;]*>/.test(a)))
          ((commandLevel = 'risky'), reasons.add('program'))
        else commandLevel = 'read'
      } else if (BASH.read.has(name)) commandLevel = 'read'
      else if (BASH.write.has(name)) ((commandLevel = 'write'), reasons.add('writes'))
      else if (isScriptPath(raw)) ((commandLevel = 'risky'), reasons.add('program'))
      else ((commandLevel = 'risky'), reasons.add('unknown'))
    } else {
      const verb = name.includes('-') ? name.split('-')[0] : ''
      if (PS.blocked.has(name) || PS_BLOCKED_CMDLETS.has(name)) {
        blocked ??= raw
        commandLevel = 'blocked'
      } else if (PS.network.has(name) || PS_NETWORK_CMDLETS.has(name))
        ((commandLevel = 'risky'), reasons.add('network'))
      else if (PS.program.has(name) || PS_PROGRAM_CMDLETS.has(name))
        ((commandLevel = 'risky'), reasons.add('program'))
      else if (PS.packages.has(name) || PS_PACKAGE_CMDLETS.has(name))
        ((commandLevel = 'risky'), reasons.add('packages'))
      else if (PS.process.has(name) || PS_PROCESS_CMDLETS.has(name))
        ((commandLevel = 'risky'), reasons.add('process'))
      else if (name === 'git' || name === 'git.exe') {
        const sub = args.find((a) => !a.startsWith('-')) ?? ''
        if (['fetch', 'pull', 'push', 'clone', 'submodule', 'ls-remote'].includes(sub))
          ((commandLevel = 'risky'), reasons.add('network'))
        else if (
          [
            'status',
            'log',
            'diff',
            'show',
            'ls-files',
            'blame',
            'rev-parse',
            'describe',
            'shortlog'
          ].includes(sub)
        )
          commandLevel = 'read'
        else ((commandLevel = 'write'), reasons.add('writes'))
      } else if (PS_READ_CMDLETS.has(name) || PS.read.has(name)) commandLevel = 'read'
      else if (PS.write.has(name)) ((commandLevel = 'write'), reasons.add('writes'))
      else if (verb && PS_READ_VERBS.has(verb)) commandLevel = 'read'
      else if (verb && PS_WRITE_VERBS.has(verb)) ((commandLevel = 'write'), reasons.add('writes'))
      else if (
        literalStarts.has(words) ||
        name.startsWith('$') ||
        name.startsWith('[') ||
        /^\d/.test(raw) ||
        ['if', 'else', 'elseif', 'foreach', 'for', 'while', 'return', 'param'].includes(name)
      )
        commandLevel = 'read' // expressions / keywords; the cmdlets inside are their own segments
      else if (isScriptPath(raw)) ((commandLevel = 'risky'), reasons.add('program'))
      else ((commandLevel = 'risky'), reasons.add('unknown'))

      // Encoded / hidden payloads
      if (args.some((a) => /^-(e|en|enc|encodedcommand|ec)$/i.test(a)))
        ((commandLevel = 'risky'), reasons.add('program'))
    }

    raise(commandLevel)

    // Every path argument must stay inside the project (reads may also
    // reach the skill folders)
    const writing = commandLevel !== 'read'
    for (const arg of args) {
      if (dialect === 'bash' && /^-/.test(arg) && !/[=:]/.test(arg)) continue
      const resolved = resolvePathWord(arg, root, dialect)
      if (!resolved) {
        // Variables in arguments of commands that change things can point anywhere
        if (writing && /\$(?!_\b|PSItem\b|null\b|true\b|false\b)/i.test(arg))
          raise('risky', 'complex')
        continue
      }
      const allowed = writing ? [root] : readable
      if (!allowed.some((r) => inside(r, resolved))) raise('risky', 'outside')
      if (DELETE_COMMANDS.has(name) && inside(resolved, root)) raise('risky', 'project-root')
    }
    // `rm -r .` / `Remove-Item * -Recurse` at the project root
    if (
      DELETE_COMMANDS.has(name) &&
      args.some((a) => a === '.' || a === '*' || a === './*' || a === '.\\*')
    )
      raise('risky', 'project-root')
  }

  if (blocked) return { level: 'blocked', reasons: [], blocked }
  return { level, reasons: [...reasons] }
}

// ── Running ─────────────────────────────────────────────

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION)/i

const commandEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      SECRET_ENV.test(key) ||
      key.startsWith('ELECTRON_') ||
      key === 'NODE_OPTIONS'
    )
      continue
    env[key] = value
  }
  env.PAGER = 'cat'
  env.GIT_PAGER = 'cat'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

// Windows PowerShell: UTF-8 output, no progress bars, and Constrained
// Language Mode (no direct .NET / COM / Add-Type) for the user's command
const psScript = (command: string) =>
  [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'",
    command
  ].join('\n')

export interface ShellResult {
  exit_code: number | null
  timed_out: boolean
  stdout: string
  stderr: string
  started: number
}

const capped = (text: string, limit: number) =>
  text.length > limit ? `… (${text.length - limit} characters cut)\n${text.slice(-limit)}` : text

export const runShellCommand = (options: {
  command: string
  root: string
  timeoutMs?: number
  outputLimit?: number
  shellPath?: string // tests
}): Promise<ShellResult> => {
  const { command, root, timeoutMs = 120_000, outputLimit = 20_000 } = options
  const dialect = shellDialect()
  const started = Date.now()

  const [file, args] =
    dialect === 'powershell' || options.shellPath?.includes('pwsh')
      ? [
          options.shellPath ?? 'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(psScript(command), 'utf16le').toString('base64')
          ]
        ]
      : [options.shellPath ?? '/bin/bash', ['--noprofile', '--norc', '-c', command]]

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: root,
      env: commandEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32' // own process group, so the whole tree can be killed
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const max = outputLimit * 4
    child.stdout.on('data', (d) => (stdout = (stdout + d.toString()).slice(-max)))
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-max)))

    const killTree = () => {
      try {
        if (process.platform === 'win32')
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        else process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    let done = false
    const finish = (exitCode: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
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
    child.on('close', (code) => finish(code))
  })
}
