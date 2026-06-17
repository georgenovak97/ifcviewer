<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Listener;

use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCA\Ifcviewer\Service\FileService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\File;
use OCP\Util;

/** @template-implements IEventListener<Event|BeforeTemplateRenderedEvent> */
class FileSharingListener implements IEventListener {
    public function handle(Event $event): void {
        if (!$event instanceof BeforeTemplateRenderedEvent) {
            return;
        }
        if (!method_exists($event, 'getShare')) {
            return;
        }
        $share = $event->getShare();
        $node = $share->getNode();
        if (!$node instanceof File) {
            return;
        }
        if (!FileService::isIfcMime($node->getMimeType())) {
            return;
        }
        Util::addScript('ifcviewer', 'public');
        Util::addStyle('ifcviewer', 'viewer');
    }
}
