/**
 * Offline harness for the dsh-workspace-sidebar client half: one boot
 * of the bundle against a fake right Sidebar, a fake layout store, a fake
 * document/React/Cordis and a fake localStorage, asserting all four
 * capabilities it now carries — the automatic open, the remembered width, the
 * drag-to-reference transfer, and the workspace pin reorder. Not shipped with
 * the plugin.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const filesId = '@deepseek-ai/dsh-client-ui-sidebar-files'

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (subscribe, get) => { void subscribe; return get() },
}

/* ------------------------------------------------------------------ *
 * Fake DOM, enough for closest()/classList/document listeners.        *
 * ------------------------------------------------------------------ */

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = [] }
  contains(other) {
    let node = other
    while (node !== null && node !== undefined) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }
}

class FakeElement extends FakeNode {
  constructor(tag, attrs = {}) {
    super()
    this.tagName = String(tag).toUpperCase()
    this.attrs = new Map(Object.entries(attrs))
    this.classes = new Set()
    const self = this
    this.classList = {
      add: (name) => { self.classes.add(name) },
      remove: (name) => { self.classes.delete(name) },
      contains: (name) => self.classes.has(name),
    }
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null }
  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  removeAttribute(name) { this.attrs.delete(name) }
  hasAttribute(name) { return this.attrs.has(name) }
  matches(selector) {
    return selector.split(/(?=\[)|(?<=])/).every((part) => {
      const bracket = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(part)
      if (bracket !== null) {
        const value = this.getAttribute(bracket[1])
        return bracket[2] === undefined ? value !== null : value === bracket[2]
      }
      return this.tagName === part.toUpperCase()
    })
  }
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (node instanceof FakeElement && node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }
  querySelector() { return null }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child }
  remove() {
    if (this.parentNode === null) return
    const at = this.parentNode.childNodes.indexOf(this)
    if (at >= 0) this.parentNode.childNodes.splice(at, 1)
    this.parentNode = null
  }
}

const listeners = new Map()
const documentElement = new FakeElement('html')
const body = new FakeElement('body')
body.parentNode = documentElement
const document = {
  body,
  documentElement,
  head: new FakeElement('head'),
  createElement: (tag) => new FakeElement(tag),
  addEventListener: (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(listener)
  },
  removeEventListener: (type, listener) => {
    listeners.get(type)?.delete(listener)
  },
}
const fire = (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event) }

/* ------------------------------------------------------------------ *
 * Fake stores and services.                                           *
 * ------------------------------------------------------------------ */

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}

function makeStore(initial) {
  let value = initial
  const subscribers = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { subscribers.add(listener); return () => { subscribers.delete(listener) } },
    set: (next) => { value = next; for (const listener of [...subscribers]) listener() },
  }
}

const VIEWPORT = 1440
const RIGHTBAR_MIN = 300
const RIGHTBAR_MAX = Math.round(VIEWPORT * 0.7)

/** A fake layout store instance whose snapshot mirrors ui-layout's shape. */
function createLayoutInstance() {
  let state = {
    panelInfo: { activePanelId: null },
    layoutInfo: {
      sidebar: 280, viewportWidth: VIEWPORT, narrowExpanded: false,
      rightbar: null, rightbarShown: false, rightbarTrack: false,
      rightbarFullscreen: false, rightbarInstant: false,
    },
  }
  const subscribers = new Set()
  const writes = []
  const publish = () => { for (const listener of [...subscribers]) listener() }
  return {
    writes,
    getSnapshot: () => state,
    subscribe: (listener) => { subscribers.add(listener); return () => { subscribers.delete(listener) } },
    actions: {
      setRightbar: (px) => {
        const clamped = Math.min(Math.max(Math.round(px), RIGHTBAR_MIN), RIGHTBAR_MAX)
        writes.push(clamped)
        state = { ...state, layoutInfo: { ...state.layoutInfo, rightbar: clamped } }
        publish()
      },
    },
    drag: (px) => {
      state = { ...state, layoutInfo: { ...state.layoutInfo, rightbar: px } }
      publish()
    },
  }
}

const layout = createLayoutInstance()
const layoutHandle = { create: () => layout }

// --- fake right Sidebar -------------------------------------------------
const opened = []
const mounted = makeStore(undefined)
const openTabs = makeStore([])
let expanded = false
let activePage
let silentOnce = false
const right = {
  mounted,
  openTabs,
  openTab: (kind) => {
    if (silentOnce) { silentOnce = false; return }
    opened.push(kind)
    expanded = true
    activePage = kind
    openTabs.set([{ sessionId: mounted.getSnapshot(), tabId: `tab${opened.length}`, kind, contentId: `sidebar://${kind}` }])
  },
  isExpanded: () => expanded,
  toggleExpanded: () => { expanded = !expanded },
  active: () => (activePage === undefined ? undefined : { kind: activePage }),
}

const registry = {
  get: (kind) => (kind === 'files' ? { id: filesId, kind: 'files' } : undefined),
  subscribe: () => () => {},
}
const withCwd = (entries) => ({
  ids: Object.keys(entries),
  byId: Object.fromEntries(Object.entries(entries).map(([id, cwd]) => [id, {
    id, displayTitle: id, cwd, running: false, retainedBy: {}, blank: false, updatedAt: 0,
  }])),
  phase: 'ready',
  projectionsBySession: {},
})
const sessionList = makeStore({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
const sessions = { list: sessionList, scope: (id) => (id === sessionId ? actx : undefined) }

// --- fake composer + session for the drag transfer -----------------------
const sessionId = 'session-a'
const seat = new FakeElement('div', { 'data-sidebar-right-session': sessionId })
const row = new FakeElement('div', { 'data-files-path': 'D:\\插件\\src\\main.js', 'data-files-entry': 'file' })
const rowName = new FakeElement('span')
row.appendChild(rowName)
seat.appendChild(row)
documentElement.appendChild(seat)
const dirRow = new FakeElement('div', { 'data-files-path': 'D:\\插件\\docs', 'data-files-entry': 'directory' })
seat.appendChild(dirRow)
const card = new FakeElement('div', { 'data-composer-card': '' })
const composerInner = new FakeElement('div')
card.appendChild(composerInner)
documentElement.appendChild(card)

const inserted = []
let draft = ''
const input = {
  state: { getSnapshot: () => ({ draft, draftRev: 3, phase: 'plain', occurrences: [] }) },
  insertReference: (reference) => {
    inserted.push({ reference })
    draft = `${draft}${reference.clipboardText}`
    return true
  },
}
const actx = { emit: () => {}, get: () => ({ input: { for: () => input } }) }
const conversation = { input: { for: () => input } }
const locale = { register: () => () => {}, bind: () => (key) => key }

/* ------------------------------------------------------------------ *
 * Fake Cordis context and slot registry.                              *
 * ------------------------------------------------------------------ */

const registered = []
const effects = []
const slots = {
  inject: (key, callback) => { const dispose = callback(); registered.push({ key, dispose }); return () => {} },
  register: (options, component) => { registered.push({ options, component }); return () => {} },
  // The registry stores a registration's store at the entry's top level
  // (`StoredEntry.store`), which is the shape the renderer resolves from; the
  // option object it was passed in is not part of the stored entry.
  entries: (key) => (key === 'root' ? [{ store: layoutHandle }] : []),
  entriesOfSlot: (key) => (key === 'sidebar.right.pane.tab' ? [{ options: { key: filesId } }] : []),
  subscribe: () => () => {},
}

// --- fake workspace registry: the reorder writes really move the list ------
const workspaceMoves = []
const workspaceList = makeStore({
  items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'idle', error: null,
})
const workspaces = {
  list: workspaceList,
  insertBefore: async (id, before) => {
    workspaceMoves.push({ id, before })
    const snapshot = workspaceList.getSnapshot()
    const items = [...snapshot.items]
    const from = items.findIndex((row) => row.workspaceId === id)
    if (from === -1) throw new Error(`no such workspace ${id}`)
    const [row] = items.splice(from, 1)
    const at = before === undefined ? items.length : items.findIndex((other) => other.workspaceId === before)
    items.splice(at === -1 ? items.length : at, 0, row)
    workspaceList.set({ ...snapshot, items })
  },
}
// --- fake context menu service: remembers contributions by target kind -----
const menuContributions = new Map()
const contextMenus = {
  active: makeStore(null),
  register: (contribution) => {
    menuContributions.set(`${contribution.target}/${contribution.id}`, contribution)
    return () => { menuContributions.delete(`${contribution.target}/${contribution.id}`) }
  },
}
const services = {
  slots, sidebarRight: right, sidebarRightTabs: registry, sessions, conversation, locale, workspaces, contextMenus,
  uiSession: { adapter: { current: { getSnapshot: () => ({ key: sessionId }) } } },
}
const ctx = {
  slots,
  get: (name) => services[name],
  effect: (callback, label) => { const dispose = callback(); effects.push({ dispose, label }); return () => {} },
  inject: (deps, callback) => {
    if (deps.some((dep) => services[dep] === undefined)) return () => {}
    const child = { ...ctx, get: (name) => services[name] }
    const dispose = callback(child)
    effects.push({ dispose, label: `inject(${deps.join(',')})` })
    return () => {}
  },
}

/* ------------------------------------------------------------------ *
 * Boot.                                                              *
 * ------------------------------------------------------------------ */

const resizeListeners = new Set()
const globalWindow = {
  innerWidth: VIEWPORT,
  addEventListener: (type, listener) => { if (type === 'resize') resizeListeners.add(listener) },
  removeEventListener: (type, listener) => { if (type === 'resize') resizeListeners.delete(listener) },
  requestAnimationFrame: (callback) => { callback() },
  __ModuleLoader__: { load: (value) => { registration = value } },
}
let registration

const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, Node: globalThis.Node }
globalThis.window = globalWindow
globalThis.document = document
globalThis.Element = FakeElement
globalThis.Node = FakeNode
globalThis.requestAnimationFrame = (callback) => { callback() }

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))
const walk = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

try {
  new Function('window', 'module', `${source}\nreturn window.__ModuleLoader__`)(globalWindow, {})
  assert.equal(registration.id, 'dsh-workspace-sidebar')

  const exported = registration.factory(() => React)
  assert.deepEqual(exported.inject, ['slots'])
  exported.apply(ctx)

  /* ---------------- 2. remembered width ------------------------------ */

  assert.ok(layout.writes.length >= 1, 'the frame width is applied on activation')
  const FIRST_USE = Math.min(Math.max(Math.round(VIEWPORT * 0.26), 300), 440)
  assert.equal(layout.writes[0], FIRST_USE)
  assert.ok(layout.writes[0] < Math.round(VIEWPORT * 0.45), 'first-use width is narrower than the frame default')
  assert.equal(layout.getSnapshot().layoutInfo.rightbar, FIRST_USE)

  await tick()
  assert.equal(storage.has('dsh.rightbar-width-memory.v1'), false, 'adopting is not a choice, so nothing is saved')

  layout.drag(520)
  await tick(60)
  assert.equal(storage.has('dsh.rightbar-width-memory.v1'), false, 'a drag in flight is not saved yet')
  await tick(500)
  assert.equal(storage.get('dsh.rightbar-width-memory.v1'), JSON.stringify({ width: 520 }))

  const widthRow = registered.find((entry) => entry.options?.id === 'workspace-sidebar-width')
  assert.equal(widthRow.options.name, 'settings.general.item')
  const widthTree = widthRow.component({ ...widthRow.options.inject(), t: (key, params) => `${key}:${params?.width ?? ''}` })
  const widthNodes = walk(widthTree)
  assert.equal(widthNodes.find((child) => child?.props?.className === 'wsw-value').children[0], 'width.remembered:520')
  const reset = widthNodes.find((child) => child?.props?.className === 'wsw-reset')
  assert.equal(reset.props.disabled, false)
  reset.props.onClick()
  assert.equal(storage.has('dsh.rightbar-width-memory.v1'), false, 'reset clears the record')

  /* ---------------- 1. automatic open -------------------------------- */

  const autoshowRow = registered.find((entry) => entry.options?.id === 'workspace-sidebar')
  assert.equal(autoshowRow.options.name, 'settings.general.item')
  const autoshowTree = autoshowRow.component({ ...autoshowRow.options.inject(), t: (key) => key })
  const toggle = walk(autoshowTree).find((child) => child?.props?.role === 'switch')
  assert.equal(toggle.props['aria-checked'], 'true')
  assert.equal(toggle.props['aria-labelledby'], 'wsb-settings-title')

  assert.deepEqual(opened, [], 'no conversation yet: nothing opens')

  mounted.set('session-a')
  assert.deepEqual(opened, [], 'a conversation without a workspace directory opens nothing')

  sessionList.set(withCwd({ 'session-a': 'D:\\插件' }))
  assert.deepEqual(opened, ['files'])

  mounted.set(undefined)
  expanded = false
  mounted.set('session-a')
  assert.deepEqual(opened, ['files'], 'coming back to it does not reopen')

  expanded = false
  activePage = undefined
  sessionList.set(withCwd({ 'session-a': 'D:\\插件', 'session-b': 'D:\\插件\\x' }))
  mounted.set('session-b')
  assert.deepEqual(opened, ['files', 'files'])

  // The reader's own page in an expanded column is never replaced.
  expanded = true
  activePage = 'editor'
  sessionList.set(withCwd({ 'session-a': 'D:\\插件', 'session-b': 'D:\\插件\\x', 'session-c': 'D:\\插件\\y' }))
  mounted.set('session-c')
  assert.deepEqual(opened, ['files', 'files'])

  // A narrow window defers; widening it delivers.
  expanded = false
  activePage = undefined
  globalWindow.innerWidth = 600
  sessionList.set(withCwd({ 'session-a': 'D:\\插件', 'session-d': 'D:\\插件\\z' }))
  mounted.set('session-d')
  assert.deepEqual(opened, ['files', 'files'])
  globalWindow.innerWidth = 1440
  for (const listener of [...resizeListeners]) listener()
  assert.deepEqual(opened, ['files', 'files', 'files'])

  // A seat that is not adopted yet answers with a silent no-op; the retry
  // window turns that into a real open instead of marking it done.
  expanded = false
  activePage = undefined
  silentOnce = true
  sessionList.set(withCwd({ 'session-a': 'D:\\插件', 'session-e': 'D:\\插件\\w' }))
  mounted.set('session-e')
  assert.deepEqual(opened, ['files', 'files', 'files'])
  await tick()
  assert.deepEqual(opened, ['files', 'files', 'files', 'files'])

  /* ---------------- 3. drag transfer --------------------------------- */

  fire('pointerdown', { button: 0, target: rowName })
  assert.equal(row.getAttribute('draggable'), 'true')
  fire('pointerup', {})
  assert.equal(row.getAttribute('draggable'), null, 'a plain click leaves no draggable residue')

  fire('pointerdown', { button: 0, target: rowName })
  const written = new Map()
  let effectAllowed
  let dragImageArgs
  const transfer = {
    types: [],
    getData: (type) => written.get(type) ?? '',
    setData: (type, value) => { written.set(type, value); transfer.types.push(type) },
    setDragImage: (...args) => { dragImageArgs = args },
    get effectAllowed() { return effectAllowed },
    set effectAllowed(value) { effectAllowed = value },
  }
  fire('dragstart', { target: row, dataTransfer: transfer })
  assert.equal(effectAllowed, 'copy')
  assert.deepEqual(JSON.parse(written.get('application/x-dsh-workspace-sidebar-file')), {
    path: 'D:\\插件\\src\\main.js', relative: 'src/main.js', isDir: false,
  })
  assert.equal(written.get('text/plain'), '@src/main.js')
  assert.equal(dragImageArgs[0].className, 'wsd-ghost')

  // The composer is not a drop target for anything else.
  let prevented = false
  fire('dragover', {
    target: composerInner, dataTransfer: { types: ['Files'], getData: () => '' },
    preventDefault: () => { prevented = true }, stopPropagation: () => {},
  })
  assert.equal(prevented, false)
  assert.equal(card.classList.contains('wsd-composer-over'), false)

  prevented = false
  fire('dragover', {
    target: composerInner, dataTransfer: transfer,
    preventDefault: () => { prevented = true }, stopPropagation: () => {},
  })
  assert.equal(prevented, true)
  assert.equal(card.classList.contains('wsd-composer-over'), true)

  fire('drop', {
    target: composerInner, dataTransfer: transfer,
    preventDefault: () => {}, stopPropagation: () => {},
  })
  assert.equal(inserted.length, 1)
  assert.deepEqual(inserted[0].reference, {
    source: 'reference',
    ref: '@src/main.js',
    label: 'src/main.js',
    appearance: 'file',
    clipboardText: '@src/main.js',
  })

  // A directory row produces a folder chip with the trailing slash.
  fire('pointerdown', { button: 0, target: dirRow })
  const dirWritten = new Map()
  const dirTransfer = {
    types: [],
    getData: (type) => dirWritten.get(type) ?? '',
    setData: (type, value) => { dirWritten.set(type, value); dirTransfer.types.push(type) },
    setDragImage: () => {},
  }
  fire('dragstart', { target: dirRow, dataTransfer: dirTransfer })
  assert.deepEqual(JSON.parse(dirWritten.get('application/x-dsh-workspace-sidebar-file')), {
    path: 'D:\\插件\\docs', relative: 'docs/', isDir: true,
  })
  fire('drop', { target: composerInner, dataTransfer: dirTransfer, preventDefault: () => {}, stopPropagation: () => {} })
  assert.equal(inserted[1].reference.appearance, 'folder')
  assert.equal(inserted[1].reference.ref, '@docs/')

  // A path with a space keeps the quoted spelling the grammar uses.
  const spacedRow = new FakeElement('div', { 'data-files-path': 'D:\\插件\\my notes.md', 'data-files-entry': 'file' })
  seat.appendChild(spacedRow)
  fire('pointerdown', { button: 0, target: spacedRow })
  const spacedWritten = new Map()
  const spacedTransfer = {
    types: [],
    getData: (type) => spacedWritten.get(type) ?? '',
    setData: (type, value) => { spacedWritten.set(type, value); spacedTransfer.types.push(type) },
    setDragImage: () => {},
  }
  fire('dragstart', { target: spacedRow, dataTransfer: spacedTransfer })
  assert.equal(spacedWritten.get('text/plain'), '@"my notes.md"')
  fire('dragend', {})
  assert.equal(spacedRow.getAttribute('draggable'), null)

  /* ---------------- the switch stops the open, not the others -------- */

  const offTree = autoshowRow.component({ ...autoshowRow.options.inject(), t: (key) => key })
  walk(offTree).find((child) => child?.props?.role === 'switch').props.onClick()
  assert.equal(storage.get('dsh.workspace-sidebar.v1'), JSON.stringify({ enabled: false }))
  expanded = false
  sessionList.set(withCwd({ 'session-a': 'D:\\插件', 'session-f': 'D:\\插件\\v' }))
  mounted.set('session-f')
  assert.equal(opened.length, 4, 'the switch stops further opens')

  // Width memory and the drag transfer still work with the switch off.
  layout.drag(410)
  await tick(500)
  assert.equal(storage.get('dsh.rightbar-width-memory.v1'), JSON.stringify({ width: 410 }))
  fire('pointerdown', { button: 0, target: rowName })
  fire('pointerup', {})
  assert.equal(row.getAttribute('draggable'), null)

  /* ---------------- 4. workspace order by recency --------------------- */

  const workspaceRow = (id, sessionIds) => ({
    workspaceId: id, path: `D:\\${id}`, title: id, sessionIds,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  })
  const summaries = (entries) => ({
    ids: Object.keys(entries),
    byId: Object.fromEntries(Object.entries(entries).map(([id, updatedAt]) => [id, {
      id, displayTitle: id, cwd: 'D:\\插件', running: false, retainedBy: {}, blank: false, updatedAt,
    }])),
    phase: 'ready',
    projectionsBySession: {},
  })

  // Before the registry is ready nothing is reordered.
  workspaceList.set({
    ...workspaceList.getSnapshot(),
    phase: 'loading',
    items: [workspaceRow('ws-a', ['s1']), workspaceRow('ws-b', ['s2'])],
  })
  sessionList.set(summaries({ s1: 100, s2: 200 }))
  await tick(1700)
  assert.equal(workspaceMoves.length, 0, 'a loading registry is left alone')

  // The Workspace holding the newest Session leads.
  workspaceList.set({ ...workspaceList.getSnapshot(), phase: 'ready' })
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-b', 'ws-a'])
  assert.deepEqual(workspaceMoves, [{ id: 'ws-b', before: 'ws-a' }])

  // A conversation in the trailing Workspace brings it back up; the move is
  // anchored at the row it must precede, not appended.
  sessionList.set(summaries({ s1: 300, s2: 200 }))
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-a', 'ws-b'])
  assert.deepEqual(workspaceMoves.at(-1), { id: 'ws-a', before: 'ws-b' })

  // Settled state writes nothing more: an unchanged order is not a reorder.
  const movesSoFar = workspaceMoves.length
  workspaceList.set({ ...workspaceList.getSnapshot() })
  await tick(1700)
  assert.equal(workspaceMoves.length, movesSoFar, 'an already ordered registry is not rewritten')

  // A Workspace with no known Session ranks last, even when it currently leads.
  workspaceList.set({
    ...workspaceList.getSnapshot(),
    items: [workspaceRow('ws-c', ['s9']), workspaceRow('ws-a', ['s1']), workspaceRow('ws-b', ['s2'])],
  })
  sessionList.set(summaries({ s1: 300, s2: 200 }))
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-a', 'ws-b', 'ws-c'],
    'the Workspace with no known Session drops below the ranked ones')

  // Ties keep their current relative order instead of shuffling.
  sessionList.set(summaries({ s1: 500, s2: 500 }))
  const beforeTie = workspaceList.getSnapshot().items.map((row) => row.workspaceId)
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), beforeTie,
    'equal timestamps do not reorder')

  // A refused write is not retried forever with the same plan.
  const refusedMoves = []
  const originalInsert = workspaces.insertBefore
  const originalError = console.error
  console.error = () => {}
  workspaces.insertBefore = async (id, before) => {
    refusedMoves.push({ id, before })
    throw new Error('workspace move refused')
  }
  sessionList.set(summaries({ s1: 100, s2: 900 }))
  await tick(1700)
  const firstAttempt = refusedMoves.length
  assert.ok(firstAttempt > 0, 'the refused plan is attempted once')
  workspaceList.set({ ...workspaceList.getSnapshot() })
  await tick(1700)
  await tick(1700)
  assert.equal(refusedMoves.length, firstAttempt, 'the same refused plan is not retried on every tick')
  workspaces.insertBefore = originalInsert
  console.error = originalError

  /* ---------------- 5. manual workspace pin --------------------------- */

  const pinContribution = menuContributions.get('workspace/workspace-sidebar.pin')
  assert.ok(pinContribution !== undefined, 'the Workspace row menu gains a pin action')

  // The menu action's icon resolves through its own keyed slot, or the row
  // would show an empty cell beside Rename and Delete.
  const iconRegistration = registered.find((entry) =>
    entry.options?.name === 'contextMenu.icon' && entry.options.key === 'workspace-sidebar.pin')
  assert.ok(iconRegistration !== undefined, 'the pin icon is registered into contextMenu.icon')
  const iconTree = iconRegistration.component({})
  assert.equal(iconTree.type, 'svg')
  const observed = pinContribution.observe({ workspaceId: 'ws-a' })
  assert.equal(observed.length, 1, 'the open menu watches the pin record so its label flips in place')
  assert.equal(typeof observed[0].getSnapshot, 'function')
  assert.equal(typeof observed[0].subscribe, 'function')

  // Unpinned: the action offers to pin.
  let pinActions = pinContribution.resolve({ workspaceId: 'ws-a', path: 'D:\\ws-a', displayTitle: 'ws-a' })
  assert.equal(pinActions.length, 1)
  assert.equal(pinActions[0].label, 'pin.pin')
  assert.equal(pinActions[0].icon.key, 'workspace-sidebar.pin')

  // Pinning ws-c (currently last) lifts it above both ranked Workspaces.
  workspaceList.set({
    ...workspaceList.getSnapshot(),
    items: [workspaceRow('ws-a', ['s1']), workspaceRow('ws-b', ['s2']), workspaceRow('ws-c', ['s3'])],
  })
  sessionList.set(summaries({ s1: 900, s2: 800, s3: 100 }))
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-a', 'ws-b', 'ws-c'])

  pinContribution.resolve({ workspaceId: 'ws-c', path: 'D:\\ws-c', displayTitle: 'ws-c' })[0].run()
  assert.deepEqual(JSON.parse(storage.get('dsh.workspace-order-manual-pins.v1')).ids, ['ws-c'])
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-c', 'ws-a', 'ws-b'],
    'a pinned Workspace leads regardless of recency')

  // The menu now offers to unpin, and a second pin leads the pinned block.
  pinActions = pinContribution.resolve({ workspaceId: 'ws-c', path: 'D:\\ws-c', displayTitle: 'ws-c' })
  assert.equal(pinActions[0].label, 'pin.unpin')
  pinContribution.resolve({ workspaceId: 'ws-b', path: 'D:\\ws-b', displayTitle: 'ws-b' })[0].run()
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-b', 'ws-c', 'ws-a'],
    'the most recent pin leads the pinned block')

  // A newer conversation still may not outrank a pin.
  sessionList.set(summaries({ s1: 9000, s2: 800, s3: 100 }))
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-b', 'ws-c', 'ws-a'],
    'recency orders only the unpinned Workspaces')

  // Unpinning restores the recency order.
  pinContribution.resolve({ workspaceId: 'ws-b', path: 'D:\\ws-b', displayTitle: 'ws-b' })[0].run()
  pinContribution.resolve({ workspaceId: 'ws-c', path: 'D:\\ws-c', displayTitle: 'ws-c' })[0].run()
  assert.equal(storage.has('dsh.workspace-order-manual-pins.v1'), false, 'unpinning every Workspace clears the record')
  await tick(1700)
  assert.deepEqual(workspaceList.getSnapshot().items.map((row) => row.workspaceId), ['ws-a', 'ws-b', 'ws-c'])

  // A pin whose Workspace disappears is dropped instead of lingering forever.
  pinContribution.resolve({ workspaceId: 'ws-b', path: 'D:\\ws-b', displayTitle: 'ws-b' })[0].run()
  await tick(1700)
  assert.deepEqual(JSON.parse(storage.get('dsh.workspace-order-manual-pins.v1')).ids, ['ws-b'])
  workspaceList.set({
    ...workspaceList.getSnapshot(),
    items: [workspaceRow('ws-a', ['s1']), workspaceRow('ws-c', ['s3'])],
  })
  await tick(1700)
  assert.equal(storage.has('dsh.workspace-order-manual-pins.v1'), false,
    'a pin for a Workspace the registry no longer reports is pruned')

  /* ---------------- unload ------------------------------------------- */

  for (const effect of effects.reverse()) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  assert.equal(resizeListeners.size, 0, 'resize listener released')
  assert.ok([...listeners.values()].every((set) => set.size === 0), 'document listeners released')
  layout.drag(460)
  await tick(500)
  assert.equal(storage.get('dsh.rightbar-width-memory.v1'), JSON.stringify({ width: 410 }),
    'a drag after unload is not recorded')

  // A late snapshot after unload must not reorder anything.
  const movesAfterUnload = workspaceMoves.length
  workspaceList.set({ ...workspaceList.getSnapshot() })
  await tick(1700)
  assert.equal(workspaceMoves.length, movesAfterUnload, 'a reorder after unload is not attempted')

  console.log('workspace files harness ok')
} finally {
  globalThis.window = previous.window
  globalThis.document = previous.document
  globalThis.Element = previous.Element
  globalThis.Node = previous.Node
}
