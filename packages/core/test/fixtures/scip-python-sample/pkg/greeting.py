"""Provides a tiny symbol that another file in this fixture imports via its
module path. This is the cross-file reference shape captured for the mapper
test."""


def greet(name: str) -> str:
    return f"Hello, {name}!"
