<?php

declare(strict_types=1);

namespace ScipPhpSample;

use ScipPhpSample\Pkg\Greeting;

class Main
{
    public static function run(): string
    {
        $greeting = new Greeting();
        return $greeting->greet('world');
    }
}
