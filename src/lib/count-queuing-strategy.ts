import { QueuingStrategy } from './queuing-strategy';

/**
 * A queuing strategy that counts the chunks.
 *
 * @public
 */
export default class CountQueuingStrategy implements QueuingStrategy<any> {
  readonly highWaterMark!: number;

  constructor({ highWaterMark }: { highWaterMark: number }) {
    this.highWaterMark = highWaterMark;
  }

  /**
   * Returns `1`.
   */
  size(): 1 {
    return 1;
  }
}
