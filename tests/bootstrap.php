<?php

declare(strict_types=1);

spl_autoload_register(static function (string $class): void {
    $prefix = 'OCA\\Ifcviewer\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }

    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/../lib/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require_once $path;
    }
});
