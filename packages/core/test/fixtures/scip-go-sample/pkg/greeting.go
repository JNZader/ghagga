// Package pkg provides a tiny symbol that another file in this fixture
// imports via its full module path (example.com/fixture/pkg), not a
// relative path. This is the exact cross-file reference shape that a
// regex-based import extractor cannot resolve, but scip-go can.
package pkg

// Greet returns a friendly greeting for the given name.
func Greet(name string) string {
	return "Hello, " + name + "!"
}
