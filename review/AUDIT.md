# Аудит Nextcloud IFC Viewer

## Контекст

- Nextcloud Hub 26 Winter, версия `33.0.5`
- Xeokit BIM Viewer `2.7.1`
- Версия приложения: **0.5.49** (review-архив)
- Один Linux-сервер, ~20 клиентов
- IFC конвертируется сервером в XKT
- Обязательный сценарий: публичная ссылка без авторизации в Nextcloud
- Горизонтальное масштабирование сейчас не требуется

## Статус аудита (2026-06-11)

| Приоритет | Пункт | Статус |
|-----------|-------|--------|
| P0 | CSP только на страницах viewer | ✅ v0.5.29 |
| P0 | Защита публичного `prepare` | ✅ v0.5.29 |
| P0 | Очистка устаревшего кеша | ✅ v0.5.29 |
| P1 | `QueuedJob` вместо `nohup` | ✅ v0.5.30 |
| P1 | Атомарная публикация кеша | ✅ v0.5.30 |
| P1 | `@nextcloud/files` (семантический резолвер) | ✅ v0.5.30 |
| P2 | Адаптер приватных API Xeokit | ✅ v0.5.31 |
| P2 | Память при загрузке XKT | ✅ v0.5.31 |
| P2 | Безопасные ошибки для публичного UI | ✅ v0.5.31 |
| P2 | Автотесты (PHPUnit unit) | ✅ v0.5.31 |

## Исправления после аудита (v0.5.32–0.5.37)

| Версия | Изменение |
|--------|-----------|
| v0.5.33 | Клик по `.ifc` в Files: регистрация default action через `window._nc_files_scope.v4_0` (NC 33) |
| v0.5.34 | Клавиатура: Q↔E (orbit) |
| v0.5.35 | Клавиатура: Z↔X (pan) |
| v0.5.36 | First Person: компенсация инверсии `yaw()` для Q/E |
| v0.5.37 | Скрыт маркер орбиты (pivot dot) при навигации с клавиатуры |

## Доработки v0.5.38–0.5.49

| Версия | Изменение |
|--------|-----------|
| v0.5.38–0.5.39 | Публичные ссылки: `IfcPublicShareTemplateProvider`, standalone-шаблон viewer с JS/CSS |
| v0.5.40 | Тёмная тема viewer (чёрный фон, белые акценты) |
| v0.5.41 | Favicon и touch-icon на standalone-странице |
| v0.5.42–0.5.45 | Исправление зависания конвертации на 0%: упрощён `prepare()`, inline-конвертация, очистка orphaned status |
| v0.5.46 | `readStatus()` ловит любые ошибки; обрезка текста ошибок в status.json |
| v0.5.47 | Ремонт неполного кеша (metadata без XKT); geometry 404 → 503 + retry; центрирование busy-modal |
| v0.5.48 | Попытка скрытия busy-modal по `complete` (недостаточно из‑за CSS `!important`) |
| v0.5.49 | Скрытие busy-modal через классы `ifcviewer-busy-open` / `ifcviewer-busy-hidden`; игнор повторных `show()` после загрузки |

## P0: исправлено

### 1. CSP

- Удалён глобальный `ContentSecurityPolicyListener`
- CSP задаётся только в `ViewerController` и `DirectEditor`
- `allowEvalWasm(true)`, без `allowEvalScript`

### 2. Публичная конвертация

- Rate limit на `prepare` (v0.5.29); в v0.5.45 упрощён путь — синхронная inline-конвертация для файлов до 500 MB
- Cooldown 5 мин после ошибки
- Очистка abandoned queue entries и orphaned conversion status

### 3. Очистка кеша

- `purgeStaleCachesForFile()` после успешной конвертации
- `repairIncompleteCache()` — удаление битого кеша (metadata без XKT)

## P1: исправлено

### 4. QueuedJob

- `lib/BackgroundJob/ConvertIfcJob.php` (резервный путь; основной — inline `prepare`)

### 5. Атомарная публикация

- Запись в `*.partial` → verify → promote → откат при ошибке

### 6. `@nextcloud/files`

- `js/files-ifc.js`: регистрация в общем scope `window._nc_files_scope.v4_0` (v0.5.33)

## P2: исправлено

### 7. Адаптер Xeokit

- `js/xeokit-adapter.mjs` — единая точка доступа к приватным полям xeokit-bim-viewer

### 8. Память XKT

- Стриминг в один предвыделенный `Uint8Array` по `Content-Length`

### 9. Публичные ошибки

- `lib/Service/PublicErrorMapper.php`
- Санитизация в публичных API и `formatViewerError()` при `data-is-public="1"`

### 10. Тесты

- `tests/Unit/Service/PublicErrorMapperTest.php` (5 тестов)
- Запуск: `composer install && ./vendor/bin/phpunit -c tests/phpunit.xml`

## Остаточные риски

- Integration tests (полный цикл prepare → geometry) — не реализованы
- Адаптер Xeokit снижает связность, но приватные API всё ещё используются внутри адаптера
- Парольные публичные ссылки намеренно не поддерживаются
- После деплоя новой версии требуется `occ upgrade` (иначе NC показывает экран «Требуется обновление»)

## Важное требование

Публичный просмотр без авторизации сохраняется.

## Установка для ревью

```bash
unzip ifcviewer-0.5.49.zip -d /var/www/nextcloud/apps/
chown -R www-data:www-data /var/www/nextcloud/apps/ifcviewer
sudo -u www-data php /var/www/nextcloud/occ app:enable ifcviewer
sudo -u www-data php /var/www/nextcloud/occ upgrade
```

## Что проверить

1. **Files** — клик по `.ifc` открывает viewer
2. **Конвертация** — новый файл: upload → open → prepare → модель загружается, busy-modal исчезает
3. **Публичная ссылка** — открытие без логина, конвертация и просмотр
4. **Инструменты** — секущие плоскости, измерения, дерево Storeys, свойства объектов
