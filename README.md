# IFC Viewer for Nextcloud

Nextcloud-приложение для просмотра IFC-моделей в браузере на базе [xeokit-bim-viewer](https://github.com/xeokit/xeokit-bim-viewer) 2.7.1.

IFC конвертируется на сервере в XKT, после чего модель открывается в полноэкранном 3D-вьюере с деревом объектов, свойствами, сечениями и измерениями. Поддерживаются публичные ссылки Nextcloud без авторизации.

## Возможности

- Открытие `.ifc` из Files и через Direct Editing
- Серверная конвертация IFC → XKT (`fast10` / `@xeokit/xeokit-convert`)
- 3D-навигация: orbit, pan, zoom, first-person, NavCube
- Клавиатура: **WASD** — перемещение, **Q/E** — вращение, **Z/X** — вверх/вниз
- Explorer (дерево этажей), панель свойств (Revit + IFC)
- Сечения, измерения расстояний и углов
- Публичные share-ссылки с отдельным standalone-шаблоном
- Локализация: `ru`, `en`

## Требования

| Компонент | Версия |
|-----------|--------|
| Nextcloud | 32–33 |
| PHP | 8.1+ (рекомендуется 8.2+) |
| Node.js | 18+ (для конвертера) |
| npm | 9+ |

На сервере должны быть доступны: `php`, `node`, достаточно RAM для конвертации IFC (зависит от размера модели).

## Установка

### 1. Клонировать в apps Nextcloud

```bash
cd /var/www/nextcloud/apps
git clone https://github.com/georgenovak97/ifcviewer.git ifcviewer
cd ifcviewer
```

### 2. Установить зависимости конвертера

```bash
cd tools
npm ci
cd ..
```

### 3. (Опционально) PHPUnit

```bash
composer install
./vendor/bin/phpunit -c tests/phpunit.xml
```

### 4. Включить приложение

```bash
sudo -u www-data php /var/www/nextcloud/occ app:enable ifcviewer
sudo -u www-data php /var/www/nextcloud/occ upgrade
```

### 5. Права

```bash
sudo chown -R www-data:www-data /var/www/nextcloud/apps/ifcviewer
```

Убедитесь, что `www-data` может запускать `node` и писать в appdata Nextcloud (кеш конвертации).

## Использование

1. Загрузите `.ifc` в Nextcloud Files.
2. Откройте файл — запустится конвертация и просмотр.
3. Для публичной ссылки создайте share в Nextcloud — откроется standalone-страница вьюера.

При первом открытии показывается окно загрузки с прогрессом и подсказками по управлению.

## Структура проекта

```
ifcviewer/
├── appinfo/              # Метаданные Nextcloud-приложения, маршруты
│   ├── info.xml
│   └── routes.php
├── config/               # MIME-типы (model/ifc, application/x-ifc)
├── css/                  # Стили вьюера и xeokit
├── js/
│   ├── viewer-boot.mjs   # Точка входа (dynamic import viewer-init)
│   ├── viewer-init.mjs   # Основная логика BIM UI
│   ├── xeokit-adapter.mjs# Адаптер приватных API xeokit
│   ├── files-ifc.js      # Интеграция с Nextcloud Files
│   └── public.js         # Публичные share-страницы
├── l10n/                 # Переводы (en, ru)
├── lib/
│   ├── AppInfo/          # Bootstrap, DI, listeners
│   ├── BackgroundJob/    # Фоновая конвертация (резервный путь)
│   ├── Command/          # occ ifcviewer:convert
│   ├── Controller/       # Viewer, API, BIM API
│   ├── Listener/         # Files, sharing, direct editor
│   ├── PublicShare/      # Шаблон публичной ссылки
│   ├── Service/          # ConvertService, FileService
│   └── Exception/
├── templates/            # viewer.php, error.php
├── tests/                # PHPUnit unit-тесты
├── tools/
│   ├── convert-ifc.mjs   # IFC → XKT конвертер
│   ├── merge_ifc.py      # Объединение IFC (опционально)
│   └── package.json
├── revit-export-config/  # Пресеты экспорта Revit → IFC для xeokit
├── review/               # Внутренний аудит и заметки
├── composer.json
└── README.md
```

## API (кратко)

BIM API обслуживает xeokit-bim-viewer:

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/bim/{fileId}/project` | Метаданные проекта |
| POST | `/api/bim/{fileId}/prepare` | Запуск/ожидание конвертации |
| GET | `/api/bim/{fileId}/geometry` | XKT-геометрия |
| GET | `/api/bim/{fileId}/properties/{objectId}` | Свойства объекта |

Аналогичные маршруты с префиксом `/api/bim/s/{token}/` для публичных ссылок.

## Разработка

### Локальная правка с деплоем на сервер

```bash
# после изменений в /home/samba-admin/ifcviewer
sudo cp -r js css templates appinfo lib /var/www/nextcloud/apps/ifcviewer/
sudo chown -R www-data:www-data /var/www/nextcloud/apps/ifcviewer
sudo -u www-data php /var/www/nextcloud/occ upgrade
```

Увеличивайте `<version>` в `appinfo/info.xml` при каждом релизе.

### Ручная конвертация

```bash
cd tools
node convert-ifc.mjs -s model.ifc -o model.xkt
```

### Revit

Для лучшей совместимости используйте пресеты из `revit-export-config/`.

## Безопасность

- CSP настроен только на страницах вьюера
- Публичный `prepare` защищён rate limit
- Ошибки конвертации для анонимных пользователей обезличены
- Секреты и кеш конвертации не должны попадать в git

## Лицензия

AGPL-3.0-or-later — см. `composer.json`.

## Автор

[georgenovak97](https://github.com/georgenovak97)
