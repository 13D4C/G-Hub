import { randomBytes } from 'node:crypto'

const MACHINE = randomBytes(5)
let counter = randomBytes(3).readUIntBE(0, 3)

export function newObjectId(): string {
  const buf = Buffer.alloc(12)
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), 0)
  MACHINE.copy(buf, 4)
  counter = (counter + 1) % 0xffffff
  buf.writeUIntBE(counter, 9, 3)
  return buf.toString('hex')
}
