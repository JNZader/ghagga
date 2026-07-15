"""Entry point fixture. Imports greet from pkg.greeting by its module path
and calls the exported symbol."""
from pkg.greeting import greet

print(greet("ghagga"))
