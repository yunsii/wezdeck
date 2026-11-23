// The image flow on the architecture page (see flows.ts for the rules):
// images go to the host compressed by the phone, come back as original bytes,
// and the page makes its own thumbnails — the host never decodes an image.
import type { Diagram } from './model'
import { DEVICE, WSL } from './lanes'

export const imageFlow: Diagram = {
  id: 'images',
  title: { zh: '图片的来回', en: 'Images, both ways' },
  summary: {
    zh: '图片在手机上压缩后上传，回看时主机只发原图字节，缩略图由页面自己生成；主机不解码任何图片。',
    en: 'Images are compressed on the phone before upload; to show them the host sends only the original bytes and the page makes its own thumbnails. The host never decodes an image.',
  },
  numbered: true,
  lanes: [DEVICE, WSL],
  cards: [
    {
      id: 'pick',
      lane: 'device',
      row: 0,
      title: { zh: '选图或粘贴', en: 'Pick or paste' },
      sub: { zh: '先在手机上压缩', en: 'Compressed on the phone first' },
      body: {
        zh: '手机截图动辄几 MB 的 PNG，上传前在浏览器里缩到长边 1600 px 的 JPEG，Agent 照样看得清。',
        en: 'A phone screenshot is megabytes of PNG; the browser shrinks it to a 1600 px JPEG first, which the agent reads just as well.',
      },
      impl: {
        zh: 'web/src/lib/upload.ts（shrinkImage）。',
        en: 'web/src/lib/upload.ts (shrinkImage).',
      },
    },
    {
      id: 'upload',
      lane: 'device',
      row: 1,
      title: { zh: '分块上传', en: 'Upload in chunks' },
      sub: {
        zh: '签名写入，每个文件 ≤ 8 MB',
        en: 'Signed writes, ≤ 8 MB a file',
      },
      body: {
        zh: '和发消息一样是签名写入，按块发送，适配 DataChannel 单条消息的大小上限。',
        en: 'A signed write like a message, sent in chunks to fit a DataChannel message.',
      },
      impl: {
        zh: 'upload 写入 → remote_upload.go uploadChunk。',
        en: 'upload write → remote_upload.go uploadChunk.',
      },
    },
    {
      id: 'store',
      lane: 'wsl',
      row: 1,
      title: { zh: '存在主机上', en: 'Kept on the host' },
      sub: { zh: '保留 30 天', en: 'Kept 30 days' },
      body: {
        zh: '最后一块到达后写成 img-* 文件，30 天后清理。',
        en: 'The last chunk writes an img-* file; files older than 30 days are pruned.',
      },
      impl: {
        zh: '~/.local/state/wezdeck/remote-uploads。',
        en: '~/.local/state/wezdeck/remote-uploads.',
      },
    },
    {
      id: 'note',
      lane: 'wsl',
      row: 2,
      title: { zh: '随消息交给 Agent', en: 'Handed to the agent' },
      sub: { zh: '附上文件路径', en: 'With the file path' },
      body: {
        zh: '发送时消息末尾加一段「[手机附件]」和文件路径，Agent 自己去读这个文件。',
        en: 'The message gets a “[手机附件]” block with the file path, and the agent reads the file itself.',
      },
      impl: {
        zh: 'remote_upload.go attachmentNote。',
        en: 'remote_upload.go attachmentNote.',
      },
    },
    {
      id: 'ask',
      lane: 'device',
      row: 3,
      title: { zh: '回看时取原图', en: 'Fetch the original to show it' },
      sub: { zh: '48 KB 一块', en: '48 KB at a time' },
      body: {
        zh: '对话里的附件和转录里的截图（粘贴的图片、工具读到的图片）都按块取回原图；工具里的图片只在展开时才取。',
        en: 'Attachments and transcript images (pasted at the desk, read by a tool) come back as the original in chunks; tool images only once the call is opened.',
      },
      impl: {
        zh: 'upload.get {name, offset}、session.image {id, ref, offset}；lib/upload-image.ts。',
        en: 'upload.get {name, offset}, session.image {id, ref, offset}; lib/upload-image.ts.',
      },
    },
    {
      id: 'bytes',
      lane: 'wsl',
      row: 3,
      title: { zh: '只发字节', en: 'Bytes only' },
      sub: { zh: '主机不解码图片', en: 'The host decodes nothing' },
      body: {
        zh: '主机只读文件、切块发送。解码交给浏览器：既能显示 webp，也不会因为一张声明超大尺寸的图片把主机内存撑爆。',
        en: 'The host reads the file and sends it in chunks. Decoding is the browser’s: it shows webp, and an image that declares a huge size cannot exhaust the host’s memory.',
      },
      impl: {
        zh: 'remote_upload_get.go serveImage。',
        en: 'remote_upload_get.go serveImage.',
      },
    },
    {
      id: 'thumb',
      lane: 'device',
      row: 4,
      title: { zh: '页面生成缩略图', en: 'The page makes the thumbnail' },
      sub: {
        zh: '长边 720 px，存进本地缓存',
        en: '720 px, kept in the local cache',
      },
      body: {
        zh: '浏览器解码原图，缩成小 JPEG 显示在对话里，并存进本地缓存，下次打开不用再取。',
        en: 'The browser decodes the original, scales it to a small JPEG for the conversation and caches it, so the next visit needs no fetch.',
      },
      impl: {
        zh: 'createImageBitmap + canvas（makeThumb）；持久化查询缓存。',
        en: 'createImageBitmap + canvas (makeThumb); the persisted query cache.',
      },
    },
    {
      id: 'view',
      lane: 'device',
      row: 5,
      title: { zh: '点开看原图', en: 'Tap for the original' },
      sub: { zh: '直接复用已取回的原图', en: 'Reuses the fetched original' },
      body: {
        zh: '查看器先用缩略图占位，原图本页已经取过，直接显示；可切换实际大小、左右翻看。',
        en: 'The viewer shows the thumbnail first; the original is already on the page and appears at once, with actual size and paging.',
      },
      impl: {
        zh: 'features/image-viewer.tsx。',
        en: 'features/image-viewer.tsx.',
      },
    },
  ],
  links: [
    { from: 'pick', to: 'upload' },
    {
      from: 'upload',
      to: 'store',
      label: { zh: '签名写入', en: 'signed write' },
    },
    { from: 'store', to: 'note' },
    { from: 'ask', to: 'bytes', kind: 'data' },
    { from: 'bytes', to: 'thumb', kind: 'data' },
    { from: 'thumb', to: 'view' },
  ],
}
