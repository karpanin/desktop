<script lang="ts">
  import { fade } from 'svelte/transition'
  import i18n from '../../../i18n'

  // Thin bar above the Open WebUI page: shows which local folder the
  // current project (folder page or chat inside a project) is linked to,
  // and lets the user link a folder or change the access mode in place.

  interface Props {
    connectionId: string
    url: string
  }

  let { connectionId, url }: Props = $props()

  type Context = {
    folderId: string
    folderName: string
    project: { folderId: string; folderName: string; path: string; mode: string } | null
    serverEnabled: boolean | null
  }

  let context = $state<Context | null>(null)
  let requestSeq = 0

  const load = async () => {
    const seq = ++requestSeq
    const result = url ? await window.electronAPI.getWorkContext(connectionId, url) : null
    if (seq === requestSeq) context = result
  }

  $effect(() => {
    // Re-resolve whenever the page or connection changes
    void connectionId
    void url
    load()
  })

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

  const enableServer = async () => {
    await window.electronAPI.setWorkServerEnabled(connectionId, true)
    await load()
  }

  const modes = [
    { id: 'read', label: () => $i18n.t('settings.work.modeRead') },
    { id: 'confirm', label: () => $i18n.t('settings.work.modeConfirm') },
    { id: 'auto', label: () => $i18n.t('settings.work.modeAuto') }
  ]

  const buttonClass =
    'text-[11px] opacity-60 hover:opacity-100 px-2 py-0.5 bg-black/[0.05] dark:bg-white/[0.07] transition border-none text-[#1d1d1f] dark:text-[#fafafa] rounded-lg shrink-0'
</script>

{#if context}
  <div
    class="flex items-center gap-2 px-3 h-8 shrink-0 text-[11px] border-b border-black/[0.06] dark:border-white/[0.06] bg-[#eee] dark:bg-[#111] min-w-0"
    in:fade={{ duration: 120 }}
  >
    <svg class="w-[13px] h-[13px] shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
    <span class="opacity-50 shrink-0">{$i18n.t('work.bar.label')}</span>

    {#if context.project}
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
        class="text-[11px] px-1.5 py-0.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.07] border-none text-[#1d1d1f] dark:text-[#fafafa] shrink-0"
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

    {#if context.project && context.serverEnabled === false}
      <span class="text-amber-600 dark:text-amber-400/80 shrink-0">{$i18n.t('work.bar.serverOff')}</span>
      <button class={buttonClass} onclick={enableServer}>{$i18n.t('work.bar.turnOn')}</button>
    {/if}
  </div>
{/if}
