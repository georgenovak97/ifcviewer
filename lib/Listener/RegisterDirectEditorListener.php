<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Listener;

use OCA\Ifcviewer\DirectEditor;
use OCP\DirectEditing\RegisterDirectEditorEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;

/** @template-implements IEventListener<Event|RegisterDirectEditorEvent> */
class RegisterDirectEditorListener implements IEventListener {
    public function __construct(
        private DirectEditor $editor,
    ) {
    }

    public function handle(Event $event): void {
        if (!$event instanceof RegisterDirectEditorEvent) {
            return;
        }
        $event->register($this->editor);
    }
}
