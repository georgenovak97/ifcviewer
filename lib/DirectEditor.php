<?php

declare(strict_types=1);

namespace OCA\Ifcviewer;
use OCA\Ifcviewer\AppInfo\Application;
use OCA\Ifcviewer\Service\ConvertService;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\DirectEditing\IEditor;
use OCP\DirectEditing\IToken;

class DirectEditor implements IEditor {
    public function __construct(
        private BimApiUrl $bimApiUrl,
    ) {
    }

    private function getConvertService(): ConvertService {
        return \OCP\Server::get(ConvertService::class);
    }

    public function getId(): string {
        return Application::APP_ID;
    }

    public function getName(): string {
        return 'IFC Viewer';
    }

    public function getMimetypes(): array {
        return [
            'model/ifc',
            'application/ifc',
            'application/x-ifc',
        ];
    }

    public function getMimetypesOptional(): array {
        return [];
    }

    public function getCreators(): array {
        return [];
    }

    public function isSecure(): bool {
        return true;
    }

    public function open(IToken $token): TemplateResponse {
        $token->useTokenScope();
        $file = $token->getFile();
        $fileId = $file->getId();

        $accessError = $this->getConvertService()->validateFileForViewing($file);
        if ($accessError !== null) {
            return new TemplateResponse(Application::APP_ID, 'error', ['message' => $accessError], 'guest');
        }

        $params = [
            'fileId' => $fileId,
            'fileName' => $file->getName(),
            'pageTitle' => $file->getName(),
            'bimApiBase' => $this->bimApiUrl->baseForFile($fileId),
            'shareToken' => '',
            'isPublic' => false,
            'externalMetadata' => $this->getConvertService()->hasExternalMetadata($file),
        ];

        ViewerAssets::register();

        $response = new TemplateResponse(Application::APP_ID, 'viewer', $params);
        $response->setContentSecurityPolicy($this->getCsp());
        return $response;
    }

    public function getCsp(): ContentSecurityPolicy {
        $csp = new ContentSecurityPolicy();
        $csp->addAllowedScriptDomain('cdn.jsdelivr.net');
        $csp->addAllowedConnectDomain('cdn.jsdelivr.net');
        $csp->addAllowedWorkerSrcDomain('cdn.jsdelivr.net');
        $csp->addAllowedWorkerSrcDomain('blob:');
        $csp->addAllowedConnectDomain('blob:');
        $csp->addAllowedWorkerSrcDomain("'self'");
        // web-ifc WASM compilation (required by xeokit WebIFCLoaderPlugin)
        $csp->allowEvalWasm(true);
        return $csp;
    }
}
