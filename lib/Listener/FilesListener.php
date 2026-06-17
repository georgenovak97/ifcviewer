<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Listener;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\Ifcviewer\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/** @template-implements IEventListener<Event|LoadAdditionalScriptsEvent> */
class FilesListener implements IEventListener {
    public function handle(Event $event): void {
        if (!$event instanceof LoadAdditionalScriptsEvent) {
            return;
        }

        // Load after files-init so header/router is ready; version bump busts stale overlay JS
        Util::addScript(Application::APP_ID, 'files-ifc', 'files');
    }
}
