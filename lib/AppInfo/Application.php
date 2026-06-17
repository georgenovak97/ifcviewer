<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCA\Ifcviewer\BimApiUrl;
use OCA\Ifcviewer\DirectEditor;
use OCA\Ifcviewer\Service\ConvertService;
use OCA\Ifcviewer\Listener\FilesListener;
use OCA\Ifcviewer\Listener\FileSharingListener;
use OCA\Ifcviewer\Listener\RegisterDirectEditorListener;
use OCA\Ifcviewer\PublicShare\IfcPublicShareTemplateProvider;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\DirectEditing\RegisterDirectEditorEvent;

class Application extends App implements IBootstrap {
    public const APP_ID = 'ifcviewer';

    public function __construct() {
        parent::__construct(self::APP_ID);
    }

    public function register(IRegistrationContext $context): void {
        $context->registerService(BimApiUrl::class, function ($c) {
            return new BimApiUrl(
                $c->get(\OCP\IURLGenerator::class),
                self::APP_ID,
            );
        });
        $context->registerService(DirectEditor::class, function ($c) {
            return new DirectEditor(
                $c->get(BimApiUrl::class),
            );
        });
        $context->registerService(ConvertService::class, function ($c) {
            return new ConvertService(
                $c->get(\OCP\Files\IAppData::class),
                $c->get(\OCP\BackgroundJob\IJobList::class),
                $c->get(\OCA\Ifcviewer\Service\FileService::class),
                $c->get(\Psr\Log\LoggerInterface::class),
            );
        });
        $context->registerEventListener(RegisterDirectEditorEvent::class, RegisterDirectEditorListener::class);
        $context->registerEventListener(LoadAdditionalScriptsEvent::class, FilesListener::class);
        $context->registerEventListener(BeforeTemplateRenderedEvent::class, FileSharingListener::class);
        $context->registerPublicShareTemplateProvider(IfcPublicShareTemplateProvider::class);
    }

    public function boot(IBootContext $context): void {
    }
}
