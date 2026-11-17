/**
 * Client half of dsh-workspace-sidebar.
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
  id: 'dsh-workspace-sidebar',
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
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        key: 'body',
        d: 'M9.6 1.8 14.2 6.4l-1.7.6-2.5 2.5-.5 2.6-1.3 1.3-3.9-3.9 1.3-1.3 2.6-.5 2.5-2.5.6-1.7Z',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
      }), h('path', {
        key: 'shaft',
        d: 'M5.4 9.1 2 12.5',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
      }));
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
