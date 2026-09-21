# История изменений / Changelog

[Русский](#русский) · [English](#english) · [README RU](README.md) · [README EN](README.en.md)

## Русский

### Unreleased — VNE-TEST (подготовка 3.2.0)

Выпуск ещё не опубликован; manifest остаётся 3.1.0 Release.

- Добавлены варианты действий с разовой подсказкой, сохраняемыми пожеланиями, тремя длинами ответа и выбором 1–100 сообщений истории (по умолчанию 10). Сохранены вставка для редактирования и немедленная автоотправка.
- Генератор вариантов отключается независимо от отношений и памяти. Компактная кнопка VN возвращает панель с анимацией.
- Единое текстовое подключение: основная модель, профиль Connection Manager или своё API. Профиль не переключает подключение чата.
- Добавлены Auto, JSON Schema, JSON mode для своего API и режим инструкций, валидация вариантов и общий бюджет дополнительных запросов.
- Исправлен JSON Schema через профиль: исходный ответ не теряется при разборе SillyTavern; принимаются готовые объекты и Claude tool input. Обрезание, отказ и неверный формат отличаются от пустого ответа.
- Добавлены отмена, тайм-аут, защита от смены чата/персоны/свайпа, настраиваемый лимит токенов своего API и отдельно разрешаемая резервная модель. Подробная диагностика выключена по умолчанию.
- Добавлены RU/EN интерфейс и независимый язык новых результатов. Стандартные промпты переведены на английский; промпт описания персонажа можно редактировать и сбрасывать.
- В HUD добавлены поиск, сортировка, компактные карточки и расшифровка доверия/романтики. Скрытых персонажей можно найти и вернуть по одному или всех сразу.
- Добавлен редактор воспоминаний и черт с удалением и отменой до 20 правок записи без изменения баллов и журнала. Исправлена потеря импортированного архива при пересчёте.
- Импорт снимка проверяется до применения, показывает сводку замены и сохраняет первоначальную точку восстановления при повторных импортах. Поддерживаются v1 и старый объект данных, лимит — 20 МиБ. Удаление импортированной основы требует подтверждения.
- Добавлена [мастерская портретов](docs/portraits.md): ручной промпт или сборка из источников, общий стиль, до четырёх референсов, предпросмотр и кадрирование.
- Подключения изображений по примеру Comic Forge: OpenAI Images, OpenAI Chat, Gemini и Naistera, загрузка моделей и профили. Для OpenAI Images референсы отправляются через `/images/edits`; отказ не запускает скрытый повтор без референсов.
- Галерея хранит новые оригиналы по чату, персоне и персонажу: повторное применение, скачивание и копирование PNG. Удаление записи сохраняет аватар и файл; галерея не включается в снимок VNE.
- Обновление профиля изображения отделено от сохранения нового; удаление требует подтверждения и сохраняет текущее подключение. Настройки собраны в компактные раскрывающиеся разделы.
- Документация сокращена до README RU/EN, changelog, инструкции по портретам и текущего ручного чек-листа. Старые рабочие планы и заметки доступны в истории Git.

Проверки: 192 автоматических теста с подменёнными API и границами интерфейса. Пользователь подтвердил работу Schema на своём профиле Claude после исправления и сообщил о прохождении доступных проверок. Это не проверка всех провайдеров; [ручной чек-лист](docs/manual-testing.md) сохраняется до решения о выпуске.

### 2026-07-23 — исправление снимков

- События после импорта, включая повторные генерации свайпов и ручные отладочные записи ниже границы импорта, учитываются с сохранением импортированной базы.
- Время отладочных записей в журнале соответствует времени события.

Источник: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). Отдельный номер релиза этому исправлению не присваивался.

### 3.1.0 — 2026-04-28

- Влияние событий на дружбу и романтику разделено на независимые шкалы.

Источник: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), включая версию в manifest. Более ранняя история здесь не реконструирована.

## English

### Unreleased — VNE-TEST (3.2.0 preparation)

Not released; the manifest remains 3.1.0 Release.

- Added action choices with per-generation hints, persistent preferences, three reply lengths and 1–100 history messages (default 10). Both editable insertion and immediate auto-send remain available.
- Option generation can be disabled independently of relationships and memory. A compact VN button restores the panel with an animation.
- Unified text connection: main model, Connection Manager profile or Custom API. Profiles do not switch the chat connection.
- Added Auto, JSON Schema, Custom API JSON mode and prompt-only output, option validation and a shared additional-request budget.
- Fixed profile JSON Schema: preserve raw responses before Tavern extraction and accept parsed objects and Claude tool input. Truncation, refusals and invalid formats are distinguished from empty output.
- Added cancellation, timeout, chat/persona/swipe guards, a Custom API output-token limit and opt-in fallback. Detailed diagnostics are off by default.
- Added RU/EN UI and independent output language. Default service prompts are English; character description instructions can be edited and reset.
- Added HUD search, sorting, compact cards and trust/romance breakdowns. Hidden characters can be searched and restored individually or together.
- Added memory and trait editing with removal and up to 20 undo steps per entry, without changing scores or logs. Fixed imported archive loss during recalculation.
- Snapshot imports validate before applying, preview replacement and retain the original recovery point across repeated imports. Supports v1 and legacy bare objects, up to 20 MiB. Removing an imported baseline requires confirmation.
- Added the [portrait workshop](docs/portraits.md): manual or source-based prompts, shared style, up to four references, preview and cropping.
- Image connections adapted from Comic Forge: OpenAI Images, OpenAI Chat, Gemini and Naistera, model discovery and profiles. OpenAI Images references use `/images/edits`; failed reference requests are never silently retried without images.
- Gallery stores new originals per chat, persona and character, with reuse, downloading and PNG copying. Removing an entry preserves its file and avatar; VNE snapshots exclude gallery history.
- Image profile updates are separate from saving new profiles; confirmed deletion preserves the current connection. Settings use compact collapsible sections.
- Consolidated documentation into RU/EN READMEs, changelog, portrait guide and current manual checklist. Old working plans and notes remain in Git history.

Verification: 192 automated tests with mocked APIs and UI boundaries. The user confirmed Schema works on their Claude profile after the fix and reported completing available checks. This does not cover all providers; the [manual checklist](docs/manual-testing.md) remains until the release decision.

### 2026-07-23 — snapshot fix

- Events after import, including regenerated swipes and manual debug entries below the import cutoff, are replayed while retaining the imported baseline.
- Debug entries in the log use the actual event time.

Source: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). No separate release number was assigned to this fix.

### 3.1.0 — 2026-04-28

- Split event impact on friendship and romance into independent scales.

Source: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), including its manifest version. Earlier release history has not been reconstructed here.
