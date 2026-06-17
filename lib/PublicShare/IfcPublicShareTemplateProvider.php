<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\PublicShare;

use OCA\Ifcviewer\BimApiUrl;
use OCA\Ifcviewer\DirectEditor;
use OCA\Ifcviewer\Service\ConvertService;
use OCA\Ifcviewer\Service\FileService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\Share\IPublicShareTemplateProvider;
use OCP\Share\IPublicShareTemplateProviderWithPriority;
use OCP\Share\IShare;

class IfcPublicShareTemplateProvider implements IPublicShareTemplateProvider, IPublicShareTemplateProviderWithPriority {
    public function __construct(
        private FileService $fileService,
        private ConvertService $convertService,
        private BimApiUrl $bimApiUrl,
        private DirectEditor $directEditor,
    ) {
    }

    public function getPriority(): int {
        return 5;
    }

    public function shouldRespond(IShare $share): bool {
        $node = $share->getNode();
        if (!$node instanceof File) {
            return false;
        }
        if (!FileService::isIfcMime($node->getMimeType())) {
            return false;
        }
        return ($share->getPermissions() & Constants::PERMISSION_READ) !== 0;
    }

    public function renderPage(IShare $share, string $token, string $path): TemplateResponse {
        try {
            [$file] = $this->fileService->getShareFile($token);
        } catch (NotFoundException $e) {
            return new TemplateResponse('ifcviewer', 'error', ['message' => $e->getMessage()], 'guest');
        }

        $accessError = $this->convertService->validateFileForViewing($file);
        if ($accessError !== null) {
            return new TemplateResponse('ifcviewer', 'error', ['message' => $accessError], 'guest');
        }

        $params = [
            'fileId' => $file->getId(),
            'fileName' => $file->getName(),
            'pageTitle' => $file->getName(),
            'bimApiBase' => $this->bimApiUrl->baseForShare($token),
            'shareToken' => $token,
            'isPublic' => true,
            'standalone' => true,
            'externalMetadata' => $this->convertService->hasExternalMetadata($file),
        ];
        $response = new TemplateResponse('ifcviewer', 'viewer', $params, 'blank');
        $response->addHeader('X-Frame-Options', 'SAMEORIGIN');
        $response->setContentSecurityPolicy($this->directEditor->getCsp());
        return $response;
    }
}
