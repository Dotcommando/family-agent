import type { BrowserContext, Page } from 'playwright'
import { BrowserActionKind } from './types.js'
import type {
  IBrowserAction,
  IBrowserObservation,
  IBrowserConfig,
  IStabilizeResult,
  IOpenUrlParams,
  ISearchWebParams,
  IClickParams,
  IFillParams,
  IPressParams,
  ISelectOptionParams,
  IWaitForSelectorParams,
  IWaitForTextParams,
  IExtractTextParams,
  IFinalAnswerParams,
  IPageButton,
  IPageLink,
  IFormField,
} from './types.js'
import { isRecord } from '../lib/type-utils.js'

const MAX_TEXT_LENGTH = 4000
const MAX_LINKS = 15
const MAX_BUTTONS = 15
const MAX_FORM_FIELDS = 15

function isOpenUrlParams(p: unknown): p is IOpenUrlParams {
  return isRecord(p) && typeof p['url'] === 'string'
}

function isSearchWebParams(p: unknown): p is ISearchWebParams {
  return isRecord(p) && typeof p['query'] === 'string'
}

function isClickParams(p: unknown): p is IClickParams {
  return isRecord(p) && typeof p['selector'] === 'string' && !('value' in p) && !('key' in p) && !('text' in p) && !('timeout' in p)
}

function isFillParams(p: unknown): p is IFillParams {
  return isRecord(p) && typeof p['selector'] === 'string' && typeof p['value'] === 'string'
}

function isPressParams(p: unknown): p is IPressParams {
  if (!isRecord(p) || typeof p['key'] !== 'string') return false
  if ('selector' in p && typeof p['selector'] !== 'string') return false
  return true
}

function isSelectOptionParams(p: unknown): p is ISelectOptionParams {
  return isRecord(p) && typeof p['selector'] === 'string' && typeof p['value'] === 'string'
}

function isWaitForSelectorParams(p: unknown): p is IWaitForSelectorParams {
  return isRecord(p) && typeof p['selector'] === 'string' && !('value' in p) && !('key' in p)
}

function isWaitForTextParams(p: unknown): p is IWaitForTextParams {
  return isRecord(p) && typeof p['text'] === 'string'
}

function isExtractTextParams(p: unknown): p is IExtractTextParams {
  return isRecord(p) && (p['selector'] === undefined || typeof p['selector'] === 'string')
}

function isFinalAnswerParams(p: unknown): p is IFinalAnswerParams {
  return isRecord(p) && typeof p['answer'] === 'string'
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const pages = context.pages()
  return pages[0] ?? await context.newPage()
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

interface IExtractPageTextResult {
  text: string
  found: boolean
}

async function extractPageText(page: Page, selector?: string): Promise<IExtractPageTextResult> {
  try {
    if (selector) {
      const target = await page.$(selector)
      if (!target) return { text: '', found: false }
      const raw = await target.innerText()
      return { text: truncate(raw.trim(), MAX_TEXT_LENGTH), found: true }
    }
    const raw = await page.evaluate(() => document.body.innerText)
    return { text: truncate(raw.trim(), MAX_TEXT_LENGTH), found: true }
  } catch {
    return { text: '', found: false }
  }
}

async function extractLinks(page: Page): Promise<ReadonlyArray<IPageLink>> {
  try {
    const links: IPageLink[] = await page.evaluate((max) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'))
      const results: { text: string; href: string; selector: string }[] = []
      for (const a of anchors) {
        if (!(a instanceof HTMLAnchorElement)) continue
        const text = (a.textContent ?? '').trim()
        const href = a.getAttribute('href') ?? ''
        if (text && href && !href.startsWith('javascript:')) {
          const id = a.id ? `#${a.id}` : ''
          const sel = id || (href ? `a[href="${href.slice(0, 200)}"]` : '')
          results.push({ text: text.slice(0, 80), href: href.slice(0, 200), selector: sel })
          if (results.length >= max) break
        }
      }
      return results
    }, MAX_LINKS)
    return links
  } catch {
    return []
  }
}

async function extractButtons(page: Page): Promise<ReadonlyArray<IPageButton>> {
  try {
    const buttons: IPageButton[] = await page.evaluate((max) => {
      const els = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
      const results: { text: string; selector: string }[] = []
      for (const el of els) {
        if (!(el instanceof HTMLElement)) continue
        const text = (el.textContent ?? (el instanceof HTMLInputElement ? el.value : '') ?? '').trim()
        if (text) {
          const id = el.id ? `#${el.id}` : ''
          const name = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? (el.name || '') : ''
          const sel = id || (name ? `[name="${name}"]` : '')
          results.push({ text: text.slice(0, 80), selector: sel })
          if (results.length >= max) break
        }
      }
      return results
    }, MAX_BUTTONS)
    return buttons
  } catch {
    return []
  }
}

async function extractFormFields(page: Page): Promise<ReadonlyArray<IFormField>> {
  try {
    const fields: IFormField[] = await page.evaluate((max) => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      const results: { label: string; type: string; selector: string }[] = []
      for (const el of inputs) {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) continue
        const type = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase()
        if (type === 'hidden') continue
        const name = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? (el.name || el.id || '') : ''
        const placeholder = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.placeholder || '') : ''
        const label = name || placeholder || type
        const id = el.id ? `#${el.id}` : name ? `[name="${name}"]` : ''
        if (id) {
          results.push({ label: label.slice(0, 80), type, selector: id })
          if (results.length >= max) break
        }
      }
      return results
    }, MAX_FORM_FIELDS)
    return fields
  } catch {
    return []
  }
}

function makeBaseObservation(action: BrowserActionKind, url: string): Pick<IBrowserObservation, 'action' | 'url' | 'title'> {
  return { action, url, title: '' }
}

async function fillTitle(obs: IBrowserObservation, page: Page): Promise<IBrowserObservation> {
  try {
    const title = await page.title()
    return { ...obs, title }
  } catch {
    return obs
  }
}

async function enrichObservation(obs: IBrowserObservation, page: Page): Promise<IBrowserObservation> {
  const withTitle = await fillTitle(obs, page)
  try {
    const links = await extractLinks(page)
    const buttons = await extractButtons(page)
    const formFields = await extractFormFields(page)
    return { ...withTitle, links, buttons, formFields }
  } catch {
    return withTitle
  }
}

async function isSubmitTarget(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.evaluate((sel: string) => {
      const el = document.querySelector(sel)
      if (!el) return false
      if (el instanceof HTMLButtonElement && el.type === 'submit') return true
      if (el instanceof HTMLInputElement && el.type === 'submit') return true
      if (el instanceof HTMLButtonElement && !el.type) return true
      const form = el.closest('form')
      if (form && form.querySelector('button[type="submit"], input[type="submit"]') === el) return true
      return false
    }, selector)
  } catch {
    return false
  }
}

async function isInsideForm(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.evaluate((sel: string) => {
      const el = document.querySelector(sel)
      return el !== null && el.closest('form') !== null
    }, selector)
  } catch {
    return false
  }
}

const STABILIZE_TIMEOUT_NORMAL = 3000
const STABILIZE_TIMEOUT_SUBMIT = 6000
const STABILIZE_SETTLE_DELAY = 200
const STABILIZE_DOM_POLL_INTERVAL = 150
const STABILIZE_DOM_POLL_ROUNDS = 3

async function stabilizePage(page: Page, beforeUrl: string, submitLike: boolean): Promise<IStabilizeResult> {
  const timeout = submitLike ? STABILIZE_TIMEOUT_SUBMIT : STABILIZE_TIMEOUT_NORMAL
  let settled = 'timeout'

  const urlChanged = (): boolean => {
    try { return page.url() !== beforeUrl } catch { return false }
  }

  if (urlChanged()) {
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {})
    settled = 'navigation'
  }

  if (settled === 'timeout') {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 2000) }).catch(() => {})
  }

  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 2000) }).catch(() => {})

  try {
    let prevSnapshot = await page.evaluate(() => document.body.innerText.length)
    let stableRounds = 0
    for (let i = 0; i < STABILIZE_DOM_POLL_ROUNDS; i++) {
      await page.waitForTimeout(STABILIZE_DOM_POLL_INTERVAL)
      const snapshot = await page.evaluate(() => document.body.innerText.length)
      if (snapshot === prevSnapshot) {
        stableRounds++
      } else {
        stableRounds = 0
        prevSnapshot = snapshot
      }
      if (stableRounds >= 2) {
        settled = settled === 'timeout' ? 'dom-stable' : settled
        break
      }
    }
  } catch {}

  await page.waitForTimeout(STABILIZE_SETTLE_DELAY)

  const navigated = urlChanged()
  if (navigated && settled === 'timeout') settled = 'navigation'

  return { navigated, settled }
}

async function executeOpenUrl(
  context: BrowserContext,
  params: IOpenUrlParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  const prevUrl = page.url()
  try {
    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: config.defaultTimeout })
    const { text } = await extractPageText(page)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.OpenUrl, page.url()), success: true, text, navigated: page.url() !== prevUrl }
    return enrichObservation(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.OpenUrl, page.url()), success: false, text: '', error: errMsg }
    return fillTitle(obs, page)
  }
}

async function executeSearchWeb(
  context: BrowserContext,
  params: ISearchWebParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const url = config.searchEngineUrl.replace('{query}', encodeURIComponent(params.query))
  return executeOpenUrl(context, { url }, config)
}

async function executeClick(
  context: BrowserContext,
  params: IClickParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  const beforeUrl = page.url()
  try {
    const locator = page.locator(params.selector)
    const count = await locator.count()
    if (count === 0) {
      const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Click, page.url()), success: false, text: '', error: `No element matches selector "${params.selector}" (0 found)` }
      return fillTitle(obs, page)
    }
    if (count > 1) {
      console.log(`[browser-action] click: selector "${params.selector}" matched ${count} elements, using first`)
    }
    const target = locator.first()
    const visible = await target.isVisible().catch(() => false)
    if (!visible) {
      const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Click, page.url()), success: false, text: '', error: `Element "${params.selector}" found but not visible` }
      return fillTitle(obs, page)
    }
    const enabled = await target.isEnabled().catch(() => true)
    if (!enabled) {
      const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Click, page.url()), success: false, text: '', error: `Element "${params.selector}" found but disabled` }
      return fillTitle(obs, page)
    }
    const submitLikely = await isSubmitTarget(page, params.selector)
    await target.click({ timeout: config.defaultTimeout })
    const stabilize = await stabilizePage(page, beforeUrl, submitLikely)
    const { text } = await extractPageText(page)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Click, page.url()), success: true, text, navigated: stabilize.navigated }
    return enrichObservation(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const detail = errMsg.includes('intercept') ? `click("${params.selector}") intercepted: ${errMsg}`
      : errMsg.includes('timeout') ? `click("${params.selector}") timeout: ${errMsg}`
      : `click("${params.selector}") failed: ${errMsg}`
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Click, page.url()), success: false, text: '', error: detail }
    return fillTitle(obs, page)
  }
}

async function executeFill(
  context: BrowserContext,
  params: IFillParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  try {
    await page.fill(params.selector, params.value, { timeout: config.defaultTimeout })
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Fill, page.url()), success: true, text: `Filled "${params.selector}" with value.` }
    return fillTitle(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Fill, page.url()), success: false, text: '', error: errMsg }
    return fillTitle(obs, page)
  }
}

interface IActiveElementInfo {
  tag: string
  interactive: boolean
  inForm: boolean
}

async function getActiveElementInfo(page: Page): Promise<IActiveElementInfo | undefined> {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body || el === document.documentElement) return null
      const tag = el.tagName.toLowerCase()
      const interactive = tag === 'input' || tag === 'textarea' || tag === 'select'
        || tag === 'button' || tag === 'a'
        || (el instanceof HTMLElement && el.isContentEditable)
        || el.getAttribute('role') === 'button'
        || el.getAttribute('role') === 'textbox'
        || el.getAttribute('tabindex') !== null
      const inForm = el.closest('form') !== null
      return { tag, interactive, inForm }
    }) ?? undefined
  } catch {
    return undefined
  }
}

async function executePress(
  context: BrowserContext,
  params: IPressParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  const beforeUrl = page.url()
  try {
    if (params.selector) {
      const locator = page.locator(params.selector)
      const count = await locator.count()
      if (count === 0) {
        const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Press, page.url()), success: false, text: '', error: `No element matches selector "${params.selector}" for focus (0 found)` }
        return fillTitle(obs, page)
      }
      await locator.first().focus({ timeout: config.defaultTimeout })
    } else {
      const active = await getActiveElementInfo(page)
      if (!active) {
        const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Press, page.url()), success: false, text: '', error: `press("${params.key}") without selector: no active element on page (focus is on <body> or null)` }
        return fillTitle(obs, page)
      }
      if (!active.interactive) {
        const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Press, page.url()), success: false, text: '', error: `press("${params.key}") without selector: active element <${active.tag}> is not interactive` }
        return fillTitle(obs, page)
      }
    }
    const isEnter = params.key.toLowerCase() === 'enter'
    const activeForSubmit = isEnter && !params.selector ? await getActiveElementInfo(page) : undefined
    const submitLikely = isEnter && (params.selector
      ? (await isSubmitTarget(page, params.selector) || await isInsideForm(page, params.selector))
      : activeForSubmit?.inForm === true)
    await page.keyboard.press(params.key)
    const stabilize = await stabilizePage(page, beforeUrl, submitLikely)
    const { text } = await extractPageText(page)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Press, page.url()), success: true, text, navigated: stabilize.navigated }
    return enrichObservation(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.Press, page.url()), success: false, text: '', error: `press("${params.key}") failed: ${errMsg}` }
    return fillTitle(obs, page)
  }
}

async function executeSelectOption(
  context: BrowserContext,
  params: ISelectOptionParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  try {
    await page.selectOption(params.selector, params.value, { timeout: config.defaultTimeout })
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.SelectOption, page.url()), success: true, text: `Selected "${params.value}" in "${params.selector}".` }
    return fillTitle(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.SelectOption, page.url()), success: false, text: '', error: errMsg }
    return fillTitle(obs, page)
  }
}

async function executeWaitForSelector(
  context: BrowserContext,
  params: IWaitForSelectorParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  const timeout = params.timeout ?? config.defaultTimeout
  try {
    await page.waitForSelector(params.selector, { timeout })
    const { text } = await extractPageText(page)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.WaitForSelector, page.url()), success: true, text }
    return enrichObservation(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.WaitForSelector, page.url()), success: false, text: '', error: errMsg }
    return fillTitle(obs, page)
  }
}

async function executeWaitForText(
  context: BrowserContext,
  params: IWaitForTextParams,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  const timeout = params.timeout ?? config.defaultTimeout
  try {
    await page.waitForFunction(
      (t: string) => document.body.innerText.includes(t),
      params.text,
      { timeout },
    )
    const { text } = await extractPageText(page)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.WaitForText, page.url()), success: true, text }
    return enrichObservation(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.WaitForText, page.url()), success: false, text: '', error: errMsg }
    return fillTitle(obs, page)
  }
}

async function executeExtractText(
  context: BrowserContext,
  params: IExtractTextParams,
): Promise<IBrowserObservation> {
  const page = await getOrCreatePage(context)
  try {
    const result = await extractPageText(page, params.selector)
    if (params.selector && !result.found) {
      const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.ExtractText, page.url()), success: false, text: '', error: `Selector "${params.selector}" not found on page` }
      return fillTitle(obs, page)
    }
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.ExtractText, page.url()), success: true, text: result.text }
    return enrichObservation(obs, page)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const obs: IBrowserObservation = { ...makeBaseObservation(BrowserActionKind.ExtractText, page.url()), success: false, text: '', error: errMsg }
    return fillTitle(obs, page)
  }
}

export async function executeBrowserAction(
  context: BrowserContext,
  action: IBrowserAction,
  config: IBrowserConfig,
): Promise<IBrowserObservation> {
  const kind = action.action
  const p: unknown = action.params

  switch (kind) {
    case BrowserActionKind.OpenUrl:
      if (isOpenUrlParams(p)) return executeOpenUrl(context, p, config)
      break
    case BrowserActionKind.SearchWeb:
      if (isSearchWebParams(p)) return executeSearchWeb(context, p, config)
      break
    case BrowserActionKind.Click:
      if (isClickParams(p)) return executeClick(context, p, config)
      break
    case BrowserActionKind.Fill:
      if (isFillParams(p)) return executeFill(context, p, config)
      break
    case BrowserActionKind.Press:
      if (isPressParams(p)) return executePress(context, p, config)
      break
    case BrowserActionKind.SelectOption:
      if (isSelectOptionParams(p)) return executeSelectOption(context, p, config)
      break
    case BrowserActionKind.WaitForSelector:
      if (isWaitForSelectorParams(p)) return executeWaitForSelector(context, p, config)
      break
    case BrowserActionKind.WaitForText:
      if (isWaitForTextParams(p)) return executeWaitForText(context, p, config)
      break
    case BrowserActionKind.ExtractText:
      if (isExtractTextParams(p)) return executeExtractText(context, p)
      break
    case BrowserActionKind.FinalAnswer:
      if (isFinalAnswerParams(p)) {
        return {
          action: BrowserActionKind.FinalAnswer,
          success: true,
          url: '',
          title: '',
          text: p.answer,
        }
      }
      break
  }

  return {
    action: kind,
    success: false,
    url: '',
    title: '',
    text: '',
    error: `Invalid params for action "${kind}"`,
  }
}
