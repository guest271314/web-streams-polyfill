import { ReadableStreamDefaultControllerType } from './default-controller';
import { ReadableByteStreamControllerType } from './byte-stream-controller';

/** @public */
export type ReadableStreamDefaultControllerCallback<R>
  = (controller: ReadableStreamDefaultControllerType<R>) => void | PromiseLike<void>;
/** @public */
export type ReadableByteStreamControllerCallback
  = (controller: ReadableByteStreamControllerType) => void | PromiseLike<void>;
/** @public */
export type ReadableStreamErrorCallback
  = (reason: any) => void | PromiseLike<void>;

/** @public */
export interface UnderlyingSource<R = any> {
  /**
   * A function that is called immediately during creation of the {@link ReadableStream}.
   */
  start?: ReadableStreamDefaultControllerCallback<R>;
  /**
   * A function that is called whenever the stream’s internal queue of chunks becomes not full,
   * i.e. whenever the queue’s desired size becomes positive. Generally, it will be called repeatedly
   * until the queue reaches its high water mark (i.e. until the desired size becomes non-positive).
   */
  pull?: ReadableStreamDefaultControllerCallback<R>;
  /**
   * A function that is called whenever the consumer cancels the stream, via
   * `stream.cancel()`, `defaultReader.cancel()`, or `byobReader.cancel()`.
   * It takes as its argument the same value as was passed to those methods by the consumer.
   */
  cancel?: ReadableStreamErrorCallback;
  type?: undefined;
}

/** @public */
export interface UnderlyingByteSource {
  /**
   * {@inheritDoc UnderlyingSource.start}
   */
  start?: ReadableByteStreamControllerCallback;
  /**
   * {@inheritDoc UnderlyingSource.pull}
   */
  pull?: ReadableByteStreamControllerCallback;
  /**
   * {@inheritDoc UnderlyingSource.cancel}
   */
  cancel?: ReadableStreamErrorCallback;
  /**
   * Can be set to "bytes" to signal that the constructed {@link ReadableStream} is a readable byte stream.
   * This ensures that the resulting {@link ReadableStream} will successfully be able to vend BYOB readers via its
   * {@link ReadableStream.(getReader:1) | getReader()} method.
   * It also affects the controller argument passed to the {@link UnderlyingByteSource.start | start()}
   * and {@link UnderlyingByteSource.pull | pull()} methods.
   */
  type: 'bytes';
  /**
   * Can be set to a positive integer to cause the implementation to automatically allocate buffers for the
   * underlying source code to write into. In this case, when a consumer is using a default reader, the stream
   * implementation will automatically allocate an ArrayBuffer of the given size, so that
   * `controller.byobRequest` is always present, as if the consumer was using a BYOB reader.
   */
  autoAllocateChunkSize?: number;
}
