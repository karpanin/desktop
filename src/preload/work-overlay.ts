import { ipcRenderer } from 'electron'

// ─── In-page Chat / Work switch ─────────────────────────
// Rendered by the desktop on top of the Open WebUI page, centred over the
// chat area like ChatGPT's switch.  It lives in a closed shadow root and
// only reacts to trusted (real user) events, so the page's own scripts
// can neither read nor click it.  It talks to the main process directly
// (work:page:*), which derives the connection from this webview's session.
//
//   Chat — Local Files is off in Open WebUI: no local file tools
//   Work — Local Files is on; the chip shows the project's local folder and
//          access mode, or lets the user pick / link a project

type Project = { folderId: string; folderName: string; path: string; mode: string }
type PageState = {
  enabled: boolean | null
  context: { folderId: string; folderName: string; project: Project | null } | null
  projects: { id: string; name: string; parentId: string | null; path: string | null }[]
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
    from: 'from "{name}"'
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
    from: 'из «{name}»'
  }
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
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
`

const THEMES = {
  light: {
    '--fg': '#171717',
    '--muted': '#6b6b6b',
    '--seg': 'rgba(0,0,0,.05)',
    '--on': '#ffffff',
    '--hover': 'rgba(0,0,0,.07)',
    '--menu': '#ffffff',
    '--border': 'rgba(0,0,0,.08)'
  },
  dark: {
    '--fg': '#ececec',
    '--muted': '#9b9b9b',
    '--seg': 'rgba(255,255,255,.07)',
    '--on': 'rgba(255,255,255,.16)',
    '--hover': 'rgba(255,255,255,.09)',
    '--menu': '#212121',
    '--border': 'rgba(255,255,255,.08)'
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
  let menuOpen = false
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
      `<div class="sep"></div><button class="item" data-action="link"><span class="check"></span>` +
      `<span class="grow">${escape(t('changeFolder'))}</span></button>`
    )
  }

  const render = () => {
    const visible = state?.enabled !== null && state !== null && isChatRoute(location.pathname)
    if (!visible) {
      if (host) host.style.display = 'none'
      return
    }
    ensureHost()
    applyTheme()
    position()
    host!.style.display = ''
    const work = state!.enabled === true
    root!.innerHTML =
      `<style>${CSS}</style><div class="bar ${busy ? 'busy' : ''}">` +
      `<div class="seg" role="radiogroup">` +
      `<button class="${work ? '' : 'on'}" data-action="chat" role="radio" aria-checked="${!work}">${escape(t('chat'))}</button>` +
      `<button class="${work ? 'on' : ''}" data-action="work" role="radio" aria-checked="${work}">${escape(t('work'))}</button>` +
      `</div>` +
      (work
        ? `<div class="chip"><button data-action="menu">${chipLabel()}</button>` +
          (menuOpen ? `<div class="menu">${menuHtml()}</div>` : '') +
          `</div>`
        : '') +
      `</div>`
  }

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
        menuOpen = false
        // Saved in Open WebUI; the desktop reloads the page to apply it
        if ((state?.enabled === true) !== (action === 'work')) {
          run(() => ipcRenderer.invoke('work:page:setEnabled', action === 'work'))
        }
        return
      case 'menu':
        menuOpen = !menuOpen
        render()
        return
      case 'open-project':
        menuOpen = false
        options.navigate(`/folders/${encodeURIComponent(arg)}`)
        render()
        return
      case 'link': {
        if (!ctx) return
        const target = ctx.project ?? { folderId: ctx.folderId, folderName: ctx.folderName }
        menuOpen = false
        run(() => ipcRenderer.invoke('work:page:link', target.folderId, target.folderName))
        return
      }
      case 'mode':
        if (!ctx?.project) return
        run(() => ipcRenderer.invoke('work:page:setMode', ctx.project!.folderId, arg))
        return
      case 'open-folder':
        if (!ctx?.project) return
        menuOpen = false
        ipcRenderer.invoke('work:page:openFolder', ctx.project.folderId).catch(() => {})
        render()
        return
    }
  }

  const start = () => {
    // Close the menu on outside clicks and Escape
    document.addEventListener(
      'mousedown',
      (e) => {
        if (menuOpen && e.target !== host) {
          menuOpen = false
          render()
        }
      },
      true
    )
    document.addEventListener('keydown', (e) => {
      if (menuOpen && e.key === 'Escape') {
        menuOpen = false
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
        menuOpen = false
        refresh()
      } else if (!state && Date.now() - lastFetch > 3000) {
        refresh() // not signed in / not registered yet
      }
    }, 400)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}
