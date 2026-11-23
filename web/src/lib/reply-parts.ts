// A host reply over 200 KB arrives in `part` frames (Chrome takes 256 KiB per
// DataChannel message; native/wezdeck-wsl/relay_parts.go):
//   {t:"part", id, seq, total, data}   data = a slice of the reply's JSON text
// join the slices, then the caller handles the result as the frame it was.

type Slices = Array<string | undefined>

export class ReplyParts {
  private open = new Map<string, Slices>()

  /** the joined JSON text once every slice of `id` is in, else null */
  add(frame: Record<string, unknown>): string | null {
    const id = String(frame.id ?? '')
    const total = Number(frame.total)
    const seq = Number(frame.seq)
    if (!id || !(total > 0) || !(seq >= 0 && seq < total)) return null
    // filled, not new Array(total): some() skips the holes of a sparse
    // array, so the first slice alone looked complete
    const slices: Slices =
      this.open.get(id) ?? Array.from({ length: total }, () => undefined)
    slices[seq] = String(frame.data ?? '')
    this.open.set(id, slices)
    if (slices.includes(undefined)) return null
    this.open.delete(id)
    return slices.join('')
  }

  drop(id: string) {
    this.open.delete(id)
  }
}
