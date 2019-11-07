/// <reference lib="esnext.asynciterable" />

export let AsyncIteratorPrototype: AsyncIterable<any> | undefined;

if (typeof Symbol.asyncIterator === 'symbol') {
  // We're running inside a ES2018+ environment, but we're compiling to an older syntax.
  // We cannot access %AsyncIteratorPrototype% without non-ES2018 syntax, but we can re-create it.
  AsyncIteratorPrototype = {
    // 25.1.3.1 %AsyncIteratorPrototype% [ @@asyncIterator ] ( )
    // https://tc39.github.io/ecma262/#sec-asynciteratorprototype-asynciterator
    [Symbol.asyncIterator]() {
      return this as any;
    }
  };
  Object.defineProperty(AsyncIteratorPrototype, Symbol.asyncIterator, { enumerable: false });
}
