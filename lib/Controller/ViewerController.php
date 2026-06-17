<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Controller;

use OCA\Ifcviewer\BimApiUrl;
use OCA\Ifcviewer\DirectEditor;
use OCA\Ifcviewer\Service\ConvertService;
use OCA\Ifcviewer\Service\FileService;
use OCA\Ifcviewer\ViewerAssets;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Files\NotFoundException;
use OCP\IRequest;
use OCP\IUserSession;

class ViewerController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IUserSession $userSession,
        private FileService $fileService,
        private ConvertService $convertService,
        private BimApiUrl $bimApiUrl,
        private DirectEditor $directEditor,
    ) {
        parent::__construct($appName, $request);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function index(int $fileId): TemplateResponse {
        $user = $this->userSession->getUser();
        if ($user === null) {
            return new TemplateResponse($this->appName, 'error', ['message' => 'Unauthorized'], 'guest');
        }
        try {
            $file = $this->fileService->getUserFile($user->getUID(), $fileId);
        } catch (NotFoundException $e) {
            return new TemplateResponse($this->appName, 'error', ['message' => $e->getMessage()], 'guest');
        }

        $accessError = $this->convertService->validateFileForViewing($file);
        if ($accessError !== null) {
            return new TemplateResponse($this->appName, 'error', ['message' => $accessError], 'guest');
        }

        ViewerAssets::register();

        $params = [
            'fileId' => $fileId,
            'fileName' => $file->getName(),
            'pageTitle' => $file->getName(),
            'bimApiBase' => $this->bimApiUrl->baseForFile($fileId),
            'shareToken' => '',
            'isPublic' => false,
            'externalMetadata' => $this->convertService->hasExternalMetadata($file),
        ];
        $response = new TemplateResponse($this->appName, 'viewer', $params);
        $response->setContentSecurityPolicy($this->directEditor->getCsp());
        return $response;
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicPage(string $token): TemplateResponse {
        try {
            [$file, $share] = $this->fileService->getShareFile($token);
        } catch (NotFoundException $e) {
            return new TemplateResponse($this->appName, 'error', ['message' => $e->getMessage()], 'guest');
        }

        $accessError = $this->convertService->validateFileForViewing($file);
        if ($accessError !== null) {
            return new TemplateResponse($this->appName, 'error', ['message' => $accessError], 'guest');
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
        $response = new TemplateResponse($this->appName, 'viewer', $params, 'blank');
        $response->addHeader('X-Frame-Options', 'SAMEORIGIN');
        $response->setContentSecurityPolicy($this->directEditor->getCsp());
        return $response;
    }
}
