<?php

declare(strict_types=1);

namespace OCA\Ifcviewer;

use OCP\IURLGenerator;

class BimApiUrl {
    public function __construct(
        private IURLGenerator $urlGenerator,
        private string $appId,
    ) {
    }

    public function baseForFile(int $fileId): string {
        $routeNames = [
            $this->appId . '.bimapi.project',
            $this->appId . '.bimApi.project',
        ];

        foreach ($routeNames as $routeName) {
            $url = $this->urlGenerator->linkToRouteAbsolute($routeName, ['fileId' => $fileId]);
            $base = preg_replace('#/project$#', '', $url);
            if ($this->isValidApiBase($base, $fileId)) {
                return $base;
            }
        }

        return $this->urlGenerator->getAbsoluteURL(
            '/index.php/apps/' . $this->appId . '/api/bim/' . $fileId,
        );
    }

    public function baseForShare(string $token): string {
        $routeNames = [
            $this->appId . '.bimapi.publicProject',
            $this->appId . '.bimApi.publicProject',
        ];

        foreach ($routeNames as $routeName) {
            $url = $this->urlGenerator->linkToRouteAbsolute($routeName, ['token' => $token]);
            $base = preg_replace('#/project$#', '', $url);
            if ($this->isValidShareApiBase($base, $token)) {
                return $base;
            }
        }

        return $this->urlGenerator->getAbsoluteURL(
            '/index.php/apps/' . $this->appId . '/api/bim/s/' . rawurlencode($token),
        );
    }

    private function isValidApiBase(string $base, int $fileId): bool {
        if ($base === '' || $base === '/') {
            return false;
        }

        return str_contains($base, '/api/bim/' . $fileId);
    }

    private function isValidShareApiBase(string $base, string $token): bool {
        if ($base === '' || $base === '/') {
            return false;
        }

        return str_contains($base, '/api/bim/s/' . rawurlencode($token))
            || str_contains($base, '/api/bim/s/' . $token);
    }
}
