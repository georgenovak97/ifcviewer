<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Controller;

use OCA\Ifcviewer\Exception\ConvertingException;
use OCA\Ifcviewer\Exception\FileTooLargeException;
use OCA\Ifcviewer\Service\ConvertService;
use OCA\Ifcviewer\Service\FileService;
use OCA\Ifcviewer\Service\PublicErrorMapper;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\NotFoundResponse;
use OCP\AppFramework\Http\StreamResponse;
use OCP\Files\File;
use OCP\Files\NotFoundException;
use OCP\IRequest;
use OCP\IUserSession;
use RuntimeException;

class BimApiController extends Controller {
    private const PROJECT_ID = 'ifc';
    private const MODEL_ID = 'model';

    public function __construct(
        string $appName,
        IRequest $request,
        private IUserSession $userSession,
        private FileService $fileService,
        private ConvertService $convertService,
        private PublicErrorMapper $publicErrorMapper,
    ) {
        parent::__construct($appName, $request);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function projects(int $fileId): DataResponse|NotFoundResponse {
        return $this->withUserFile($fileId, fn (File $file) => $this->projectsPayload($file));
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function project(int $fileId): DataResponse|NotFoundResponse {
        return $this->withUserFile($fileId, fn (File $file) => $this->projectPayload($file));
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function status(int $fileId): DataResponse|NotFoundResponse {
        return $this->withUserFile($fileId, fn (File $file) => new DataResponse($this->convertService->getStatus($file)));
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function prepare(int $fileId): DataResponse|NotFoundResponse {
        return $this->withUserFile($fileId, function (File $file) {
            try {
                return new DataResponse($this->convertService->prepare($file));
            } catch (FileTooLargeException $e) {
                return new DataResponse([
                    'state' => 'error',
                    'progress' => 0,
                    'message' => $e->getMessage(),
                    'code' => 'file_too_large',
                ]);
            } catch (RuntimeException $e) {
                return new DataResponse([
                    'state' => 'error',
                    'progress' => 0,
                    'message' => $e->getMessage(),
                ], Http::STATUS_INTERNAL_SERVER_ERROR);
            }
        });
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function geometry(int $fileId): StreamResponse|NotFoundResponse|JSONResponse {
        return $this->withUserFile($fileId, fn (File $file) => $this->geometryResponse($file));
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function propertiesQuery(int $fileId): DataResponse|NotFoundResponse {
        $objectId = (string)$this->request->getParam('objectId', '');
        if ($objectId === '') {
            return new DataResponse(['propertySets' => []]);
        }

        $fallbackIds = $this->parsePropertySetIdsParam((string)$this->request->getParam('propertySetIds', ''));

        return $this->withUserFile($fileId, function (File $file) use ($objectId, $fallbackIds) {
            try {
                return new DataResponse($this->convertService->getObjectProperties($file, $objectId, $fallbackIds));
            } catch (RuntimeException $e) {
                return new DataResponse([
                    'propertySets' => [],
                    'message' => $e->getMessage(),
                ], Http::STATUS_INTERNAL_SERVER_ERROR);
            }
        });
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function properties(int $fileId, string $objectId): DataResponse|NotFoundResponse {
        $fallbackIds = $this->parsePropertySetIdsParam((string)$this->request->getParam('propertySetIds', ''));

        return $this->withUserFile($fileId, function (File $file) use ($objectId, $fallbackIds) {
            try {
                return new DataResponse($this->convertService->getObjectProperties($file, $objectId, $fallbackIds));
            } catch (RuntimeException $e) {
                return new DataResponse([
                    'propertySets' => [],
                    'message' => $e->getMessage(),
                ], Http::STATUS_INTERNAL_SERVER_ERROR);
            }
        });
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicProjects(string $token): DataResponse|NotFoundResponse {
        return $this->withShareFile($token, fn (File $file) => $this->projectsPayload($file));
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicProject(string $token): DataResponse|NotFoundResponse {
        return $this->withShareFile($token, fn (File $file) => $this->projectPayload($file));
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicStatus(string $token): DataResponse|NotFoundResponse {
        return $this->withShareFile($token, fn (File $file) => new DataResponse(
            $this->publicErrorMapper->sanitizeStatus($this->convertService->getStatus($file)),
        ));
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicPrepare(string $token): DataResponse|NotFoundResponse {
        return $this->withShareFile($token, function (File $file) {
            try {
                return new DataResponse($this->publicErrorMapper->sanitizeStatus(
                    $this->convertService->prepare($file),
                ));
            } catch (FileTooLargeException $e) {
                return new DataResponse($this->publicErrorMapper->sanitizeStatus([
                    'state' => 'error',
                    'progress' => 0,
                    'message' => $e->getMessage(),
                    'code' => 'file_too_large',
                ]));
            } catch (RuntimeException) {
                return new DataResponse($this->publicErrorMapper->sanitizeStatus([
                    'state' => 'error',
                    'progress' => 0,
                    'message' => PublicErrorMapper::PUBLIC_FALLBACK,
                ]), Http::STATUS_INTERNAL_SERVER_ERROR);
            }
        });
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicGeometry(string $token): StreamResponse|NotFoundResponse|JSONResponse {
        return $this->withShareFile($token, fn (File $file) => $this->geometryResponse($file, true));
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicPropertiesQuery(string $token): DataResponse|NotFoundResponse {
        $objectId = (string)$this->request->getParam('objectId', '');
        if ($objectId === '') {
            return new DataResponse(['propertySets' => []]);
        }

        $fallbackIds = $this->parsePropertySetIdsParam((string)$this->request->getParam('propertySetIds', ''));

        return $this->withShareFile($token, function (File $file) use ($objectId, $fallbackIds) {
            try {
                return new DataResponse($this->convertService->getObjectProperties($file, $objectId, $fallbackIds));
            } catch (RuntimeException) {
                return new DataResponse([
                    'propertySets' => [],
                ], Http::STATUS_INTERNAL_SERVER_ERROR);
            }
        });
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function publicProperties(string $token, string $objectId): DataResponse|NotFoundResponse {
        $fallbackIds = $this->parsePropertySetIdsParam((string)$this->request->getParam('propertySetIds', ''));

        return $this->withShareFile($token, function (File $file) use ($objectId, $fallbackIds) {
            try {
                return new DataResponse($this->convertService->getObjectProperties($file, $objectId, $fallbackIds));
            } catch (RuntimeException) {
                return new DataResponse([
                    'propertySets' => [],
                ], Http::STATUS_INTERNAL_SERVER_ERROR);
            }
        });
    }

    /**
     * @return list<string>|null
     */
    private function parsePropertySetIdsParam(string $raw): ?array {
        if ($raw === '') {
            return null;
        }

        $ids = array_values(array_filter(array_map('trim', explode(',', $raw)), static fn (string $id): bool => $id !== ''));
        return $ids === [] ? null : $ids;
    }

    /**
     * @template T of Http\Response
     * @param callable(File): T $callback
     * @return T|NotFoundResponse
     */
    private function withUserFile(int $fileId, callable $callback): Http\Response|NotFoundResponse {
        $user = $this->userSession->getUser();
        if ($user === null) {
            return new NotFoundResponse();
        }

        try {
            $file = $this->fileService->getUserFile($user->getUID(), $fileId);
        } catch (NotFoundException) {
            return new NotFoundResponse();
        }

        return $callback($file);
    }

    /**
     * @template T of Http\Response
     * @param callable(File): T $callback
     * @return T|NotFoundResponse
     */
    private function withShareFile(string $token, callable $callback): Http\Response|NotFoundResponse {
        try {
            [$file] = $this->fileService->getShareFile($token);
        } catch (NotFoundException) {
            return new NotFoundResponse();
        }

        return $callback($file);
    }

    private function projectsPayload(File $file): DataResponse {
        return new DataResponse([
            'projects' => [
                [
                    'id' => self::PROJECT_ID,
                    'name' => $file->getName(),
                ],
            ],
        ]);
    }

    private function projectPayload(File $file): DataResponse {
        return new DataResponse([
            'id' => self::PROJECT_ID,
            'name' => $file->getName(),
            'models' => [
                [
                    'id' => self::MODEL_ID,
                    'name' => $file->getName(),
                ],
            ],
            'viewerConfigs' => [
                'backgroundColor' => [0, 0, 0],
                'externalMetadata' => $this->convertService->hasExternalMetadata($file),
                'edgesEnabled' => false,
                'saoEnabled' => true,
                'saoIntensity' => 0.18,
                'pbrEnabled' => false,
            ],
            'viewerContent' => [
                'modelsLoaded' => [self::MODEL_ID],
            ],
            'viewerState' => [
                'tabOpen' => 'storeys',
                'expandClassesTree' => 0,
                'expandStoreysTree' => 0,
            ],
        ]);
    }

    private function geometryResponse(File $file, bool $public = false): StreamResponse|NotFoundResponse|JSONResponse {
        try {
            $xkt = $this->convertService->getXktFile($file);
        } catch (ConvertingException $e) {
            $status = $this->convertService->getStatus($file);
            if ($public) {
                $status = $this->publicErrorMapper->sanitizeStatus($status);
            }
            return new JSONResponse($status, Http::STATUS_SERVICE_UNAVAILABLE);
        } catch (RuntimeException $e) {
            $message = $public
                ? $this->publicErrorMapper->sanitizeMessage($e->getMessage())
                : $e->getMessage();
            return new JSONResponse([
                'state' => 'error',
                'progress' => 0,
                'message' => $message,
            ], Http::STATUS_INTERNAL_SERVER_ERROR);
        }

        $stream = $xkt->read();
        if ($stream === false) {
            $this->convertService->repairIncompleteCache($file);
            $status = $this->convertService->getStatus($file);
            if ($public) {
                $status = $this->publicErrorMapper->sanitizeStatus($status);
            }
            return new JSONResponse($status, Http::STATUS_SERVICE_UNAVAILABLE);
        }

        return new StreamResponse($stream, Http::STATUS_OK, [
            'Content-Type' => 'application/octet-stream',
            'Content-Length' => (string)$xkt->getSize(),
            'Cache-Control' => 'private, max-age=3600',
        ]);
    }
}
