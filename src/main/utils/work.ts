// @ts-nocheck

import http from 'http'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { app, dialog, session, shell, webContents, BrowserWindow } from 'electron'
import log from 'electron-log'
import { getConfig, setConfig } from './index'
import { extractDocumentText, isExtractableDocument } from './work-documents'

// ─── Work Mode: Local Files Server ──────────────────────
// A small HTTP server that gives Open WebUI's agent loop access to a
// local folder.  It speaks the Open Terminal file API, so Open WebUI
// treats it as a user-level ("direct") terminal server:
//
//   • tools from /openapi.json are offered to every model in every chat,
//   • the browser (our webview) executes the tool calls, so the Open
//     WebUI server never needs to reach this machine,
//   • the built-in file browser / preview pane works against it.
//
// Each Open WebUI project (folder) can be linked to a local directory.
// Open WebUI sends the chat id with every call (X-Session-Id), which we
// map to the chat's folder and then to the linked directory.  Chats
// outside a linked project get no file access.
//
// Every connection gets its own base path (/c/<connectionId>) so tokens,
// projects and CORS origins never mix between servers.

export type WorkMode = 'read' | 'confirm' | 'auto'

export interface WorkProject {
  connectionId: string
  folderId: string
  folderName: string
  path: string
  mode: WorkMode
}

export interface WorkConfig {
  enabled: boolean
  port: number
  apiKey: string
  projects: Record<string, WorkProject>
}

const DEFAULT_PORT = 39380
const MAX_BODY_BYTES = 100 * 1024 * 1024
const MAX_TEXT_READ_BYTES = 5 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const MAX_WALK_ENTRIES = 50_000
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', '.DS_Store'])
const CHAT_FOLDER_TTL = 10_000
const FOLDERS_TTL = 30_000
const REGISTER_RETRY_MS = 5_000
const SERVER_NAME = 'Local Files (Desktop)'

// ─── State ──────────────────────────────────────────────

let server: http.Server | null = null
let port: number | null = null
let apiKey: string | null = null
let status: string | null = null // null | started | stopped | failed

let getWindow: () => BrowserWindow | null = () => null
let emit: (type: string, data?: any) => void = () => {}

// connectionId → Open WebUI origin (e.g. https://chat.example.com)
const attached = new Map<string, { url: string; origin: string }>()
const registered = new Set<string>()
const registering = new Set<string>()
const reloaded = new Set<string>()
const registerTimers = new Map<string, NodeJS.Timeout>()

const chatFolderCache = new Map<string, { folderId: string | null; ts: number }>()
const foldersCache = new Map<string, { folders: any[]; ts: number }>()
// Chats where the user picked "Allow for this chat" in the approval dialog
const chatApprovals = new Set<string>()

// ─── Public API ─────────────────────────────────────────

export const getWorkInfo = () => ({
  status,
  port,
  connections: [...attached.entries()].map(([id, c]) => ({
    id,
    url: c.url,
    registered: registered.has(id)
  }))
})

export const initWork = (options: {
  getWindow: () => BrowserWindow | null
  emit: (type: string, data?: any) => void
}) => {
  getWindow = options.getWindow
  emit = options.emit
}

const workConfig = async (): Promise<WorkConfig> => {
  const config = await getConfig()
  return {
    enabled: true,
    port: DEFAULT_PORT,
    apiKey: '',
    projects: {},
    ...(config.work ?? {})
  }
}

const saveWorkConfig = async (patch: Partial<WorkConfig>) => {
  const current = await workConfig()
  await setConfig({ work: { ...current, ...patch } })
}

const projectKey = (connectionId: string, folderId: string) => `${connectionId}:${folderId}`

export const startWorkServer = async (): Promise<void> => {
  if (server) return
  const config = await workConfig()
  if (!config.enabled) {
    status = 'stopped'
    return
  }

  apiKey = config.apiKey
  if (!apiKey) {
    apiKey = crypto.randomBytes(24).toString('base64url')
    await saveWorkConfig({ apiKey })
  }

  const srv = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log.error('[work] request failed:', err)
      if (!res.headersSent) sendJson(res, 500, { detail: String(err?.message ?? err) })
      else res.end()
    })
  })

  // Keep the port stable across launches — it is part of the URL
  // stored in the user's Open WebUI settings.
  let candidate = config.port || DEFAULT_PORT
  for (let attempt = 0; attempt < 20; attempt++, candidate++) {
    const ok = await new Promise<boolean>((resolve) => {
      srv.once('error', () => resolve(false))
      srv.listen(candidate, '127.0.0.1', () => resolve(true))
    })
    if (ok) break
  }

  if (!srv.listening) {
    status = 'failed'
    log.error('[work] could not bind a local port')
    return
  }

  server = srv
  port = candidate
  status = 'started'
  if (port !== config.port) await saveWorkConfig({ port })
  log.info(`[work] local files server listening on http://127.0.0.1:${port}`)

  // Connections attached before the server started
  for (const id of attached.keys()) scheduleRegister(id, 0)
}

export const stopWorkServer = async (): Promise<void> => {
  for (const t of registerTimers.values()) clearTimeout(t)
  registerTimers.clear()
  registered.clear()
  registering.clear()
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
  status = 'stopped'
}

const baseUrlFor = (connectionId: string) =>
  `http://127.0.0.1:${port}/c/${encodeURIComponent(connectionId)}`

// Called by the renderer whenever a connection's webview finishes loading.
export const attachWorkConnection = (connectionId: string, url: string) => {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return
  }
  attached.set(connectionId, { url, origin })
  if (!registered.has(connectionId)) scheduleRegister(connectionId, 0)
}

// ─── Open WebUI API (as the signed-in user) ─────────────

const connectionSession = (connectionId: string) =>
  session.fromPartition(`persist:connection-${connectionId}`)

// The webview keeps the user's JWT in localStorage — reuse it so every
// call is made with exactly the user's Open WebUI permissions.
const getToken = async (connectionId: string): Promise<string | null> => {
  const ses = connectionSession(connectionId)
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (contents.isDestroyed() || contents.getType() !== 'webview') continue
      if (contents.session !== ses) continue
      const token = await contents.executeJavaScript(`localStorage.getItem('token') || ''`)
      if (token) return token
    } catch {
      // Not ready yet
    }
  }
  return null
}

const owuiFetch = async (connectionId: string, apiPath: string, init: any = {}) => {
  const conn = attached.get(connectionId)
  if (!conn) throw new Error('Connection is not open')
  const token = await getToken(connectionId)
  if (!token) throw new Error('Not signed in to Open WebUI')

  const res = await connectionSession(connectionId).fetch(`${conn.origin}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  })
  if (!res.ok) throw new Error(`Open WebUI ${apiPath} → ${res.status}`)
  return res.json()
}

export const listWorkFolders = async (connectionId: string, force = false): Promise<any[]> => {
  const cached = foldersCache.get(connectionId)
  if (!force && cached && Date.now() - cached.ts < FOLDERS_TTL) return cached.folders
  const folders = await owuiFetch(connectionId, '/api/v1/folders/')
  const list = Array.isArray(folders) ? folders : (folders?.items ?? [])
  foldersCache.set(connectionId, { folders: list, ts: Date.now() })
  return list
}

const getChatFolderId = async (connectionId: string, chatId: string): Promise<string | null> => {
  const key = `${connectionId}:${chatId}`
  const cached = chatFolderCache.get(key)
  if (cached && Date.now() - cached.ts < CHAT_FOLDER_TTL) return cached.folderId
  let folderId: string | null = null
  try {
    const chat = await owuiFetch(connectionId, `/api/v1/chats/${encodeURIComponent(chatId)}`)
    folderId = chat?.folder_id ?? null
  } catch (err) {
    log.warn(`[work] chat lookup failed for ${chatId}:`, err?.message ?? err)
  }
  // A chat can be moved into a project at any time — keep "no folder" short
  chatFolderCache.set(key, {
    folderId,
    ts: folderId ? Date.now() : Date.now() - CHAT_FOLDER_TTL + 2_000
  })
  return folderId
}

const readTerminalServers = async (connectionId: string): Promise<any[]> => {
  const settings = await owuiFetch(connectionId, '/api/v1/users/user/settings?raw=true')
  return settings?.ui?.terminalServers ?? []
}

const saveTerminalServers = (connectionId: string, servers: any[]) =>
  owuiFetch(connectionId, '/api/v1/users/user/settings/update', {
    method: 'POST',
    body: JSON.stringify({ ui: { terminalServers: servers } })
  })

// Register this server as a user-level terminal server in the user's
// Open WebUI settings.  Field-level patch — other settings are untouched.
// Open WebUI allows only one active terminal, so once our entry exists we
// never flip its `enabled` flag here: the user may have switched to
// another terminal on purpose.  setWorkServerEnabled() does that on request.
const ensureRegistered = async (connectionId: string): Promise<'ok' | 'changed'> => {
  const url = baseUrlFor(connectionId)
  const servers = await readTerminalServers(connectionId)

  const current = servers.find((s) => s?.desktop_work)
  if (current && current.url === url && current.key === apiKey) return 'ok'

  await saveTerminalServers(connectionId, [
    ...servers.filter((s) => !s?.desktop_work),
    {
      url,
      key: apiKey,
      name: SERVER_NAME,
      auth_type: 'bearer',
      path: '/openapi.json',
      enabled: current ? current.enabled !== false : true,
      desktop_work: true
    }
  ])
  return 'changed'
}

// Whether Open WebUI currently offers our tools — this is the Chat / Work
// switch (also Open WebUI → Settings → Integrations → Open Terminal).
export const getWorkServerEnabled = async (connectionId: string): Promise<boolean | null> => {
  const servers = await readTerminalServers(connectionId)
  const current = servers.find((s) => s?.desktop_work)
  return current ? current.enabled !== false : null
}

// Switch between Chat and Work: turn our terminal server on/off in Open
// WebUI.  Enabling mirrors Open WebUI's own toggle (other direct terminals
// are switched off) and also selects it in the chat input's terminal menu,
// so the file panel works right away.
export const setWorkServerEnabled = async (connectionId: string, enabled: boolean) => {
  await ensureRegistered(connectionId)
  const servers = await readTerminalServers(connectionId)
  await saveTerminalServers(
    connectionId,
    servers.map((s) =>
      s?.desktop_work ? { ...s, enabled } : enabled ? { ...s, enabled: false } : s
    )
  )

  // Open WebUI restores the selected terminal from localStorage on load
  const url = JSON.stringify(baseUrlFor(connectionId))
  const script = enabled
    ? `localStorage.setItem('selectedTerminalId', ${url})`
    : `if (localStorage.getItem('selectedTerminalId') === ${url}) localStorage.removeItem('selectedTerminalId')`
  const ses = connectionSession(connectionId)
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (contents.isDestroyed() || contents.getType() !== 'webview' || contents.session !== ses)
        continue
      await contents.executeJavaScript(script)
    } catch {
      // Page not ready — the setting still applies after reload
    }
  }

  // Open WebUI reads terminal servers on load
  emit('work:reload', { connectionId })
}

const scheduleRegister = (connectionId: string, delay = REGISTER_RETRY_MS) => {
  if (!server) return
  clearTimeout(registerTimers.get(connectionId))
  registerTimers.set(
    connectionId,
    setTimeout(async () => {
      registerTimers.delete(connectionId)
      // Webviews fire several load events in a row — one registration at a time
      if (registering.has(connectionId) || registered.has(connectionId)) return
      registering.add(connectionId)
      try {
        const result = await ensureRegistered(connectionId)
        registered.add(connectionId)
        log.info(`[work] registered with ${connectionId} (${result})`)
        // Open WebUI loads terminal servers on startup; reload once so the
        // freshly-saved server is picked up.
        if (result === 'changed' && !reloaded.has(connectionId)) {
          reloaded.add(connectionId)
          emit('work:reload', { connectionId })
        }
        emit('work:status', getWorkInfo())
      } catch (err) {
        // Usually "not signed in yet" — retry until the user logs in
        log.debug(`[work] register ${connectionId} pending: ${err?.message ?? err}`)
        registering.delete(connectionId)
        scheduleRegister(connectionId)
        return
      }
      registering.delete(connectionId)
    }, delay)
  )
}

// ─── Projects ───────────────────────────────────────────

export const getWorkProjects = async (connectionId: string) => {
  const config = await workConfig()
  let folders: any[] = []
  let error: string | null = null
  try {
    folders = await listWorkFolders(connectionId, true)
  } catch (err) {
    error = err?.message ?? String(err)
  }
  let serverEnabled: boolean | null = null
  if (!error) serverEnabled = await getWorkServerEnabled(connectionId).catch(() => null)
  return {
    error,
    serverEnabled,
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parent_id ?? null,
      project: config.projects[projectKey(connectionId, f.id)] ?? null
    }))
  }
}

export const linkWorkProject = async (
  connectionId: string,
  folderId: string,
  folderName: string,
  dirPath: string,
  mode: WorkMode = 'confirm'
) => {
  const config = await workConfig()
  const projects = {
    ...config.projects,
    [projectKey(connectionId, folderId)]: {
      connectionId,
      folderId,
      folderName,
      path: dirPath,
      mode
    }
  }
  await saveWorkConfig({ projects })
}

export const updateWorkProject = async (
  connectionId: string,
  folderId: string,
  patch: Partial<WorkProject>
) => {
  const config = await workConfig()
  const key = projectKey(connectionId, folderId)
  if (!config.projects[key]) return
  await saveWorkConfig({
    projects: { ...config.projects, [key]: { ...config.projects[key], ...patch } }
  })
}

export const unlinkWorkProject = async (connectionId: string, folderId: string) => {
  const config = await workConfig()
  const projects = { ...config.projects }
  delete projects[projectKey(connectionId, folderId)]
  await saveWorkConfig({ projects })
}

// Find the linked project for a chat.  Chats in a sub-folder inherit the
// nearest linked ancestor.
// Nearest linked project for a folder — sub-folders inherit their parent's link
const projectForFolder = async (
  connectionId: string,
  folderId: string
): Promise<WorkProject | null> => {
  const { projects } = await workConfig()
  let current: string | null = folderId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const project = projects[projectKey(connectionId, current)]
    if (project) return project
    const folders = await listWorkFolders(connectionId).catch(() => [])
    current = folders.find((f) => f.id === current)?.parent_id ?? null
  }
  return null
}

const projectForChat = async (
  connectionId: string,
  chatId: string
): Promise<WorkProject | null> => {
  if (!chatId || chatId.startsWith('local:')) return null
  const folderId = await getChatFolderId(connectionId, chatId)
  return folderId ? projectForFolder(connectionId, folderId) : null
}

// The project of the page open in a webview: /folders/<id> or the chat /c/<id>
export const getWorkContext = async (connectionId: string, pageUrl: string) => {
  let pathname: string
  try {
    pathname = new URL(pageUrl).pathname
  } catch {
    return null
  }
  if (!attached.has(connectionId)) return null

  let folderId = pathname.match(/\/folders\/([^/?#]+)/)?.[1] ?? null
  const chatId = pathname.match(/\/c\/([^/?#]+)/)?.[1] ?? null
  if (!folderId && chatId)
    folderId = await getChatFolderId(connectionId, decodeURIComponent(chatId))
  if (!folderId) return null
  folderId = decodeURIComponent(folderId)

  let folders = await listWorkFolders(connectionId).catch(() => [])
  if (!folders.some((f) => f.id === folderId)) {
    folders = await listWorkFolders(connectionId, true).catch(() => [])
  }
  const folder = folders.find((f) => f.id === folderId)
  if (!folder) return null

  return {
    folderId,
    folderName: folder.name,
    project: await projectForFolder(connectionId, folderId)
  }
}

// ─── In-page Chat / Work switch ─────────────────────────

// Which connection a webview belongs to (by its partition session)
export const workConnectionForContents = (contents: Electron.WebContents): string | null => {
  for (const id of attached.keys()) {
    if (connectionSession(id) === contents.session) return id
  }
  return null
}

export const getWorkProjectPath = async (connectionId: string, folderId: string) => {
  const { projects } = await workConfig()
  return projects[projectKey(connectionId, folderId)]?.path ?? null
}

// Everything the in-page switch renders for the current page: the mode,
// the project context and — outside a project — the list to pick from.
export const getWorkPageState = async (connectionId: string, pageUrl: string) => {
  const enabled = await getWorkServerEnabled(connectionId).catch(() => null)
  const context = enabled ? await getWorkContext(connectionId, pageUrl).catch(() => null) : null
  let projects: any[] = []
  if (enabled && !context) {
    const { projects: linked } = await workConfig()
    projects = (await listWorkFolders(connectionId).catch(() => [])).map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parent_id ?? null,
      path: linked[projectKey(connectionId, f.id)]?.path ?? null
    }))
  }
  return { enabled, context, projects }
}

// ─── Path Sandboxing ────────────────────────────────────

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error'
  ) {
    super(message)
  }
}

// Model-facing denials are worded as final answers: reasoning models tend
// to deliberate at length over vague errors, so say what happened, that
// retrying won't help, and what to do instead.
const outsideError = (p: string, root: string) =>
  new HttpError(
    403,
    `Access denied: "${p}" is outside the project folder ${root}. Only files inside that folder ` +
      'are accessible. This is final — do not retry with another path; tell the user in one sentence.',
    'access_denied'
  )

const samePathCase = process.platform === 'win32' || process.platform === 'darwin'

const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(
    samePathCase ? root.toLowerCase() : root,
    samePathCase ? target.toLowerCase() : target
  )
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Resolve symlinks on the longest existing prefix so a link inside the
// project cannot point outside it, even for paths that don't exist yet.
const realpathLoose = async (target: string): Promise<string> => {
  let existing = target
  const rest: string[] = []
  while (true) {
    try {
      const real = await fs.promises.realpath(existing)
      return path.join(real, ...rest.reverse())
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return target
      rest.push(path.basename(existing))
      existing = parent
    }
  }
}

const skillRoots = (): string[] => {
  const home = os.homedir()
  return [
    path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'resources', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills')
  ]
}

interface Workspace {
  project: WorkProject
  root: string
}

const resolveIn = async (root: string, p: string | undefined | null): Promise<string | null> => {
  const raw = (p ?? '.').trim() || '.'
  const target = path.resolve(root, raw)
  const realRoot = await realpathLoose(root)
  const realTarget = await realpathLoose(target)
  return isInside(realRoot, realTarget) ? target : null
}

const resolvePath = async (ws: Workspace, p: string | undefined | null): Promise<string> => {
  const target = await resolveIn(ws.root, p)
  if (!target) throw outsideError(String(p), ws.root)
  return target
}

// Reads may also reach the skill folders (SKILL.md and its resources).
const resolveReadable = async (ws: Workspace | null, p: string): Promise<string> => {
  if (ws) {
    const target = await resolveIn(ws.root, p)
    if (target) return target
  }
  if (p && path.isAbsolute(p)) {
    for (const root of skillRoots()) {
      const target = await resolveIn(root, p)
      if (target) return target
    }
  }
  if (!ws) throw notLinkedError()
  throw outsideError(p, ws.root)
}

const notLinkedError = () =>
  new HttpError(
    409,
    'This chat is not in an Open WebUI project linked to a local folder, so no local files are ' +
      'accessible. Do not retry. Tell the user to move the chat into a project and link that project ' +
      'to a folder in the Work bar of Open WebUI Desktop.',
    'not_linked'
  )

// ─── Approvals ──────────────────────────────────────────

let approvalQueue: Promise<unknown> = Promise.resolve()

const requestApproval = (
  connectionId: string,
  chatId: string,
  ws: Workspace,
  action: string,
  detail: string
): Promise<boolean> => {
  const chatKey = `${connectionId}:${chatId}`
  if (ws.project.mode === 'auto' || chatApprovals.has(chatKey)) return Promise.resolve(true)

  // One dialog at a time — parallel tool calls queue up
  const run = async () => {
    if (chatApprovals.has(chatKey)) return true
    const win = getWindow()
    win?.show()
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'question',
      buttons: ['Allow', 'Allow for this chat', 'Deny'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Open WebUI — Work',
      message: `${action}`,
      detail: `Project: ${ws.project.folderName}\nFolder: ${ws.root}\n\n${detail}`.slice(0, 4000)
    })
    if (response === 1) chatApprovals.add(chatKey)
    return response !== 2
  }
  const result = approvalQueue.then(run, run)
  approvalQueue = result.catch(() => {})
  return result
}

const preview = (text: string, lines = 15): string => {
  const all = text.split('\n')
  const head = all.slice(0, lines).join('\n')
  return all.length > lines ? `${head}\n… (+${all.length - lines} more lines)` : head
}

// ─── Skills ─────────────────────────────────────────────
// Agent Skills (agentskills.io): <root>/<name>/SKILL.md with name +
// description frontmatter.  Project skills (<project>/.agents/skills)
// win over bundled and user-level ones with the same name.

const listSkills = async (ws: Workspace | null) => {
  const roots = [...(ws ? [path.join(ws.root, '.agents', 'skills')] : []), ...skillRoots()]
  const skills: any[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    let dirs: fs.Dirent[] = []
    try {
      dirs = await fs.promises.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const location = path.join(root, d.name, 'SKILL.md')
      let text: string
      try {
        text = await fs.promises.readFile(location, 'utf8')
      } catch {
        continue
      }
      const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
      const field = (k: string) =>
        front
          .match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, '') ?? ''
      const name = field('name') || d.name
      const description = field('description')
      if (!description || seen.has(name)) continue
      seen.add(name)
      skills.push({
        id: `terminal:${encodeURIComponent(name)}`,
        name,
        description: description.slice(0, 1024),
        location,
        scope: 'global',
        source: 'terminal',
        body: text.replace(/^---[\s\S]*?---\r?\n?/, '').trim()
      })
    }
  }
  return skills
}

// ─── HTTP Helpers ───────────────────────────────────────

const sendJson = (res: http.ServerResponse, code: number, body: any) => {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': data.length })
  res.end(data)
}

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const readJson = async (req: http.IncomingMessage): Promise<any> => {
  const body = await readBody(req)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

const parseMultipartFile = (body: Buffer, contentType: string) => {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!boundary) return null
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`)
  let start = body.indexOf(delimiter)
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length)
    if (next === -1) break
    const part = body.subarray(start + delimiter.length + 2, next - 2)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8')
      if (/name="file"/.test(headers)) {
        const filename = headers.match(/filename="([^"]*)"/)?.[1] || 'upload'
        return { filename, data: part.subarray(headerEnd + 4) }
      }
    }
    start = next
  }
  return null
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip'
}
const mimeFor = (p: string) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0)

const bool = (v: any, fallback: boolean) =>
  v === undefined || v === null || v === '' ? fallback : v === true || v === 'true'

// ─── Filesystem Helpers ─────────────────────────────────

const statEntry = async (full: string, name: string) => {
  const s = await fs.promises.stat(full)
  let writable = true
  try {
    await fs.promises.access(full, fs.constants.W_OK)
  } catch {
    writable = false
  }
  return {
    name,
    type: s.isDirectory() ? 'directory' : 'file',
    size: s.size,
    modified: s.mtimeMs / 1000,
    writable
  }
}

async function* walk(
  root: string,
  showHidden = false
): AsyncGenerator<{ full: string; rel: string; dirent: fs.Dirent }> {
  const stack = [root]
  let count = 0
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of entries) {
      if (SKIP_DIRS.has(dirent.name)) continue
      if (!showHidden && dirent.name.startsWith('.')) continue
      const full = path.join(dir, dirent.name)
      if (++count > MAX_WALK_ENTRIES) return
      yield { full, rel: path.relative(root, full).split(path.sep).join('/'), dirent }
      if (dirent.isDirectory()) stack.push(full)
    }
  }
}

const globToRegExp = (pattern: string): RegExp => {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

const readTextForModel = async (target: string) => {
  const ext = path.extname(target).toLowerCase()
  const buf = await fs.promises.readFile(target)
  if (isExtractableDocument(ext)) return extractDocumentText(buf, ext)
  if (isBinary(buf)) return null
  if (buf.length > MAX_TEXT_READ_BYTES) {
    return buf.subarray(0, MAX_TEXT_READ_BYTES).toString('utf8') + '\n… (truncated)'
  }
  return buf.toString('utf8')
}

// ─── OpenAPI Spec (tools offered to the model) ──────────

const str = (description: string) => ({ type: 'string', description })
const int = (description: string) => ({ type: 'integer', description })
const boolean = (description: string) => ({ type: 'boolean', description })
const query = (name: string, schema: any, required = false) => ({
  name,
  in: 'query',
  required,
  schema,
  description: schema.description
})
const jsonBody = (properties: Record<string, any>, required: string[]) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties, required } } }
})

const openApiSpec = () => ({
  openapi: '3.1.0',
  info: {
    title: SERVER_NAME,
    version: app.getVersion(),
    description:
      'Access to the local folder linked to the current Open WebUI project. ' +
      'Paths are relative to the project folder; anything outside it is rejected by the tools.'
  },
  paths: {
    '/workspace': {
      get: {
        operationId: 'get_workspace',
        summary: 'Get the project folder',
        description:
          "Return the local folder linked to this chat's project, its access mode " +
          '(read = read-only, confirm = changes need user approval, auto = changes allowed) ' +
          "and available skills (read a skill's SKILL.md with read_file when it fits the task). " +
          'Call this first before working with files.'
      }
    },
    '/files/list': {
      get: {
        operationId: 'list_files',
        summary: 'List directory contents',
        description: 'List files and sub-folders of a folder inside the project.',
        parameters: [
          query('directory', str('Folder path, relative to the project folder. Default "."'))
        ]
      }
    },
    '/files/read': {
      get: {
        operationId: 'read_file',
        summary: 'Read a file',
        description:
          'Read a file and return its text. Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) ' +
          'files are converted to text (tables as | cells |, sheets as CSV). ' +
          'Optionally request a line range for large files.',
        parameters: [
          query(
            'path',
            str('File path, relative to the project folder (absolute paths inside it work too).'),
            true
          ),
          query('start_line', int('First line to return (1-indexed).')),
          query('end_line', int('Last line to return (1-indexed, inclusive).'))
        ]
      }
    },
    '/files/display': {
      get: {
        operationId: 'display_file',
        summary: 'Show a file to the user',
        description:
          "Open a file in the user's file preview panel. Use after creating or changing a " +
          'document the user should look at. Does not return the content.',
        parameters: [
          query(
            'path',
            str('File path, relative to the project folder (absolute paths inside it work too).'),
            true
          )
        ]
      }
    },
    '/files/grep': {
      post: {
        operationId: 'grep_search',
        summary: 'Search text inside files',
        description:
          'Search for text or a regular expression in text files of the project. ' +
          'Returns file paths, line numbers and matching lines.',
        requestBody: jsonBody(
          {
            query: str('Text or regular expression to find.'),
            path: str('Folder or file to search in, relative to the project folder. Default "."'),
            regex: boolean('Treat query as a regular expression. Default false.'),
            case_insensitive: boolean('Ignore case. Default true.'),
            include: str('Only search files matching this glob, e.g. "*.md".'),
            max_results: int('Maximum matches to return. Default 50.')
          },
          ['query']
        )
      }
    },
    '/files/glob': {
      get: {
        operationId: 'glob_search',
        summary: 'Find files by name pattern',
        description:
          'Find files and folders whose path matches a glob pattern, e.g. "**/*.xlsx" or "*report*".',
        parameters: [
          query(
            'pattern',
            str('Glob pattern. Without "/" it matches file names at any depth.'),
            true
          ),
          query('path', str('Folder to search in, relative to the project folder. Default "."')),
          query('type', str('Filter: file, directory or any. Default any.')),
          query('max_results', int('Maximum results. Default 100.'))
        ]
      }
    },
    '/files/write': {
      post: {
        operationId: 'write_file',
        summary: 'Write a text file',
        description:
          'Create or overwrite a text file (txt, md, csv, json, html, …). Parent folders are ' +
          'created automatically. Depending on the project mode the user may need to approve.',
        requestBody: jsonBody(
          {
            path: str(
              'File path, relative to the project folder (absolute paths inside it work too).'
            ),
            content: str('Full text content of the file.')
          },
          ['path', 'content']
        )
      }
    },
    '/files/replace': {
      post: {
        operationId: 'replace_file_content',
        summary: 'Edit a text file',
        description:
          'Replace exact text fragments in a text file. Each target must match exactly once ' +
          'unless allow_multiple is true. Prefer this over rewriting the whole file.',
        requestBody: jsonBody(
          {
            path: str(
              'File path, relative to the project folder (absolute paths inside it work too).'
            ),
            replacements: {
              type: 'array',
              description: 'Replacements applied in order.',
              items: {
                type: 'object',
                properties: {
                  target: str('Exact text to find.'),
                  replacement: str('Text to put instead.'),
                  allow_multiple: boolean('Replace all occurrences. Default false.')
                },
                required: ['target', 'replacement']
              }
            }
          },
          ['path', 'replacements']
        )
      }
    },
    '/tools/create_directory': {
      post: {
        operationId: 'create_directory',
        summary: 'Create a folder',
        description: 'Create a folder (and missing parents) inside the project.',
        requestBody: jsonBody(
          {
            path: str(
              'Folder path, relative to the project folder (absolute paths inside it work too).'
            )
          },
          ['path']
        )
      }
    },
    '/tools/move_path': {
      post: {
        operationId: 'move_path',
        summary: 'Move or rename',
        description: 'Move or rename a file or folder inside the project.',
        requestBody: jsonBody(
          {
            source: str(
              'Existing path, relative to the project folder (absolute paths inside it work too).'
            ),
            destination: str(
              'New path, relative to the project folder (absolute paths inside it work too).'
            )
          },
          ['source', 'destination']
        )
      }
    },
    '/tools/copy_path': {
      post: {
        operationId: 'copy_path',
        summary: 'Copy a file or folder',
        description: 'Copy a file or folder inside the project.',
        requestBody: jsonBody(
          {
            source: str(
              'Existing path, relative to the project folder (absolute paths inside it work too).'
            ),
            destination: str(
              'Destination path, relative to the project folder (absolute paths inside it work too).'
            )
          },
          ['source', 'destination']
        )
      }
    },
    '/tools/delete_path': {
      post: {
        operationId: 'delete_path',
        summary: 'Move to trash',
        description: 'Move a file or folder to the system trash (recoverable by the user).',
        requestBody: jsonBody(
          {
            path: str('Path, relative to the project folder (absolute paths inside it work too).')
          },
          ['path']
        )
      }
    }
  }
})

// Routes exposed to the model as tools (see openApiSpec)
const MODEL_TOOL_ROUTES = new Set(Object.keys(openApiSpec().paths))

const SYSTEM_PROMPT =
  "You can work with files in a local folder on the user's computer through the Local Files tools " +
  '(get_workspace, list_files, read_file, grep_search, glob_search, write_file, replace_file_content, ' +
  'create_directory, move_path, copy_path, delete_path, display_file). They only work when the chat ' +
  'belongs to an Open WebUI project that the user linked to a local folder in Open WebUI Desktop. ' +
  'When the user asks about their files or documents, call get_workspace first. Use paths relative to ' +
  'the project folder. The tools enforce all access limits themselves: when the user asks for a file, ' +
  'just call the tool and report its answer briefly — never deliberate about whether a path is allowed. ' +
  'If one of the listed skills fits the task, read its SKILL.md with read_file and follow it. Explore ' +
  'before changing anything, make focused edits, and after creating or changing a document call ' +
  "display_file so the user can review it. Some changes need the user's approval; when a tool " +
  'returns an error, do not retry the same action — explain it to the user.'

// ─── Request Router ─────────────────────────────────────

const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const match = url.pathname.match(/^\/c\/([^/]+)(\/.*)?$/)
  const connectionId = match ? decodeURIComponent(match[1]) : null
  const route = match?.[2] ?? '/'
  const conn = connectionId ? attached.get(connectionId) : null

  // CORS — only the Open WebUI origin of this connection may call us
  const origin = req.headers.origin
  if (origin && conn && origin === conn.origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Session-Id, X-User-Id'
    )
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Access-Control-Expose-Headers', '*')
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (route === '/health') return sendJson(res, 200, { status: 'ok' })
  if (!conn) return sendJson(res, 404, { detail: 'Unknown connection' })

  // Capability discovery is fetched without credentials
  if (route === '/api/config') {
    return sendJson(res, 200, { features: { terminal: false, notebooks: false, system: true } })
  }

  const auth = req.headers.authorization ?? ''
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''))
  const expected = Buffer.from(apiKey ?? '')
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return sendJson(res, 401, { detail: 'Invalid API key' })
  }

  const chatId = String(req.headers['x-session-id'] ?? '')

  try {
    await routeRequest(req, res, url, route, connectionId!, chatId)
  } catch (err) {
    let failure: HttpError | null = err instanceof HttpError ? err : null
    if (err?.code === 'ENOENT')
      failure = new HttpError(404, 'File or folder not found.', 'not_found')
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      failure = new HttpError(403, 'The operating system denied access to this file.', 'os_denied')
    }
    if (!failure) throw err

    // For tool calls Open WebUI would hand the model "HTTP error! Status:
    // 403. Message: {...escaped JSON...}" — answer with a clean result
    // instead.  UI-only endpoints keep real status codes.
    if (MODEL_TOOL_ROUTES.has(route)) {
      return sendJson(res, 200, {
        error: failure.code,
        message: failure.message,
        ...(route === '/files/display' ? { exists: false } : {})
      })
    }
    return sendJson(res, failure.status, { detail: failure.message })
  }
}

const routeRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  route: string,
  connectionId: string,
  chatId: string
) => {
  const q = url.searchParams
  const method = req.method ?? 'GET'

  if (route === '/openapi.json') return sendJson(res, 200, openApiSpec())
  if (route === '/system') return sendJson(res, 200, { prompt: SYSTEM_PROMPT })

  const project = chatId ? await projectForChat(connectionId, chatId) : null
  let ws: Workspace | null = project ? { project, root: path.resolve(project.path) } : null

  // Some UI requests (preview, download) are sent without a chat id —
  // accept them for paths inside any project linked on this connection.
  const wsForAbsolute = async (p: string | null): Promise<Workspace> => {
    if (ws) return ws
    if (p && path.isAbsolute(p)) {
      const { projects } = await workConfig()
      for (const candidate of Object.values(projects)) {
        if (candidate.connectionId !== connectionId) continue
        const root = path.resolve(candidate.path)
        if (await resolveIn(root, p)) return { project: candidate, root }
      }
    }
    throw notLinkedError()
  }
  const requireWs = (): Workspace => {
    if (!ws) throw notLinkedError()
    return ws
  }

  const guardWrite = async (w: Workspace, action: string, detail: string) => {
    if (w.project.mode === 'read') {
      throw new HttpError(
        403,
        'The project is read-only (set by the user in Open WebUI Desktop), so files cannot be changed. ' +
          'Do not retry; tell the user and suggest switching the project to "Ask before changes".',
        'read_only'
      )
    }
    const ok = await requestApproval(connectionId, chatId, w, action, detail)
    if (!ok) {
      throw new HttpError(
        403,
        'The user declined this change. Do not retry it; ask the user how they want to proceed.',
        'declined'
      )
    }
    emit('work:activity', { connectionId, chatId, project: w.project.folderName, action })
  }

  // ── Skills (Agent Skills: <root>/<name>/SKILL.md) ──
  if (route === '/skills' || route === '/skills/read') {
    const skills = await listSkills(ws)
    if (route === '/skills')
      return sendJson(
        res,
        200,
        skills.map(({ body, ...s }) => s)
      )
    const skill = skills.find((s) => s.name === q.get('name'))
    if (!skill) throw new HttpError(404, 'Skill not found')
    const resources: string[] = []
    for await (const { rel, dirent } of walk(path.dirname(skill.location))) {
      if (dirent.isFile() && rel !== 'SKILL.md') resources.push(rel)
      if (resources.length >= 50) break
    }
    const { body, ...summary } = skill
    return sendJson(res, 200, { ...summary, content: body, resources })
  }

  // ── Workspace info ──
  if (route === '/workspace') {
    if (!ws) {
      return sendJson(res, 200, { linked: false, message: notLinkedError().message })
    }
    return sendJson(res, 200, {
      linked: true,
      project: ws.project.folderName,
      path: ws.root,
      mode: ws.project.mode,
      os: `${process.platform} ${os.release()}`,
      // Progressive disclosure: only name + description here; the model
      // reads SKILL.md with read_file when a skill fits the task
      skills: (await listSkills(ws)).map(({ name, description, location }) => ({
        name,
        description,
        location
      }))
    })
  }

  // ── File browser: current directory ──
  if (route === '/files/cwd') {
    const w = requireWs()
    if (method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, { cwd: await resolvePath(w, body.path) })
    }
    return sendJson(res, 200, {
      cwd: w.root,
      home: w.root,
      root: { path: w.root, label: w.project.folderName }
    })
  }

  if (route === '/files/list') {
    const dir = q.get('directory') ?? '.'
    const target = await resolveReadable(ws ?? (await wsForAbsolute(dir).catch(() => null)), dir)
    const names = await fs.promises.readdir(target)
    const entries: any[] = []
    for (const name of names.sort()) {
      try {
        entries.push(await statEntry(path.join(target, name), name))
      } catch {
        // Broken link or vanished
      }
    }
    return sendJson(res, 200, { dir: target, writable: ws?.project.mode !== 'read', entries })
  }

  if (route === '/files/read') {
    const p = q.get('path') ?? ''
    const target = await resolveReadable(ws ?? (await wsForAbsolute(p).catch(() => null)), p)
    const stat = await fs.promises.stat(target)
    if (!stat.isFile()) throw new HttpError(404, 'File not found')

    const mime = mimeFor(target)
    if (mime.startsWith('image/')) {
      res.writeHead(200, { 'Content-Type': mime })
      res.end(await fs.promises.readFile(target))
      return
    }

    const text = await readTextForModel(target)
    if (text === null) {
      throw new HttpError(415, `Unsupported binary file type: ${mime} (${stat.size} bytes)`)
    }
    const lines = text.split(/(?<=\n)/)
    const start = Math.max(1, Number(q.get('start_line') ?? 1)) - 1
    const end = q.get('end_line') ? Number(q.get('end_line')) : lines.length
    return sendJson(res, 200, {
      path: target,
      total_lines: lines.length,
      content: lines.slice(start, end).join('')
    })
  }

  if (route === '/files/display') {
    const p = q.get('path') ?? ''
    const target = await resolvePath(requireWs(), p)
    const exists = await fs.promises
      .stat(target)
      .then((s) => s.isFile())
      .catch(() => false)
    return sendJson(res, 200, { path: target, exists })
  }

  if (route === '/files/view' || route.startsWith('/files/serve/')) {
    const p = route.startsWith('/files/serve/')
      ? decodeURIComponent(route.slice('/files/serve'.length))
      : (q.get('path') ?? '')
    const w = await wsForAbsolute(p)
    const target = await resolvePath(w, p)
    const data = await fs.promises.readFile(target)
    res.writeHead(200, { 'Content-Type': mimeFor(target), 'Content-Length': data.length })
    res.end(data)
    return
  }

  if (route === '/files/grep') {
    const w = requireWs()
    const params = method === 'POST' ? await readJson(req) : Object.fromEntries(q)
    const target = await resolvePath(w, params.path)
    const maxResults = Math.min(500, Number(params.max_results ?? 50))
    const flags = bool(params.case_insensitive, true) ? 'i' : ''
    let pattern: RegExp
    try {
      pattern = bool(params.regex, false)
        ? new RegExp(params.query, flags)
        : new RegExp(String(params.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    } catch (err) {
      throw new HttpError(400, `Invalid regex: ${err.message}`)
    }
    const include = params.include ? globToRegExp(String(params.include)) : null

    const matches: any[] = []
    const stat = await fs.promises.stat(target)
    const files = stat.isFile()
      ? [{ full: target, rel: path.basename(target) }]
      : (async function* () {
          for await (const e of walk(target)) if (e.dirent.isFile()) yield e
        })()

    outer: for await (const { full, rel } of files as any) {
      if (include && !include.test(path.basename(rel)) && !include.test(rel)) continue
      const ext = path.extname(full).toLowerCase()
      let text: string | null = null
      try {
        const s = await fs.promises.stat(full)
        if (s.size > MAX_SEARCH_FILE_BYTES && !isExtractableDocument(ext)) continue
        text = await readTextForModel(full)
      } catch {
        continue
      }
      if (text === null) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) })
          if (matches.length >= maxResults) break outer
        }
      }
    }
    return sendJson(res, 200, { matches, truncated: matches.length >= maxResults })
  }

  if (route === '/files/glob' || route === '/files/search' || route === '/files/matches') {
    const w = requireWs()
    const target = await resolvePath(w, q.get('path'))
    const type = q.get('type') ?? 'any'
    const showHidden = bool(q.get('show_hidden'), false)
    const limit = Math.min(500, Number(q.get('max_results') ?? q.get('limit') ?? 100))
    const term = (q.get('pattern') ?? q.get('query') ?? '').trim()
    const re =
      route === '/files/glob'
        ? globToRegExp(term || '*')
        : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '.*', 'i')

    const found: any[] = []
    for await (const { full, rel, dirent } of walk(target, showHidden)) {
      const kind = dirent.isDirectory() ? 'directory' : 'file'
      if (type !== 'any' && type !== kind) continue
      const subject = route === '/files/glob' && term.includes('/') ? rel : dirent.name
      if (!re.test(subject)) continue
      const s = await fs.promises.stat(full).catch(() => null)
      found.push({
        path: route === '/files/glob' ? rel : full,
        relative_path: rel,
        name: dirent.name,
        type: kind,
        size: s?.size,
        modified: s ? s.mtimeMs / 1000 : undefined,
        name_match: true,
        content_matches: []
      })
      if (found.length >= limit) break
    }
    if (route === '/files/glob') return sendJson(res, 200, { path: target, matches: found })
    if (route === '/files/matches') return sendJson(res, 200, { results: found, next_offset: null })
    return sendJson(res, 200, { results: found })
  }

  // ── Changes (model tools — gated by project mode) ──

  if (route === '/files/write' && method === 'POST') {
    const w = requireWs()
    const body = await readJson(req)
    const target = await resolvePath(w, body.path)
    const exists = fs.existsSync(target)
    const content = String(body.content ?? '')
    await guardWrite(
      w,
      `${exists ? 'Overwrite' : 'Create'} file ${path.relative(w.root, target)}`,
      preview(content)
    )
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, content, 'utf8')
    return sendJson(res, 200, { path: target, size: Buffer.byteLength(content) })
  }

  if (route === '/files/replace' && method === 'POST') {
    const w = requireWs()
    const body = await readJson(req)
    const target = await resolvePath(w, body.path)
    let content = await fs.promises.readFile(target, 'utf8')
    const replacements = Array.isArray(body.replacements) ? body.replacements : []
    for (const r of replacements) {
      const count = content.split(r.target).length - 1
      if (!r.target || count === 0) {
        throw new HttpError(400, `Target string not found: ${String(r.target).slice(0, 100)}`)
      }
      if (count > 1 && !r.allow_multiple) {
        throw new HttpError(400, `Found ${count} occurrences of target but allow_multiple is false`)
      }
      content = r.allow_multiple
        ? content.split(r.target).join(r.replacement)
        : content.replace(r.target, () => r.replacement)
    }
    await guardWrite(
      w,
      `Edit file ${path.relative(w.root, target)}`,
      replacements
        .map((r: any) => `− ${preview(r.target, 5)}\n+ ${preview(r.replacement, 5)}`)
        .join('\n\n')
    )
    await fs.promises.writeFile(target, content, 'utf8')
    return sendJson(res, 200, { path: target, size: Buffer.byteLength(content) })
  }

  if (route === '/tools/create_directory' && method === 'POST') {
    const w = requireWs()
    const body = await readJson(req)
    const target = await resolvePath(w, body.path)
    await guardWrite(w, `Create folder ${path.relative(w.root, target)}`, '')
    await fs.promises.mkdir(target, { recursive: true })
    return sendJson(res, 200, { path: target })
  }

  if ((route === '/tools/move_path' || route === '/tools/copy_path') && method === 'POST') {
    const w = requireWs()
    const body = await readJson(req)
    const source = await resolvePath(w, body.source)
    const destination = await resolvePath(w, body.destination)
    if (!fs.existsSync(source)) throw new HttpError(404, 'Source not found')
    if (fs.existsSync(destination)) throw new HttpError(409, 'Destination already exists')
    const copy = route === '/tools/copy_path'
    await guardWrite(
      w,
      `${copy ? 'Copy' : 'Move'} ${path.relative(w.root, source)} → ${path.relative(w.root, destination)}`,
      ''
    )
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    if (copy) await fs.promises.cp(source, destination, { recursive: true })
    else await fs.promises.rename(source, destination)
    return sendJson(res, 200, { source, destination })
  }

  if (route === '/tools/delete_path' && method === 'POST') {
    const w = requireWs()
    const body = await readJson(req)
    const target = await resolvePath(w, body.path)
    if (target === w.root) throw new HttpError(403, 'Cannot delete the project folder itself')
    if (!fs.existsSync(target)) throw new HttpError(404, 'Path not found')
    await guardWrite(w, `Move to trash: ${path.relative(w.root, target)}`, '')
    await shell.trashItem(target)
    return sendJson(res, 200, { path: target, trashed: true })
  }

  // ── File browser actions (initiated by the user in the Open WebUI UI) ──

  if (route === '/files/upload' && method === 'POST') {
    const dir = q.get('directory') ?? '.'
    const w = await wsForAbsolute(dir)
    const target = await resolvePath(w, dir)
    const file = parseMultipartFile(await readBody(req), String(req.headers['content-type'] ?? ''))
    if (!file) throw new HttpError(400, 'No file in upload')
    const dest = await resolvePath(w, path.join(target, path.basename(file.filename)))
    await fs.promises.mkdir(target, { recursive: true })
    await fs.promises.writeFile(dest, file.data)
    return sendJson(res, 200, { path: dest, size: file.data.length })
  }

  if (route === '/files/mkdir' && method === 'POST') {
    const body = await readJson(req)
    const w = await wsForAbsolute(body.path)
    const target = await resolvePath(w, body.path)
    await fs.promises.mkdir(target, { recursive: true })
    return sendJson(res, 200, { path: target })
  }

  if (route === '/files/move' && method === 'POST') {
    const body = await readJson(req)
    const w = await wsForAbsolute(body.source)
    const source = await resolvePath(w, body.source)
    const destination = await resolvePath(w, body.destination)
    if (fs.existsSync(destination)) throw new HttpError(409, 'Destination already exists')
    await fs.promises.rename(source, destination)
    return sendJson(res, 200, { source, destination })
  }

  if (route === '/files/delete' && method === 'DELETE') {
    const p = q.get('path') ?? ''
    const w = await wsForAbsolute(p)
    const target = await resolvePath(w, p)
    if (target === w.root) throw new HttpError(403, 'Cannot delete the project folder itself')
    const isDir = (await fs.promises.stat(target)).isDirectory()
    await shell.trashItem(target)
    return sendJson(res, 200, { path: target, type: isDir ? 'directory' : 'file' })
  }

  if (route === '/ports') return sendJson(res, 200, [])

  throw new HttpError(404, 'Not found')
}
