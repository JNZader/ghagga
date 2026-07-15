// Entry point fixture. Imports greet from the greeting module and calls
// the exported symbol.
mod greeting;

fn main() {
    println!("{}", greeting::greet("ghagga"));
}
