<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Service;

class PublicErrorMapper {
    public const PUBLIC_FALLBACK = 'Не удалось подготовить модель к просмотру. Обратитесь к владельцу файла.';

    /**
     * @param array<string, mixed> $status
     * @return array<string, mixed>
     */
    public function sanitizeStatus(array $status): array {
        if (($status['state'] ?? '') !== 'error') {
            return $status;
        }

        $status['message'] = $this->sanitizeMessage(
            (string)($status['message'] ?? ''),
            isset($status['code']) ? (string)$status['code'] : null,
        );

        return $status;
    }

    public function sanitizeMessage(string $message, ?string $code = null): string {
        if ($code === 'file_too_large') {
            return $message;
        }

        if ($this->isUserFacingMessage($message)) {
            return $message;
        }

        return self::PUBLIC_FALLBACK;
    }

    private function isUserFacingMessage(string $message): bool {
        if ($message === '') {
            return false;
        }

        $prefixes = [
            'Файл слишком большой',
            'Конвертация IFC прервана',
            'Файл не является корректным IFC',
            'В IFC нет отображаемой геометрии',
            'IFC conversion produced no visible geometry',
            'Ожидание свободного слота конвертации',
            'Большая модель',
        ];

        foreach ($prefixes as $prefix) {
            if (str_starts_with($message, $prefix) || str_contains($message, $prefix)) {
                return true;
            }
        }

        return false;
    }
}
