export enum BrowserActionKind {
  OpenUrl = 'open_url',
  SearchWeb = 'search_web',
  Click = 'click',
  Fill = 'fill',
  Press = 'press',
  SelectOption = 'select_option',
  WaitForSelector = 'wait_for_selector',
  WaitForText = 'wait_for_text',
  ExtractText = 'extract_text',
  FinalAnswer = 'final_answer',
}

export interface IOpenUrlParams {
  url: string
}

export interface ISearchWebParams {
  query: string
}

export interface IClickParams {
  selector: string
}

export interface IFillParams {
  selector: string
  value: string
}

export interface IPressParams {
  key: string
  selector?: string
}

export interface ISelectOptionParams {
  selector: string
  value: string
}

export interface IWaitForSelectorParams {
  selector: string
  timeout?: number
}

export interface IWaitForTextParams {
  text: string
  timeout?: number
}

export interface IExtractTextParams {
  selector?: string
}

export interface IFinalAnswerParams {
  answer: string
  nextStep?: string
  suppressReply?: boolean
}

export interface IBrowserAction {
  action: BrowserActionKind
  params: Record<string, unknown>
}

export interface IFormField {
  label: string
  type: string
  selector: string
}

export interface IPageButton {
  text: string
  selector: string
}

export interface IPageLink {
  text: string
  href: string
  selector: string
}

export interface IBrowserObservation {
  action: BrowserActionKind
  success: boolean
  url: string
  title: string
  text: string
  error?: string
  links?: ReadonlyArray<IPageLink>
  formFields?: ReadonlyArray<IFormField>
  buttons?: ReadonlyArray<IPageButton>
  navigated?: boolean
}

export interface IStabilizeResult {
  navigated: boolean
  settled: string
}

export interface IBrowserConfig {
  profileDir: string
  headless: boolean
  defaultTimeout: number
  maxStepsPerRun: number
  searchEngineUrl: string
}
