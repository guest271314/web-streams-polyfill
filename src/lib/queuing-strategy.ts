/**
 * Returns the size of a chunk.
 *
 * @public
 */
export type QueuingStrategySizeCallback<T = any> = (chunk: T) => number;

/**
 * A queuing strategy is an object that determines how a stream should signal backpressure
 * based on the state of its internal queue.
 *
 * @public
 */
export interface QueuingStrategy<T = any> {
  /**
   * The maximum size of the internal queue before backpressure is applied,
   * in the same units as returned by {@link QueuingStrategy.size}.
   */
  highWaterMark?: number;
  /**
   * A function that returns the size of each chunk.
   */
  size?: QueuingStrategySizeCallback<T>;
}
