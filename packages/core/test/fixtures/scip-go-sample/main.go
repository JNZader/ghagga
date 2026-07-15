// Command fixture is a minimal Go program used as a SCIP indexing fixture.
// It imports pkg by its full module path (example.com/fixture/pkg) and
// calls the exported symbol Greet defined there.
package main

import (
	"fmt"

	"example.com/fixture/pkg"
)

func main() {
	fmt.Println(pkg.Greet("ghagga"))
}
