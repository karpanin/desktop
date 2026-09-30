<script lang="ts">
  import { fade } from 'svelte/transition'
  import { workEnabled } from '../../../stores'
  import i18n from '../../../i18n'

  // Thin bar above the Open WebUI page, shown in Work mode:
  //   • inside a project (folder page or chat in a project): the linked
  //     local folder and its access mode, or "Link folder…"
  //   • elsewhere: a picker to open one of the user's projects

  interface Props {
    connectionId: string
    url: string
  }

  let { connectionId, url }: Props = $props()

  type Project = { folderId: string; folderName: string; path: string; mode: string }
  type Context = { folderId: string; folderName: string; project: Project | null }
  type Folder = { id: string; name: string; parentId: string | null; project: Project | null }

  let context = $state<Context | null>(null)
  let folders = $state<Folder[]>([])
  let loaded = $state(false)
  let requestSeq = 0

  const load = async () => {
    const seq = ++requestSeq
    const result = url ? await window.electronAPI.getWorkContext(connectionId, url) : null
    let list: Folder[] = []
    if (!result) list = (await window.electronAPI.getWorkProjects(connectionId))?.folders ?? []
    if (seq !== requestSeq) return
    context = result
    folders = list
    loaded = true
  }

  $effect(() => {
    // Re-resolve whenever the page, connection or mode changes
    void connectionId
    void url
    if ($workEnabled) load()
  })

  // Linked projects first, then the rest; sub-folders indented
  const pickerOptions = $derived.by(() => {
    const out: { folder: Folder; depth: number }[] = []
    const visit = (parentId: string | null, depth: number) => {
      for (const f of folders.filter((f) => f.parentId === parentId)) {
        out.push({ folder: f, depth })
        visit(f.id, depth + 1)
      }
    }
    visit(null, 0)
    return [...out.filter((o) => o.folder.project), ...out.filter((o) => !o.folder.project)]
  })

  const openProject = (folderId: string) => {
    if (!folderId) return
    const wv = document.querySelector(`webview[partition="persist:connection-${connectionId}"]`) as any
    wv?.loadURL?.(new URL(`/folders/${encodeURIComponent(folderId)}`, url).href)
  }

  const link = async () => {
    if (!context) return
    const target = context.project ?? { folderId: context.folderId, folderName: context.folderName }
    await window.electronAPI.linkWorkProject(connectionId, target.folderId, target.folderName)
    await load()
  }

  const setMode = async (mode: string) => {
    if (!context?.project) return
    await window.electronAPI.updateWorkProject(connectionId, context.project.folderId, { mode })
    await load()
  }

  const modes = [
    { id: 'read', label: () => $i18n.t('settings.work.modeRead') },
    { id: 'confirm', label: () => $i18n.t('settings.work.modeConfirm') },
    { id: 'auto', label: () => $i18n.t('settings.work.modeAuto') }
  ]

  const buttonClass =
    'text-[11px] opacity-60 hover:opacity-100 px-2 py-0.5 bg-black/[0.05] dark:bg-white/[0.07] transition border-none text-[#1d1d1f] dark:text-[#fafafa] rounded-lg shrink-0'
  const selectClass =
    'text-[11px] px-1.5 py-0.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.07] border-none text-[#1d1d1f] dark:text-[#fafafa] shrink-0'
</script>

{#if $workEnabled && loaded}
  <div
    class="flex items-center gap-2 px-3 h-8 shrink-0 text-[11px] border-b border-black/[0.06] dark:border-white/[0.06] bg-[#eee] dark:bg-[#111] min-w-0"
    in:fade={{ duration: 120 }}
  >
    <svg class="w-[13px] h-[13px] shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>

    {#if !context}
      <span class="opacity-50 shrink-0">{$i18n.t('work.bar.pickProject')}</span>
      {#if pickerOptions.length}
        <select
          class={selectClass}
          value=""
          onchange={(e) => openProject((e.target as HTMLSelectElement).value)}
        >
          <option value="" disabled>{$i18n.t('work.bar.choose')}</option>
          {#each pickerOptions as { folder, depth } (folder.id)}
            <option value={folder.id}>
              {'\u00a0\u00a0'.repeat(depth)}{folder.name}{folder.project ? ` — ${folder.project.path}` : ''}
            </option>
          {/each}
        </select>
      {:else}
        <span class="opacity-40 truncate min-w-0">{$i18n.t('work.bar.noProjects')}</span>
      {/if}
    {:else if context.project}
      <span class="opacity-50 shrink-0">{$i18n.t('work.bar.label')}</span>
      <button
        class="opacity-80 hover:opacity-100 truncate min-w-0 bg-transparent border-none p-0 text-left text-[#1d1d1f] dark:text-[#fafafa]"
        title={context.project.path}
        onclick={() => window.electronAPI.openPath(context!.project!.path)}
      >
        {context.project.path}
      </button>
      {#if context.project.folderId !== context.folderId}
        <span class="opacity-30 shrink-0 truncate">
          {$i18n.t('work.bar.inherited', { name: context.project.folderName })}
        </span>
      {/if}
      <div class="flex-1"></div>
      <select
        class={selectClass}
        value={context.project.mode}
        onchange={(e) => setMode((e.target as HTMLSelectElement).value)}
      >
        {#each modes as m}
          <option value={m.id}>{m.label()}</option>
        {/each}
      </select>
      <button class={buttonClass} onclick={link}>{$i18n.t('settings.work.change')}</button>
    {:else}
      <span class="opacity-40 truncate min-w-0">
        {$i18n.t('work.bar.notLinked', { name: context.folderName })}
      </span>
      <div class="flex-1"></div>
      <button class={buttonClass} onclick={link}>{$i18n.t('settings.work.link')}</button>
    {/if}
  </div>
{/if}
