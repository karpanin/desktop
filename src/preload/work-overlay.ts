import { contextBridge, ipcRenderer } from 'electron'

// ─── Desktop tools entry: desktop-only ────────────────────
// The Desktop tools terminal server is never stored in Open WebUI.  This runs
// in the page's own world before Open WebUI starts and wraps fetch():
//   • GET  /api/v1/users/user/settings        → add our entry to
//     ui.terminalServers (and drop any stale copy)
//   • POST /api/v1/users/user/settings/update → strip our entry before it
//     reaches the server, report its enabled flag (the user toggled it in
//     Open WebUI's own UI) and add it back to the response
// A regular browser therefore never sees the entry or its key.
function installSettingsPatch() {
  const w = window as any
  if (w.__owuiDesktopWork) return

  let entry: { url: string; key: string; name: string; enabled: boolean } | null = null
  let settled = false
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => (markReady = resolve))
  const setEntry = (value: typeof entry) => {
    if (settled) return
    settled = true
    entry = value
    markReady()
  }
  // Never hold Open WebUI's settings request for long
  setTimeout(() => setEntry(null), 3000)

  const isOurs = (s: any) => !!s?.desktop_work
  const inject = (ui: any) => {
    const base = ui && typeof ui === 'object' ? ui : {}
    const servers = (Array.isArray(base.terminalServers) ? base.terminalServers : []).filter(
      (s: any) => !isOurs(s)
    )
    if (entry) {
      servers.push({
        url: entry.url,
        key: entry.key,
        name: entry.name,
        auth_type: 'bearer',
        path: '/openapi.json',
        enabled: entry.enabled,
        desktop_work: true
      })
    }
    return { ...base, terminalServers: servers }
  }
  const kindOf = (url: string) => {
    try {
      const u = new URL(url, location.href)
      if (u.origin !== location.origin) return null
      if (u.pathname.endsWith('/api/v1/users/user/settings')) return 'get'
      if (u.pathname.endsWith('/api/v1/users/user/settings/update')) return 'update'
    } catch {
      // not a URL
    }
    return null
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const kind = kindOf(url)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (!kind || (kind === 'get' && method !== 'GET') || (kind === 'update' && method !== 'POST')) {
      return originalFetch(input, init)
    }
    await ready

    if (kind === 'update' && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        const servers = body?.ui?.terminalServers
        if (Array.isArray(servers)) {
          const mine = servers.find(isOurs)
          if (mine && entry && !!mine.enabled !== entry.enabled) {
            entry.enabled = !!mine.enabled
            window.postMessage(
              { __owuiDesktopWork: 'enabled', enabled: entry.enabled },
              location.origin
            )
          }
          body.ui.terminalServers = servers.filter((s: any) => !isOurs(s))
          init = { ...init, body: JSON.stringify(body) }
        }
      } catch {
        // Not JSON — pass through untouched
      }
    }

    const res = await originalFetch(input, init)
    if (!res.ok) return res
    try {
      const json = (await res.clone().json()) ?? {}
      json.ui = inject(json.ui)
      return new Response(JSON.stringify(json), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      })
    } catch {
      return res
    }
  }

  Object.defineProperty(w, '__owuiDesktopWork', { value: Object.freeze({ setEntry }) })
}

// Call as early as possible — before Open WebUI loads the user's settings
export const installWorkSettingsBridge = () => {
  try {
    contextBridge.executeInMainWorld({ func: installSettingsPatch })
  } catch (err) {
    console.error('[work] could not install the settings bridge:', err)
    return
  }

  ipcRenderer
    .invoke('work:page:entry')
    .catch(() => null)
    .then((entry) => {
      contextBridge.executeInMainWorld({
        func: (value: unknown) => (window as any).__owuiDesktopWork?.setEntry(value),
        args: [entry]
      })
    })

  // The user toggled Desktop tools in Open WebUI's own UI
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__owuiDesktopWork === 'enabled') {
      ipcRenderer.invoke('work:page:reportEnabled', e.data.enabled === true).catch(() => {})
    }
  })
}

// ─── In-page Chat / Work switch ─────────────────────────
// Rendered by the desktop on top of the Open WebUI page, centred over the
// chat area like ChatGPT's switch.  It lives in a closed shadow root and
// only reacts to trusted (real user) events, so the page's own scripts
// can neither read nor click it.  It talks to the main process directly
// (work:page:*), which derives the connection from this webview's session.
//
//   Chat — Desktop tools are off in Open WebUI: no local file tools
//   Work — Desktop tools are on; the chip shows the project's local folder and
//          access mode, or lets the user pick / link a project

type Project = { folderId: string; folderName: string; path: string; mode: string; shell?: boolean }
type PageState = {
  enabled: boolean | null
  context: { folderId: string; folderName: string; project: Project | null } | null
  projects: { id: string; name: string; parentId: string | null; path: string | null }[]
  python?: { state: 'missing' | 'installing' | 'ready' | 'failed'; message?: string }
  chatId?: string | null
  chat?: ChatState | null
  approvals?: Approval[]
}
type ChatState = {
  plan: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]
  explanation?: string
  activity: { time: number; action: string; status: string; files?: string[] }[]
}
type Approval = {
  id: string
  chatId: string
  action: string
  project: string
  root: string
  view: any
}

const STRINGS = {
  en: {
    chat: 'Chat',
    work: 'Work',
    chooseProject: 'Choose a project',
    linkFolder: 'Link a folder',
    workInProject: 'Work in a project',
    noProjects: 'Create a folder in the sidebar to start a project.',
    localFolder: 'Local folder',
    openFolder: 'Open in file manager',
    access: 'Access',
    read: 'Read only',
    confirm: 'Ask before changes',
    auto: 'Autonomous',
    changeFolder: 'Change folder…',
    projectNotLinked: 'Project "{name}" is not linked to a folder on this computer.',
    linkLocalFolder: 'Link a local folder…',
    from: 'from "{name}"',
    preparing: 'Preparing tools…',
    preparingHint: 'Setting up Python for documents (once, a few minutes): {message}',
    setupFailed: 'Tools setup failed — retry',
    plan: 'Plan',
    recent: 'Recent actions',
    allDone: 'Done',
    actions: '{n} actions',
    approveChange: 'Allow this change?',
    approveScript: 'Allow this script to run?',
    allow: 'Allow',
    allowChat: 'Allow for this chat',
    deny: 'Deny',
    newFile: 'New file {path}',
    overwriteFile: 'Replaces {path}',
    editFile: 'Edit {path}',
    createFolder: 'Create folder {path}',
    trash: 'Move to trash: {path}',
    moveTo: 'Move {path} → {to}',
    copyTo: 'Copy {path} → {to}',
    scriptNote: 'The script can only change files in the project folder.',
    morePending: '+{n} more waiting',
    st_done: 'done',
    st_failed: 'failed',
    st_declined: 'declined',
    st_blocked: 'blocked',
    terminal: 'Terminal commands',
    approveCommand: 'Allow this command?',
    runsIn: 'Runs in {shell} in the project folder.',
    alwaysAsk: 'Asked every time:',
    r_writes: 'changes files',
    r_outside: 'reaches outside the project folder',
    r_network: 'uses the network',
    r_complex: 'hard to check (substitutions or variables)',
    r_program: 'runs another program or script',
    r_packages: 'installs software',
    r_process: 'stops processes',
    r_unknown: 'unknown command',
    'r_project-root': 'affects the whole project folder'
  },
  ru: {
    chat: 'Чат',
    work: 'Работа',
    chooseProject: 'Выбрать проект',
    linkFolder: 'Привязать папку',
    workInProject: 'Работать в проекте',
    noProjects: 'Создайте папку в боковой панели, чтобы начать проект.',
    localFolder: 'Локальная папка',
    openFolder: 'Открыть в проводнике',
    access: 'Доступ',
    read: 'Только чтение',
    confirm: 'Спрашивать перед изменениями',
    auto: 'Автономно',
    changeFolder: 'Сменить папку…',
    projectNotLinked: 'Проект «{name}» не привязан к папке на этом компьютере.',
    linkLocalFolder: 'Привязать локальную папку…',
    from: 'из «{name}»',
    preparing: 'Подготовка инструментов…',
    preparingHint: 'Устанавливается Python для документов (один раз, несколько минут): {message}',
    setupFailed: 'Не удалось подготовить инструменты — повторить',
    plan: 'План',
    recent: 'Последние действия',
    allDone: 'Готово',
    actions: 'Действий: {n}',
    approveChange: 'Разрешить изменение?',
    approveScript: 'Разрешить запуск скрипта?',
    allow: 'Разрешить',
    allowChat: 'Разрешить до конца чата',
    deny: 'Отклонить',
    newFile: 'Новый файл {path}',
    overwriteFile: 'Заменит {path}',
    editFile: 'Правка {path}',
    createFolder: 'Создать папку {path}',
    trash: 'В корзину: {path}',
    moveTo: 'Переместить {path} → {to}',
    copyTo: 'Скопировать {path} → {to}',
    scriptNote: 'Скрипт может менять файлы только в папке проекта.',
    morePending: 'ещё {n} в очереди',
    st_done: 'выполнено',
    st_failed: 'ошибка',
    st_declined: 'отклонено',
    st_blocked: 'запрещено',
    terminal: 'Команды терминала',
    approveCommand: 'Разрешить команду?',
    runsIn: 'Выполняется в {shell} в папке проекта.',
    alwaysAsk: 'Спрашиваем каждый раз:',
    r_writes: 'меняет файлы',
    r_outside: 'обращается за пределы папки проекта',
    r_network: 'использует сеть',
    r_complex: 'сложно проверить (подстановки или переменные)',
    r_program: 'запускает другую программу или скрипт',
    r_packages: 'устанавливает программы',
    r_process: 'останавливает процессы',
    r_unknown: 'неизвестная команда',
    'r_project-root': 'затрагивает всю папку проекта'
  }
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--fg); }
.bar { display: flex; align-items: center; gap: 8px; color: var(--fg); }
.seg { display: flex; padding: 3px; border-radius: 999px; background: var(--seg); }
.seg button { border: 0; background: transparent; color: var(--muted); padding: 5px 14px; border-radius: 999px;
  font-size: 13px; line-height: 16px; cursor: pointer; transition: background .15s, color .15s; }
.seg button:hover { color: var(--fg); }
.seg button.on { background: var(--on); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.chip { position: relative; }
.chip > button { display: flex; align-items: center; gap: 6px; max-width: 280px; border: 0; cursor: pointer;
  background: var(--seg); color: var(--fg); padding: 6px 10px; border-radius: 999px; font-size: 12px; line-height: 16px; }
.chip > button:hover { background: var(--hover); }
.chip > button .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip > button .muted { color: var(--muted); }
svg { flex-shrink: 0; }
.menu { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); min-width: 270px; max-width: 360px;
  max-height: 60vh; overflow-y: auto; background: var(--menu); color: var(--fg); border: 1px solid var(--border);
  border-radius: 14px; box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 6px; }
.label { font-size: 11px; color: var(--muted); padding: 6px 10px 3px; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; color: var(--fg);
  text-align: left; padding: 7px 10px; border-radius: 9px; font-size: 13px; cursor: pointer; }
.item:hover { background: var(--hover); }
.item .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .sub { display: block; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.item .check { width: 14px; color: var(--fg); }
.note { font-size: 12px; color: var(--muted); padding: 6px 10px 8px; line-height: 1.4; }
.sep { height: 1px; background: var(--border); margin: 5px 4px; }
.busy { opacity: .6; pointer-events: none; }
.status { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding: 6px 4px; }
.status button { border: 0; background: var(--seg); color: var(--fg); padding: 6px 10px; border-radius: 999px; font-size: 12px; cursor: pointer; }
.spin { display: inline-block; flex-shrink: 0; width: 11px; height: 11px; border: 1.5px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.step { display: flex; align-items: flex-start; gap: 8px; padding: 5px 10px; font-size: 13px; line-height: 18px; }
.step .icon { width: 14px; flex-shrink: 0; text-align: center; color: var(--muted); }
.step.completed { color: var(--muted); }
.step.completed .text { text-decoration: line-through; }
.step.in_progress { font-weight: 600; }
.step .spin { margin-top: 3px; }
.act { display: flex; gap: 8px; padding: 4px 10px; font-size: 12px; line-height: 17px; }
.act .time { color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.act .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act.failed .st, .act.declined .st, .act.blocked .st { color: var(--del-fg); }
.act .st { color: var(--muted); flex-shrink: 0; }
.progress-bar { height: 3px; border-radius: 2px; background: var(--seg); margin: 4px 10px 6px; overflow: hidden; }
.progress-bar > div { height: 100%; background: var(--fg); opacity: .55; }
.card { width: min(520px, calc(100vw - 32px)); background: var(--menu); color: var(--fg); border: 1px solid var(--border);
  border-radius: 16px; box-shadow: 0 10px 34px rgba(0,0,0,.32); padding: 14px; }
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.card-sub { font-size: 12px; color: var(--muted); margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-line { font-size: 13px; margin: 2px 0 8px; word-break: break-all; }
.preview { max-height: 260px; overflow: auto; border-radius: 10px; background: var(--seg); padding: 8px 0;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }
.preview, .preview * { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.preview div { padding: 0 10px; }
.preview.wrap { white-space: pre-wrap; word-break: break-all; }
.preview .del { background: var(--del-bg); color: var(--del-fg); }
.preview .add { background: var(--add-bg); color: var(--add-fg); }
.preview .gap { height: 8px; }
.card-note { font-size: 11px; color: var(--muted); margin-top: 8px; }
.card-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 12px; }
.card-actions .more { margin-right: auto; font-size: 11px; color: var(--muted); }
.card-actions button { border: 0; border-radius: 999px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  background: var(--seg); color: var(--fg); }
.card-actions button:hover { background: var(--hover); }
.card-actions button.primary { background: var(--primary-bg); color: var(--primary-fg); }
`

const THEMES = {
  light: {
    '--fg': '#171717',
    '--muted': '#6b6b6b',
    '--seg': 'rgba(0,0,0,.05)',
    '--on': '#ffffff',
    '--hover': 'rgba(0,0,0,.07)',
    '--menu': '#ffffff',
    '--border': 'rgba(0,0,0,.08)',
    '--del-bg': 'rgba(220,38,38,.08)',
    '--del-fg': '#b42318',
    '--add-bg': 'rgba(22,163,74,.09)',
    '--add-fg': '#157f3c',
    '--primary-bg': '#171717',
    '--primary-fg': '#ffffff'
  },
  dark: {
    '--fg': '#ececec',
    '--muted': '#9b9b9b',
    '--seg': 'rgba(255,255,255,.07)',
    '--on': 'rgba(255,255,255,.16)',
    '--hover': 'rgba(255,255,255,.09)',
    '--menu': '#212121',
    '--border': 'rgba(255,255,255,.08)',
    '--del-bg': 'rgba(248,113,113,.14)',
    '--del-fg': '#ff9d9d',
    '--add-bg': 'rgba(74,222,128,.12)',
    '--add-fg': '#86efac',
    '--primary-bg': '#ececec',
    '--primary-fg': '#171717'
  }
}

const FOLDER_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/></svg>'
const CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>'

// Routes where the chat area is visible
const isChatRoute = (pathname: string) =>
  pathname === '/' || pathname.startsWith('/c/') || pathname.startsWith('/folders/')

const basename = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

export const initWorkOverlay = (options: { navigate: (path: string) => void }) => {
  let host: HTMLDivElement | null = null
  let root: ShadowRoot | null = null
  let state: PageState | null = null
  let openMenu: null | 'project' | 'progress' = null
  let busy = false
  let lastUrl = ''
  let lastFetch = 0

  const t = (key: keyof (typeof STRINGS)['en'], vars: Record<string, string> = {}) => {
    const locale = (localStorage.getItem('locale') || navigator.language || 'en').toLowerCase()
    const dict = locale.startsWith('ru') ? STRINGS.ru : STRINGS.en
    return dict[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
  }

  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
    )

  const ensureHost = () => {
    if (host?.isConnected) return
    host = document.createElement('div')
    host.setAttribute('data-owui-desktop', 'work')
    Object.assign(host.style, {
      position: 'fixed',
      top: '9px',
      zIndex: '45',
      transform: 'translateX(-50%)'
    })
    root = host.attachShadow({ mode: 'closed' })
    document.documentElement.appendChild(host)

    // Only real user input — the page's scripts can't drive the switch
    root.addEventListener('click', (e) => {
      if (!e.isTrusted) return
      const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
      if (target) handleAction(target.dataset.action!, target.dataset.arg ?? '')
    })
  }

  // Centre over the chat area, i.e. to the right of Open WebUI's sidebar
  const position = () => {
    if (!host) return
    const sidebar = document.getElementById('sidebar')
    const rect = sidebar?.getBoundingClientRect()
    const left =
      rect && rect.width > 0 && rect.right > 0 && rect.right < innerWidth * 0.6 ? rect.right : 0
    host.style.left = `${left + (innerWidth - left) / 2}px`
  }

  const applyTheme = () => {
    if (!host) return
    const dark = document.documentElement.classList.contains('dark')
    for (const [k, v] of Object.entries(dark ? THEMES.dark : THEMES.light))
      host.style.setProperty(k, v)
    host.style.colorScheme = dark ? 'dark' : 'light' // native scrollbars
  }

  const chipLabel = (): string => {
    const ctx = state?.context
    if (!ctx)
      return `${FOLDER_ICON}<span class="text">${escape(t('chooseProject'))}</span>${CHEVRON}`
    if (!ctx.project)
      return `${FOLDER_ICON}<span class="text">${escape(t('linkFolder'))}</span>${CHEVRON}`
    const mode = t(ctx.project.mode as 'read' | 'confirm' | 'auto')
    return (
      `${FOLDER_ICON}<span class="text">${escape(basename(ctx.project.path))}` +
      ` <span class="muted">· ${escape(mode)}</span></span>${CHEVRON}`
    )
  }

  const menuHtml = (): string => {
    const ctx = state?.context
    if (!ctx) {
      const projects = state?.projects ?? []
      if (!projects.length) return `<div class="note">${escape(t('noProjects'))}</div>`
      // Linked projects first, sub-folders indented
      const ordered: { p: PageState['projects'][0]; depth: number }[] = []
      const visit = (parentId: string | null, depth: number) => {
        for (const p of projects.filter((x) => x.parentId === parentId)) {
          ordered.push({ p, depth })
          visit(p.id, depth + 1)
        }
      }
      visit(null, 0)
      const sorted = [...ordered.filter((o) => o.p.path), ...ordered.filter((o) => !o.p.path)]
      return (
        `<div class="label">${escape(t('workInProject'))}</div>` +
        sorted
          .map(
            ({ p, depth }) =>
              `<button class="item" data-action="open-project" data-arg="${escape(p.id)}" style="padding-left:${10 + depth * 14}px">` +
              `${FOLDER_ICON}<span class="grow">${escape(p.name)}` +
              `${p.path ? `<span class="sub">${escape(p.path)}</span>` : ''}</span></button>`
          )
          .join('')
      )
    }
    if (!ctx.project) {
      return (
        `<div class="note">${escape(t('projectNotLinked', { name: ctx.folderName }))}</div>` +
        `<button class="item" data-action="link">${FOLDER_ICON}<span class="grow">${escape(t('linkLocalFolder'))}</span></button>`
      )
    }
    const project = ctx.project
    const inherited =
      project.folderId !== ctx.folderId
        ? `<span class="sub">${escape(t('from', { name: project.folderName }))}</span>`
        : ''
    const modes = (['read', 'confirm', 'auto'] as const)
      .map(
        (m) =>
          `<button class="item" data-action="mode" data-arg="${m}"><span class="check">${project.mode === m ? '✓' : ''}</span>` +
          `<span class="grow">${escape(t(m))}</span></button>`
      )
      .join('')
    return (
      `<div class="label">${escape(t('localFolder'))}</div>` +
      `<button class="item" data-action="open-folder" title="${escape(t('openFolder'))}">${FOLDER_ICON}` +
      `<span class="grow">${escape(project.path)}${inherited}</span></button>` +
      `<div class="sep"></div><div class="label">${escape(t('access'))}</div>${modes}` +
      `<button class="item" data-action="toggle-shell"><span class="check">${project.shell !== false ? '✓' : ''}</span>` +
      `<span class="grow">${escape(t('terminal'))}</span></button>` +
      `<div class="sep"></div><button class="item" data-action="link"><span class="check"></span>` +
      `<span class="grow">${escape(t('changeFolder'))}</span></button>`
    )
  }

  // One-time setup of the Python tools (scripts, PDF reading)
  const pythonStatusHtml = () => {
    const python = state?.python
    if (python?.state === 'installing') {
      return (
        `<div class="status" title="${escape(t('preparingHint', { message: python.message ?? '' }))}">` +
        `<span class="spin"></span>${escape(t('preparing'))}</div>`
      )
    }
    if (python?.state === 'failed') {
      return (
        `<div class="status" title="${escape(python.message ?? '')}">` +
        `<button data-action="setup-python">${escape(t('setupFailed'))}</button></div>`
      )
    }
    return ''
  }

  // Plan (update_plan) and recent file actions of the current chat
  const progressChipHtml = () => {
    const chat = state?.chat
    if (!chat || (!chat.plan.length && !chat.activity.length)) return ''
    let label: string
    if (chat.plan.length) {
      const done = chat.plan.filter((s) => s.status === 'completed').length
      const current = chat.plan.find((s) => s.status === 'in_progress')
      const icon = current ? '<span class="spin"></span>' : done === chat.plan.length ? '✓' : '○'
      label =
        `${icon}<span class="text">${done}/${chat.plan.length} · ` +
        `${escape(current?.step ?? (done === chat.plan.length ? t('allDone') : chat.plan[0].step))}</span>`
    } else {
      label = `<span class="text">${escape(t('actions', { n: String(chat.activity.length) }))}</span>`
    }
    return (
      `<div class="chip"><button data-action="progress">${label}${CHEVRON}</button>` +
      (openMenu === 'progress' ? `<div class="menu">${progressMenuHtml(chat)}</div>` : '') +
      `</div>`
    )
  }

  const progressMenuHtml = (chat: ChatState) => {
    let html = ''
    if (chat.plan.length) {
      const done = chat.plan.filter((s) => s.status === 'completed').length
      html +=
        `<div class="label">${escape(t('plan'))} · ${done}/${chat.plan.length}</div>` +
        `<div class="progress-bar"><div style="width:${Math.round((done / chat.plan.length) * 100)}%"></div></div>` +
        (chat.explanation ? `<div class="note">${escape(chat.explanation)}</div>` : '') +
        chat.plan
          .map((s) => {
            const icon =
              s.status === 'completed'
                ? '✓'
                : s.status === 'in_progress'
                  ? '<span class="spin"></span>'
                  : '○'
            return `<div class="step ${s.status}"><span class="icon">${icon}</span><span class="text">${escape(s.step)}</span></div>`
          })
          .join('')
    }
    if (chat.activity.length) {
      if (html) html += '<div class="sep"></div>'
      html +=
        `<div class="label">${escape(t('recent'))}</div>` +
        chat.activity
          .slice(-8)
          .reverse()
          .map((a) => {
            const time = new Date(a.time).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            })
            const st = t(`st_${a.status}` as 'st_done')
            const files = a.files?.length ? ` — ${a.files.join(', ')}` : ''
            return (
              `<div class="act ${escape(a.status)}" title="${escape(a.action + files)}"><span class="time">${time}</span>` +
              `<span class="what">${escape(a.action)}</span><span class="st">${escape(st)}</span></div>`
            )
          })
          .join('')
    }
    return html
  }

  // Approval card: what the agent wants to change, with a diff / the script
  const approvalHtml = () => {
    const approvals = state?.approvals ?? []
    if (!approvals.length) return ''
    const a = approvals[0]
    const v = a.view ?? {}
    const lines = (text: string, cls: string, sign: string) =>
      String(text ?? '')
        .split('\n')
        .map((l) => `<div class="${cls}">${sign}${escape(l) || ' '}</div>`)
        .join('')
    let title = t('approveChange')
    let line = escape(a.action)
    let previewHtml = ''
    let note = ''
    switch (v.kind) {
      case 'write':
        line = escape(t(v.overwrite ? 'overwriteFile' : 'newFile', { path: v.path }))
        previewHtml = lines(v.content, 'add', '+ ')
        break
      case 'edit':
        line = escape(t('editFile', { path: v.path }))
        previewHtml = (v.diff ?? [])
          .map((d: any) => lines(d.before, 'del', '− ') + lines(d.after, 'add', '+ '))
          .join('<div class="gap"></div>')
        break
      case 'script':
        title = t('approveScript')
        line = escape(v.description || a.action)
        previewHtml = lines(v.code, '', '')
        note = t('scriptNote')
        break
      case 'command': {
        title = t('approveCommand')
        line = escape(v.description || a.action)
        previewHtml = lines(v.command, '', v.shell?.includes('PowerShell') ? 'PS> ' : '$ ')
        const reasons = (v.reasons ?? []).map((r: string) => t(`r_${r}` as 'r_writes')).join(', ')
        note =
          t('runsIn', { shell: v.shell ?? '' }) +
          (v.always && reasons ? ` ${t('alwaysAsk')} ${reasons}.` : reasons ? ` (${reasons})` : '')
        break
      }
      case 'folder':
        line = escape(t('createFolder', { path: v.path }))
        break
      case 'delete':
        line = escape(t('trash', { path: v.path }))
        break
      case 'move':
      case 'copy':
        line = escape(t(v.kind === 'move' ? 'moveTo' : 'copyTo', { path: v.path, to: v.to }))
        break
    }
    return (
      `<div class="card" role="dialog" aria-modal="false">` +
      `<div class="card-title">${escape(title)}</div>` +
      `<div class="card-sub">${FOLDER_ICON} ${escape(a.project)} · ${escape(a.root)}</div>` +
      `<div class="card-line">${line}</div>` +
      (previewHtml
        ? `<div class="preview${v.kind === 'command' ? ' wrap' : ''}">${previewHtml}</div>`
        : '') +
      (note ? `<div class="card-note">${escape(note)}</div>` : '') +
      `<div class="card-actions">` +
      (approvals.length > 1
        ? `<span class="more">${escape(t('morePending', { n: String(approvals.length - 1) }))}</span>`
        : '') +
      `<button data-action="approve" data-arg="deny">${escape(t('deny'))}</button>` +
      (v.always
        ? ''
        : `<button data-action="approve" data-arg="allow-chat">${escape(t('allowChat'))}</button>`) +
      `<button class="primary" data-action="approve" data-arg="allow">${escape(t('allow'))}</button>` +
      `</div></div>`
    )
  }

  const render = () => {
    const showBar = state !== null && state.enabled !== null && isChatRoute(location.pathname)
    const approval = approvalHtml()
    if (!showBar && !approval) {
      if (host) host.style.display = 'none'
      return
    }
    ensureHost()
    applyTheme()
    position()
    host!.style.display = ''
    const work = state!.enabled === true
    root!.innerHTML =
      `<style>${CSS}</style><div class="wrap">` +
      (showBar ? barHtml(work) : '') +
      approval +
      `</div>`
  }

  const barHtml = (work: boolean) =>
    `<div class="bar ${busy ? 'busy' : ''}">` +
    `<div class="seg" role="radiogroup">` +
    `<button class="${work ? '' : 'on'}" data-action="chat" role="radio" aria-checked="${!work}">${escape(t('chat'))}</button>` +
    `<button class="${work ? 'on' : ''}" data-action="work" role="radio" aria-checked="${work}">${escape(t('work'))}</button>` +
    `</div>` +
    (work
      ? `<div class="chip"><button data-action="menu">${chipLabel()}</button>` +
        (openMenu === 'project' ? `<div class="menu">${menuHtml()}</div>` : '') +
        `</div>` +
        progressChipHtml() +
        pythonStatusHtml()
      : '') +
    `</div>`

  const refresh = async () => {
    lastFetch = Date.now()
    try {
      state = await ipcRenderer.invoke('work:page:state', location.href)
    } catch {
      state = null // connection not attached yet / not signed in
    }
    render()
  }

  const run = async (fn: () => Promise<unknown>) => {
    busy = true
    render()
    try {
      await fn()
    } catch (err) {
      console.error('[work] action failed:', err)
    }
    busy = false
    await refresh()
  }

  const handleAction = (action: string, arg: string) => {
    const ctx = state?.context
    switch (action) {
      case 'chat':
      case 'work':
        openMenu = null
        // Saved in Open WebUI; the desktop reloads the page to apply it
        if ((state?.enabled === true) !== (action === 'work')) {
          run(() => ipcRenderer.invoke('work:page:setEnabled', action === 'work'))
        }
        return
      case 'menu':
      case 'progress': {
        const menu = action === 'menu' ? 'project' : 'progress'
        openMenu = openMenu === menu ? null : menu
        render()
        return
      }
      case 'approve': {
        const approval = state?.approvals?.[0]
        if (!approval) return
        state!.approvals = state!.approvals!.filter((a) => a.id !== approval.id)
        ipcRenderer.invoke('work:page:approval', approval.id, arg).catch(() => {})
        render()
        return
      }
      case 'open-project':
        openMenu = null
        options.navigate(`/folders/${encodeURIComponent(arg)}`)
        render()
        return
      case 'link': {
        if (!ctx) return
        const target = ctx.project ?? { folderId: ctx.folderId, folderName: ctx.folderName }
        openMenu = null
        run(() => ipcRenderer.invoke('work:page:link', target.folderId, target.folderName))
        return
      }
      case 'mode':
        if (!ctx?.project) return
        run(() => ipcRenderer.invoke('work:page:setMode', ctx.project!.folderId, arg))
        return
      case 'toggle-shell':
        if (!ctx?.project) return
        run(() =>
          ipcRenderer.invoke(
            'work:page:setShell',
            ctx.project!.folderId,
            ctx.project!.shell === false
          )
        )
        return
      case 'open-folder':
        if (!ctx?.project) return
        openMenu = null
        ipcRenderer.invoke('work:page:openFolder', ctx.project.folderId).catch(() => {})
        render()
        return
      case 'setup-python':
        ipcRenderer.invoke('work:page:setupPython').catch(() => {})
        if (state) state.python = { state: 'installing' }
        render()
        return
    }
  }

  // Pushed by the main process (Python setup progress, …)
  ipcRenderer.on('work:event', (_event, message: { type: string; data: any }) => {
    const { type, data } = message ?? {}
    if (type === 'work:approval') {
      // Tell the desktop the card is shown (otherwise it falls back to a dialog)
      ipcRenderer.invoke('work:page:approvalAck', data.id).catch(() => {})
      if (!state) return
      state.approvals = [...(state.approvals ?? []).filter((a) => a.id !== data.id), data]
      render()
      return
    }
    if (!state) return
    if (type === 'work:python') state.python = data
    else if (type === 'work:approvalDone') {
      state.approvals = (state.approvals ?? []).filter((a) => a.id !== data.id)
    } else if (type === 'work:chat') {
      if (data.chatId !== state.chatId) return
      state.chat = data.chat
    } else return
    render()
  })

  const start = () => {
    // Close the menu on outside clicks and Escape
    document.addEventListener(
      'mousedown',
      (e) => {
        if (openMenu && e.target !== host) {
          openMenu = null
          render()
        }
      },
      true
    )
    document.addEventListener('keydown', (e) => {
      if (openMenu && e.key === 'Escape') {
        openMenu = null
        render()
      }
    })
    addEventListener('resize', position)
    addEventListener('focus', refresh)
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    // SvelteKit navigates with pushState in the page's own world, which
    // this isolated world can't hook — poll the URL instead (cheap).
    setInterval(() => {
      position()
      if (host && !host.isConnected) render()
      if (location.href !== lastUrl) {
        lastUrl = location.href
        openMenu = null
        refresh()
      } else if (!state && Date.now() - lastFetch > 3000) {
        refresh() // not signed in / not registered yet
      }
    }, 400)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}
