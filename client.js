window.__ModuleLoader__.load({
  id: '@ayui124/dsh-openai-image-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'openai-image-tools'
    const FIELDS = [
      'baseURL', 'model', 'generationPath', 'editPath', 'responseFormat', 'imageField',
      'timeoutMs', 'downloadTimeoutMs', 'allowPrivateImageUrls',
      'maxInputImageBytes', 'maxOutputImageBytes', 'maxImages',
    ]
    const defaults = {
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-image-1',
      generationPath: '/images/generations',
      editPath: '/images/edits',
      responseFormat: 'auto',
      imageField: 'image',
      timeoutMs: 120000,
      downloadTimeoutMs: 30000,
      allowPrivateImageUrls: false,
      maxInputImageBytes: 20971520,
      maxOutputImageBytes: 26214400,
      maxImages: 4,
    }
    const dictionaries = {
      en: {
        summary: 'Configure the OpenAI-compatible image endpoint, credentials, model, and safety limits.',
        loading: 'Loading image tool settings…', unavailable: 'This configuration is unavailable.', readOnly: 'This configuration is read-only.',
        endpoint: 'API connection', limits: 'Limits and compatibility', baseURL: 'Base URL', apiKey: 'API key', apiKeyHint: 'Leave blank to keep the saved key unchanged.', clearKey: 'Clear saved API key', model: 'Default model', generationPath: 'Generation path', editPath: 'Edit path', responseFormat: 'Response format', imageField: 'Edit image field', timeoutMs: 'Request timeout (ms)', downloadTimeoutMs: 'URL download timeout (ms)', maxInputImageBytes: 'Maximum input bytes per image', maxOutputImageBytes: 'Maximum output bytes per image', maxImages: 'Maximum images per call', allowPrivateImageUrls: 'Allow localhost/private image URLs', privateHint: 'Enable only for a trusted local service.', save: 'Save settings', saving: 'Saving…', saved: 'Settings saved.', refused: 'The Host refused this change. Refresh and try again.', failed: 'Could not save: {message}', reset: 'Restore defaults', resetConfirm: 'Restore all non-secret fields to their composed defaults?',
      },
      zh: {
        summary: '配置 OpenAI 兼容图片接口、密钥、模型和安全限制。',
        loading: '正在加载图片工具设置…', unavailable: '此配置当前不可用。', readOnly: '此配置为只读。',
        endpoint: 'API 连接', limits: '限制与兼容性', baseURL: '基础 URL', apiKey: 'API Key', apiKeyHint: '留空将保持已保存的密钥不变。', clearKey: '清除已保存的 API Key', model: '默认模型', generationPath: '文生图路径', editPath: '图生图路径', responseFormat: '响应格式', imageField: '图生图图片字段', timeoutMs: '请求超时（毫秒）', downloadTimeoutMs: '图片 URL 下载超时（毫秒）', maxInputImageBytes: '单张输入图片最大字节数', maxOutputImageBytes: '单张输出图片最大字节数', maxImages: '单次最大图片数', allowPrivateImageUrls: '允许 localhost/私网图片 URL', privateHint: '仅应对可信本地服务启用。', save: '保存配置', saving: '保存中…', saved: '配置已保存。', refused: 'Host 拒绝了本次修改，请刷新后重试。', failed: '保存失败：{message}', reset: '恢复默认值', resetConfirm: '确定让所有非密钥字段恢复为组合默认值吗？',
      },
    }

    function TextField({ label, name, value, onChange, type = 'text', hint }) {
      return h('label', { className: 'oit-field' },
        h('span', { className: 'oit-label' }, label),
        h('input', { className: 'oit-input', name, type, value, onChange: event => onChange(event.target.value), autoComplete: type === 'password' ? 'new-password' : 'off' }),
        hint ? h('span', { className: 'oit-hint' }, hint) : null,
      )
    }

    function SelectField({ label, name, value, onChange, options }) {
      return h('label', { className: 'oit-field' },
        h('span', { className: 'oit-label' }, label),
        h('select', { className: 'oit-input', name, value, onChange: event => onChange(event.target.value) },
          options.map(option => h('option', { key: option, value: option }, option)),
        ),
      )
    }

    const acceptedValues = value => Object.fromEntries(FIELDS.map(field => [field, value?.[field] ?? defaults[field]]))

    function ImageToolsConfigPage({ form, t }) {
      const revision = form.state.revision
      const accepted = acceptedValues(form.state.value)
      const [draft, setDraft] = React.useState(accepted)
      const [apiKey, setApiKey] = React.useState('')
      const [clearKey, setClearKey] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      React.useEffect(() => {
        setDraft(acceptedValues(form.state.value))
        setApiKey('')
        setClearKey(false)
      }, [revision])
      const set = (field, value) => setDraft(current => ({ ...current, [field]: value }))
      const save = async event => {
        event.preventDefault()
        if (!form.state.writable || saving) return
        setSaving(true)
        setStatus(null)
        const ops = FIELDS.filter(field => draft[field] !== accepted[field]).map(field => ({ op: 'set', path: [field], value: draft[field] }))
        if (clearKey) ops.push({ op: 'unset', path: ['apiKey'] })
        else if (apiKey.length > 0) ops.push({ op: 'set', path: ['apiKey'], value: apiKey })
        try {
          const ok = ops.length === 0 || await form.mutate(ops, revision)
          setStatus({ ok, text: ok ? t('saved') : t('refused') })
          if (ok) { setApiKey(''); setClearKey(false) }
        } catch (error) {
          setStatus({ ok: false, text: t('failed', { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          setSaving(false)
        }
      }
      const reset = async () => {
        if (!form.state.writable || saving || !window.confirm(t('resetConfirm'))) return
        setSaving(true)
        setStatus(null)
        try {
          const ok = await form.mutate([...FIELDS, 'apiKey'].map(field => ({ op: 'unset', path: [field] })), revision)
          setStatus({ ok, text: ok ? t('saved') : t('refused') })
        } catch (error) {
          setStatus({ ok: false, text: t('failed', { message: error instanceof Error ? error.message : String(error) }) })
        } finally {
          setSaving(false)
        }
      }
      const numberField = (name, min, max) => h(TextField, { label: t(name), name, type: 'number', value: String(draft[name]), onChange: value => set(name, Math.max(min, Math.min(max, Number(value) || min))) })
      return h(React.Fragment, null,
        h('style', null, `
          .oit-form{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary)}
          .oit-group{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
          .oit-group h4{grid-column:1/-1;margin:0;font-size:14px;font-weight:600}.oit-wide{grid-column:1/-1}
          .oit-field{display:flex;min-width:0;flex-direction:column;gap:6px}.oit-label{font-size:13px;font-weight:500}.oit-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
          .oit-input{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit}.oit-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
          .oit-check{display:flex;align-items:flex-start;gap:8px;font-size:13px}.oit-actions{display:flex;align-items:center;gap:10px}.oit-button{height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.oit-button-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}.oit-button:disabled{cursor:not-allowed;opacity:.55}.oit-status{margin:0;font-size:13px}.oit-error{color:var(--dsw-alias-state-error-primary)}
          @media(max-width:720px){.oit-group{grid-template-columns:1fr}}
        `),
        h('form', { className: 'oit-form', onSubmit: save },
          h('section', { className: 'oit-group' },
            h('h4', null, t('endpoint')),
            h('div', { className: 'oit-wide' }, h(TextField, { label: t('baseURL'), name: 'baseURL', value: draft.baseURL, onChange: value => set('baseURL', value) })),
            h(TextField, { label: t('model'), name: 'model', value: draft.model, onChange: value => set('model', value) }),
            h(TextField, { label: t('apiKey'), name: 'apiKey', type: 'password', value: apiKey, onChange: value => { setApiKey(value); setClearKey(false) }, hint: t('apiKeyHint') }),
            h(TextField, { label: t('generationPath'), name: 'generationPath', value: draft.generationPath, onChange: value => set('generationPath', value) }),
            h(TextField, { label: t('editPath'), name: 'editPath', value: draft.editPath, onChange: value => set('editPath', value) }),
            h('label', { className: 'oit-check oit-wide' }, h('input', { type: 'checkbox', checked: clearKey, onChange: event => { setClearKey(event.target.checked); if (event.target.checked) setApiKey('') } }), h('span', null, t('clearKey'))),
          ),
          h('section', { className: 'oit-group' },
            h('h4', null, t('limits')),
            h(SelectField, { label: t('responseFormat'), name: 'responseFormat', value: draft.responseFormat, onChange: value => set('responseFormat', value), options: ['auto', 'b64_json', 'url'] }),
            h(SelectField, { label: t('imageField'), name: 'imageField', value: draft.imageField, onChange: value => set('imageField', value), options: ['image', 'image[]'] }),
            numberField('timeoutMs', 1, 2147483647), numberField('downloadTimeoutMs', 1, 2147483647),
            numberField('maxInputImageBytes', 1, Number.MAX_SAFE_INTEGER), numberField('maxOutputImageBytes', 1, Number.MAX_SAFE_INTEGER),
            numberField('maxImages', 1, 16),
            h('label', { className: 'oit-check' }, h('input', { type: 'checkbox', checked: Boolean(draft.allowPrivateImageUrls), onChange: event => set('allowPrivateImageUrls', event.target.checked) }), h('span', null, t('allowPrivateImageUrls'), h('span', { className: 'oit-hint', style: { display: 'block' } }, t('privateHint')))),
          ),
          !form.state.writable ? h('p', { className: 'oit-status oit-error', role: 'status' }, t('readOnly')) : null,
          status ? h('p', { className: `oit-status${status.ok ? '' : ' oit-error'}`, role: 'status' }, status.text) : null,
          h('div', { className: 'oit-actions' },
            h('button', { className: 'oit-button oit-button-primary', type: 'submit', disabled: saving || !form.state.writable }, saving ? t('saving') : t('save')),
            h('button', { className: 'oit-button', type: 'button', disabled: saving || !form.state.writable, onClick: reset }, t('reset')),
          ),
        ),
      )
    }

    function ImageToolsConfig({ view, form, t }) {
      if (view === 'summary') return h('span', null, t('summary'))
      if (!form || form.state.status === 'loading') return h('p', { role: 'status' }, t('loading'))
      if (form.state.status !== 'ready' || !form.state.value) return h('p', { role: 'status' }, t('unavailable'))
      return h(ImageToolsConfigPage, { form, t })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: '@ayui124/dsh-openai-image-tools#dsh-openai-image-tools',
          locale: NS,
        }, ImageToolsConfig))
      },
    }
  },
})
