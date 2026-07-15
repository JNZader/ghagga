// Provides a tiny symbol that another file in this fixture imports via a
// relative module path. This is the cross-file reference shape captured
// for the mapper test.
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
