// Off-main-thread Shiki tokenizer so opening 200+ line files never triggers
// 180-280 ms main-thread longtasks during sheet transitions.
import { highlightLinesCore } from './highlight-core'
import type { Token } from './highlight-core'

type HighlightRequest = {
  id: number
  lines: Array<string>
  lang: string
}

type HighlightResponse = {
  id: number
  tokens: Array<Array<Token>> | null
}

const workerSelf = globalThis as unknown as {
  addEventListener: (
    type: 'message',
    listener: (ev: MessageEvent<HighlightRequest>) => void,
  ) => void
  postMessage: (msg: HighlightResponse) => void
}

workerSelf.addEventListener('message', (ev) => {
  const { id, lines, lang } = ev.data
  void highlightLinesCore(lines, lang).then(
    (tokens) => workerSelf.postMessage({ id, tokens }),
    () => workerSelf.postMessage({ id, tokens: null }),
  )
})
