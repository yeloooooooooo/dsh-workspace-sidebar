/**
 * Client half of emoji-workspace-sidebar.
 *
 * One bundle keeps the right Sidebar's workspace file tree usable end to end.
 * It carries four capabilities that share one activation, one stylesheet, and
 * one Settings → General area:
 *
 *   1. **Opening** — a conversation brings its workspace tree on screen. The
 *      tree itself is the shipped `files` page
 *      (@deepseek-ai/dsh-client-ui-sidebar-files, or whichever type has taken
 *      that kind over); this module only decides WHEN that page is opened:
 *        - once per conversation, the first time that conversation comes on
 *          screen and its workspace directory is known;
 *        - never again in the same page load, so a column the reader collapsed
 *          or a page they closed stays closed when they come back to it;
 *        - only while the General settings row leaves the behavior enabled;
 *        - never over a page the reader is already reading in that column, and
 *          never at a width where the column would cover the conversation.
 *
 *   2. **Width** — the frame keeps its right-column width in the layout
 *      store's `layoutInfo.rightbar`, seeded at 45% of the viewport and never
 *      persisted, so every page load dropped back to that wide default. This
 *      module reaches the layout store the frame is already seated on (the
 *      `root` slot's entry carries a handle whose `create()` returns that one
 *      shared instance, because ui-layout hands the frame a pinned instance),
 *      applies the remembered width — or a narrower first-use default before
 *      anything is remembered — and saves each width the reader settles on.
 *
 *   3. **Drag** — dragging a file or folder out of the tree and dropping it on
 *      the conversation composer inserts it as an `@` reference, the same chip
 *      the composer's own `@` picker produces. Neither shipped tree makes its
 *      rows draggable and neither exposes a row extension point for drag, so
 *      the missing half is supplied at document level: `pointerdown` marks a
 *      row `draggable`, `dragstart` publishes a private payload — the absolute
 *      path and whether it is a directory — under the bundle's own MIME type,
 *      and `dragover`/`drop` on the composer card resolves that payload and
 *      inserts a reference chip through the conversation service.
 *
 *   4. **Workspace order** — the left sidebar draws one section per Workspace
 *      in the Host registry's own order, which never follows the conversation
 *      the reader just used. This module reorders it through
 *      `workspaces.insertBefore()`: manually pinned Workspaces first in pin
 *      order, then every other Workspace by the recency of its newest Session.
 *      The pin action lives in each Workspace row's context menu.
 *
 * Every slot registration happens in `apply` itself, or in one of its own
 * `ctx.inject` callbacks. Registering into a slot from inside another slot's
 * injection callback is the one shape the registry documents as able to stall
 * boot with no error at all, so the frame is only *observed* here.
 */
window.__ModuleLoader__.load({
  id: 'emoji-workspace-sidebar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useSyncExternalStore } = React;

    /* ------------------------------------------------------------------ *
     * 1. Opening the workspace tree                                        *
     * ------------------------------------------------------------------ */

    /** The right-Sidebar page kind that draws a workspace tree, and the slot its body occupies. */
    const FILES_KIND = 'files';
    const TAB_BODY_SLOT = 'sidebar.right.pane.tab';
    /** Browser-local preference: whether the automatic open is on. */
    const PREF_KEY = 'dsh.workspace-sidebar.v1';
    /**
     * The arriving Session is published before its Seat is adopted, so the first
     * open can be a silent no-op. Retry for a bounded window, then give up.
     */
    const RETRY_MS = 60;
    const RETRY_WINDOW_MS = 8_000;
    /**
     * Below this viewport the right Sidebar is presented full screen, so opening
     * it unasked would take the whole frame away from the conversation.
     */
    const NARROW_VIEWPORT = 768;

    /* ------------------------------------------------------------------ *
     * 2. Remembering the right-column width                                *
     * ------------------------------------------------------------------ */

    /**
     * Browser-local store for the remembered width. The key keeps its older
     * name on purpose: an existing installation keeps the width it already
     * remembered instead of falling back to the first-use default.
     */
    const STORAGE_KEY = 'dsh.rightbar-width-memory.v1';
    /**
     * First-use width, used only until the reader drags the column themselves.
     * The frame's own default is 45% of the viewport, which crowds the
     * conversation on a desktop screen; a file explorer wants much less.
     */
    const DEFAULT_RATIO = 0.26;
    const DEFAULT_MIN = 300;
    const DEFAULT_MAX = 440;
    /** The frame's own bounds, mirrored so a restored value is always legal. */
    const RIGHTBAR_MIN = 300;
    const RIGHTBAR_MAX_RATIO = 0.7;
    /** A drag writes continuously; save only the width it settles on. */
    const SAVE_DEBOUNCE_MS = 400;
    /** The frame's store can appear a commit after its `root` declaration. */
    const ADOPT_RETRY_MS = 60;
    const ADOPT_ATTEMPTS = 40;

    /* ------------------------------------------------------------------ *
     * 3. Dragging a tree row into the composer                             *
     * ------------------------------------------------------------------ */

    /** The private drag MIME type and the plain-text fallback. */
    const DRAG_TYPE = 'application/x-dsh-workspace-sidebar-file';
    /** Marks the row we made draggable, so dragend can undo exactly that. */
    const ARMED_ATTR = 'data-dsh-workspace-sidebar-drag';
    /** Composer card marker the shipping input bar renders. */
    const COMPOSER = '[data-composer-card]';
    /** Right-Sidebar seats, inside which tree rows live. */
    const SIDEBAR = '[data-sidebar-right-session]';
    /** Drop-target highlight class, styled from the module stylesheet. */
    const OVER_CLASS = 'wsd-composer-over';

    /* ------------------------------------------------------------------ *
     * 4. Workspace order by conversation recency                           *
     * ------------------------------------------------------------------ */

    /**
     * Settle time before a workspace reorder. A Session being written to
     * advances `updatedAt` on every step; the order only needs its final value.
     */
    const REORDER_SETTLE_MS = 1_500;
    /**
     * Browser-local pinned Workspace ids, most recently pinned first. A pin
     * keeps its Workspace above every unpinned one; the rest of the order is
     * still recency, so pinning changes nothing about which conversation is
     * newest — only which Workspaces the reader insisted on seeing first.
     */
    const PIN_KEY = 'dsh.workspace-order-manual-pins.v1';

    /* ------------------------------------------------------------------ *
     * 5. Session-row mood faces                                            *
     * ------------------------------------------------------------------ */

    /**
     * Whether a conversation row shows a mood face instead of the shipped
     * state dot. Browser-local; the faces are cosmetic, so a profile that
     * turns them off gets the shipped dots back unchanged.
     */
    const MOOD_KEY = 'dsh.session-row-mood.v1';
    /**
     * How long one face holds before the cycle advances. A face that changed on
     * every render would strobe; one that never changed would read as a static
     * icon, so a running row cycles slowly enough to look alive.
     */
    const MOOD_FRAME_MS = 2_200;
    /**
     * Browser-local conversation bookmarks set from the row menu: one face per
     * conversation, chosen by the reader. Independent of the live state, so a
     * mark survives while the conversation runs or idles.
     */
    const MARK_KEY = 'dsh.session-row-marks.v1';
    /** The faces a reader can set as a mark, in menu order. */
    const MOOD_MARK_KEYS = ['calm', 'bubbles', 'rays', 'sleep', 'fire', 'hearts', 'tears'];
    const MARK_ICON_KEY = 'workspace-sidebar.mark';
    const MARK_CLEAR_ICON_KEY = 'workspace-sidebar.mark-clear';

    /* ------------------------------------------------------------------ *
     * Copy                                                                 *
     * ------------------------------------------------------------------ */

    const NS = 'workspaceSidebar';
    const ZH = {
      'open.title': '对话打开时显示工作区文件',
      'open.description':
        '切换对话时，自动在右侧栏显示该对话工作区的文件目录。手动关闭后，本次打开页面期间该对话不再自动显示；再次打开开关可重新计算。',
      'open.switch': '自动显示工作区文件目录',
      'width.title': '右侧栏宽度',
      'width.description': '记住你拖动后的右侧栏宽度，重启后恢复。',
      'width.reset': '恢复默认宽度',
      'width.remembered': '已记住 {width}px',
      'width.unset': '尚未调整，使用默认宽度',
      'pin.pin': '置顶工作区',
      'pin.unpin': '取消置顶',
      'mood.calm.label': '平静',
      'mood.bubbles.label': '活跃',
      'mood.rays.label': '有动静',
      'mood.sleep.label': '休眠',
      'mood.fire.label': '正在处理',
      'mood.hearts.label': '已完成',
      'mood.tears.label': '出错了',
      'mood.title': '对话状态表情',
      'mood.description':
        '把侧边栏对话行的状态点换成一个小表情：思考中、正在忙、等你回复、已完成、空闲。关闭后恢复原来的状态点。',
      'mood.switch': '在对话行显示状态表情',
      'mark.apply': '标记表情',
      'mark.change': '更改标记表情',
      'mark.clear': '清除标记',
      'mark.calm': '平静',
      'mark.bubbles': '活跃',
      'mark.rays': '有动静',
      'mark.sleep': '休眠',
      'mark.fire': '正在处理',
      'mark.hearts': '已完成',
      'mark.tears': '出错了',
    };
    const EN = {
      'open.title': 'Show workspace files when a conversation opens',
      'open.description':
        'Opening a conversation shows its workspace file tree in the right sidebar. After you close it, that conversation stays closed until the page reloads; switching this back on recalculates.',
      'open.switch': 'Show the workspace file tree automatically',
      'width.title': 'Right sidebar width',
      'width.description': 'Remembers the width you drag the right sidebar to, and restores it next time.',
      'width.reset': 'Reset to default',
      'width.remembered': 'Remembered {width}px',
      'width.unset': 'Not adjusted yet; using the default width',
      'pin.pin': 'Pin workspace to top',
      'pin.unpin': 'Unpin workspace',
      'mood.calm.label': 'Calm',
      'mood.bubbles.label': 'Chatty',
      'mood.rays.label': 'Needs you',
      'mood.sleep.label': 'Resting',
      'mood.fire.label': 'Working',
      'mood.hearts.label': 'Finished',
      'mood.tears.label': 'Went wrong',
      'mood.title': 'Conversation mood faces',
      'mood.description':
        'Replace the sidebar state dot with a small face: thinking, working, waiting for you, finished, or idle. Turn it off to get the shipped dots back.',
      'mood.switch': 'Show mood faces on conversation rows',
      'mark.apply': 'Mark with a face',
      'mark.change': 'Change the mark',
      'mark.clear': 'Clear the mark',
      'mark.calm': 'Calm',
      'mark.bubbles': 'Chatty',
      'mark.rays': 'Needs you',
      'mark.sleep': 'Resting',
      'mark.fire': 'Working',
      'mark.hearts': 'Finished',
      'mark.tears': 'Went wrong',
    };

    const CSS = `
.wsb-row,.wsw-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.wsb-text,.wsw-text{min-width:0}
.wsb-title,.wsw-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.wsb-desc,.wsw-desc{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.wsb-toggle{display:flex;flex:none;align-items:center;justify-content:center;width:48px;height:44px;padding:0;border:0;background:none;cursor:pointer}
.wsb-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:999px}
.wsb-track{position:relative;display:block;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .15s ease}
.wsb-toggle:hover .wsb-track{background:var(--dsw-alias-border-l1)}
.wsb-toggle[aria-checked="true"] .wsb-track{background:var(--dsw-alias-brand-primary)}
.wsb-toggle:active .wsb-thumb{width:18px}
.wsb-thumb{position:absolute;top:2px;left:2px;box-sizing:border-box;width:16px;height:16px;border-radius:50%;background:#fff;border:0.5px solid var(--dsw-alias-border-l2);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease,width .1s ease}
.wsb-toggle[aria-checked="true"] .wsb-thumb{transform:translateX(16px)}
@media (prefers-reduced-motion:reduce){.wsb-track,.wsb-thumb{transition:none}}
.wsw-side{display:flex;flex:none;flex-direction:column;align-items:flex-end;gap:6px}
.wsw-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wsw-reset{font:inherit;font-size:12px;line-height:18px;padding:5px 12px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.wsw-reset:hover{background:var(--dsw-alias-bg-layer-1)}
.wsw-reset:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wsw-reset[disabled]{opacity:.5;cursor:default}
${COMPOSER} { transition: outline-color .12s ease; outline: 2px solid transparent; outline-offset: -2px; border-radius: 12px; }
${COMPOSER}.${OVER_CLASS} { outline-color: var(--dsw-alias-brand-primary); }
.wsd-ghost {
  position: fixed; top: -1000px; left: -1000px;
  padding: 4px 10px; border-radius: 6px;
  font: 12px/1.5 system-ui, sans-serif;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2);
}
.wsm-mood-cell{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;line-height:0}
.wsm-mood{display:block;overflow:visible}
`;

    /* ------------------------------------------------------------------ *
     * Shared helpers                                                       *
     * ------------------------------------------------------------------ */

    /** Read the stored preference, treating absent or unreadable storage as "on". */
    function readPref() {
      try {
        const raw = localStorage.getItem(PREF_KEY);
        if (raw === null) return { enabled: true };
        const parsed = JSON.parse(raw);
        return { enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : true };
      } catch (_unavailable) {
        return { enabled: true };
      }
    }

    /** One preference record shared by the automatic open and its settings row. */
    function createPrefStore() {
      let record = readPref();
      const listeners = new Set();
      const publish = () => {
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => record,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        setEnabled: (enabled) => {
          if (record.enabled === enabled) return;
          record = { ...record, enabled };
          try {
            localStorage.setItem(PREF_KEY, JSON.stringify(record));
          } catch (_unavailable) {
            /* the switch still governs this page */
          }
          publish();
        },
      };
    }

    /** Read the remembered width, ignoring absent or unreadable storage. */
    function readSaved() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return undefined;
        const width = Number(JSON.parse(raw)?.width);
        return Number.isFinite(width) && width > 0 ? width : undefined;
      } catch (_unavailable) {
        return undefined;
      }
    }

    /** Persist one width, or clear the record; a failed write leaves the session working. */
    function writeSaved(width) {
      try {
        if (width === undefined) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: Math.round(width) }));
      } catch (_unavailable) {
        /* the column still works for this page */
      }
    }

    /** One observable record of the remembered width, shared by the row and the writer. */
    function createWidthRecord() {
      let value = readSaved();
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set: (next) => {
          if (value === next) return;
          value = next;
          writeSaved(next);
          for (const listener of [...listeners]) listener();
        },
        /** The value as last persisted, for comparisons that must not re-save. */
        peek: () => value,
      };
    }

    /** Read the pinned Workspace ids, ignoring absent or unreadable storage. */
    function readPins() {
      try {
        const raw = localStorage.getItem(PIN_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.ids) ? parsed.ids.filter((id) => typeof id === 'string' && id !== '') : [];
      } catch (_unavailable) {
        return [];
      }
    }

    /** Persist the pinned Workspace ids; an empty list clears the record. */
    function writePins(ids) {
      try {
        if (ids.length === 0) localStorage.removeItem(PIN_KEY);
        else localStorage.setItem(PIN_KEY, JSON.stringify({ ids }));
      } catch (_unavailable) {
        /* the pins still order this page */
      }
    }

    /**
     * The pinned Workspaces, most recently pinned first, shared by the row menu
     * and the reorder.
     */
    function createPinStore() {
      let ids = readPins();
      const listeners = new Set();
      const publish = () => {
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => ids,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        /** Pin at the front, or unpin; an absent id and an absent pin are both no-ops. */
        toggle: (id) => {
          const pinned = ids.includes(id);
          ids = pinned ? ids.filter((other) => other !== id) : [id, ...ids];
          writePins(ids);
          publish();
        },
        /** Drop ids the registry no longer reports, so a deleted Workspace leaves no residue. */
        retain: (existing) => {
          const kept = ids.filter((id) => existing.includes(id));
          if (kept.length === ids.length) return;
          ids = kept;
          writePins(ids);
          publish();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 1. Opening the workspace tree                                        *
     * ------------------------------------------------------------------ */

    /** The registered implementation id of the `files` page kind, or undefined when nothing offers it. */
    function filesTypeId(registry) {
      try {
        const type = registry?.get?.(FILES_KIND);
        return type?.kind === FILES_KIND && typeof type.id === 'string' && type.id !== '' ? type.id : undefined;
      } catch (_unavailable) {
        return undefined;
      }
    }

    /** Whether some registered body would actually draw that page. */
    function bodyRegistered(slots, id) {
      try {
        const entries = slots?.entriesOfSlot?.(TAB_BODY_SLOT) ?? [];
        return entries.some((entry) => entry?.options?.key === id);
      } catch (_unavailable) {
        return false;
      }
    }

    /** The automatic-open switch in Settings → General. */
    function AutoshowRow(props) {
      const prefs = props.prefs;
      const t = props.t;
      const enabled = useSyncExternalStore(prefs.subscribe, prefs.getSnapshot, prefs.getSnapshot).enabled;
      return h('div', { className: 'wsb-row' }, [
        h('div', { key: 'text', className: 'wsb-text' }, [
          h('div', { key: 'title', className: 'wsb-title', id: 'wsb-settings-title' }, t('open.title')),
          h('div', { key: 'desc', className: 'wsb-desc', id: 'wsb-settings-desc' }, t('open.description')),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          className: 'wsb-toggle',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-labelledby': 'wsb-settings-title',
          'aria-describedby': 'wsb-settings-desc',
          onClick: () => { prefs.setEnabled(!enabled); },
        }, h('span', { key: 'track', className: 'wsb-track' },
          h('span', { key: 'thumb', className: 'wsb-thumb' }))),
      ]);
    }

    /* ------------------------------------------------------------------ *
     * 2. Remembering the right-column width                                *
     * ------------------------------------------------------------------ */

    /** The first-use width for one viewport, inside the frame's bounds. */
    function defaultWidth(viewport) {
      const ceiling = Math.max(RIGHTBAR_MIN, Math.round(viewport * RIGHTBAR_MAX_RATIO));
      return Math.min(Math.max(Math.round(viewport * DEFAULT_RATIO), DEFAULT_MIN), Math.min(DEFAULT_MAX, ceiling));
    }

    /** Keep one width inside the frame's bounds for the current viewport. */
    function clamp(width, viewport) {
      const ceiling = Math.max(RIGHTBAR_MIN, Math.round(viewport * RIGHTBAR_MAX_RATIO));
      return Math.min(Math.max(Math.round(width), RIGHTBAR_MIN), ceiling);
    }

    /**
     * The layout store instance the frame renders from.
     *
     * ui-layout registers the frame on the `root` slot with a store whose
     * `create()` always returns that one shared instance, so calling it hands
     * back the live layout rather than minting a second. The frame's store is
     * recognised by the shape only it has — panel selection beside per-column
     * geometry, with the right column's setter — rather than by registrant
     * name, which a packaged build may spell differently.
     * @param slots - the live slot registry.
     * @returns the instance, or undefined before the frame is seated.
     */
    function layoutInstance(slots) {
      let entries;
      try {
        entries = slots?.entries?.('root') ?? [];
      } catch (_unavailable) {
        return undefined;
      }
      for (const entry of entries) {
        // The registration options place `store` where they were passed, but the
        // stored entry carries it at the top level (`StoredEntry.store`); the
        // renderer resolves stores from there. Reading the options object finds
        // nothing and leaves the width unapplied, so prefer the resolved field
        // and keep the options copy only as a fallback.
        const store = entry?.store ?? entry?.options?.store;
        if (store === undefined || typeof store.create !== 'function') continue;
        let instance;
        try {
          instance = store.create();
        } catch (_unavailable) {
          continue;
        }
        const snapshot = instance?.getSnapshot?.();
        if (snapshot?.layoutInfo !== undefined && snapshot?.panelInfo !== undefined
          && typeof instance.actions?.setRightbar === 'function') {
          return instance;
        }
      }
      return undefined;
    }

    /**
     * The pin glyph for the Workspace row menu. Drawn locally: a Client plugin
     * must not import a Harness Client package for one icon, and the shared
     * icon set is not a module-table entry.
     * @param props - unused; the menu renderer passes the action's icon face.
     */
    function PinIcon() {
      // Mirrors the shipped `IconPinFillRegular` that a pinned conversation row
      // draws for itself, so the workspace menu and the session rows read as the
      // same gesture. Filled, because that is what the shipped marker is.
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        key: 'pin',
        d: 'M9.7 1.5a.6.6 0 0 1 .85 0l3.95 3.95a.6.6 0 0 1-.42 1.02h-1.3l-2.2 2.2-.3 2.2a.6.6 0 0 1-1.02.42L5.2 6.74a.6.6 0 0 1 .42-1.02l2.2-.3 2.2-2.2V1.92a.6.6 0 0 1 .18-.42Z',
        fill: 'currentColor',
      }), h('path', {
        key: 'needle',
        d: 'M5.6 9.1 2.2 12.5',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }));
    }

    /* ------------------------------------------------------------------ *
     * 5. Session-row mood faces                                            *
     * ------------------------------------------------------------------ */

    // Faces are drawn here rather than imported: a Client plugin must not pull
    // a Harness Client package for artwork, and third-party sticker sets carry
    // licences this bundle cannot redistribute. Five faces cover the states a
    // row actually reports — mid-thought, concentrating, waiting on the
    // reader, just finished, and done for now.
    //
    // Each face is a 16x16 glyph painted with `currentColor` so it inherits the
    // row's own muted label colour, with one accent fill that follows the
    // state's meaning instead of the theme's greys.

    /**
     * The five faces, each a complete `<svg>` child list.
     *
     * `thinking` looks up and away — mid-thought, not mid-task. `working` looks
     * straight ahead behind level lids with a pressed mouth and a green spark:
     * concentrating. The two differ in gaze direction, not just colour, because
     * a running row is what alternates between them. `waiting` is wide-eyed with
     * an open mouth, because that row wants an answer. `done` is a closed-eye
     * smile with a bright accent. An idle conversation draws no face at all.
     */
    // The whale-tail faces, cropped from the reader-supplied sprite sheet.
    // Inlined as data URLs rather than fetched: a Client bundle has no asset
    // route in this build, and a network round trip per row would be worse
    // than the ~17 KB these seven 40px tiles cost together.
    const MOOD_IMAGES = {
      calm: 'data:image/png;base64,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',
      bubbles: 'data:image/png;base64,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',
      rays: 'data:image/png;base64,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',
      sleep: 'data:image/png;base64,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',
      fire: 'data:image/png;base64,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',
      hearts: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAGFUlEQVR42u2YW4xW1RXHf2ufc77zXWYYYOgMqBiiVIQ0fWqljL2YtKYPNo0vNG3aEmurMhRF0BG5TCYKtSIyzFi1BkKx2D709tLYJr0pWEnUpNimQaPlWowyOH4Ow3c7l71XH850KKFQZpgqD7OSk5Odk73O76y913+tfWDSJm3Szmsykc5sx52q1mKe78UU8xLPX6xm1uVIDN6LffKhAaanKqqfXwU5D/FBqw3kpkXw/N+QVBEDGgR4z/WP+X1mIgB1cQ/MaML72iKkqRlzZRv6231oawmZ1QLtLbjUjcv3hACaukWcoH96DUKDAjJnKp7voUI2FvnwAAlBYgsCYkYupzgUQREjCBcBaGt1Tb7cpfaLqxQgvfEudR3LNKnU9EKceL/vE5pzaDXGOQdOwAiigvPBDdaxP+0ZfxbHn+tUr70FiRyuYREsiMKC+Xi9Sy/40+2bR1SXbgVfkNDHVhKoJPi7t2JK4X/1o90/UxpDyOY7Rp+79c+o2fhNGY2gDJaR1KJYxFcQgQgYHh7T13rXzBEJDGIVogTPOqTrK+eEyyaluCml0aFbuUO1EZ8tM+6znep8D3IBYgz4gvfrR8e1cdzCZaoFg7f78THNt2t3KmmK98htclaSmBd+KLa1iASCm3fNuOEAzMtPyljhAFQVl8+iactV/Z9Cfei5N3TbLY9Tt3WsWkpegUgj+t7aMW747tl3adVWUYUUS3OuSPlUlafKPx71We9+WoN6ivEM/vmcbf36I4gqRQo4sVTiYfISsGZWp1YlwhhYu/sh2ubOPCdwNDSsa+etxIig6hhOhmiWJk66Kg6LSxwthQKDB8o6Y+50AQgbDr31ZsyCGedXz65Zy/R73UvwRaEUgG9gOGX1uqdIA0MsCSUNSRHW7t3AjKvbRv2VjwzqhuvvxVmLh0HVUEtqPLl5BRRySAqIEA1V6Nq4gwf2bKb12vazeM4bwchF0BKiSQpzp2Vi65SHf3Q3cmQYjWIOHhuk/+fP0rPoXr7bvkSfGNglP7llu25ctJo8ASk+mx5dDq0FMA7qCfyjjAaCJA6JU/ImRP5Dcd2KbcpDSzClvPh28Ub1frFe7Dc2qQ69i//s6eTIeyEyWINqjLQV0TfL4IHULeoJhAFXX9ZG35rbIPToenAHy2ffqvv/+CqbttyJsQ6ZEqKhgf0DkPdOVxwL+IJfrmFEiKP0dJL13y42H2i6fJsacg771QeUU6cwRwfOiGDsGjzxzK8ARX0B55BamuW+AFYhJ3gGTDXFD5VpFKmaGsYXmBLgsPD3AcBBLQFrUQ9ELdpIWLPrl6gqYb5w5vINlMFaxL5yWOnZDiWD7FqPKebP2AfrZq/Q7i8sJJg/E1QQT8AzKIKoAgouawjwDft/8wof+9J1kDhAUE8RRwYmklUoEUSh9tIb3PfiXpZ8/9t86ls3yLj6wRVXfEcjm9D36Q5y189HdWSzOBAj/xawDMa5rAqhWfciAuqyOXZkePQ99Og70PoR1v1hD6nGbHn73LJ1QXp2z2VLNRfk2XDTQlwjIpg3Bw0MKln0MqSRuwiCopp1NTgFI+AJ9tAJTC3m4P7XeezgP7Hq6Du0nbCUl4vuqO+/fLnWJAJP2XLdJzFXzQRVpH3qSBQz2VARwJ3u/5xDDw9iXz/G6r++is35WJTQQu+Jp2VCW/6ht97XzR09lN0QEntYEfo7PkGwcEGW3Z5BDLhUQRzll18jemeIhw8cohEl5HxL3uToPb7zgt/rjwVw6hXTBKB6sqrdC1YRk7Dn3WPcePJKmN4EOrK0zqE4pgUFOg/8BaOOUj6k/+3t8oEemuqVuq78aCehL/Te8Bnk41ch1qKiJPsOc/fevahVHju4jVwxlA+85S80FSSwgmiOTb/7M+obNE7QSsKDL+yjRYuEkhs33IScSX5wYqcExudozkEtRgGNEwZtheOV4+Na1gk/NCUupdmUUBy8V0VjyxQpYVQv2veEAObwcGohShFjEASrFqNyaQCqU5y6rPSZrJxZLDh3aQDmjY8BtJFAmgJKs1+kWGy6NABTSSgFITI9nx05naMmDRp28u/cpE3a/93+BalbzWFYD4RvAAAAAElFTkSuQmCC',
      tears: 'data:image/png;base64,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',
    };

    /**
     * The rendered size of one face. The sprites are drawn on a 40px canvas;
     * showing them at 20px reads clearly without crowding the timestamp.
     */
    const MOOD_SIZE = 20;

    /**
     * Render one face as an image tile.
     *
     * `image-rendering: pixelated` keeps the upscaled sprite's hard edges; the
     * sheet was drawn as pixel art, so smoothing it would undo the artwork.
     * @param mood - which face to draw.
     */
    function MoodFace(props) {
      const src = MOOD_IMAGES[props.mood];
      if (src === undefined) return null;
      return h('img', {
        src,
        width: MOOD_SIZE,
        height: MOOD_SIZE,
        alt: '',
        'aria-hidden': 'true',
        draggable: 'false',
        className: `wsm-mood wsm-mood-${props.mood}`,
        style: { imageRendering: 'pixelated' },
      });
    }

    /**
     * Which face one conversation status calls for, or undefined to draw none.
     *
     * Only a conversation that is actually doing something — or has finished
     * and not been looked at yet — gets a face. An idle row draws nothing: a
     * column of identical resting faces added noise without saying anything,
     * and the reader already has the title and timestamp to go on.
     * @param status - the conversation's UI status, absent before it is known.
     * @returns a face key, or undefined when the row should stay bare.
     */
    function moodOf(status) {
      // Waiting on the reader is loud: sparks overhead.
      if (status?.pendingInteraction !== undefined) return 'rays';
      // A running conversation works with its flukes aflame.
      if (status?.running === true) return 'fire';
      // Finished and not yet looked at: the pleased heart variant.
      if (status?.completionUnread === true) return 'hearts';
      // Idle, archived-but-clean, and not-yet-known all render nothing; the
      // reader can still pin a face with a mark if they want one there.
      return undefined;
    }

    /**
     * The mood badge one conversation row shows.
     *
     * The shipped row reserves its 16px leading cell for the state dot, and that
     * cell admits a registered occupant only while the row is idle — a running
     * row always gets the shipped dot instead. So the face rides the trailing
     * strip, which every non-blank row draws and which hides itself while the
     * row is hovered.
     *
     * @param props.sessionId - the row's conversation, used to read its status.
     * @param props.useSessionStatus - the root status hook, supplied by the slot.
     * @param props.moods - the preference record, from this plugin's inject face.
     * @param props.t - the bound translate function.
     */
    function MoodBadge(props) {
      const { sessionId, useSessionStatus, moods, marks, t } = props;
      const enabled = useSyncExternalStore(moods.subscribe, moods.getSnapshot, moods.getSnapshot).enabled;
      // A hand-set mark is a bookmark: while one is set it owns the slot, and
      // clearing it hands the row back to whatever it is doing.
      const marked = useSyncExternalStore(marks.subscribe, marks.getSnapshot, marks.getSnapshot).get(sessionId);
      // The status source is a Map keyed by conversation; a selector keeps one
      // row from re-rendering when a different conversation changes.
      const status = useSessionStatus((statuses) => statuses.get(sessionId));
      const mood = marked ?? moodOf(status);
      // Only a working row cycles: it is the one state that lasts, and a face
      // that never changed would read as a frozen icon.
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        if (!enabled || marked !== undefined || mood !== 'working') return undefined;
        const timer = setInterval(() => { setTick((value) => (value + 1) % 2); }, MOOD_FRAME_MS);
        return () => { clearInterval(timer); };
      }, [enabled, marked, mood]);
      // Turning the feature off removes the mark, so the shipped dot returns;
      // an idle conversation draws nothing at all.
      if (!enabled || mood === undefined) return null;
      const shown = mood === 'working' ? (tick === 0 ? 'working' : 'thinking') : mood;
      return h('span', {
        className: 'wsm-mood-cell',
        'data-wsm-mood': shown,
        title: t(`mood.${shown}.label`),
        'aria-hidden': 'true',
      }, h(MoodFace, { mood: shown }));
    }

    /** The mood-face switch in Settings → General. */
    function MoodRow(props) {
      const moods = props.moods;
      const t = props.t;
      const enabled = useSyncExternalStore(moods.subscribe, moods.getSnapshot, moods.getSnapshot).enabled;
      return h('div', { className: 'wsb-row' }, [
        h('div', { key: 'text', className: 'wsb-text' }, [
          h('div', { key: 'title', className: 'wsb-title', id: 'wsm-settings-title' }, t('mood.title')),
          h('div', { key: 'desc', className: 'wsb-desc', id: 'wsm-settings-desc' }, t('mood.description')),
        ]),
        h('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          className: 'wsb-toggle',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-labelledby': 'wsm-settings-title',
          'aria-describedby': 'wsm-settings-desc',
          onClick: () => { moods.setEnabled(!enabled); },
        }, h('span', { key: 'track', className: 'wsb-track' },
          h('span', { key: 'thumb', className: 'wsb-thumb' }))),
      ]);
    }

    /** Read the mood-face preference, treating absent or unreadable storage as "on". */
    function readMood() {
      try {
        const raw = localStorage.getItem(MOOD_KEY);
        if (raw === null) return { enabled: true };
        const parsed = JSON.parse(raw);
        return { enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : true };
      } catch (_unavailable) {
        return { enabled: true };
      }
    }

    /** One preference record shared by the mood faces and their settings row. */
    function createMoodStore() {
      let record = readMood();
      const listeners = new Set();
      const publish = () => {
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => record,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        setEnabled: (enabled) => {
          if (record.enabled === enabled) return;
          record = { ...record, enabled };
          try {
            localStorage.setItem(MOOD_KEY, JSON.stringify(record));
          } catch (_unavailable) {
            /* the switch still governs this page */
          }
          publish();
        },
      };
    }

    /** Read the stored conversation marks, ignoring absent or unreadable storage. */
    function readMarks() {
      try {
        const raw = localStorage.getItem(MARK_KEY);
        if (raw === null) return new Map();
        const parsed = JSON.parse(raw);
        const map = new Map();
        for (const [id, mood] of Object.entries(parsed ?? {})) {
          if (typeof id === 'string' && id !== '' && MOOD_MARK_KEYS.includes(mood)) map.set(id, mood);
        }
        return map;
      } catch (_unavailable) {
        return new Map();
      }
    }

    /**
     * One observable record of the hand-set conversation marks.
     *
     * A mark is a bookmark, not a status: it outranks the live face while set,
     * and clearing it hands the row back to its live state.
     */
    function createMarkStore() {
      let value = readMarks();
      const listeners = new Set();
      const publish = () => {
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        /** Set or clear one conversation's mark; an unknown face clears it. */
        set: (sessionId, mood) => {
          const next = new Map(value);
          if (mood === undefined || !MOOD_MARK_KEYS.includes(mood)) next.delete(sessionId);
          else next.set(sessionId, mood);
          value = next;
          try {
            // An empty record is removed rather than left as `{}`: "no marks"
            // and "an object with no keys" should not both exist on disk.
            if (next.size === 0) localStorage.removeItem(MARK_KEY);
            else localStorage.setItem(MARK_KEY, JSON.stringify(Object.fromEntries(next)));
          } catch (_unavailable) {
            /* the mark still shows on this page */
          }
          publish();
        },
        /** Drop marks for conversations the catalog no longer lists. */
        retain: (existing) => {
          const kept = new Map([...value].filter(([id]) => existing.has(id)));
          if (kept.size === value.size) return;
          value = kept;
          try {
            if (kept.size === 0) localStorage.removeItem(MARK_KEY);
            else localStorage.setItem(MARK_KEY, JSON.stringify(Object.fromEntries(kept)));
          } catch (_unavailable) {
            /* a stale mark is dropped from this page anyway */
          }
          publish();
        },
      };
    }

    /** The menu glyph for "mark this conversation": a small flag. */
    function MarkIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        key: 'pole',
        d: 'M3.6 2.2v11.6',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }), h('path', {
        key: 'flag',
        d: 'M3.6 2.6h7.2l-1.6 2.4l1.6 2.4H3.6Z',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', fill: 'none',
      }));
    }

    /** The menu glyph for "clear the mark": the same flag, struck through. */
    function MarkClearIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        key: 'pole',
        d: 'M4.2 2.2v11.6',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.6,
      }), h('path', {
        key: 'flag',
        d: 'M4.2 2.6h6.6l-1.5 2.2l1.5 2.2H4.2Z',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', fill: 'none', opacity: 0.6,
      }), h('path', {
        key: 'slash',
        d: 'M2.6 13.4 13.4 2.6',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }));
    }

    /**
     * One menu entry's face glyph, drawn at menu-icon size in the face colour.
     * @param props.mood - which face to draw.
     */
    function MarkIconFor(props) {
      return h(MoodFace, { mood: props.mood });
    }

    /** The width row in Settings → General: the remembered width, and a way back to the default. */
    function WidthRow(props) {
      const widths = props.widths;
      const t = props.t;
      const saved = useSyncExternalStore(widths.subscribe, widths.getSnapshot, widths.getSnapshot);
      return h('div', { className: 'wsw-row' }, [
        h('div', { key: 'text', className: 'wsw-text' }, [
          h('div', { key: 'title', className: 'wsw-title', id: 'wsw-settings-title' }, t('width.title')),
          h('div', { key: 'desc', className: 'wsw-desc', id: 'wsw-settings-desc' }, t('width.description')),
        ]),
        h('div', { key: 'side', className: 'wsw-side' }, [
          h('div', { key: 'value', className: 'wsw-value' },
            saved === undefined ? t('width.unset') : t('width.remembered', { width: saved })),
          h('button', {
            key: 'reset',
            type: 'button',
            className: 'wsw-reset',
            disabled: saved === undefined,
            'aria-describedby': 'wsw-settings-desc',
            onClick: () => { widths.set(undefined); },
          }, t('width.reset')),
        ]),
      ]);
    }

    /* ------------------------------------------------------------------ *
     * 3. Dragging a tree row into the composer                             *
     * ------------------------------------------------------------------ */

    /** Whether a string looks like the absolute path both trees label rows with. */
    function looksAbsolute(value) {
      return typeof value === 'string' && value !== '' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'));
    }

    /** The path and kind a tree row stands for, or undefined when it is not a row. */
    function rowOf(target) {
      if (!(target instanceof Element)) return undefined;
      const seat = target.closest(SIDEBAR);
      if (seat === null) return undefined;
      // The official files page tags its rows; read the tag first because it
      // states the kind outright.
      const tagged = target.closest('[data-files-path]');
      if (tagged !== null) {
        const path = tagged.getAttribute('data-files-path');
        if (looksAbsolute(path)) {
          return { element: tagged, path, isDir: tagged.getAttribute('data-files-entry') === 'directory' };
        }
      }
      // Any other tree labels each row with its absolute path in `title`; the
      // row itself is the `role="button"` element (a wrapper with the same
      // title must not be mistaken for it). A broken symlink's title carries
      // an explanatory suffix after an em dash.
      const titled = target.closest('[role="button"][title]');
      if (titled !== null) {
        const raw = titled.getAttribute('title') ?? '';
        const path = raw.split(' \u2014 ')[0];
        if (looksAbsolute(path)) {
          const expandedToggle = titled.hasAttribute('aria-expanded')
            || titled.querySelector('[aria-expanded]') !== null;
          return { element: titled, path, isDir: expandedToggle };
        }
      }
      return undefined;
    }

    /** `path` relative to `root`, with `/` separators and a trailing `/` for a directory. */
    function relativeTo(root, path, isDir) {
      let rel = path;
      if (typeof root === 'string' && root !== '') {
        const normal = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
        const base = normal(root);
        const full = normal(path);
        const same = full.toLowerCase().startsWith(base.toLowerCase() + '/');
        if (same) rel = full.slice(base.length + 1);
      }
      rel = rel.replace(/\\/g, '/');
      return isDir && !rel.endsWith('/') ? `${rel}/` : rel;
    }

    /** The `@` mention spelling the composer's own picker would produce for this path. */
    function mentionOf(rel) {
      // A directory mention stays open-quoted, matching the reference grammar.
      if (/\s/.test(rel)) return rel.endsWith('/') ? `@"${rel}` : `@"${rel}"`;
      return `@${rel}`;
    }

    /**
     * Append one reference chip to the session's composer draft.
     *
     * The composer's draft has two coordinate systems: the clipboard projection
     * (`input.state.draft`) expands every chip to its clipboard text, while a
     * span speaks the detect projection, where each chip is one character. A
     * chip appended at the end therefore needs its offset folded, or a draft
     * that already carries chips rejects the span.
     * @returns whether the chip (or, failing that, its text) landed.
     */
    function insertReference(ctx, sessionId, reference) {
      const service = (name) => {
        try {
          return ctx.get(name);
        } catch (_unavailable) {
          return undefined;
        }
      };
      const scopeOf = () => {
        try {
          return service('sessions')?.scope?.(sessionId);
        } catch (_unavailable) {
          return undefined;
        }
      };
      const inputOf = () => {
        const actx = scopeOf();
        if (actx === undefined) return undefined;
        try {
          const conversation = service('conversation') ?? actx.get?.('conversation');
          return conversation?.input?.for(actx);
        } catch (_unavailable) {
          return undefined;
        }
      };
      const folded = (snapshot) => {
        const draft = snapshot.draft ?? '';
        const occurrences = snapshot.occurrences ?? [];
        const token = snapshot.phase === 'claimed' && snapshot.claim !== undefined && draft.startsWith(snapshot.claim.token)
          ? snapshot.claim.token
          : '';
        const fold = (text, list, offset) => {
          const target = Math.max(0, Math.min(offset, text.length));
          let shrink = 0;
          for (const occurrence of list) {
            const end = occurrence.offset + occurrence.length;
            if (target >= end) { shrink += occurrence.length - 1; continue; }
            if (target > occurrence.offset) return occurrence.offset - shrink + 1;
            break;
          }
          return target - shrink;
        };
        if (token === '') return fold(draft, occurrences, draft.length);
        const rest = draft.slice(token.length);
        const inside = occurrences
          .filter((occurrence) => occurrence.offset >= token.length)
          .map((occurrence) => ({ offset: occurrence.offset - token.length, length: occurrence.length }));
        return 1 + fold(rest, inside, rest.length);
      };

      const input = inputOf();
      if (input === undefined || typeof input.insertReference !== 'function') return false;
      const snapshot = input.state.getSnapshot();
      if (snapshot.draftRev === undefined) return false;
      if (snapshot.phase === 'adjudicating' || snapshot.phase === 'submitting' || snapshot.phase === 'sending') return false;
      const at = folded(snapshot);
      // The host adds a space AFTER a chip but never before one, so a chip
      // appended to existing text would read `hello[chip]`. Reserve the
      // separator through the same span channel first.
      let revision = snapshot.draftRev;
      let start = at;
      const draft = snapshot.draft ?? '';
      const needsLead = draft.trim() !== '' && !/\s$/.test(draft);
      if (needsLead) {
        const actx = scopeOf();
        if (actx !== undefined && typeof actx.emit === 'function') {
          try {
            actx.emit('slash/input-insert-text', { text: ' ', span: { draftRev: revision, start: at, end: at } });
          } catch (_refused) {
            /* fall through: the chip insert reports its own failure */
          }
          const after = input.state.getSnapshot();
          if (after.draftRev !== revision) {
            revision = after.draftRev ?? revision;
            start = at + 1;
          }
        }
      }
      try {
        return input.insertReference({
          source: 'reference',
          ref: reference.ref,
          label: reference.label,
          appearance: reference.appearance,
          clipboardText: reference.clipboardText,
        }, { draftRev: revision, start, end: start }) === true;
      } catch (error) {
        console.error(error);
        return false;
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const prefs = createPrefStore();
        const widths = createWidthRecord();
        // One pin record shared by the Workspace row menu and the reorder that
        // honours it.
        const pins = createPinStore();
        const moods = createMoodStore();
        // Hand-set conversation marks, shared by the row menu and the badge.
        const marks = createMarkStore();

        // One stylesheet for the module's lifetime, covering all three
        // capabilities, not one per row render.
        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head) return;
          const node = document.createElement('style');
          node.setAttribute('data-plugin-css', 'workspace-sidebar');
          node.textContent = CSS;
          document.head.appendChild(node);
          return () => { node.remove(); };
        }, 'workspace-sidebar: stylesheet');

        // Dictionaries arrive with the locale service; a profile without one
        // keeps the keys as labels instead of failing to activate.
        let t = (key) => key;
        ctx.inject(['locale'], (child) => {
          const locale = child.get('locale');
          if (locale?.register === undefined || locale?.bind === undefined) return;
          child.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'workspace-sidebar: dictionaries');
          t = locale.bind(NS);
        });

        // Both rows live in General settings. They need only the two records, so
        // they exist even while the frame or the right Sidebar is not mounted.
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'workspace-sidebar',
          order: 18,
          locale: NS,
          inject: () => ({ prefs, t }),
        }, AutoshowRow));

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'workspace-sidebar-width',
          order: 19,
          locale: NS,
          inject: () => ({ widths, t }),
        }, WidthRow));

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'workspace-sidebar-mood',
          order: 21,
          locale: NS,
          inject: () => ({ moods, t }),
        }, MoodRow));

        /* ---------------------------------------------------------------- *
         * 5. Session-row mood faces                                          *
         * ---------------------------------------------------------------- */

        // The faces ride the trailing strip: the leading cell admits an occupant
        // only on an idle row, and the whole point is to cover the busy states
        // the shipped dot already draws.
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'workspace-sidebar-mood',
          order: 10,
          locale: NS,
          inject: () => ({ moods, marks, t }),
        }, MoodBadge));

        /* ---------------------------------------------------------------- *
         * 1. The automatic open                                              *
         * ---------------------------------------------------------------- */

        // The automatic behavior waits for the right Sidebar, its tab registry,
        // and the Session catalog; each may arrive after this module activates.
        ctx.inject(['sidebarRight', 'sidebarRightTabs', 'sessions', 'slots'], (child) => {
          const right = child.get('sidebarRight');
          const registry = child.get('sidebarRightTabs');
          const sessions = child.get('sessions');
          const slotRegistry = child.get('slots');

          /** Conversations this page load already handled, opened or deliberately left alone. */
          const handled = new Set();
          const subscriptions = [];
          let disposed = false;
          let retryTimer = null;
          let retryDeadline = 0;
          let attemptSession;

          const own = (source, listener) => {
            if (typeof source?.subscribe !== 'function') return;
            const unsubscribe = source.subscribe(listener);
            subscriptions.push(typeof unsubscribe === 'function' ? unsubscribe : () => {});
          };

          /**
           * Ask for one more attempt inside a window that starts at the first
           * attempt for a conversation and never slides forward, so a Seat that is
           * never adopted ends the loop instead of spinning.
           */
          const armRetry = () => {
            if (disposed || retryTimer !== null) return;
            if (retryDeadline === 0) retryDeadline = Date.now() + RETRY_WINDOW_MS;
            if (Date.now() > retryDeadline) return;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              evaluate();
            }, RETRY_MS);
          };

          /** The `files` page this conversation already holds, if any. */
          const heldTree = (sessionId) => (right.openTabs?.getSnapshot?.() ?? [])
            .find((row) => row.sessionId === sessionId && row.kind === FILES_KIND);

          /** Bring up the on-screen conversation's workspace tree, once per conversation. */
          const evaluate = () => {
            if (disposed || !prefs.getSnapshot().enabled) return;
            const sessionId = right?.mounted?.getSnapshot?.();
            if (typeof sessionId !== 'string' || sessionId === '') return;
            if (sessionId !== attemptSession) {
              attemptSession = sessionId;
              retryDeadline = 0;
            }
            if (handled.has(sessionId)) return;
            const typeId = filesTypeId(registry);
            if (typeId === undefined || !bodyRegistered(slotRegistry, typeId)) return;
            // A conversation with no workspace directory has no tree to show. A New
            // Session gains one after its first message, and the catalog
            // subscription brings the attempt back for it then.
            const cwd = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
            if (typeof cwd !== 'string' || cwd === '') return;
            // A narrow frame presents this column full screen: opening it unasked
            // would take the whole conversation away. Widening the window comes
            // back through the resize listener below.
            if (typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT) return;

            // Claim the conversation before opening: `openTab` notifies the tab
            // inventory synchronously, and a re-entrant pass must not read that new
            // tab as the reader's own tree.
            handled.add(sessionId);
            try {
              const tree = heldTree(sessionId);
              const expanded = right.isExpanded();
              if (tree !== undefined) {
                // The conversation already owns a tree: only a collapsed column is
                // brought back. An open column keeps whatever page it shows.
                if (!expanded) right.toggleExpanded();
                return;
              }
              if (expanded) {
                // The reader has already made this column theirs for this
                // conversation — another page fills it. Opening the tree would
                // replace what they are reading, so leave the column alone.
                return;
              }
              right.openTab(FILES_KIND);
              // A session whose right-Sidebar store is not adopted yet answers with a
              // silent no-op, so prove the open landed before treating it as done.
              // An expanding column is proof enough; the tab inventory may follow a
              // commit later, and waiting for it would retry a success.
              if (heldTree(sessionId) === undefined && !right.isExpanded()) {
                handled.delete(sessionId);
                armRetry();
              }
            } catch (error) {
              handled.delete(sessionId);
              armRetry();
              console.error(error);
            }
          };

          own(right?.mounted, () => evaluate());
          own(right?.openTabs, () => evaluate());
          own(sessions?.list, () => evaluate());
          // Turning the switch on takes effect now: the reader asked for the tree,
          // so earlier "already handled" conversations are reconsidered.
          own(prefs, () => {
            if (prefs.getSnapshot().enabled) handled.clear();
            evaluate();
          });
          own(registry, () => evaluate());
          own(slotRegistry === undefined ? undefined : {
            subscribe: (listener) => slotRegistry.subscribe(TAB_BODY_SLOT, listener),
          }, () => evaluate());

          // A narrow window defers the open; widening it is the only event that can
          // turn that deferral into an open.
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            const onResize = () => { evaluate(); };
            window.addEventListener('resize', onResize);
            subscriptions.push(() => { window.removeEventListener('resize', onResize); });
          }

          evaluate();

          return () => {
            disposed = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            retryTimer = null;
            retryDeadline = 0;
            for (const unsubscribe of subscriptions.reverse()) {
              try {
                unsubscribe();
              } catch (_unavailable) {
                /* a released source needs no cleanup */
              }
            }
            subscriptions.length = 0;
            handled.clear();
          };
        });

        /* ---------------------------------------------------------------- *
         * 2. The remembered width                                            *
         * ---------------------------------------------------------------- */

        /** The width this module last applied or observed, so its own write is not re-saved. */
        let written;
        let saveTimer;
        let unsubscribe;
        let adoptTimer;

        const remember = (width) => {
          if (width === written) return;
          written = width;
          if (saveTimer !== undefined) clearTimeout(saveTimer);
          // A drag writes continuously; remember only where it comes to rest.
          saveTimer = setTimeout(() => {
            saveTimer = undefined;
            widths.set(width);
          }, SAVE_DEBOUNCE_MS);
        };

        const release = () => {
          if (adoptTimer !== undefined) { clearTimeout(adoptTimer); adoptTimer = undefined; }
          if (saveTimer !== undefined) {
            clearTimeout(saveTimer);
            saveTimer = undefined;
            // A drag interrupted by teardown still leaves the reader where they
            // last put the column.
            if (typeof written === 'number') widths.set(written);
          }
          unsubscribe?.();
          unsubscribe = undefined;
        };

        /**
         * Take over the live layout store: apply the remembered width once, then
         * follow every width the reader settles on.
         */
        const adopt = (instance) => {
          const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth;
          const saved = widths.peek();
          const target = saved === undefined ? defaultWidth(viewport) : clamp(saved, viewport);
          try {
            instance.actions.setRightbar(target);
          } catch (error) {
            console.error(error);
          }
          // Read back what the store took, so the frame's own clamping is not
          // mistaken for a width the reader chose.
          const applied = instance.getSnapshot()?.layoutInfo?.rightbar;
          written = typeof applied === 'number' && applied > 0 ? applied : target;
          unsubscribe = instance.subscribe?.(() => {
            const width = instance.getSnapshot()?.layoutInfo?.rightbar;
            if (typeof width !== 'number' || width <= 0) return;
            remember(width);
          });
        };

        let attempts = 0;
        const look = () => {
          adoptTimer = undefined;
          const instance = layoutInstance(ctx.slots);
          if (instance === undefined) {
            if (++attempts < ADOPT_ATTEMPTS) adoptTimer = setTimeout(look, ADOPT_RETRY_MS);
            return;
          }
          adopt(instance);
        };

        // The frame is seated on `root`. Re-running on each declaration (a
        // rebuild of ui-layout, an HMR reload) re-applies the width to the new
        // store instead of following a dead one; the injection only observes.
        ctx.slots.inject('root', () => {
          release();
          attempts = 0;
          look();
          return () => { release(); };
        });

        ctx.effect(() => () => { release(); }, 'workspace-sidebar: width memory');

        /* ---------------------------------------------------------------- *
         * 3. Dragging a tree row into the composer                           *
         * ---------------------------------------------------------------- */

        ctx.effect(() => {
          if (typeof document === 'undefined') return;

          /** The row whose `draggable` this module turned on, restored on dragend. */
          let armed;
          /** The source row of the drag in flight. */
          let origin;
          /** The composer currently showing the drop highlight. */
          let highlighted;
          /** Session the drag started in, so a drop lands in that conversation. */
          let dragSession;
          /** True between `dragstart` and `dragend`; a pointerup then is not a plain click. */
          let dragging = false;

          const arm = (row) => {
            if (armed === row) return;
            disarm();
            if (row === undefined) return;
            row.setAttribute('draggable', 'true');
            row.setAttribute(ARMED_ATTR, '');
            armed = row;
          };

          const disarm = () => {
            if (armed === undefined) return;
            if (armed.getAttribute(ARMED_ATTR) !== null) {
              armed.removeAttribute('draggable');
              armed.removeAttribute(ARMED_ATTR);
            }
            armed = undefined;
          };

          const clearHighlight = () => {
            if (highlighted !== undefined) {
              highlighted.classList.remove(OVER_CLASS);
              highlighted = undefined;
            }
          };

          const onPointerDown = (event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
            const row = rowOf(event.target);
            if (row === undefined) return;
            // Trail: `pointerup` disarms, so a plain click leaves no draggable
            // residue on a row the reader is only selecting.
            arm(row.element);
            origin = row;
            const seat = row.element.closest(SIDEBAR);
            dragSession = seat?.getAttribute('data-sidebar-right-session') ?? undefined;
          };

          const onPointerUp = () => {
            // While a drag runs the row must stay draggable until dragend; a
            // pointerup here is the plain click that ends a selection.
            if (dragging) return;
            disarm();
          };

          const onDragStart = (event) => {
            const row = origin ?? (event.target instanceof Element ? rowOf(event.target) : undefined);
            const transfer = event.dataTransfer;
            if (row === undefined || transfer === null) return;
            dragging = true;
            // Setting our own payload replaces whatever the row would have
            // carried, so the composer's file intake (which claims only
            // `Files` and its own token) leaves this drop alone.
            const cwd = dragSession === undefined ? undefined : ctx.get?.('sessions')?.list?.getSnapshot?.()?.byId?.[dragSession]?.cwd;
            const rel = relativeTo(cwd, row.path, row.isDir);
            const payload = { path: row.path, relative: rel, isDir: row.isDir };
            try {
              transfer.setData(DRAG_TYPE, JSON.stringify(payload));
              transfer.setData('text/plain', mentionOf(rel));
              transfer.effectAllowed = 'copy';
            } catch (_restricted) {
              return;
            }
            if (typeof transfer.setDragImage === 'function') {
              const ghost = document.createElement('div');
              ghost.className = 'wsd-ghost';
              ghost.textContent = mentionOf(rel);
              document.body.appendChild(ghost);
              try {
                transfer.setDragImage(ghost, 8, 8);
              } catch (_unsupported) {
                /* the browser keeps its own drag image */
              }
              // The drag image is read synchronously; the node can go next frame.
              const later = typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (callback) => setTimeout(callback, 0);
              later(() => { ghost.remove(); });
            }
          };

          const payloadOf = (transfer) => {
            if (transfer === null) return undefined;
            let raw;
            try {
              raw = transfer.getData(DRAG_TYPE);
            } catch (_restricted) {
              return undefined;
            }
            if (typeof raw !== 'string' || raw === '') return undefined;
            try {
              const value = JSON.parse(raw);
              return typeof value?.path === 'string' && value.path !== '' ? value : undefined;
            } catch (_invalid) {
              return undefined;
            }
          };

          const composerUnder = (target) => (target instanceof Element ? target.closest(COMPOSER) : null);

          const onDragOver = (event) => {
            const composer = composerUnder(event.target);
            if (composer === null) return;
            // Reading the payload during `dragover` is not allowed in every
            // browser (only the type list is), so the guard is the type list.
            const types = event.dataTransfer?.types;
            if (types === undefined || !Array.from(types).includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            try {
              event.dataTransfer.dropEffect = 'copy';
            } catch (_readonly) {
              /* the browser keeps its own cursor */
            }
            if (highlighted !== composer) {
              clearHighlight();
              composer.classList.add(OVER_CLASS);
              highlighted = composer;
            }
          };

          const onDragLeave = (event) => {
            const composer = composerUnder(event.target);
            if (composer === null || composer !== highlighted) return;
            // Leaving into a child of the same card is not leaving the card.
            const next = event.relatedTarget;
            if (next instanceof Node && composer.contains(next)) return;
            clearHighlight();
          };

          const onDrop = (event) => {
            const composer = composerUnder(event.target);
            if (composer === null) return;
            const payload = payloadOf(event.dataTransfer);
            clearHighlight();
            disarm();
            dragging = false;
            if (payload === undefined) return;
            // The drop belongs to this module now: refuse the composer's own
            // upload intake and the browser's default navigation.
            event.preventDefault();
            event.stopPropagation();
            const sessionId = dragSession ?? ctx.get?.('uiSession')?.adapter?.current?.getSnapshot?.()?.key;
            if (typeof sessionId !== 'string' || sessionId === '') return;
            insertReference(ctx, sessionId, {
              ref: mentionOf(payload.relative),
              label: payload.relative,
              appearance: payload.isDir ? 'folder' : 'file',
              clipboardText: mentionOf(payload.relative),
            });
          };

          const onDragEnd = () => {
            clearHighlight();
            disarm();
            dragging = false;
            origin = undefined;
            dragSession = undefined;
          };

          // Capture phase: the trees mark rows `role="button"` and their own
          // click handlers must still see the pointerdown afterwards.
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('pointerup', onPointerUp, true);
          document.addEventListener('dragstart', onDragStart, true);
          document.addEventListener('dragover', onDragOver, true);
          document.addEventListener('dragleave', onDragLeave, true);
          document.addEventListener('drop', onDrop, true);
          document.addEventListener('dragend', onDragEnd, true);

          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointerup', onPointerUp, true);
            document.removeEventListener('dragstart', onDragStart, true);
            document.removeEventListener('dragover', onDragOver, true);
            document.removeEventListener('dragleave', onDragLeave, true);
            document.removeEventListener('drop', onDrop, true);
            document.removeEventListener('dragend', onDragEnd, true);
            clearHighlight();
            disarm();
          };
        }, 'workspace-sidebar: drag transfer');

        /* ---------------------------------------------------------------- *
         * 4. Workspace order by conversation recency                         *
         * ---------------------------------------------------------------- */

        // The left sidebar draws one section per Workspace in the Host
        // registry's own order, so a Workspace that just gained a conversation
        // stays wherever the reader last left it. This block moves it back up:
        // pinned Workspaces first in pin order, then the Workspace holding the
        // most recently updated Session, which is also what `insertBefore`
        // records — a real reorder, not a view-local one.
        //
        // The row menu's Pin action lives here too: it writes the same pin
        // record, and the store subscription below turns that write into a
        // reorder without the menu having to know about the order.
        //
        // Registered at apply level, not inside another injection: the icon
        // seat and the menu action are separate registrations.
        const PIN_ICON_KEY = 'workspace-sidebar.pin';
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({ name: 'contextMenu.icon', key: PIN_ICON_KEY }, PinIcon));
        ctx.inject(['contextMenus'], (menuChild) => {
          const contextMenus = menuChild.get('contextMenus');
          if (contextMenus?.register === undefined) return undefined;
          return contextMenus.register({
            id: 'workspace-sidebar.pin',
            target: 'workspace',
            order: 50,
            // An open menu must flip its own label once the reader pins, so the
            // pin record is watched rather than read once at opening.
            observe: () => [pins],
            resolve: ({ workspaceId }) => {
              const pinned = pins.getSnapshot().includes(workspaceId);
              return [{
                id: pinned ? 'unpin' : 'pin',
                label: pinned ? t('pin.unpin') : t('pin.pin'),
                icon: { key: PIN_ICON_KEY },
                run: () => { pins.toggle(workspaceId); },
              }];
            },
          });
        });

        // A conversation can carry a hand-set face as a bookmark: the reader
        // picks one from the row menu and it shows on the row until they pick
        // "clear" or the conversation's live state takes the slot back. The
        // mark is browser-local, like every other preference here.
        // Each menu row shows the face it sets, so the reader picks by look
        // rather than by word. One keyed icon registration per face.
        for (const key of MOOD_MARK_KEYS) {
          const Face = () => MarkIconFor({ mood: key });
          ctx.slots.inject('contextMenu.icon', () =>
            ctx.slots.register({ name: 'contextMenu.icon', key }, Face));
        }
        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register({ name: 'contextMenu.icon', key: MARK_ICON_KEY }, MarkIcon));
        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register({ name: 'contextMenu.icon', key: MARK_CLEAR_ICON_KEY }, MarkClearIcon));
        ctx.inject(['contextMenus'], (menuChild) => {
          const contextMenus = menuChild.get('contextMenus');
          if (contextMenus?.register === undefined) return undefined;
          return contextMenus.register({
            id: 'workspace-sidebar.mark',
            target: 'session',
            order: 400,
            observe: () => [marks],
            resolve: ({ sessionId }) => {
              const marked = marks.getSnapshot().get(sessionId);
              const rows = MOOD_MARK_KEYS.map((key) => ({
                id: `mark:${key}`,
                label: t(`mark.${key}`),
                icon: { key },
                run: () => { marks.set(sessionId, key); },
              }));
              return [
                {
                  id: 'mark',
                  label: marked === undefined ? t('mark.apply') : t('mark.change'),
                  icon: { key: MARK_ICON_KEY },
                  children: rows,
                },
                ...(marked === undefined
                  ? []
                  : [{
                    id: 'mark-clear',
                    label: t('mark.clear'),
                    icon: { key: MARK_CLEAR_ICON_KEY },
                    run: () => { marks.set(sessionId, undefined); },
                  }]),
              ];
            },
          });
        });

        ctx.inject(['workspaces', 'sessions'], (child) => {
          const workspaces = child.get('workspaces');
          const sessions = child.get('sessions');
          if (workspaces?.list?.getSnapshot === undefined || sessions?.list?.getSnapshot === undefined) return undefined;
          if (typeof workspaces.insertBefore !== 'function') return undefined;

          let disposed = false;
          let busy = false;
          let timer = null;
          /** The plan that already failed for this exact order, so a refusal is not retried forever. */
          let attempted = '';
          const subscriptions = [];

          const own = (source, listener) => {
            if (typeof source?.subscribe !== 'function') return;
            const unsubscribe = source.subscribe(listener);
            subscriptions.push(typeof unsubscribe === 'function' ? unsubscribe : () => {});
          };

          /** The newest Session timestamp a Workspace knowingly holds. */
          const recencyOf = (workspace, summaries) => {
            let newest = -Infinity;
            for (const id of workspace.sessionIds ?? []) {
              const at = summaries?.[id]?.updatedAt;
              if (typeof at === 'number' && at > newest) newest = at;
            }
            return newest;
          };

          /**
           * The wanted order: the pinned Workspaces first in pin order, then
           * every other Workspace by the recency of its newest Session.
           * Workspaces without a known Session (never used, still loading) rank
           * last and keep their relative order, as do ties.
           */
          const wantedOrder = (items, summaries, pins) => items
            .map((workspace, index) => ({
              id: workspace.workspaceId,
              pin: pins.indexOf(workspace.workspaceId),
              at: recencyOf(workspace, summaries),
              index,
            }))
            .sort((left, right) => {
              // A pin outranks every timestamp; among pins, the most recently
              // pinned leads, so pinning twice reads as the newest first.
              const leftPinned = left.pin !== -1;
              const rightPinned = right.pin !== -1;
              if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
              if (leftPinned) return left.pin - right.pin;
              return (right.at - left.at) || (left.index - right.index);
            })
            .map((row) => row.id);

          /**
           * The `insertBefore` calls that turn `current` into `target`, each
           * anchored at the row it must precede. One move is enough when only
           * the leading Workspace changed, which is the common case.
           */
          const planMoves = (current, target) => {
            const moves = [];
            const working = [...current];
            for (let index = 0; index < target.length; index += 1) {
              if (working[index] === target[index]) continue;
              const from = working.indexOf(target[index]);
              if (from === -1) continue;
              const anchor = working[index];
              working.splice(from, 1);
              working.splice(working.indexOf(anchor), 0, target[index]);
              moves.push({ id: target[index], before: anchor });
            }
            return moves;
          };

          const reconcile = async () => {
            timer = null;
            if (disposed) return;
            // A write already in flight drives the order toward `target`; the
            // change that woke this pass is answered by that write, but a
            // further snapshot must not be dropped on the floor.
            if (busy) {
              schedule();
              return;
            }
            const snapshot = workspaces.list.getSnapshot();
            const list = sessions.list.getSnapshot();
            if (snapshot?.phase !== 'ready' || list?.phase !== 'ready') return;
            const items = snapshot.items ?? [];
            if (items.length < 2) return;
            const current = items.map((workspace) => workspace.workspaceId);
            // A Workspace the registry no longer reports cannot stay pinned;
            // dropping it here also re-runs the pass, so the order catches up.
            pins.retain(current);
            // A mark for a conversation that no longer exists would linger
            // forever; prune it against the catalog's current membership.
            marks.retain(new Set(Object.keys(list.byId ?? {})));
            const target = wantedOrder(items, list.byId, pins.getSnapshot());
            if (target.every((id, index) => id === current[index])) return;
            const signature = `${current.join(',')}=>${target.join(',')}`;
            // A refused write leaves the order untouched, so the same plan
            // would come back on every later tick; try each plan once.
            if (signature === attempted) return;
            attempted = signature;
            const moves = planMoves(current, target);
            busy = true;
            try {
              for (const move of moves) {
                if (disposed) break;
                await workspaces.insertBefore(move.id, move.before);
              }
            } catch (error) {
              console.error(error);
            } finally {
              busy = false;
            }
          };

          // A conversation still being written to reports a new `updatedAt` on
          // every step, so settle first and reorder once it comes to rest.
          const schedule = () => {
            if (disposed || timer !== null) return;
            timer = setTimeout(() => { void reconcile(); }, REORDER_SETTLE_MS);
          };

          own(workspaces.list, schedule);
          own(sessions.list, schedule);
          // Pinning writes the record, not the order: the reorder owns the
          // write so a pin and a recency change cannot disagree about it.
          own(pins, schedule);
          schedule();

          return () => {
            disposed = true;
            if (timer !== null) clearTimeout(timer);
            timer = null;
            for (const unsubscribe of subscriptions.reverse()) {
              try {
                unsubscribe();
              } catch (_unavailable) {
                /* a released source needs no cleanup */
              }
            }
            subscriptions.length = 0;
          };
        });

      },
    };
  },
});
