/**
 * 「模型」面板:上方选模型与音色,下方按服务给的参数元数据渲染字段。
 * 数据面只有 state / refresh / save 三个方法,保存与刷新都由服务端写回配置。
 */

import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { PanelModelSave, PanelModelState } from '../src/panel.ts';
import type { ModelParameter, VoiceModelStyle } from '../src/types.ts';
import { PARAM_LABELS, panelText, type PanelText } from './strings.ts';
import './style.css';

const EMPTY_STYLE: VoiceModelStyle = {
  voice: '',
  emotionMode: 'instruct',
  defaultEmotion: '',
  defaultInstruct: '',
  speed: 1,
  paralinguistic: 'auto',
};

interface Control {
  param: ModelParameter;
  el: HTMLElement;
  read(): unknown | undefined;
}

interface StyleFields {
  el: HTMLElement;
  read(): VoiceModelStyle;
}

function parameterValue(param: ModelParameter, options: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(options, param.name)) return options[param.name];
  return param.default;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  return String(value);
}

function numberValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return value.trim();
  return '';
}

function makeControl(
  ctx: WebUiPanelContext,
  param: ModelParameter,
  options: Record<string, unknown>,
): Control {
  const ui = ctx.ui;
  const field = ui.h('div', 'vx-field');
  const head = ui.h('div', 'vx-head');
  const label = PARAM_LABELS[param.name];
  if (label && label !== param.name) {
    head.append(ui.h('span', 'vx-label', label), ui.h('span', 'vx-name', param.name));
  } else {
    head.append(ui.h('span', 'vx-label', param.name));
  }
  field.append(head);

  const value = parameterValue(param, options);
  let read: Control['read'];

  switch (param.type) {
    case 'bool': {
      const box = ui.checkbox('', { checked: value === true });
      field.append(box.el);
      read = () => box.checked;
      break;
    }
    case 'enum': {
      const values = param.values ?? [];
      const current = textValue(value);
      const choices = [{ value: '', label: '—' }, ...values.map((item) => ({ value: item, label: item }))];
      if (current && !values.includes(current)) choices.push({ value: current, label: current });
      const select = ui.select({ options: choices, value: current });
      field.append(select);
      read = () => select.value || undefined;
      break;
    }
    case 'int':
    case 'float': {
      const input = ui.input({ type: 'number', value: numberValue(value) });
      if (param.min !== undefined) input.min = String(param.min);
      if (param.max !== undefined) input.max = String(param.max);
      // 浮点参数(尤其是 0–1 的强度/概率)用 0.01 步进,右侧调节才够细。
      input.step = param.type === 'int' ? '1' : '0.01';
      field.append(input);
      read = () => {
        const raw = input.value.trim();
        if (!raw) return undefined;
        const number = Number(raw);
        if (!Number.isFinite(number)) return undefined;
        return param.type === 'int' ? Math.trunc(number) : number;
      };
      break;
    }
    case 'string_list':
    case 'path_list': {
      const input = ui.input({ type: 'text', value: textValue(value) });
      field.append(input);
      read = () => {
        const list = input.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
        return list.length > 0 ? list : undefined;
      };
      break;
    }
    default: {
      const input = ui.input({ type: 'text', value: textValue(value) });
      field.append(input);
      read = () => input.value.trim() || undefined;
      break;
    }
  }

  if (param.description) field.append(ui.h('div', 'vx-desc', param.description));
  return { param, el: field, read };
}

function styleField(
  ctx: WebUiPanelContext,
  label: string,
  control: HTMLElement,
): HTMLElement {
  const field = ctx.ui.h('div', 'vx-field');
  const head = ctx.ui.h('div', 'vx-head');
  head.append(ctx.ui.h('span', 'vx-label', label));
  field.append(head, control);
  return field;
}

/** 模型的朗读风格;音色在上方的选择器里,这里不再重复。 */
function makeStyleFields(
  ctx: WebUiPanelContext,
  t: PanelText,
  style: VoiceModelStyle,
): StyleFields {
  const ui = ctx.ui;
  const grid = ui.h('div', 'vx-params');

  const emotionMode = ui.select({
    options: t.emotionModeOptions.map(({ value, label }) => ({ value, label })),
    value: style.emotionMode,
  });
  const defaultEmotion = ui.input({ type: 'text', value: style.defaultEmotion });
  const defaultInstruct = ui.input({ type: 'text', value: style.defaultInstruct });
  const speed = ui.input({ type: 'number', value: String(style.speed) });
  speed.min = '0.5';
  speed.max = '2';
  speed.step = '0.05';
  const paralinguistic = ui.select({
    options: t.paralinguisticOptions.map(({ value, label }) => ({ value, label })),
    value: style.paralinguistic,
  });

  grid.append(
    styleField(ctx, t.emotionMode, emotionMode),
    styleField(ctx, t.defaultEmotion, defaultEmotion),
    styleField(ctx, t.defaultInstruct, defaultInstruct),
    styleField(ctx, t.speed, speed),
    styleField(ctx, t.paralinguistic, paralinguistic),
  );

  return {
    el: grid,
    read: () => {
      const value = Number(speed.value);
      return {
        voice: style.voice,
        emotionMode: emotionMode.value as VoiceModelStyle['emotionMode'],
        defaultEmotion: defaultEmotion.value.trim(),
        defaultInstruct: defaultInstruct.value.trim(),
        speed: Number.isFinite(value) ? Math.min(2, Math.max(0.5, value)) : style.speed,
        paralinguistic: paralinguistic.value as VoiceModelStyle['paralinguistic'],
      };
    },
  };
}

function mountModel(ctx: WebUiPanelContext): void {
  const t = panelText(ctx.language);
  const ui = ctx.ui;
  let latest: PanelModelState | null = null;
  let selected = '';
  let controls: Control[] = [];
  let busy = false;

  const sheet = ui.sheet({ title: t.title });
  const top = ui.h('div', 'vx-top');
  const modelSelect = ui.select({ onChange: () => selectModel(modelSelect.value) });
  const voiceSelect = ui.select({});
  const modelPick = ui.h('label', 'vx-pick');
  modelPick.append(ui.h('span', 'vx-pick-label', t.model), modelSelect);
  const voicePick = ui.h('label', 'vx-pick');
  voicePick.append(ui.h('span', 'vx-pick-label', t.voice), voiceSelect);
  const refresh = ui.button(t.refresh, { size: 'sm', onClick: () => void load('refresh') });
  top.append(modelPick, voicePick, refresh);

  const styleSection = ui.section(t.styleTitle);
  const styleHost = ui.h('div', 'vx-section');
  const paramsSection = ui.section(t.paramsTitle);
  paramsSection.hidden = true;
  const params = ui.h('div', 'vx-params');
  const save = ui.button(t.save, { variant: 'primary', size: 'sm', onClick: () => void saveOptions() });
  const msg = ui.msgline();
  const actions = ui.actions();
  actions.append(save);
  sheet.body.append(top, styleSection, styleHost, paramsSection, params, actions, msg);
  ctx.root.append(sheet.el);

  const prompt = ui.foldSheet('voice-model-prompt', { title: t.promptTitle, defaultOpen: false });
  const promptText = ui.h('pre', 'vx-prompt');
  prompt.body.append(promptText);
  ctx.root.append(prompt.el);

  let styleFields: StyleFields | null = null;

  function option(value: string, label = value): HTMLOptionElement {
    const el = ui.h('option');
    el.value = value;
    el.textContent = label;
    return el;
  }

  function setMessage(text: string, bad: boolean): void {
    msg.textContent = text;
    msg.classList.toggle('bad', bad);
  }

  function applyEnabled(): void {
    const hasModels = latest !== null && latest.models.length > 0;
    modelSelect.disabled = busy || !hasModels;
    voiceSelect.disabled = busy || !hasModels || !selected;
    save.disabled = busy || !hasModels || !selected;
    refresh.disabled = busy;
  }

  function settingOf(id: string) {
    return latest?.settings?.[id];
  }

  function styleOf(id: string): VoiceModelStyle {
    return settingOf(id)?.style
      ?? (latest?.model === id ? latest.style : undefined)
      ?? EMPTY_STYLE;
  }

  function renderVoices(): void {
    const model = latest?.models.find((item) => item.id === selected);
    const voices = model?.voices ?? [];
    const current = settingOf(selected)?.voice
      ?? (latest?.model === selected ? latest.voice : '');
    const list = [...voices];
    if (current && !list.includes(current)) list.unshift(current);
    const choices = list.map((voice) => option(voice));
    if (!current) choices.unshift(option('', '—'));
    voiceSelect.replaceChildren(...(choices.length > 0 ? choices : [option('', '—')]));
    voiceSelect.value = current;
  }

  function renderStyle(): void {
    styleFields = makeStyleFields(ctx, t, styleOf(selected));
    styleHost.replaceChildren(styleFields.el);
  }

  function renderParams(): void {
    const model = latest?.models.find((item) => item.id === selected);
    const options = settingOf(selected)?.options
      ?? (latest?.model === selected ? latest.options : {});
    controls = [];
    params.replaceChildren();
    for (const param of model?.parameters ?? []) {
      const control = makeControl(ctx, param, options);
      controls.push(control);
      params.append(control.el);
    }
    paramsSection.hidden = (model?.parameters?.length ?? 0) === 0;
  }

  function renderPrompt(): void {
    const text = latest?.prompts?.[selected]
      ?? (latest?.model === selected ? latest.prompt : '');
    promptText.textContent = text;
    prompt.note.textContent = selected || '—';
  }

  function selectModel(value: string): void {
    selected = value;
    renderVoices();
    renderStyle();
    renderParams();
    renderPrompt();
    applyEnabled();
  }

  function paint(next: PanelModelState): void {
    latest = next;
    selected = next.model;
    renderTop();
    renderStyle();
    renderParams();
    renderPrompt();
    applyEnabled();
    setMessage(next.error ?? '', next.error !== undefined);
  }

  function renderTop(): void {
    const models = latest?.models ?? [];
    const choices = models.map((model) => option(model.id, model.label || model.id));
    if (!selected && models.length > 0) {
      choices.unshift(option('', '—'));
    } else if (selected && !models.some((model) => model.id === selected)) {
      choices.unshift(option(selected, selected));
    }
    modelSelect.replaceChildren(...choices);
    modelSelect.value = selected;
    renderVoices();
  }

  function currentOptions(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const control of controls) {
      const value = control.read();
      if (value !== undefined) out[control.param.name] = value;
    }
    return out;
  }

  function currentStyle(): VoiceModelStyle {
    return { ...(styleFields?.read() ?? styleOf(selected)), voice: voiceSelect.value };
  }

  async function load(method: 'state' | 'refresh'): Promise<void> {
    if (busy) return;
    busy = true;
    applyEnabled();
    setMessage(t.loading, false);
    try {
      const next = await ctx.invoke<PanelModelState>(method, []);
      if (!ctx.signal.aborted) paint(next);
    } catch (error) {
      if (!ctx.signal.aborted) setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      if (!ctx.signal.aborted) applyEnabled();
    }
  }

  async function saveOptions(): Promise<void> {
    if (busy || !latest) return;
    const payload: PanelModelSave = {
      model: selected,
      voice: voiceSelect.value,
      style: currentStyle(),
      options: currentOptions(),
    };
    busy = true;
    applyEnabled();
    setMessage('', false);
    try {
      const next = await ctx.invoke<PanelModelState>('save', [payload]);
      if (!ctx.signal.aborted) {
        paint(next);
        setMessage(t.saved, false);
      }
    } catch (error) {
      if (!ctx.signal.aborted) setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      if (!ctx.signal.aborted) applyEnabled();
    }
  }

  applyEnabled();
  void load('state');
}

const bundle: WebUiClientBundle = {
  panels: {
    model: { mount: mountModel },
  },
};

export default bundle;
