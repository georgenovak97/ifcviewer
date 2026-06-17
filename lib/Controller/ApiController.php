<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Controller;

use OCA\Ifcviewer\Service\FileService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\NotFoundResponse;
use OCP\AppFramework\Http\StreamResponse;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\IRequest;
use OCP\IUserSession;

class ApiController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IUserSession $userSession,
        private FileService $fileService,
    ) {
        parent::__construct($appName, $request);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function file(int $fileId): StreamResponse|NotFoundResponse {
        $user = $this->userSession->getUser();
        if ($user === null) {
            return new NotFoundResponse();
        }
        try {
            $file = $this->fileService->getUserFile($user->getUID(), $fileId);
        } catch (NotFoundException) {
            return new NotFoundResponse();
        }
        return $this->streamIfcFile($file);
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicFile(string $token): StreamResponse|NotFoundResponse {
        try {
            [$file] = $this->fileService->getShareFile($token);
        } catch (NotFoundException) {
            return new NotFoundResponse();
        }
        return $this->streamIfcFile($file);
    }

    private function streamIfcFile(File $file): StreamResponse|NotFoundResponse {
        $stream = $file->fopen('r');
        if ($stream === false) {
            return new NotFoundResponse();
        }

        $mime = $file->getMimeType() ?? 'model/ifc';
        $response = new StreamResponse($stream, Http::STATUS_OK, [
            'Content-Type' => $mime,
            'Content-Length' => (string)$file->getSize(),
            'Content-Disposition' => 'inline; filename="' . rawurlencode($file->getName()) . '"',
            'Cache-Control' => 'private, max-age=0, must-revalidate',
        ]);

        $response->setETag($file->getEtag());
        $lastModified = new \DateTime();
        $lastModified->setTimestamp($file->getMTime());
        $response->setLastModified($lastModified);

        return $response;
    }
}
