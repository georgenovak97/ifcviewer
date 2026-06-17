<?php

declare(strict_types=1);

namespace OCA\Ifcviewer\Command;

use OCA\Ifcviewer\Service\ConvertService;
use OCA\Ifcviewer\Service\FileService;
use OCP\Files\NotFoundException;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class ConvertCommand extends Command {
    public function __construct(
        private FileService $fileService,
        private ConvertService $convertService,
    ) {
        parent::__construct();
    }

    protected function configure(): void {
        $this->setName('ifcviewer:convert')
            ->setDescription('Convert an IFC file to XKT in the background')
            ->addArgument('file-id', InputArgument::REQUIRED, 'Nextcloud file ID')
            ->addArgument('user-id', InputArgument::REQUIRED, 'Owner user ID');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int {
        $fileId = (int)$input->getArgument('file-id');
        $userId = (string)$input->getArgument('user-id');

        try {
            $file = $this->fileService->getUserFile($userId, $fileId);
        } catch (NotFoundException $e) {
            $output->writeln('<error>' . $e->getMessage() . '</error>');
            return Command::FAILURE;
        }

        try {
            $this->convertService->convertAndCache($file);
            $output->writeln('<info>Conversion finished for file ' . $fileId . '</info>');
            return Command::SUCCESS;
        } catch (\Throwable $e) {
            $output->writeln('<error>' . $e->getMessage() . '</error>');
            return Command::FAILURE;
        }
    }
}
