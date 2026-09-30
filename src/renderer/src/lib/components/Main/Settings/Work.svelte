<script lang="ts">
  import { onMount } from 'svelte'
  import { config, activeConnection, workEnabled } from '../../../stores'
  import i18n from '../../../i18n'
  import Switch from '../../common/Switch.svelte'

  type Project = { path: string; mode: 'read' | 'confirm' | 'auto'; folderName: string }
  type Folder = { id: string; name: string; parentId: string | null; project: Project | null }

  let info = $state<{
    status: string | null
    port: number | null
    connections: { id: string; url: string; registered: boolean }[]
  } | null>(null)
  let connectionId = $state<string | null>(null)
  let folders = $state<Folder[]>([])
  let serverEnabled = $state<boolean | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let loaded = $state(false)

  const enabled = $derived(($config as any)?.work?.enabled ?? true)

  const modes = [
    { id: 'read', label: () => $i18n.t('settings.work.modeRead') },
    { id: 'confirm', label: () => $i18n.t('settings.work.modeConfirm') },
    { id: 'auto', label: () => $i18n.t('settings.work.modeAuto') }
  ]

  // Nested projects are shown indented under their parent
  const ordered = $derived.by(() => {
    const out: { folder: Folder; depth: number }[] = []
    const visit = (parentId: string | null, depth: number) => {
      for (const f of folders.filter((f) => f.parentId === parentId)) {
        out.push({ folder: f, depth })
        visit(f.id, depth + 1)
      }
    }
    visit(null, 0)
    return out
  })

  const loadProjects = async () => {
    if (!connectionId) return
    loading = true
    const result = await window.electronAPI.getWorkProjects(connectionId)
    folders = result?.folders ?? []
    serverEnabled = result?.serverEnabled ?? null
    error = result?.error ?? null
    loading = false
  }

  const refresh = async () => {
    info = await window.electronAPI.getWorkInfo()
    if (!connectionId || !info?.connections.some((c) => c.id === connectionId)) {
      connectionId = info?.connections[0]?.id ?? null
    }
    await loadProjects()
    loaded = true
  }

  onMount(refresh)

  const setEnabled = async (value: boolean) => {
    info = await window.electronAPI.setWorkEnabled(value)
    config.set(await window.electronAPI.getConfig())
  }

  const setServerEnabled = async (value: boolean) => {
    await window.electronAPI.setWorkServerEnabled(connectionId, value)
    // Keep the top bar Chat / Work switch in sync
    if (connectionId === $activeConnection?.id) workEnabled.set(value)
    await loadProjects()
  }

  const link = async (folder: Folder) => {
    const dir = await window.electronAPI.linkWorkProject(connectionId, folder.id, folder.name)
    if (dir) await loadProjects()
  }

  const setMode = async (folder: Folder, mode: string) => {
    await window.electronAPI.updateWorkProject(connectionId, folder.id, { mode })
    await loadProjects()
  }

  const unlink = async (folder: Folder) => {
    await window.electronAPI.unlinkWorkProject(connectionId, folder.id)
    await loadProjects()
  }

  const buttonClass =
    'text-[12px] opacity-40 hover:opacity-70 px-3 py-1.5 bg-black/[0.04] dark:bg-white/[0.06] transition border-none text-[#1d1d1f] dark:text-[#fafafa] rounded-xl'
</script>

{#if !loaded}
  <div class="py-6 text-[12px] opacity-20 text-center">{$i18n.t('common.loading')}</div>
{:else}
  <div class="flex flex-col divide-y divide-white/[0.04]">
    <div class="py-4 flex items-center justify-between">
      <div class="pr-6">
        <div class="text-[13px] opacity-70">{$i18n.t('settings.work.enable')}</div>
        <div class="text-[11px] opacity-25 mt-0.5">{$i18n.t('settings.work.enableDesc')}</div>
      </div>
      <div class="flex items-center gap-3">
        {#if info?.status === 'started'}
          <div class="flex items-center gap-1.5">
            <div class="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>
            <span class="text-[12px] opacity-50">{$i18n.t('common.running')}</span>
          </div>
        {/if}
        <Switch checked={enabled} label={$i18n.t('settings.work.enable')} onchange={setEnabled} />
      </div>
    </div>

    {#if enabled && connectionId && !error && serverEnabled !== null}
      <div class="py-4 flex items-center justify-between">
        <div class="pr-6">
          <div class="text-[13px] opacity-70">{$i18n.t('settings.work.serverInOpenWebUI')}</div>
          <div class="text-[11px] opacity-25 mt-0.5">
            {serverEnabled
              ? $i18n.t('settings.work.serverOnDesc')
              : $i18n.t('settings.work.serverOffDesc')}
          </div>
        </div>
        <Switch
          checked={serverEnabled}
          label={$i18n.t('settings.work.serverInOpenWebUI')}
          onchange={setServerEnabled}
        />
      </div>
    {/if}

    {#if enabled}
      <div class="py-4">
        <div class="flex items-center justify-between mb-3">
          <div class="pr-6">
            <div class="text-[13px] opacity-70">{$i18n.t('settings.work.projects')}</div>
            <div class="text-[11px] opacity-25 mt-0.5">{$i18n.t('settings.work.projectsDesc')}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if (info?.connections.length ?? 0) > 1}
              <select
                class="text-[12px] px-2 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border-none text-[#1d1d1f] dark:text-[#fafafa]"
                bind:value={connectionId}
                onchange={loadProjects}
              >
                {#each info?.connections ?? [] as c}
                  <option value={c.id}>{new URL(c.url).host}</option>
                {/each}
              </select>
            {/if}
            <button class={buttonClass} onclick={refresh}>{$i18n.t('common.refresh')}</button>
          </div>
        </div>

        {#if !connectionId}
          <div class="text-[12px] opacity-30 py-3">{$i18n.t('settings.work.noConnection')}</div>
        {:else if error}
          <div class="text-[12px] opacity-40 py-3">{$i18n.t('settings.work.signInRequired')}</div>
        {:else if loading && folders.length === 0}
          <div class="text-[12px] opacity-20 py-3">{$i18n.t('common.loading')}</div>
        {:else if folders.length === 0}
          <div class="text-[12px] opacity-30 py-3">{$i18n.t('settings.work.noProjects')}</div>
        {:else}
          <div class="flex flex-col gap-1">
            {#each ordered as { folder, depth } (folder.id)}
              <div
                class="flex items-center gap-3 py-2 px-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.03]"
                style="margin-left: {depth * 16}px"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] opacity-80 truncate">{folder.name}</div>
                  {#if folder.project}
                    <button
                      class="text-[11px] opacity-40 hover:opacity-70 truncate block max-w-full bg-transparent border-none p-0 text-left text-[#1d1d1f] dark:text-[#fafafa]"
                      title={folder.project.path}
                      onclick={() => window.electronAPI.openPath(folder.project!.path)}
                    >
                      {folder.project.path}
                    </button>
                  {:else}
                    <div class="text-[11px] opacity-25">{$i18n.t('settings.work.notLinked')}</div>
                  {/if}
                </div>

                {#if folder.project}
                  <select
                    class="text-[12px] px-2 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border-none text-[#1d1d1f] dark:text-[#fafafa]"
                    value={folder.project.mode}
                    onchange={(e) => setMode(folder, (e.target as HTMLSelectElement).value)}
                  >
                    {#each modes as m}
                      <option value={m.id}>{m.label()}</option>
                    {/each}
                  </select>
                  <button class={buttonClass} onclick={() => link(folder)}>
                    {$i18n.t('settings.work.change')}
                  </button>
                  <button class={buttonClass} onclick={() => unlink(folder)}>
                    {$i18n.t('settings.work.unlink')}
                  </button>
                {:else}
                  <button class={buttonClass} onclick={() => link(folder)}>
                    {$i18n.t('settings.work.link')}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="py-4">
        <div class="text-[13px] opacity-70">{$i18n.t('settings.work.howTo')}</div>
        <div class="text-[11px] opacity-30 mt-1 leading-relaxed whitespace-pre-line">
          {$i18n.t('settings.work.howToDesc')}
        </div>
      </div>
    {/if}
  </div>
{/if}
