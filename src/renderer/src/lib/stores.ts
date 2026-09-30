import { writable } from 'svelte/store'

export const appInfo = writable(null)
export const config = writable(null)
export const connections = writable([])
export const serverInfo = writable(null)
export const appState = writable('loading') // loading | initializing | setup | ready

// Work mode — the active connection (shared by the top bar toggle and the
// Work bar) and whether Local Files is on in its Open WebUI (null = unknown)
export const activeConnection = writable<{ id: string; url: string } | null>(null)
export const workEnabled = writable<boolean | null>(null)
// Bumped when the main process reports a Work status change
export const workTick = writable(0)
