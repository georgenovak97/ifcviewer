<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\BackgroundJob;

use OCA\Ifcviewer\Service\ConvertService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\QueuedJob;
use Override;
use Psr\Log\LoggerInterface;

class ConvertIfcJob extends QueuedJob {
    public function __construct(
        ITimeFactory $time,
        private ConvertService $convertService,
        private LoggerInterface $logger,
    ) {
        parent::__construct($time);
    }

    /**
     * @param array{fileId?: int, userId?: string} $argument
     */
    #[Override]
    protected function run($argument): void {
        $fileId = (int)($argument['fileId'] ?? 0);
        $userId = (string)($argument['userId'] ?? '');
        if ($fileId <= 0 || $userId === '') {
            $this->logger->warning('IFC conversion job skipped: invalid arguments', [
                'fileId' => $fileId,
                'userId' => $userId,
            ]);
            return;
        }

        $this->convertService->runQueuedConversion($fileId, $userId);
    }
}
