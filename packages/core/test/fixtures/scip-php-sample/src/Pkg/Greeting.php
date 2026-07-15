<?php

declare(strict_types=1);

namespace ScipPhpSample\Pkg;

class Greeting
{
    public function greet(string $name): string
    {
        return "Hello, {$name}!";
    }
}
