<?php

declare(strict_types=1);

namespace OCA\Ifcviewer;

use OCA\Ifcviewer\AppInfo\Application;
use OCP\IURLGenerator;
use OCP\Server;
use OCP\Util;

class ViewerAssets {
    public static function register(): void {
        Util::addStyle(Application::APP_ID, 'fontawesome');
        Util::addStyle(Application::APP_ID, 'xeokit-bim-viewer');
        Util::addStyle(Application::APP_ID, 'viewer');
        Util::addScript(Application::APP_ID, 'viewer-boot', 'core');
    }

    public static function getVersion(): string {
        return Server::get(\OCP\App\IAppManager::class)->getAppVersion(Application::APP_ID);
    }

    public static function getStyleUrl(string $name): string {
        $url = Server::get(IURLGenerator::class)->linkTo(Application::APP_ID, 'css/' . $name . '.css');
        return $url . '?v=' . rawurlencode(self::getVersion());
    }

    public static function getViewerBootUrl(): string {
        $url = Server::get(IURLGenerator::class)->linkTo(Application::APP_ID, 'js/viewer-boot.mjs');
        return $url . '?v=' . rawurlencode(self::getVersion());
    }

    public static function getFaviconUrl(): string {
        return Server::get(IURLGenerator::class)->imagePath('core', 'favicon.ico');
    }

    public static function getTouchIconUrl(): string {
        return Server::get(IURLGenerator::class)->imagePath('core', 'favicon-touch.png');
    }

    public static function getViewerInitUrl(): string {
        $appRoot = Server::get(\OCP\App\IAppManager::class)->getAppPath(Application::APP_ID);
        $mtime = (string)(@filemtime($appRoot . '/js/viewer-init.mjs') ?: '0');
        $url = Server::get(IURLGenerator::class)->linkTo(Application::APP_ID, 'js/viewer-init.mjs');

        return $url . '?mtime=' . rawurlencode($mtime);
    }
}
