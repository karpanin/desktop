<script lang="ts">
  import { activeConnection, workEnabled, workTick } from '../../stores'
  import i18n from '../../i18n'

  // Chat / Work switch in the top bar.  Work = the Local Files terminal
  // server is on in Open WebUI (models get the local file tools and the
  // Work bar shows the project folder); Chat = it's off.

  let switching = $state(false)
  let requestSeq = 0

  const load = async (connectionId: string) => {
    const seq = ++requestSeq
    const enabled = await window.electronAPI.getWorkServerEnabled(connectionId)
    if (seq === requestSeq) workEnabled.set(enabled)
  }

  $effect(() => {
    // Re-read on connection change and when registration completes
    void $workTick
    if ($activeConnection) load($activeConnection.id)
    else workEnabled.set(null)
  })

  const select = async (work: boolean) => {
    if (!$activeConnection || switching || ($workEnabled ?? false) === work) return
    switching = true
    try {
      // Saves the choice in Open WebUI and reloads the page to apply it
      await window.electronAPI.setWorkServerEnabled($activeConnection.id, work)
      workEnabled.set(work)
    } catch (e) {
      console.error('Failed to switch Work mode:', e)
      await load($activeConnection.id)
    }
    switching = false
  }

  const segment =
    'px-3 h-[20px] rounded-full text-[11px] transition border-none text-[#1d1d1f] dark:text-[#fafafa] cursor-pointer'
</script>

<div
  class="no-drag flex items-center p-[2px] rounded-full bg-black/[0.06] dark:bg-white/[0.07] {switching
    ? 'opacity-60 pointer-events-none'
    : ''}"
  role="radiogroup"
  aria-label={$i18n.t('work.toggle.label')}
>
  <button
    class="{segment} {$workEnabled
      ? 'bg-transparent opacity-50 hover:opacity-80'
      : 'bg-white dark:bg-white/[0.14] shadow-sm opacity-100'}"
    role="radio"
    aria-checked={!$workEnabled}
    onclick={() => select(false)}
  >
    {$i18n.t('work.toggle.chat')}
  </button>
  <button
    class="{segment} {$workEnabled
      ? 'bg-white dark:bg-white/[0.14] shadow-sm opacity-100'
      : 'bg-transparent opacity-50 hover:opacity-80'}"
    role="radio"
    aria-checked={!!$workEnabled}
    onclick={() => select(true)}
  >
    {$i18n.t('work.toggle.work')}
  </button>
</div>
