import { h, btn, icon, clear, formatNumber } from '../../ui/dom.js';
import { t } from '../../ui/i18n.js';
import { section } from '../../ui/components/section.js';
import { combobox } from '../../ui/components/combobox.js';
import { openMenu } from '../../ui/components/menu.js';
import { confirmDialog, promptDialog } from '../../ui/components/confirm.js';
import { statusChip, severityDot } from '../../ui/components/chip.js';
import { METRIC_STATUSES, METRIC_ROLES } from '../../core/models/metric.js';
import { BindingType, BINDING_STATUSES } from '../../core/models/binding.js';
import { ConflictError } from '../../repositories/repository.js';
import { debounce } from '../../utils/debounce.js';
import { formatDateTime } from '../../utils/time.js';
import { worstSeverity } from '../../services/validation-service.js';

const METRIC_FIELDS = ['name', 'code', 'aliases', 'unitId', 'definition', 'owner', 'role', 'status', 'tags'];

/**
 * Metric detail drawer. Opened from every view; edits go through services.
 * Sections: Definition · Structure · Dimensions · Bindings (TT | GD) · Advanced.
 */
export class MetricDrawer {
  constructor(ctx, drawer) {
    this.ctx = ctx;
    this.drawer = drawer;
    this.metricId = null;
    this.base = null; // metric record as loaded (for dirty + conflict comparison)
    this.draft = null;
    this.bindingDrafts = new Map(); // scenarioId → { base, draft, dirty, preview }
    this.activeScenarioId = null;
    this.sections = {};
    this.els = {};
    this._offStore = ctx.store.events.on('change', (evt) => this._onStoreChange(evt));
    this._offValidation = ctx.validation.onChange(() => this._renderWarnings());
  }

  // ------------------------------------------------------------ open / close
  open(metricId, { section: focusSection = null, scenarioId = null } = {}) {
    const metric = this.ctx.store.get('metrics', metricId);
    if (!metric) {
      this.ctx.toast.error(t('drawer.metricNotFound'));
      return;
    }
    if (this.metricId === metricId && this.drawer.isOpen()) {
      this._focus(focusSection, scenarioId);
      return;
    }
    this.metricId = metricId;
    this.base = metric;
    this.draft = pickMetric(metric);
    this.bindingDrafts = new Map();
    this.activeScenarioId = scenarioId || (this.ctx.selectors.scenarios()[0] || {}).id || null;
    this._build();
    this.drawer.open({
      titleNode: this.els.title,
      actionNodes: [this.els.saveBtn, this.els.menuBtn],
      content: this.els.content,
      onSave: () => this.save(),
      canClose: () => this._confirmDiscard(),
      onClose: () => {
        this.metricId = null;
        this.ctx.services.presence.clear();
        if (this.onClose) this.onClose();
      },
    });
    this.ctx.services.presence.announce({ entityType: 'metric', entityId: metricId, mode: 'viewing' });
    this._focus(focusSection, scenarioId);
  }

  close() {
    return this.drawer.close();
  }

  async _confirmDiscard() {
    if (!this._isDirty()) return true;
    return confirmDialog({ title: t('drawer.discardTitle'), message: t('drawer.discardMessage'), confirmLabel: t('drawer.discard'), danger: true });
  }

  _isDirty() {
    if (this.draft && !sameMetric(this.draft, pickMetric(this.base))) return true;
    for (const b of this.bindingDrafts.values()) if (b.dirty) return true;
    return false;
  }

  _focus(focusSection, scenarioId) {
    if (scenarioId) this._selectScenario(scenarioId);
    if (focusSection && this.sections[focusSection]) {
      this.sections[focusSection].setOpen(true);
      setTimeout(() => this.sections[focusSection].el.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    }
  }

  // ------------------------------------------------------------ build
  _build() {
    const { ctx } = this;
    const metric = this.base;
    this.els.title = h('div', { class: 'drawer-title-inner' }, h('span', { class: 'mono muted', text: metric.code }), h('span', { class: 'drawer-name', text: metric.name }), statusChip(metric.status));
    this.els.saveBtn = btn(t('common.save'), { kind: 'primary', icon: 'check', disabled: true, title: 'Ctrl+S', on: { click: () => this.save() } });
    this.els.menuBtn = btn('', { icon: 'more', title: t('common.more'), on: { click: (e) => this._openMenu(e.currentTarget) } });
    this.els.warnings = h('div', { class: 'drawer-warnings' });
    this.els.conflict = h('div', { class: 'conflict-banner', hidden: true });

    this.sections.definition = section({ title: t('drawer.section.definition'), open: true });
    this.sections.structure = section({ title: t('drawer.section.structure'), open: true });
    this.sections.dimensions = section({ title: t('drawer.section.dimensions'), open: true });
    this.sections.bindings = section({ title: t('drawer.section.bindings'), open: true });
    this.sections.advanced = section({ title: t('drawer.section.advanced'), open: false });

    this.els.content = h('div', { class: 'drawer-content' }, this.els.conflict, this.els.warnings, this.sections.definition.el, this.sections.structure.el, this.sections.dimensions.el, this.sections.bindings.el, this.sections.advanced.el);

    this._renderWarnings();
    this._renderDefinition();
    this._renderStructure();
    this._renderDimensions();
    this._renderBindings();
    this._renderAdvanced();
    this._updateDirty();
  }

  _openMenu(anchor) {
    const metric = this.base;
    openMenu(anchor, [
      { label: t('drawer.menu.openDependencies'), icon: 'graph', onClick: () => this.ctx.router.navigate('dependencies', { metric: metric.id, scenario: this.ctx.store.get('scenarios', this.activeScenarioId)?.code }) },
      { label: t('drawer.menu.copyCode'), icon: 'link', onClick: () => { navigator.clipboard?.writeText(metric.code); this.ctx.toast.info(t('drawer.copied', { code: metric.code })); } },
      { separator: true },
      { label: t('drawer.menu.delete'), icon: 'trash', danger: true, onClick: () => this._deleteMetric() },
    ]);
  }

  // ------------------------------------------------------------ warnings
  _renderWarnings() {
    if (!this.metricId || !this.els.warnings) return;
    const issues = this.ctx.validation.issuesForMetric(this.metricId);
    clear(this.els.warnings);
    if (!issues.length) {
      this.els.warnings.hidden = true;
      return;
    }
    this.els.warnings.hidden = false;
    const sev = worstSeverity(issues);
    this.els.warnings.className = `drawer-warnings sev-${sev}`;
    this.els.warnings.appendChild(h('div', { class: 'drawer-warnings-head' }, icon('warning'), h('span', { text: t('drawer.warningsTitle', { n: issues.length }) })));
    const list = h('ul', { class: 'issue-list' });
    for (const issue of issues.slice(0, 8)) {
      list.appendChild(h('li', { class: 'issue-item', on: { click: () => this._jumpToIssue(issue) } }, severityDot(issue.severity), h('span', { text: this.ctx.describeIssue(issue) })));
    }
    if (issues.length > 8) list.appendChild(h('li', { class: 'issue-more', text: t('drawer.warningsMore', { n: issues.length - 8 }) }));
    this.els.warnings.appendChild(list);
  }

  _jumpToIssue(issue) {
    if (issue.entity.type === 'binding' || issue.scenarioId) {
      this.sections.bindings.setOpen(true);
      if (issue.scenarioId) this._selectScenario(issue.scenarioId);
      this.sections.bindings.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (issue.entity.type === 'metricDimension') {
      this.sections.dimensions.setOpen(true);
      this.sections.dimensions.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (issue.code.includes('UNPLACED') || issue.entity.type === 'metricStructure') {
      this.sections.structure.setOpen(true);
      this.sections.structure.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      this.sections.definition.setOpen(true);
      this.sections.definition.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // ------------------------------------------------------------ definition
  _renderDefinition() {
    const { selectors } = this.ctx;
    const d = this.draft;
    const body = this.sections.definition.body;
    clear(body);
    const onInput = (field, transform = (v) => v) => (e) => {
      this.draft[field] = transform(e.target.value);
      this._updateDirty();
    };
    const unitOptions = [h('option', { value: '', text: t('drawer.noUnit') }), ...selectors.units().map((u) => h('option', { value: u.id, text: `${u.code} — ${u.name}`, selected: u.id === d.unitId }))];
    this.els.nameInput = h('input', { class: 'input', type: 'text', value: d.name, placeholder: t('drawer.namePlaceholder'), on: { input: onInput('name') } });
    body.append(
      field(t('metric.field.name'), this.els.nameInput, { required: true }),
      h('div', { class: 'field-row' },
        field(t('metric.field.code'), h('input', { class: 'input mono', type: 'text', value: d.code, on: { input: onInput('code') } }), { hint: t('drawer.codeHint') }),
        field(t('metric.field.unit'), h('select', { class: 'input', on: { change: onInput('unitId', (v) => v || null) } }, unitOptions)),
      ),
      field(t('metric.field.aliases'), h('input', { class: 'input', type: 'text', value: d.aliases.join(', '), placeholder: 'REVENUE, DT', on: { input: onInput('aliases', splitList) } }), { hint: t('drawer.aliasHint') }),
      field(t('metric.field.definition'), h('textarea', { class: 'input', rows: 3, value: d.definition, on: { input: onInput('definition') } })),
      h('div', { class: 'field-row' },
        field(t('metric.field.status'), h('select', { class: 'input', on: { change: onInput('status') } }, METRIC_STATUSES.map((s) => h('option', { value: s, text: t(`metric.status.${s}`), selected: s === d.status })))),
        field(t('metric.field.role'), h('select', { class: 'input', on: { change: onInput('role') } }, [h('option', { value: '', text: '—' }), ...METRIC_ROLES.map((r) => h('option', { value: r, text: t(`metric.role.${r}`), selected: r === d.role }))])),
      ),
      field(t('metric.field.owner'), h('input', { class: 'input', type: 'text', value: d.owner, on: { input: onInput('owner') } })),
    );
  }

  // ------------------------------------------------------------ structure
  _renderStructure() {
    const { selectors, services, store } = this.ctx;
    const body = this.sections.structure.body;
    clear(body);
    const links = selectors.placementsByMetric(this.metricId).filter((l) => store.has('structureNodes', l.structureNodeId));
    this.sections.structure.setBadge(links.length || '');
    if (!links.length) body.appendChild(h('p', { class: 'hint warn', text: t('drawer.noPlacement') }));
    const list = h('ul', { class: 'link-list' });
    for (const l of links) {
      const path = selectors.nodePath(l.structureNodeId);
      list.appendChild(h('li', { class: 'link-item' },
        h('button', { type: 'button', class: ['star', l.isPrimary && 'on'], title: l.isPrimary ? t('drawer.primary') : t('drawer.makePrimary'), on: { click: () => this._run(() => services.structure.setPrimary(l.id)) } }, icon('star', { size: 14 })),
        h('span', { class: 'link-path' }, path.map((n, i) => h('span', { class: ['crumb', i === path.length - 1 && 'last'], text: n.name, on: { click: () => this.ctx.router.navigate('metrics', { node: n.id, metric: this.metricId }) } }))),
        btn('', { icon: 'close', size: 'sm', title: t('drawer.removePlacement'), on: { click: () => this._run(() => services.structure.removePlacement(l.id)) } }),
      ));
    }
    body.appendChild(list);
    const existing = new Set(links.map((l) => l.structureNodeId));
    const picker = combobox({
      placeholder: t('drawer.addPlacement'),
      search: (q) => searchNodes(this.ctx, q, existing),
      onSelect: (item, { clear: reset }) => { reset(); this._run(() => services.structure.placeMetric(this.metricId, item.id)); },
    });
    body.appendChild(picker.el);
  }

  // ------------------------------------------------------------ dimensions
  _renderDimensions() {
    const { selectors, services, store } = this.ctx;
    const body = this.sections.dimensions.body;
    clear(body);
    const links = selectors.metricDimensions(this.metricId).filter((l) => store.has('dimensions', l.dimensionId));
    this.sections.dimensions.setBadge(links.length || '');
    if (!links.length) body.appendChild(h('p', { class: 'hint', text: t('drawer.noDimensions') }));
    const list = h('ul', { class: 'link-list' });
    for (const l of links) {
      const dim = store.get('dimensions', l.dimensionId);
      const depth = selectors.memberTree(dim.id).depth;
      const maxLevel = h('input', { class: 'input input-xs', type: 'number', min: 1, max: Math.max(depth, 1), value: l.maxLevel ?? '', placeholder: String(depth || 1), title: t('drawer.maxLevel'), on: { change: (e) => this._run(() => services.dimensions.updateLink(l.id, { maxLevel: e.target.value ? Number(e.target.value) : null })) } });
      list.appendChild(h('li', { class: 'link-item' },
        h('span', { class: 'mono muted', text: dim.code }),
        h('span', { class: 'link-name', text: dim.name }),
        h('label', { class: 'check-inline', title: t('drawer.required') }, h('input', { type: 'checkbox', checked: l.required, on: { change: (e) => this._run(() => services.dimensions.updateLink(l.id, { required: e.target.checked })) } }), h('span', { text: t('drawer.requiredShort') })),
        h('label', { class: 'check-inline', title: t('drawer.maxLevel') }, h('span', { text: t('drawer.maxLevelShort') }), maxLevel),
        btn('', { icon: 'close', size: 'sm', title: t('common.remove'), on: { click: () => this._run(() => services.dimensions.unlink(l.id)) } }),
      ));
    }
    body.appendChild(list);
    const existing = new Set(links.map((l) => l.dimensionId));
    const picker = combobox({
      placeholder: t('drawer.addDimension'),
      search: (q) => {
        const norm = q.toLowerCase();
        return selectors.dimensionsSorted().filter((d) => !existing.has(d.id) && (!norm || `${d.code} ${d.name}`.toLowerCase().includes(norm))).slice(0, 12).map((d) => ({ id: d.id, label: d.name, sub: d.code, meta: t('drawer.memberCount', { n: selectors.membersByDimension(d.id).length }) }));
      },
      onSelect: (item, { clear: reset }) => { reset(); this._run(() => services.dimensions.linkMetric(this.metricId, item.id)); },
    });
    body.appendChild(picker.el);
  }

  // ------------------------------------------------------------ bindings
  _renderBindings() {
    const body = this.sections.bindings.body;
    clear(body);
    const scenarios = this.ctx.selectors.scenarios();
    if (!scenarios.some((s) => s.id === this.activeScenarioId)) this.activeScenarioId = scenarios[0] ? scenarios[0].id : null;
    this.els.tabs = h('div', { class: 'tabs', role: 'tablist' });
    this.els.bindingPanel = h('div', { class: 'binding-panel' });
    body.append(this.els.tabs, this.els.bindingPanel);
    this._renderBindingTabs();
    this._renderBindingPanel();
  }

  _renderBindingTabs() {
    const { selectors } = this.ctx;
    clear(this.els.tabs);
    for (const s of selectors.scenarios()) {
      const b = selectors.bindingFor(this.metricId, s.id);
      const type = b && b.type !== 'none' ? b.type : 'none';
      const draft = this.bindingDrafts.get(s.id);
      this.els.tabs.appendChild(h('button', { type: 'button', role: 'tab', class: ['tab', s.id === this.activeScenarioId && 'active'], 'aria-selected': String(s.id === this.activeScenarioId), on: { click: () => this._selectScenario(s.id) } },
        h('span', { class: 'tab-code', text: s.code }),
        h('span', { class: `tab-type chip-${type}`, text: type === 'none' ? '—' : t(`binding.type.${type}.short`) }),
        draft && draft.dirty && h('span', { class: 'tab-dirty', title: t('drawer.unsaved') }),
      ));
    }
  }

  _selectScenario(scenarioId) {
    if (!this.ctx.store.has('scenarios', scenarioId)) return;
    this.activeScenarioId = scenarioId;
    if (this.els.tabs) {
      this._renderBindingTabs();
      this._renderBindingPanel();
    }
  }

  _bindingDraft(scenarioId) {
    if (!this.bindingDrafts.has(scenarioId)) {
      const base = this.ctx.selectors.bindingFor(this.metricId, scenarioId);
      this.bindingDrafts.set(scenarioId, { base, draft: pickBinding(base), dirty: false, preview: null });
    }
    return this.bindingDrafts.get(scenarioId);
  }

  _renderBindingPanel() {
    const panel = this.els.bindingPanel;
    clear(panel);
    const scenarioId = this.activeScenarioId;
    if (!scenarioId) return;
    const scenario = this.ctx.store.get('scenarios', scenarioId);
    const state = this._bindingDraft(scenarioId);
    const d = state.draft;
    const setField = (path, value) => {
      const [a, b] = path.split('.');
      if (b) d[a][b] = value;
      else d[a] = value;
      state.dirty = !sameBinding(d, pickBinding(state.base));
      this._renderBindingTabs();
      this._updateDirty();
    };

    // Type selector
    const types = [BindingType.NONE, BindingType.SOURCE, BindingType.FORMULA, BindingType.ASSUMPTION];
    panel.appendChild(h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('binding.type') }, types.map((type) => h('button', { type: 'button', role: 'radio', class: ['seg-btn', `seg-${type}`, d.type === type && 'active'], 'aria-checked': String(d.type === type), on: { click: () => { setField('type', type); this._renderBindingPanel(); } } }, t(`binding.type.${type}`)))));

    const fields = h('div', { class: 'binding-fields' });
    panel.appendChild(fields);

    if (d.type === BindingType.NONE) {
      fields.appendChild(h('p', { class: 'hint', text: t('binding.noneHint', { scenario: scenario.name }) }));
    } else if (d.type === BindingType.SOURCE) {
      fields.append(
        h('div', { class: 'field-row' },
          field(t('binding.source.system'), h('input', { class: 'input', type: 'text', value: d.source.system, placeholder: 'ERP / CRM / PMS', on: { input: (e) => setField('source.system', e.target.value) } }), { required: true }),
          field(t('binding.source.dataset'), h('input', { class: 'input', type: 'text', value: d.source.dataset, on: { input: (e) => setField('source.dataset', e.target.value) } })),
        ),
        h('div', { class: 'field-row' },
          field(t('binding.source.field'), h('input', { class: 'input mono', type: 'text', value: d.source.field, on: { input: (e) => setField('source.field', e.target.value) } })),
          field(t('binding.source.frequency'), h('select', { class: 'input', on: { change: (e) => setField('source.frequency', e.target.value) } }, ['', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'].map((f) => h('option', { value: f, text: f ? t(`frequency.${f}`) : '—', selected: f === d.source.frequency })))),
        ),
        field(t('binding.source.owner'), h('input', { class: 'input', type: 'text', value: d.source.owner, on: { input: (e) => setField('source.owner', e.target.value) } })),
      );
    } else if (d.type === BindingType.ASSUMPTION) {
      fields.append(
        h('div', { class: 'field-row' },
          field(t('binding.assumption.value'), h('input', { class: 'input', type: 'text', value: d.assumption.value, placeholder: '75%', on: { input: (e) => setField('assumption.value', e.target.value) } }), { required: true }),
          field(t('binding.assumption.validity'), h('div', { class: 'range' }, h('input', { class: 'input', type: 'text', value: d.assumption.validFrom, placeholder: '2027-01', on: { input: (e) => setField('assumption.validFrom', e.target.value) } }), h('span', { text: '→' }), h('input', { class: 'input', type: 'text', value: d.assumption.validTo, placeholder: '2027-12', on: { input: (e) => setField('assumption.validTo', e.target.value) } }))),
        ),
        field(t('binding.assumption.basis'), h('textarea', { class: 'input', rows: 2, value: d.assumption.basis, placeholder: t('binding.assumption.basisPlaceholder'), on: { input: (e) => setField('assumption.basis', e.target.value) } }), { required: true }),
      );
    } else if (d.type === BindingType.FORMULA) {
      this._renderFormulaEditor(fields, state, setField);
    }

    if (d.type !== BindingType.NONE) {
      fields.appendChild(h('div', { class: 'field-row' },
        field(t('binding.legacyCode'), h('input', { class: 'input mono', type: 'text', value: d.legacyCode, placeholder: `${scenario.code}-KD001`, on: { input: (e) => setField('legacyCode', e.target.value) } }), { hint: t('binding.legacyHint') }),
        field(t('binding.status'), h('select', { class: 'input', on: { change: (e) => setField('status', e.target.value) } }, BINDING_STATUSES.map((s) => h('option', { value: s, text: t(`binding.status.${s}`), selected: s === d.status })))),
      ));
      fields.appendChild(field(t('binding.note'), h('input', { class: 'input', type: 'text', value: d.note, on: { input: (e) => setField('note', e.target.value) } })));
    }

    const actions = h('div', { class: 'binding-actions' });
    actions.appendChild(btn(t('binding.save', { scenario: scenario.code }), { kind: 'primary', size: 'sm', on: { click: () => this.saveBinding(scenarioId) } }));
    if (state.base) actions.appendChild(btn(t('binding.remove'), { size: 'sm', icon: 'trash', on: { click: () => this._removeBinding(scenarioId) } }));
    if (state.base) actions.appendChild(h('span', { class: 'muted small', text: t('drawer.versionInfo', { v: state.base.version, at: formatDateTime(state.base.updatedAt) }) }));
    panel.appendChild(actions);
  }

  _renderFormulaEditor(container, state, setField) {
    const scenarioId = this.activeScenarioId;
    const d = state.draft;
    const textarea = h('textarea', { class: 'input mono formula-input', rows: 3, value: d.formulaText, placeholder: '[VOLUME] * [PRICE]', spellcheck: false });
    const refsBox = h('div', { class: 'refs' });
    const insert = combobox({
      placeholder: t('binding.insertReference'),
      className: 'combo-sm',
      search: (q) => this.ctx.selectors.suggestMetrics(q, 8, new Set([this.metricId])).map((m) => ({ id: m.id, label: m.name, sub: m.code, meta: (m.aliases || [])[0] || '' })),
      onSelect: (item, { clear: reset }) => {
        reset();
        const m = this.ctx.store.get('metrics', item.id);
        const token = (m.aliases && m.aliases[0]) || m.code;
        insertAtCursor(textarea, `[${token}]`);
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
      },
    });
    const update = debounce(() => {
      state.preview = this.ctx.services.bindings.preview(d.formulaText, scenarioId);
      this._renderReferences(refsBox, state);
    }, 180);
    textarea.addEventListener('input', () => {
      setField('formulaText', textarea.value);
      update();
    });
    container.append(
      field(t('binding.formula'), textarea, { required: true, hint: t('binding.formulaHint') }),
      h('div', { class: 'formula-tools' }, insert.el),
      refsBox,
    );
    state.preview = this.ctx.services.bindings.preview(d.formulaText, scenarioId);
    this._renderReferences(refsBox, state);
  }

  _renderReferences(box, state) {
    clear(box);
    const p = state.preview;
    if (!p) return;
    if (p.isEmpty) {
      box.appendChild(h('p', { class: 'hint', text: t('binding.formulaEmpty') }));
      return;
    }
    for (const err of p.errors) box.appendChild(h('div', { class: 'ref-error' }, icon('warning', { size: 14 }), h('span', { text: t('binding.syntaxError', { message: err.message, pos: err.position + 1 }) })));
    if (!p.references.length) return;
    const list = h('ul', { class: 'ref-list' });
    for (const r of p.references) list.appendChild(this._renderReference(r, state));
    box.appendChild(h('div', { class: 'ref-head', text: t('binding.references', { n: p.references.length }) }));
    box.appendChild(list);
  }

  _renderReference(r, state) {
    const { store } = this.ctx;
    const scenario = store.get('scenarios', r.scenarioId);
    const li = h('li', { class: `ref-item ref-${r.status}` });
    li.appendChild(h('code', { class: 'ref-raw', text: r.raw }));
    if (r.status === 'resolved') {
      const m = store.get('metrics', r.metricId);
      li.appendChild(h('button', { type: 'button', class: 'ref-target link', on: { click: () => this._openOther(m.id, r.scenarioId) } }, h('span', { class: 'mono muted', text: m.code }), h('span', { text: m.name })));
      if (r.isCrossScenario) li.appendChild(h('span', { class: 'tag tag-cross', text: t('binding.crossScenario', { scenario: scenario ? scenario.code : r.scenarioCode }) }));
      const tb = this.ctx.selectors.bindingFor(m.id, r.scenarioId);
      if (!tb || tb.type === 'none') li.appendChild(h('span', { class: 'tag tag-warn', text: t('binding.targetUnbound', { scenario: scenario ? scenario.code : '?' }) }));
    } else if (r.status === 'missing') {
      li.appendChild(h('span', { class: 'ref-msg', text: t('binding.refMissing') }));
      const actions = h('div', { class: 'ref-actions' });
      for (const s of r.suggestions.slice(0, 3)) {
        actions.appendChild(h('button', { type: 'button', class: 'suggestion', title: t('binding.useSuggestion'), on: { click: () => this._replaceToken(state, r, s.id) } }, h('span', { class: 'mono muted', text: s.code }), h('span', { text: s.name })));
      }
      actions.appendChild(btn(t('binding.createDraft'), { size: 'sm', icon: 'plus', on: { click: () => this._createDraftFromReference(state, r) } }));
      li.appendChild(actions);
    } else if (r.status === 'ambiguous') {
      li.appendChild(h('span', { class: 'ref-msg', text: t('binding.refAmbiguous', { n: r.candidates.length }) }));
      const actions = h('div', { class: 'ref-actions' });
      for (const c of r.candidates.slice(0, 5)) actions.appendChild(h('button', { type: 'button', class: 'suggestion', on: { click: () => this._replaceToken(state, r, c.id) } }, h('span', { class: 'mono muted', text: c.code }), h('span', { text: c.name })));
      li.appendChild(actions);
    } else if (r.status === 'unknown-scenario') {
      li.appendChild(h('span', { class: 'ref-msg', text: t('binding.refUnknownScenario', { code: r.scenarioCode }) }));
    }
    return li;
  }

  _replaceToken(state, ref, metricId) {
    const m = this.ctx.store.get('metrics', metricId);
    if (!m) return;
    const token = m.code;
    const prefix = ref.scenarioCode ? `${ref.scenarioCode}:` : '';
    const ctxPart = ref.dimensionContext ? ` | ${ref.dimensionContext.map((p) => (p.member == null ? p.dimension : `${p.dimension}=${p.member}`)).join('; ')}` : '';
    const replacement = `[${prefix}${token}${ctxPart}]`;
    const text = state.draft.formulaText.split(ref.raw).join(replacement);
    state.draft.formulaText = text;
    state.dirty = true;
    this._renderBindingTabs();
    this._renderBindingPanel();
    this._updateDirty();
  }

  async _createDraftFromReference(state, ref) {
    const { ctx } = this;
    const nodes = ctx.store.list('structureNodes');
    const placements = ctx.selectors.placementsByMetric(this.metricId);
    const defaultNode = placements.find((p) => p.isPrimary) || placements[0];
    const values = await promptDialog({
      title: t('binding.createDraftTitle', { token: ref.token }),
      confirmLabel: t('binding.createDraftConfirm'),
      fields: [
        { name: 'name', label: t('metric.field.name'), value: ref.token },
        nodes.length ? { name: 'structureNodeId', label: t('drawer.section.structure'), type: 'select', value: defaultNode ? defaultNode.structureNodeId : '', options: nodeOptions(ctx) } : null,
      ].filter(Boolean),
    });
    if (!values) return;
    try {
      // Persist the binding first so the reference can be re-resolved on a stored record.
      const scenarioId = this.activeScenarioId;
      const savedBinding = await this._persistBinding(scenarioId, { silent: true });
      if (!savedBinding) return;
      const { metric } = await ctx.services.bindings.createDraftFromReference(savedBinding.id, ref.token, { structureNodeId: values.structureNodeId || null, name: values.name || ref.token });
      ctx.toast.success(t('binding.draftCreated', { code: metric.code, name: metric.name }), { action: { label: t('common.open'), onClick: () => this.open(metric.id) } });
      this.bindingDrafts.delete(scenarioId);
      this._renderBindingTabs();
      this._renderBindingPanel();
      this._updateDirty();
    } catch (err) {
      this._handleError(err);
    }
  }

  _openOther(metricId, scenarioId) {
    if (this._isDirty()) {
      this.ctx.toast.info(t('drawer.saveFirst'));
      return;
    }
    this.open(metricId, { section: 'bindings', scenarioId });
  }

  // ------------------------------------------------------------ advanced
  _renderAdvanced() {
    const body = this.sections.advanced.body;
    clear(body);
    const m = this.base;
    const bindings = [...this.ctx.selectors.bindingsByMetric(m.id).values()];
    const legacy = bindings.filter((b) => b.legacyCode).map((b) => `${this.ctx.store.get('scenarios', b.scenarioId)?.code}: ${b.legacyCode}`);
    const used = this.ctx.selectors.referencingBindings(m.id);
    body.append(
      field(t('metric.field.tags'), h('input', { class: 'input', type: 'text', value: this.draft.tags.join(', '), on: { input: (e) => { this.draft.tags = splitList(e.target.value); this._updateDirty(); } } })),
      h('dl', { class: 'meta-list' },
        h('dt', { text: t('drawer.meta.id') }), h('dd', { class: 'mono', text: m.id }),
        h('dt', { text: t('drawer.meta.version') }), h('dd', { text: String(m.version) }),
        h('dt', { text: t('drawer.meta.created') }), h('dd', { text: formatDateTime(m.createdAt) }),
        h('dt', { text: t('drawer.meta.updated') }), h('dd', { text: formatDateTime(m.updatedAt) }),
        h('dt', { text: t('drawer.meta.legacyCodes') }), h('dd', { text: legacy.length ? legacy.join(' · ') : '—' }),
        h('dt', { text: t('drawer.meta.usedBy') }), h('dd', { text: used.length ? t('drawer.meta.usedByCount', { n: used.length }) : '—' }),
      ),
      h('div', { class: 'danger-zone' }, btn(t('drawer.menu.delete'), { kind: 'danger-ghost', icon: 'trash', size: 'sm', on: { click: () => this._deleteMetric() } })),
    );
  }

  // ------------------------------------------------------------ save / delete
  _updateDirty() {
    const dirty = this._isDirty();
    this.els.saveBtn.disabled = !dirty;
    this.els.saveBtn.classList.toggle('pulse', dirty);
    if (this.els.title) {
      const nameEl = this.els.title.querySelector('.drawer-name');
      if (nameEl && this.draft) nameEl.textContent = this.draft.name || this.base.name;
    }
    const mode = dirty ? 'editing' : 'viewing';
    this.ctx.services.presence.announce({ entityType: 'metric', entityId: this.metricId, mode });
  }

  async save() {
    if (!this.metricId) return;
    const { ctx } = this;
    let savedAny = false;
    try {
      if (!sameMetric(this.draft, pickMetric(this.base))) {
        const saved = await ctx.services.metrics.update(this.metricId, this.draft, this.base.version);
        this.base = saved;
        this.draft = pickMetric(saved);
        savedAny = true;
        this._refreshHeader();
      }
      for (const [scenarioId, state] of this.bindingDrafts) {
        if (state.dirty) {
          await this._persistBinding(scenarioId, { silent: true });
          savedAny = true;
        }
      }
      if (savedAny) ctx.toast.success(t('drawer.saved'));
      this._updateDirty();
      this._renderAdvanced();
    } catch (err) {
      this._handleError(err);
    }
  }

  async saveBinding(scenarioId) {
    try {
      const saved = await this._persistBinding(scenarioId);
      if (saved) this.ctx.toast.success(t('binding.saved', { scenario: this.ctx.store.get('scenarios', scenarioId)?.code }));
    } catch (err) {
      this._handleError(err);
    }
  }

  /** Persist the binding draft of one scenario; returns the saved binding (or null when nothing to save). */
  async _persistBinding(scenarioId, { silent = false } = {}) {
    const state = this._bindingDraft(scenarioId);
    const d = state.draft;
    if (!state.dirty && state.base) return state.base;
    if (d.type === BindingType.NONE && !state.base) {
      state.dirty = false;
      this._updateDirty();
      return null;
    }
    const { binding, resolution } = await this.ctx.services.bindings.setBinding(this.metricId, scenarioId, d, state.base ? state.base.version : null);
    this.bindingDrafts.set(scenarioId, { base: binding, draft: pickBinding(binding), dirty: false, preview: state.preview });
    if (resolution && !silent) {
      const missing = resolution.references.filter((r) => r.status !== 'resolved').length;
      if (missing) this.ctx.toast.info(t('binding.savedWithMissing', { n: missing }));
    }
    this._renderBindingTabs();
    if (this.activeScenarioId === scenarioId) this._renderBindingPanel();
    this._updateDirty();
    return binding;
  }

  async _removeBinding(scenarioId) {
    const scenario = this.ctx.store.get('scenarios', scenarioId);
    const ok = await confirmDialog({ title: t('binding.removeTitle', { scenario: scenario.code }), message: t('binding.removeMessage', { metric: this.base.name, scenario: scenario.name }), confirmLabel: t('common.remove') });
    if (!ok) return;
    try {
      await this.ctx.services.bindings.removeBinding(this.metricId, scenarioId);
      this.bindingDrafts.delete(scenarioId);
      this._renderBindingTabs();
      this._renderBindingPanel();
      this._updateDirty();
      this.ctx.toast.success(t('binding.removed', { scenario: scenario.code }));
    } catch (err) {
      this._handleError(err);
    }
  }

  async _deleteMetric() {
    const m = this.base;
    const used = this.ctx.selectors.referencingBindings(m.id).length;
    const ok = await confirmDialog({ title: t('drawer.deleteTitle', { name: m.name }), message: used ? t('drawer.deleteMessageUsed', { n: used }) : t('drawer.deleteMessage'), confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await this.ctx.services.metrics.remove(m.id, m.version);
      this.ctx.toast.success(t('drawer.deleted', { name: m.name }));
      this.drawer.close({ force: true });
    } catch (err) {
      this._handleError(err);
    }
  }

  async _run(fn) {
    try {
      await fn();
    } catch (err) {
      this._handleError(err);
    }
  }

  _handleError(err) {
    if (err instanceof ConflictError) {
      this._showConflict(err);
      return;
    }
    if (err && err.name === 'ValidationFailure') {
      this.ctx.toast.error(err.message);
      if (err.field === 'name' && this.els.nameInput) this.els.nameInput.focus();
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    this.ctx.toast.error(err && err.message ? err.message : String(err));
  }

  _showConflict(err) {
    const box = this.els.conflict;
    clear(box);
    box.hidden = false;
    const current = err.current;
    const diffs = [];
    if (err.collection === 'metrics' && current) {
      for (const f of METRIC_FIELDS) {
        const mine = JSON.stringify(this.draft[f]);
        const theirs = JSON.stringify(pickMetric(current)[f]);
        const orig = JSON.stringify(pickMetric(this.base)[f]);
        if (theirs !== orig) diffs.push({ field: f, theirs: current[f], mine: this.draft[f], sameAsMine: mine === theirs });
      }
    }
    box.append(
      h('div', { class: 'conflict-head' }, icon('warning'), h('strong', { text: t('conflict.title') }), h('span', { text: current ? t('conflict.message', { mine: err.expectedVersion, theirs: current.version }) : t('conflict.deleted') })),
      diffs.length ? h('ul', { class: 'conflict-diffs' }, diffs.map((d) => h('li', null, h('span', { class: 'conflict-field', text: t(`metric.field.${d.field}`) }), h('span', { class: 'conflict-theirs', text: fmt(d.theirs) }), h('span', { class: 'conflict-arrow', text: d.sameAsMine ? '=' : '≠' }), h('span', { class: 'conflict-mine', text: fmt(d.mine) })))) : null,
      h('div', { class: 'conflict-actions' },
        btn(t('conflict.reload'), { kind: 'primary', size: 'sm', on: { click: () => this._reloadFromCurrent(err) } }),
        current && btn(t('conflict.overwrite'), { kind: 'danger-ghost', size: 'sm', on: { click: () => this._overwrite(err) } }),
        btn(t('conflict.keepEditing'), { size: 'sm', on: { click: () => { box.hidden = true; } } }),
      ),
    );
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  _reloadFromCurrent(err) {
    this.els.conflict.hidden = true;
    if (!err.current) {
      this.drawer.close({ force: true });
      return;
    }
    if (err.collection === 'metrics') {
      this.ctx.store.upsert('metrics', err.current);
      this.base = err.current;
      this.draft = pickMetric(err.current);
      this._refreshHeader();
      this._renderDefinition();
      this._renderAdvanced();
    } else if (err.collection === 'bindings') {
      this.ctx.store.upsert('bindings', err.current);
      this.bindingDrafts.delete(err.current.scenarioId);
      this._renderBindingTabs();
      this._renderBindingPanel();
    }
    this._updateDirty();
  }

  async _overwrite(err) {
    this.els.conflict.hidden = true;
    try {
      if (err.collection === 'metrics') {
        this.ctx.store.upsert('metrics', err.current);
        this.base = { ...this.base, version: err.current.version };
        await this.save();
      } else if (err.collection === 'bindings') {
        this.ctx.store.upsert('bindings', err.current);
        const state = this._bindingDraft(err.current.scenarioId);
        state.base = err.current;
        await this.saveBinding(err.current.scenarioId);
      }
    } catch (e) {
      this._handleError(e);
    }
  }

  _refreshHeader() {
    const m = this.base;
    this.els.title.replaceChildren(h('span', { class: 'mono muted', text: m.code }), h('span', { class: 'drawer-name', text: m.name }), statusChip(m.status));
  }

  // ------------------------------------------------------------ store sync
  _onStoreChange(evt) {
    if (!this.metricId || !this.drawer.isOpen()) return;
    const c = evt.collection;
    if (c === '*') {
      if (!this.ctx.store.has('metrics', this.metricId)) this.drawer.close({ force: true });
      else this.open(this.metricId);
      return;
    }
    if (c === 'metrics') {
      if (evt.type === 'remove' && evt.ids.includes(this.metricId)) {
        this.drawer.close({ force: true });
        return;
      }
      const current = this.ctx.store.get('metrics', this.metricId);
      if (current && current.version !== this.base.version && sameMetric(this.draft, pickMetric(this.base))) {
        this.base = current;
        this.draft = pickMetric(current);
        this._refreshHeader();
        this._renderDefinition();
        this._renderAdvanced();
      }
      // Other metrics changed: reference previews may resolve differently.
      for (const state of this.bindingDrafts.values()) if (state.draft.type === BindingType.FORMULA) state.preview = null;
      if (this.els.bindingPanel && this._bindingDraft(this.activeScenarioId).draft.type === BindingType.FORMULA) this._renderBindingPanel();
    } else if (c === 'metricStructures' || c === 'structureNodes') {
      this._renderStructure();
    } else if (c === 'metricDimensions' || c === 'dimensions' || c === 'dimensionMembers') {
      this._renderDimensions();
    } else if (c === 'bindings') {
      let touched = false;
      for (const [scenarioId, state] of this.bindingDrafts) {
        const current = this.ctx.selectors.bindingFor(this.metricId, scenarioId);
        const changed = (current ? current.version : null) !== (state.base ? state.base.version : null);
        if (changed && !state.dirty) {
          this.bindingDrafts.delete(scenarioId);
          touched = true;
        }
      }
      if (touched || evt.ids.length) {
        this._renderBindingTabs();
        this._renderBindingPanel();
      }
      this._renderAdvanced();
    } else if (c === 'units') {
      this._renderDefinition();
    }
  }

  destroy() {
    this._offStore();
    this._offValidation();
  }
}

// ---------------------------------------------------------------- helpers
function pickMetric(m) {
  return { name: m.name || '', code: m.code || '', aliases: [...(m.aliases || [])], unitId: m.unitId || null, definition: m.definition || '', owner: m.owner || '', role: m.role || '', status: m.status || 'draft', tags: [...(m.tags || [])] };
}

function sameMetric(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pickBinding(b) {
  return {
    type: b ? b.type : BindingType.NONE,
    legacyCode: b ? b.legacyCode || '' : '',
    source: { system: '', dataset: '', field: '', owner: '', frequency: '', note: '', ...(b ? b.source : {}) },
    formulaText: b ? b.formulaText || '' : '',
    assumption: { value: '', basis: '', validFrom: '', validTo: '', note: '', ...(b ? b.assumption : {}) },
    status: b ? b.status : 'draft',
    note: b ? b.note || '' : '',
  };
}

function sameBinding(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function splitList(v) {
  return String(v || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

function fmt(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  return String(v);
}

export function field(label, control, { hint = null, required = false } = {}) {
  return h('label', { class: ['field', required && 'required'] }, h('span', { class: 'field-label', text: label }), control, hint && h('span', { class: 'field-hint', text: hint }));
}

export function searchNodes(ctx, query, exclude = new Set(), limit = 12) {
  const q = (query || '').toLowerCase();
  const out = [];
  for (const entry of ctx.selectors.structureTree().byId.values()) {
    const n = entry.node;
    if (exclude.has(n.id)) continue;
    const path = ctx.selectors.nodePathLabel(n.id);
    if (q && !`${n.code} ${n.name} ${path}`.toLowerCase().includes(q)) continue;
    out.push({ id: n.id, label: n.name, sub: path, meta: n.code, depth: entry.depth });
    if (out.length >= limit * 4) break;
  }
  out.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));
  return out.slice(0, limit);
}

export function nodeOptions(ctx) {
  const out = [];
  const walk = (entry) => {
    out.push({ value: entry.node.id, label: `${'  '.repeat(entry.depth)}${entry.node.name}` });
    for (const c of entry.children) walk(c);
  };
  for (const r of ctx.selectors.structureTree().roots) walk(r);
  return out;
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  textarea.value = `${before}${pad}${text}${after}`;
  const pos = before.length + pad.length + text.length;
  textarea.setSelectionRange(pos, pos);
}
