/**
 * dsh-plugin-team-balancer — Client half.
 *
 * Two surfaces share one editor:
 *   - a first-class sidebar panel (`sidebar.panellist` id + `main` key
 *     `team-balancer`) opened by its own icon in the left rail;
 *   - the bundle's configuration area on the Web Plugins page.
 *
 * The editor offers ready-made balancing styles (1:1, DeepSeek-first,
 * GLM-first, single-provider) plus a free-form weighted provider/model pool,
 * and shows the route each delegated child currently runs on. Reads and writes
 * go through the Host routes /dsh-team-balancer/state, /config and /reset.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-team-balancer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'team-balancer'
    const PACKAGE_NAME = 'dsh-plugin-team-balancer'
    const PANEL_ID = 'team-balancer'
    const POLL_MS = 5000

    const ZH = {
      title: '多 AI 均衡调度',
      panelTitle: '均衡调度',
      subtitle: '团队多 Agent 的队友会按权重轮流分到不同供应商；主 Agent 保持自己的模型。',
      style: '搭配样式',
      styleHint: '先点一个样式快速套用，再按需微调下面的权重；保存后生效。',
      balanced: '均衡轮换',
      balancedRatio: 'DeepSeek 1 : GLM 1',
      deepseekFirst: 'DeepSeek 优先',
      deepseekFirstRatio: 'DeepSeek 2 : GLM 1',
      glmFirst: 'GLM 优先',
      glmFirstRatio: 'GLM 2 : DeepSeek 1',
      deepseekOnly: '仅 DeepSeek',
      glmOnly: '仅 GLM',
      presetMissing: '当前没有可用的 DeepSeek / GLM 路由，无法套用该样式。',
      enabled: '启用均衡调度',
      enabledHint: '关闭后所有子 Agent 恢复继承主 Agent 的模型，保存立即生效。',
      includeSubagents: '也调度普通子代理',
      includeSubagentsHint: '打开后 subagent / subagent_fork 创建的子代理也会参与轮换；默认只调度团队成员。',
      pool: '模型池（自定义）',
      poolHint: '按权重轮流分配：队友按创建顺序取轮转序列中的下一项。deepseek 2 : glm 1 表示每 3 个队友 2 个 DeepSeek、1 个 GLM。',
      provider: '供应商',
      model: '模型',
      weight: '权重',
      weightHint: '1-100 的整数',
      actions: '操作',
      remove: '删除',
      addRoute: '添加路由',
      save: '保存并生效',
      saving: '保存中…',
      reset: '恢复默认',
      refresh: '刷新',
      saved: '已保存，后续请求立即生效。',
      resetDone: '已恢复默认配置。',
      saveFailed: '保存失败：',
      loadFailed: '读取配置失败：',
      emptyPool: '至少保留一条路由。',
      assignments: '当前分配',
      assignmentsHint: '修改权重后：正在运行的队友保持当前模型，空闲/新队友在下次请求时按新权重重新分配。',
      noAssignments: '本次运行还没有子 Agent 被分配。创建一个队友后这里会显示它的真实模型。',
      kind: '类型',
      kindTeammate: '队友',
      kindSubagent: '子代理',
      ordinal: '#',
      unavailable: '当前不可用',
      availability: '路由可用性',
      loading: '读取中…',
      dirty: '有未保存的修改',
    }

    const EN = {
      title: 'Team AI Balancer',
      panelTitle: 'AI Balance',
      subtitle: 'Team teammates rotate across providers by weight; the Lead keeps its own model.',
      style: 'Balancing style',
      styleHint: 'Pick a style to fill the pool, then fine-tune weights below. Save applies it.',
      balanced: 'Even rotation',
      balancedRatio: 'DeepSeek 1 : GLM 1',
      deepseekFirst: 'DeepSeek first',
      deepseekFirstRatio: 'DeepSeek 2 : GLM 1',
      glmFirst: 'GLM first',
      glmFirstRatio: 'GLM 2 : DeepSeek 1',
      deepseekOnly: 'DeepSeek only',
      glmOnly: 'GLM only',
      presetMissing: 'No usable DeepSeek / GLM route right now, so this style cannot be applied.',
      enabled: 'Enable balancing',
      enabledHint: 'When off, delegated agents inherit the Lead model again. Saving applies immediately.',
      includeSubagents: 'Balance ordinary subagents too',
      includeSubagentsHint: 'Also rotate subagent / subagent_fork children. Off by default so Team sessions stay predictable.',
      pool: 'Model pool (custom)',
      poolHint: 'Weighted round robin in teammate creation order. deepseek 2 : glm 1 means 2 of every 3 teammates use DeepSeek, 1 uses GLM.',
      provider: 'Provider',
      model: 'Model',
      weight: 'Weight',
      weightHint: 'Integer 1-100',
      actions: 'Actions',
      remove: 'Remove',
      addRoute: 'Add route',
      save: 'Save and apply',
      saving: 'Saving…',
      reset: 'Restore defaults',
      refresh: 'Refresh',
      saved: 'Saved. Later requests use it immediately.',
      resetDone: 'Restored the default configuration.',
      saveFailed: 'Save failed: ',
      loadFailed: 'Could not read the configuration: ',
      emptyPool: 'Keep at least one route.',
      assignments: 'Current assignments',
      assignmentsHint: 'After a weight change, running teammates keep their model; idle/new children are re-balanced on their next request.',
      noAssignments: 'No delegated agent has been assigned in this run yet. Create a teammate and its real model appears here.',
      kind: 'Kind',
      kindTeammate: 'Teammate',
      kindSubagent: 'Subagent',
      ordinal: '#',
      unavailable: 'Unavailable',
      availability: 'Route availability',
      loading: 'Loading…',
      dirty: 'Unsaved changes',
    }

    const css = [
      '.tbz-panel{height:100%;overflow:auto;padding:22px 26px 40px;color:var(--dsw-alias-label-primary);}',
      '.tbz-panel-inner{max-width:880px;width:100%;display:flex;flex-direction:column;gap:14px;}',
      '.tbz-page{display:flex;flex-direction:column;gap:14px;max-width:880px;color:var(--dsw-alias-label-primary);}',
      '.tbz-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}',
      '.tbz-head h2{margin:0;font-size:18px;font-weight:700;letter-spacing:-.01em;}',
      '.tbz-lead{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:0;}',
      '.tbz-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}',
      '.tbz-card h3{margin:0;font-size:13px;font-weight:650;}',
      '.tbz-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55;margin:0;}',
      '.tbz-row{display:flex;align-items:center;gap:10px;min-width:0;}',
      '.tbz-row label{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;}',
      '.tbz-row input[type=checkbox]{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}',
      '.tbz-grid-head,.tbz-grid-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(150px,1.3fr) 74px 56px;gap:8px;align-items:center;}',
      '.tbz-grid-head{color:var(--dsw-alias-label-secondary);font-size:11px;padding:0 2px;}',
      '.tbz-grid-row{padding:4px 0;}',
      '.tbz-select,.tbz-input{width:100%;min-width:0;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px;height:30px;}',
      '.tbz-select:focus,.tbz-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
      '.tbz-input[type=number]{text-align:center;}',
      '.tbz-remove{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;border-radius:7px;height:30px;cursor:pointer;padding:0 6px;}',
      '.tbz-remove:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}',
      '.tbz-remove:disabled{opacity:.4;cursor:not-allowed;}',
      '.tbz-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.tbz-btn{font:inherit;font-size:12px;height:30px;padding:0 14px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);}',
      '.tbz-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.tbz-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.tbz-btn--primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.tbz-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill);opacity:.92;}',
      '.tbz-btn--ghost{border-color:transparent;color:var(--dsw-alias-label-secondary);}',
      '.tbz-presets{display:flex;gap:8px;flex-wrap:wrap;}',
      '.tbz-preset{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:9px;padding:7px 12px;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:118px;text-align:left;transition:border-color .15s ease,background-color .15s ease;}',
      '.tbz-preset small{color:var(--dsw-alias-label-secondary);font-size:10.5px;}',
      '.tbz-preset:hover{border-color:var(--dsw-alias-label-secondary);}',
      '.tbz-preset--on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-2));}',
      '.tbz-preset--on small{color:var(--dsw-alias-brand-primary);}',
      '.tbz-note{font-size:11.5px;line-height:1.5;padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);display:inline-block;}',
      '.tbz-note--ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l2));}',
      '.tbz-note--error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));}',
      '.tbz-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.tbz-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px 8px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);}',
      '.tbz-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle;}',
      '.tbz-table tr:last-child td{border-bottom:0;}',
      '.tbz-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;}',
      '.tbz-muted{color:var(--dsw-alias-label-secondary);}',
      '.tbz-warn{color:var(--dsw-alias-state-warning-primary);font-size:11px;}',
    ].join('')

    /** POST one JSON body and return the parsed reply. */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const reply = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!response.ok || reply.ok !== true) throw new Error(reply.error ?? `HTTP ${response.status}`)
      return reply
    }

    /** Whether two pools describe the same weighted routes. */
    function samePool(left, right) {
      if (left.length !== right.length) return false
      return left.every((entry, index) => entry.provider === right[index].provider && entry.model === right[index].model && Number(entry.weight) === Number(right[index].weight))
    }

    /** The DeepSeek / GLM anchor routes of the live provider catalog. */
    function anchorRoutes(providers) {
      const deepseek = providers.find((provider) => provider.id === 'deepseek-official') ?? providers.find((provider) => String(provider.id).includes('deepseek'))
      const glm = providers.find((provider) => provider.id === 'zai') ?? providers.find((provider) => String(provider.id).includes('zai'))
      const routeOf = (provider, preferred) => {
        if (provider === undefined || !Array.isArray(provider.models) || provider.models.length === 0) return undefined
        const model = provider.models.find((candidate) => candidate.id === preferred) ?? provider.models[0]
        return { provider: provider.id, model: model.id }
      }
      return {
        deepseek: routeOf(deepseek, 'deepseek-flash'),
        glm: routeOf(glm, 'glm-5.3-flash'),
      }
    }

    function buildPresets(providers) {
      const anchors = anchorRoutes(providers)
      const presets = []
      const push = (id, label, ratio, pool, enabled) => presets.push({ id, label, ratio, pool, enabled })
      if (anchors.deepseek !== undefined && anchors.glm !== undefined) {
        push('balanced', 'balanced', 'balancedRatio', [{ ...anchors.deepseek, weight: 1 }, { ...anchors.glm, weight: 1 }], true)
        push('deepseek-first', 'deepseekFirst', 'deepseekFirstRatio', [{ ...anchors.deepseek, weight: 2 }, { ...anchors.glm, weight: 1 }], true)
        push('glm-first', 'glmFirst', 'glmFirstRatio', [{ ...anchors.deepseek, weight: 1 }, { ...anchors.glm, weight: 2 }], true)
      }
      if (anchors.deepseek !== undefined) push('deepseek-only', 'deepseekOnly', null, [{ ...anchors.deepseek, weight: 1 }], true)
      if (anchors.glm !== undefined) push('glm-only', 'glmOnly', null, [{ ...anchors.glm, weight: 1 }], true)
      return presets
    }

    /** Sidebar icon: a small balance scale drawn in the current text color. */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 20
      const color = props.active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', role: 'img', 'aria-hidden': true },
        h('path', { d: 'M10 2.6v12.2', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 10, cy: 2.6, r: 1.25, fill: color }),
        h('path', { d: 'M3.6 15.9h12.8', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M4.4 15.9l-1 2.2M4.4 15.9l1 2.2M15.6 15.9l-1 2.2M15.6 15.9l1 2.2', stroke: color, strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.85 }),
        h('circle', { cx: 4.4, cy: 15.9, r: 1.7, fill: color }),
        h('circle', { cx: 15.6, cy: 15.9, r: 1.7, fill: color }),
        h('path', { d: 'M4.4 15.9h11.2', stroke: color, strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.55 }),
      )
    }

    /** One label + checkbox row. */
    function ToggleRow(props) {
      return h(
        'div',
        { className: 'tbz-row' },
        h(
          'label',
          null,
          h('input', {
            type: 'checkbox',
            checked: props.checked === true,
            disabled: props.disabled === true,
            onChange: (event) => props.onChange(event.target.checked),
          }),
          h('span', null, props.label),
        ),
      )
    }

    /** The shared balancer editor. */
    function TeamBalancerPage(props) {
      const t = props.t
      const inPanel = props.view === 'panel'
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const dirtyRef = React.useRef(false)
      dirtyRef.current = dirty

      React.useEffect(() => {
        let alive = true
        async function load() {
          try {
            const response = await fetch('/dsh-team-balancer/state', { headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
            if (!alive) return
            if (!response.ok || body.ok !== true) {
              setError(body.error ?? `HTTP ${response.status}`)
              return
            }
            setError(null)
            setState(body)
            if (!dirtyRef.current) {
              setDraft({ enabled: body.enabled === true, includeSubagents: body.includeSubagents === true, pool: body.pool.map((entry) => ({ ...entry })) })
              setDirty(false)
            }
          } catch (cause) {
            if (alive) setError(cause && cause.message ? cause.message : String(cause))
          }
        }
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      if (props.view === 'summary') {
        const summary = state === null ? t('loading') : state.pool.map((entry) => `${entry.provider}/${entry.model}×${entry.weight}`).join(' · ')
        return h('span', { className: 'tbz-lead' }, summary)
      }

      const providers = state && Array.isArray(state.providers) ? state.providers : []
      const presets = buildPresets(providers)

      function edit(nextDraft) {
        setDraft(nextDraft)
        setDirty(true)
        setNotice(null)
      }

      function updateEntry(index, field, value) {
        if (draft === null) return
        const pool = draft.pool.map((entry, position) => (position === index ? { ...entry, [field]: value } : entry))
        edit({ ...draft, pool })
      }

      function changeProvider(index, providerId) {
        if (draft === null) return
        const provider = providers.find((candidate) => candidate.id === providerId)
        const model = provider && provider.models.length > 0 ? provider.models[0].id : ''
        const pool = draft.pool.map((entry, position) => (position === index ? { ...entry, provider: providerId, model } : entry))
        edit({ ...draft, pool })
      }

      function addRoute() {
        if (draft === null || draft.pool.length >= 20) return
        const first = providers[0]
        const provider = first ? first.id : ''
        const model = first && first.models.length > 0 ? first.models[0].id : ''
        edit({ ...draft, pool: [...draft.pool, { provider, model, weight: 1 }] })
      }

      function removeRoute(index) {
        if (draft === null || draft.pool.length <= 1) return
        edit({ ...draft, pool: draft.pool.filter((_, position) => position !== index) })
      }

      function applyPreset(preset) {
        if (draft === null || preset.enabled !== true) {
          setNotice({ kind: 'error', text: t('presetMissing') })
          return
        }
        edit({ ...draft, pool: preset.pool.map((entry) => ({ ...entry })) })
      }

      function adopter(reply) {
        setState(reply)
        setDraft({ enabled: reply.enabled === true, includeSubagents: reply.includeSubagents === true, pool: reply.pool.map((entry) => ({ ...entry })) })
        setDirty(false)
      }

      async function save() {
        if (draft === null || busy) return
        if (draft.pool.length === 0) {
          setNotice({ kind: 'error', text: t('emptyPool') })
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          const reply = await postJson('/dsh-team-balancer/config', {
            enabled: draft.enabled,
            includeSubagents: draft.includeSubagents,
            pool: draft.pool.map((entry) => ({
              provider: String(entry.provider ?? '').trim(),
              model: String(entry.model ?? '').trim(),
              weight: Number(entry.weight) || 1,
              ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
            })),
          })
          adopter(reply)
          setNotice({ kind: 'ok', text: t('saved') })
        } catch (cause) {
          setNotice({ kind: 'error', text: t('saveFailed') + (cause && cause.message ? cause.message : String(cause)) })
        } finally {
          setBusy(false)
        }
      }

      async function reset() {
        if (busy) return
        setBusy(true)
        setNotice(null)
        try {
          adopter(await postJson('/dsh-team-balancer/reset'))
          setNotice({ kind: 'ok', text: t('resetDone') })
        } catch (cause) {
          setNotice({ kind: 'error', text: t('saveFailed') + (cause && cause.message ? cause.message : String(cause)) })
        } finally {
          setBusy(false)
        }
      }

      async function refresh() {
        if (busy) return
        setBusy(true)
        try {
          const response = await fetch('/dsh-team-balancer/state', { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (response.ok && body.ok === true) {
            setState(body)
            if (!dirtyRef.current) adopter(body)
            setError(null)
          } else setError(body.error ?? `HTTP ${response.status}`)
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const children = []
      children.push(h('style', { key: 'style' }, css))
      if (inPanel) {
        children.push(
          h(
            'div',
            { key: 'head', className: 'tbz-head' },
            h('h2', null, t('title')),
            dirty ? h('span', { className: 'tbz-muted', style: { fontSize: '11.5px' } }, '· ' + t('dirty')) : null,
          ),
        )
      }
      children.push(h('p', { key: 'lead', className: 'tbz-lead' }, t('subtitle')))

      if (error !== null) {
        children.push(
          h(
            'div',
            { key: 'error', className: 'tbz-note tbz-note--error', style: { display: 'block' } },
            t('loadFailed') + error,
            h(
              'button',
              { className: 'tbz-btn tbz-btn--ghost', style: { marginLeft: '10px', height: '24px' }, onClick: refresh, disabled: busy },
              t('refresh'),
            ),
          ),
        )
      }

      if (draft !== null) {
        const presetButtons = presets.map((preset) => {
          const active = preset.enabled === true && samePool(draft.pool, preset.pool)
          return h(
            'button',
            {
              key: `preset-${preset.id}`,
              className: 'tbz-preset' + (active ? ' tbz-preset--on' : ''),
              disabled: preset.enabled !== true,
              title: preset.enabled === true ? '' : t('presetMissing'),
              onClick: () => applyPreset(preset),
            },
            h('span', null, t(preset.label)),
            preset.ratio === null ? null : h('small', null, t(preset.ratio)),
          )
        })
        children.push(
          h(
            'div',
            { key: 'style', className: 'tbz-card' },
            h('h3', null, t('style')),
            h('p', { className: 'tbz-hint' }, t('styleHint')),
            h('div', { className: 'tbz-presets' }, ...presetButtons),
          ),
        )

        children.push(
          h(
            'div',
            { key: 'switches', className: 'tbz-card' },
            h(
              'div',
              null,
              h(ToggleRow, { label: t('enabled'), checked: draft.enabled, onChange: (value) => edit({ ...draft, enabled: value }) }),
              h('p', { className: 'tbz-hint', style: { marginTop: '4px' } }, t('enabledHint')),
            ),
            h(
              'div',
              null,
              h(ToggleRow, { label: t('includeSubagents'), checked: draft.includeSubagents, onChange: (value) => edit({ ...draft, includeSubagents: value }) }),
              h('p', { className: 'tbz-hint', style: { marginTop: '4px' } }, t('includeSubagentsHint')),
            ),
          ),
        )

        const poolRows = []
        draft.pool.forEach((entry, index) => {
          const provider = providers.find((candidate) => candidate.id === entry.provider)
          const models = provider && Array.isArray(provider.models) ? provider.models : []
          poolRows.push(
            h(
              'div',
              { key: `row-${index}`, className: 'tbz-grid-row' },
              h(
                'select',
                {
                  className: 'tbz-select',
                  value: entry.provider,
                  onChange: (event) => changeProvider(index, event.target.value),
                  'aria-label': t('provider'),
                },
                providers.map((candidate) => h('option', { key: candidate.id, value: candidate.id }, candidate.name ?? candidate.id)),
                providers.some((candidate) => candidate.id === entry.provider) ? null : h('option', { value: entry.provider }, entry.provider || '—'),
              ),
              models.length > 0
                ? h(
                    'select',
                    {
                      className: 'tbz-select',
                      value: entry.model,
                      onChange: (event) => updateEntry(index, 'model', event.target.value),
                      'aria-label': t('model'),
                    },
                    models.map((model) => h('option', { key: model.id, value: model.id }, model.name ?? model.id)),
                    models.some((model) => model.id === entry.model) ? null : h('option', { value: entry.model }, entry.model || '—'),
                  )
                : h('input', {
                    className: 'tbz-input',
                    value: entry.model,
                    placeholder: t('model'),
                    onChange: (event) => updateEntry(index, 'model', event.target.value),
                    'aria-label': t('model'),
                  }),
              h('input', {
                className: 'tbz-input',
                type: 'number',
                min: 1,
                max: 100,
                step: 1,
                value: entry.weight,
                title: t('weightHint'),
                onChange: (event) => updateEntry(index, 'weight', Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1)))),
                'aria-label': t('weight'),
              }),
              h(
                'button',
                { className: 'tbz-remove', onClick: () => removeRoute(index), disabled: draft.pool.length <= 1, title: t('remove') },
                t('remove'),
              ),
            ),
          )
        })

        children.push(
          h(
            'div',
            { key: 'pool', className: 'tbz-card' },
            h('h3', null, t('pool')),
            h('p', { className: 'tbz-hint' }, t('poolHint')),
            h(
              'div',
              { className: 'tbz-grid-head' },
              h('span', null, t('provider')),
              h('span', null, t('model')),
              h('span', null, t('weight')),
              h('span', null, t('actions')),
            ),
            ...poolRows,
            h('div', { className: 'tbz-actions' }, h('button', { className: 'tbz-btn tbz-btn--ghost', onClick: addRoute, disabled: draft.pool.length >= 20 }, '+ ' + t('addRoute'))),
          ),
        )

        children.push(
          h(
            'div',
            { key: 'actions', className: 'tbz-actions' },
            h('button', { className: 'tbz-btn tbz-btn--primary', onClick: save, disabled: busy || !dirty }, busy ? t('saving') : t('save')),
            h('button', { className: 'tbz-btn', onClick: reset, disabled: busy }, t('reset')),
            h('button', { className: 'tbz-btn tbz-btn--ghost', onClick: refresh, disabled: busy }, t('refresh')),
          ),
        )
        if (notice !== null) children.push(h('div', { key: 'notice', className: `tbz-note tbz-note--${notice.kind}` }, notice.text))
      }

      if (state !== null) {
        const availability = []
        state.routes.forEach((route, index) => {
          if (route.available === true) return
          availability.push(
            h(
              'div',
              { key: `bad-route-${index}`, className: 'tbz-warn' },
              `⚠ ${route.provider}/${route.model} ${t('unavailable')}${route.error ? `：${route.error}` : ''}`,
            ),
          )
        })
        if (availability.length > 0) children.push(h('div', { key: 'availability', className: 'tbz-card' }, h('h3', null, t('availability')), ...availability))

        const rows = state.assignments.map((record) =>
          h(
            'tr',
            { key: record.agentId },
            h('td', null, record.teammateName ?? String(record.agentId).slice(0, 8)),
            h('td', null, record.kind === 'teammate' ? t('kindTeammate') : t('kindSubagent')),
            h('td', { className: 'tbz-mono' }, `${record.provider}/${record.model}`),
            h('td', { className: 'tbz-muted' }, String(record.ordinal ?? '')),
          ),
        )
        children.push(
          h(
            'div',
            { key: 'assignments', className: 'tbz-card' },
            h('h3', null, t('assignments')),
            h('p', { className: 'tbz-hint' }, t('assignmentsHint')),
            rows.length === 0
              ? h('p', { className: 'tbz-hint' }, t('noAssignments'))
              : h(
                  'table',
                  { className: 'tbz-table' },
                  h('thead', null, h('tr', null, h('th', null, t('assignments')), h('th', null, t('kind')), h('th', null, t('model')), h('th', null, t('ordinal')))),
                  h('tbody', null, ...rows),
                ),
          ),
        )
      }

      const body = h('div', { className: inPanel ? 'tbz-panel-inner' : 'tbz-page' }, ...children)
      return inPanel ? h('div', { className: 'tbz-panel' }, body) : body
    }

    /** Register both surfaces while their owner slots exist. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () => {
          const disposeZh = ctx.locale.register(NS, 'zh', ZH)
          const disposeEn = ctx.locale.register(NS, 'en', EN)
          return () => {
            disposeZh()
            disposeEn()
          }
        },
        'team-balancer: locale dictionaries',
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => h(TeamBalancerPage, { t, view: 'panel' })),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => t('panelTitle') },
          (props) => h(PanelIcon, { size: typeof props.size === 'number' ? props.size : 20, active: props.active === true }),
        ),
      )
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS, label: () => t('title') },
          (props) => h(TeamBalancerPage, { t, view: props && props.view === 'summary' ? 'summary' : 'page' }),
        ),
      )
    }

    return {
      id: PACKAGE_NAME,
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
