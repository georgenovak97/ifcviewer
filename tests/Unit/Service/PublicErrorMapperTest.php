<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Tests\Unit\Service;

use OCA\Ifcviewer\Service\PublicErrorMapper;
use PHPUnit\Framework\TestCase;

class PublicErrorMapperTest extends TestCase {
    private PublicErrorMapper $mapper;

    protected function setUp(): void {
        parent::setUp();
        $this->mapper = new PublicErrorMapper();
    }

    public function testSanitizeStatusKeepsReadyState(): void {
        $status = ['state' => 'ready', 'progress' => 100];
        self::assertSame($status, $this->mapper->sanitizeStatus($status));
    }

    public function testSanitizeStatusMapsInternalErrorToFallback(): void {
        $status = $this->mapper->sanitizeStatus([
            'state' => 'error',
            'progress' => 0,
            'message' => 'Failed to read converted cache file at /var/www/...',
        ]);

        self::assertSame(PublicErrorMapper::PUBLIC_FALLBACK, $status['message']);
    }

    public function testSanitizeMessageKeepsFileTooLargeCode(): void {
        $message = 'Файл слишком большой (600 МБ). Максимальный поддерживаемый размер IFC: 500 МБ.';
        self::assertSame(
            $message,
            $this->mapper->sanitizeMessage($message, 'file_too_large'),
        );
    }

    public function testSanitizeMessageKeepsUserFacingConversionErrors(): void {
        $message = 'Конвертация IFC прервана: слишком сложная или повреждённая геометрия.';
        self::assertSame($message, $this->mapper->sanitizeMessage($message));
    }

    public function testSanitizeMessageHidesPhpExceptionDetails(): void {
        self::assertSame(
            PublicErrorMapper::PUBLIC_FALLBACK,
            $this->mapper->sanitizeMessage('RuntimeException: fopen(): Permission denied'),
        );
    }
}
