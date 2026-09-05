// The studio is browser code and its tsconfig has no Node types; this test reads a
// fixture from disk, so declare the one function it needs, as examples/test does.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
