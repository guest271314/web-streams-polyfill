import { QueuingStrategy } from './queuing-strategy';

/**
 * A queuing strategy that counts the number of bytes in each chunk.
 *
 * @public
 */
export default class ByteLengthQueuingStrategy implements QueuingStrategy<ArrayBufferView> {
  readonly highWaterMark!: number;

  constructor({ highWaterMark }: { highWaterMark: number }) {
    this.highWaterMark = highWaterMark;
  }

  /**
   * Returns the chunk's `byteLength`.
   */
  size(chunk: ArrayBufferView): number {
    return chunk.byteLength;
  }
}
