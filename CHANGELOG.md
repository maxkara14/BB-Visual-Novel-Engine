# История изменений / Changelog

[Русский](#русский) · [English](#english) · [README RU](README.md) · [README EN](README.en.md)

## Русский

### Незабываемые события и пользовательские шкалы — 2 ноября 2026 (без изменения версии)

- Глубокая память и отметки незабываемых событий теперь зависят от категорий `life_changing` / `unforgivable`, а не от фиксированного порога ±15. Крайние события при ±10 и других ненулевых значениях накапливаются для создания черт. Нулевые и отключённые романтические изменения не создают память.
- При одинаковом знаке двух шкал незабываемое событие не теряется за обычным изменением с большим числом баллов. Обычные категории не становятся глубокими только из-за увеличенной шкалы. Баллы и правило пяти событий одного знака для черты сохранены.
- Пересчёт исправляет память ранее сохранённых обычных и восстановленных событий с категорией. Числовые события без категории сохраняют прежние пороги; импортированная готовая память не меняется.
- Обновлены оба README. Проверены пользовательские шкалы, обе полярности, романтика, алиасы, восстановление, повторный пересчёт, накопление пяти событий и архивирование после записи черты.

### Направление статусов при восстановлении — 2 ноября 2026 (без изменения версии)

- Восстановление явно запрашивает `user_label`: кем пользователь является для NPC. Добавлены проверка направления фразы и примеры несимметричных связей: телохранитель/подопечный и дочь/родитель. Неизвестная связь остаётся пустой вместо подстановки роли NPC.
- Подписи из предыдущих порций не передаются следующему запросу, чтобы не закреплять ошибочную интерпретацию. Формат сохранённых событий совместим с обычным трекером; баллы и существующие записи автоматически не меняются. Ранее неверные подписи можно исправить через «Изменить статус».
- Добавлены регрессионные проверки инструкции, приоритета `user_label`, пустых подписей и совместимости старого формата.

### Восстановление отношений из истории — 2 ноября 2026 (без изменения версии)

- В настройки «Отношения» добавлена ручная кнопка восстановления для уже начатой игры. Можно выбрать последние N сообщений, весь чат или свой диапазон с фрагментами границ; число запросов видно до запуска, прогресс — во время анализа.
- История анализируется порциями примерно по 18 000 символов. Новые персонажи, подписи и изменения доверия/влечения показываются для проверки; лишние предложения можно снять. Сохранение включает трекер и использует обычный пересчёт VNE без повторного прибавления итоговых баллов.
- Сохранён учёт обработанных сообщений по персоне и свайпу, включая пустые результаты. Повторы и пересекающиеся диапазоны пропускаются. Ходы с обычными событиями трекера и сообщения до границы импортированной основы пропускаются целиком.
- Изменение исходного или непосредственно предшествующего сообщения исключает устаревшие события из пересчёта; после просмотра новый анализ заменяет их. Ошибки, отмена и смена контекста не сохраняют частичный результат. Полный сброс отношений очищает и отметки восстановления активной персоны.
- Обновлены русский и английский README и переводы интерфейса. Добавлены проверки повторов, пересечений, свайпов, правок, изоляции персон, формата ответа, безопасного предпросмотра, отмены и настоящего пересчёта. Работа функции подтверждена пользователем на локальной Таверне.

### Стиль портретов по профилям — 30 октября 2026 (без изменения версии)

- Каждый профиль подключения изображений сохраняет собственный стиль и восстанавливает его при выборе. Старые профили без стиля загружают пустое значение вместо стиля другого подключения.
- Поле стиля в мастерской стало временным переопределением до закрытия окна. Генерация, применение аватара, отмена и ошибки не записывают его в настройки.
- Кнопка «Сохранить стиль в профиль» обновляет только стиль профиля, с которым открыта мастерская. Без профиля, во время запроса, после смены или удаления профиля сохранение недоступно; устаревший редактор не может записать стиль.
- Обновлены переводы и руководство; добавлены проверки независимых стилей, пустого значения, старых профилей, временных правок и явного сохранения.

### Обновление трекера после нового ответа — 24 октября 2026 (без изменения версии)

- Исправлен вызов несуществующего `markdownToHtml` после очистки служебного блока в видимом сообщении. Используется штатный `updateMessageBlock` Таверны.
- Ошибка больше не обрывает пересчёт до обновления карточек и запроса начальных отношений для нового персонажа. Ранее данные могли обновиться, пока панель оставалась со старым списком.
- Карточки и значения отношений обновляются после ответа без закрытия и повторного открытия панели. Исправление проверено пользователем на локальной Таверне.
- Добавлены проверки полного пути для видимого и неотрисованного сообщения: очистка блока, сохранение обновлений, обновление панели и однократный запрос начальных отношений.

### Автоматические размеры портретов GPT Image — 23 октября 2026 (без изменения версии)

- Автоматический расчёт размера GPT Image 2/2.5 учитывает верхний лимит площади. Квадратный 4K и пропорции 3:4 больше не вызывают локальную ошибку: размер уменьшается с округлением сторон до кратности 16.
- Точный размер остаётся без изменений и проверяется отдельно. Обновлены README и руководство портретов; добавлены проверки запросов генерации и редактирования с референсами.

### Повторная обработка имён и текста сцены — 20 октября 2026 (без изменения версии)

- Во время одного синхронного пересчёта имена пользовательской персоны собираются один раз. Проверки большого списка персонажей больше не разбирают описание персоны заново для каждого имени.
- Очистка скрытых блоков и нормализация строк переиспользуют результат для полного исходного текста внутри текущей операции. Поиск упоминаний разных персонажей больше не обрабатывает один и тот же текст сцены многократно.
- Кэш освобождается после операции, включая ошибки. Следующий пересчёт видит изменения персоны, текста, свайпов и чата; строки одинаковой длины с разным содержимым проверяются отдельно.
- Добавлены регрессионные проверки переиспользования результатов, правок одинаковой длины, смены персоны и освобождения кэша после ошибки.

### Меньше повторных расчётов и скрытых редакторов — 20 октября 2026 (без изменения версии)

- Попарное сравнение похожих имён повторяется при изменении реестра или подсказок объединения. Обычные обращения к профилям и изменение аватара не запускают сравнение заново; кэш разделён по состояниям персон. Покрытие реестра учитывает имена и алиасы за один проход.
- Редактор персонажа создаётся при первом открытии карточки, а не для всех скрытых карточек при каждой отрисовке. Его кнопки, загрузка картинок и кадрирование работают через обработчики панели; закрытие и повторное открытие сохраняют черновик до следующей отрисовки HUD.
- Уведомления о получении, отрисовке и завершении ответа объединяются в пределах 16 мс. Правки, удаления и свайпы пересчитываются сразу; смена чата или персоны отменяет старую задачу. Перед генерацией и прямым чтением социального промпта, включая Custom API, ожидающий расчёт выполняется немедленно.
- Правила отношений, памяти и веток сохранены. Добавлены проверки обновления кэша, редакторов, событий и актуальности промпта.

### Хранение аватаров вне чата — 20 октября 2026 (без изменения версии)

- Новые аватары и исходники сохраняются файлами на сервере Таверны; в профилях и новых состояниях веток остаются короткие пути. Правка описания без смены картинки или кадрирования повторно не сохраняет аватар.
- В «Данные» добавлен перенос встроенных изображений текущего чата, включая другие персоны и историю веток. Перед переносом скачивается полный JSONL-бэкап. Ссылки меняются вместе после побайтовой проверки всех файлов; ошибки, смена контекста и параллельные правки отменяют перенос.
- Экспорт snapshot через настройки по-прежнему включает изображения для переноса между серверами; импорт сохраняет их файлами до применения. Лимит JSON увеличен до 100 МиБ, чтобы принимать крупные снимки с исходниками. Сохранены формат v1 и совместимость со встроенными картинками.
- Расчёты отношений и обработка ответов не менялись. Добавлены проверки загрузки, отката при ошибке, резервной копии, сохранения карточки, истории веток и переносимости snapshot.

### Оптимизация проверки персоны — 17 октября 2026 (без изменения версии)

- Фоновая проверка использует существующую привязку персоны без построения индекса всей истории. Резервный опрос выполняется раз в 2,5 секунды; события SillyTavern обрабатываются сразу.
- Внутри одного синхронного расчёта повторные обращения используют общий индекс принадлежности записей. После операции кэш освобождается; правки записей внутри расчёта сбрасывают его.
- Убраны дублирующие пересчёты при готовности приложения и смене чата. Сохранены проверки смены персоны, свайпов, веток и snapshot; баллы и правила отношений не изменены.

### Добавление контактов и статусы отношений — 16 октября 2026 (без изменения версии)

- Уточнены инструкции модели: именованный персонаж при прямом взаимодействии добавляется в трекер даже без изменения отношений, в том числе если он появился в истории раньше. Нейтральный контакт не начисляет баллы доверия или влечения.
- Подпись отношения учитывает установленное родство независимо от баллов. Корректные подписи вроде «достойная дочь и мастер» больше не отбрасываются из-за отдельных слов профессии или роли.
- Если автоматическая подпись отсутствует или отклонена, карточка показывает «Статус не задан» и предлагает «Указать статус» вместо подстановки «Незнакомец». Отклонённый вариант модели доступен в редакторе.
- Статус можно задать или изменить вручную без изменения баллов. Ручная подпись имеет приоритет перед моделью, сохраняется в профиле и snapshot; кнопка «Автоматически» возвращает автоматический вариант.
- Добавлены регрессионные проверки нейтральных контактов, подписей, сохранения, отмены и защиты редактора при смене чата или персоны.

### Изоляция карточек персонажей — 10 октября 2026 (без изменения версии)

- При генерации описаний и портретов карточки подбираются только среди текущего бота или участников текущей группы. Посторонняя карточка с совпадающим именем больше не подмешивает биографию и внешность из другой истории или AU.
- При совпадении имён приоритет получает активный персонаж. Неоднозначное совпадение между участниками группы без активного совпадения не используется; остальные источники текущей сцены сохраняются.
- Ранее сохранённые описания и портреты автоматически не изменяются. Если в них уже попали чужие сведения, их нужно исправить или перегенерировать.

### Параметры портретов — 10 октября 2026 (без изменения версии)

- В подключение изображений перенесены режимы параметров из Comic Forge: OpenAI-compatible, GPT Image 1 / 1.5 / Mini, GPT Image 2, GPT Image 2.5 и Grok. Старые подключения и профили используют совместимый режим; установка Comic Forge не требуется.
- Добавлены разрешение, пропорции (по умолчанию 1:1), качество и необязательный точный размер GPT. `xhigh` / `max` доступны в режиме GPT Image 2.5; Grok предлагает 1K / 2K и собственный набор качества. Новые параметры сохраняются в профилях.
- GPT отправляет референсы файлами, Grok — JSON через `/images/edits`, с сохранением внешности/стиля и лимита четырёх изображений. Точная ошибка прокси `images[].image_url is required` допускает один повтор в формате `image_url` с теми же референсами; другие ошибки не вызывают этот повтор.
- Исправлена компоновка настроек: режим и точный размер занимают всю ширину, связанные поля выровнены парами, на узкой панели используется одна колонка. Длинная справка свёрнута отдельно.
- Добавлены проверки параметров, референсов, совместимости профилей и видимых ошибок. Доступность параметров зависит от прокси.

### Интеграция Interactive Map 2.0 — 4 октября 2026 (без изменения версии)

- Добавлен переключатель «Использовать контекст карты» для генерации вариантов VN-ответа. По умолчанию выключен.
- Контекст берётся из сохранённой карты активного чата при каждом запросе; без карты или при выключенной настройке генерация работает как обычно.

### Микрообновление — 30 сентября 2026 (без изменения версии)

- VNE не запускает автоматическое сохранение до загрузки сообщений и идентификатора целого чата. Это защищает существующий файл от перезаписи пустым состоянием при запуске.
- Крупные изображения персонажей хранятся один раз для истории ревизий. Старый формат уплотняется при следующем сохранении без удаления ревизий; откат ветки восстанавливает нужные изображения.

### Микрообновление — 29 сентября 2026 (без изменения версии)

- Язычок VNE вынесен из выезжающей панели для совместимости с мобильной Opera; его анимация синхронизирована с панелью.
- Вне чата панель и язычок скрыты. При входе язычок плавно появляется; при выходе открытая панель задвигается вместе с ним, затем язычок гаснет. Оставшиеся в контексте сообщения больше не удерживают панель открытой.
- Исправлено расширение страницы в мобильном Firefox: панель остаётся в пределах экрана, а её содержимое и язычок получают общую позицию на каждом кадре анимации. Язычок больше не зависит от обрезающего контейнера и ожидания стилей. Жест перетаскивания сохранён.

### Микрообновление — 28 сентября 2026 (без изменения версии)

- Новые ветки чата восстанавливают основу отношений на выбранном сообщении. Последующие импорты и правки родительского чата не попадают в более раннюю ветку.
- В разделе «Данные» появился единый редактор отношений: память и черты чата или импорта можно править и скрывать; лишних персонажей, записи журнала и моменты можно удалять из импортированной основы. Доступны поиск, предпросмотр и отмена.
- Изменения отношений из чата тоже доступны в редакторе: правка причины, эмоции и баллов или отключение события пересчитывает отношения, память и журнал для выбранного свайпа. Правки учитываются при создании веток.
- Вкладка «Персонажи» показывает персонажей текущего чата даже при нулевых баллах отношений.
- Для старых чатов без истории ревизий показано предупреждение, если точное состояние ветки не может быть подтверждено.

### 3.2.2 — 2026-09-23

- Добавлены перемещаемые язычки VNE и Scene Director: их можно двигать вверх и вниз, а выбранная позиция сохраняется.
- Панель можно открыть обычным кликом или постепенно вытянуть горизонтальным жестом; состояние перетаскивания корректно сбрасывается после закрытия.
- Исправлено позиционирование язычка Scene Director на узких мобильных экранах.

### 3.2.1 — 2026-09-21

- Исправлена потеря внешности в конце длинной персоны и лора при сборке портрета. Добавлены позиции лорбука на глубине чата, заметки автора, примеры и именованные вставки; в поиск передаётся имя персонажа.
- Ответ «внешности достаточно» больше не принимается без цитаты, найденной в источниках: при её отсутствии показывается предложение дополнить.

- Сборка промпта портрета учитывает описание персоны и контекст мира из активной карточки, не подставляя внешность другого персонажа.
- При недостатке сведений о внешности предлагается дополнить промпт с ИИ по контексту мира или вручную. Дополнение с ИИ запускается отдельно; ошибка или отмена сохраняет прежний текст.

### 3.2.0 — 2026-09-21

- Бюджет сборки промпта портрета увеличен с 900 до 8192 токенов. Текстовые ответы профилей Chat Completion проверяются на обрезание; при лимите прежний промпт сохраняется и показывается ошибка.

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


### 2026-07-23 — исправление снимков

- События после импорта, включая повторные генерации свайпов и ручные отладочные записи ниже границы импорта, учитываются с сохранением импортированной базы.
- Время отладочных записей в журнале соответствует времени события.

Источник: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). Отдельный номер релиза этому исправлению не присваивался.

### 3.1.0 — 2026-04-28

- Влияние событий на дружбу и романтику разделено на независимые шкалы.

Источник: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), включая версию в manifest. Более ранняя история здесь не реконструирована.

## English

### Unforgettable events and custom scales — November 2, 2026 (no version bump)

- Deep memories and unforgettable story moments now depend on `life_changing` / `unforgivable` categories rather than a fixed ±15 threshold. Extreme events at ±10 or any other nonzero score accumulate toward traits. Zero changes and disabled romance do not create memories.
- For same-sign changes on both scales, an unforgettable event is no longer hidden by an ordinary change with a larger score. Ordinary categories do not become deep merely because their configured score is large. Scores and the five-events-per-polarity trait requirement are unchanged.
- Recalculation corrects memories for previously saved native and recovered events with categories. Numeric events without categories retain the old thresholds; imported ready-made memories are unchanged.
- Updated both READMEs. Added checks for custom scales, both polarities, romance, aliases, recovery, repeated recalculation, five-event accumulation, and archiving after a trait record is saved.

### Relationship label direction during recovery — November 2, 2026 (no version bump)

- Recovery explicitly requests `user_label`: who the player is to the NPC. Added a sentence-direction check and asymmetric examples covering bodyguard/ward and daughter/parent. Unsupported relationships remain empty instead of describing the NPC's role.
- Labels from previous batches are excluded from subsequent requests to avoid reinforcing an inverted interpretation. Stored events remain compatible with the ordinary tracker; scores and existing records are not automatically changed. Previously incorrect labels can be corrected with Edit label.
- Added regression checks for the prompt, `user_label` precedence, empty labels, and legacy compatibility.

### Restore relationships from history — November 2, 2026 (no version bump)

- Added a manual recovery button under Relationships for ongoing games. Choose the last N messages, the entire chat, or a custom range with boundary excerpts. Request counts appear before starting and progress appears during analysis.
- History is analyzed in batches of roughly 18,000 characters. Review proposed characters, labels, and trust/attraction changes and uncheck unwanted suggestions. Saving enables tracking and uses VNE's normal recalculation without adding cumulative scores twice.
- Processed messages are recorded per persona and swipe, including empty results. Repeated and overlapping ranges are skipped. Turns with ordinary tracker events and messages before an imported baseline's cutoff are skipped entirely.
- Editing a source message or its immediately preceding message excludes outdated events from recalculation; a reviewed replacement analysis replaces them. Errors, cancellation, and context changes do not save partial results. A full relationship reset also clears the active persona's recovery markers.
- Updated both READMEs and interface translations. Added regression checks for repeats, overlaps, swipes, edits, persona isolation, response validation, safe previews, cancellation, and real recalculation. The user confirmed the feature works in their local Tavern.

### Portrait styles per profile — October 30, 2026 (no version change)

- Each image connection profile stores and restores its own style. Legacy profiles without a style load an empty value rather than another connection's style.
- The workshop style field is a temporary override until the window closes. Generation, applying an avatar, cancellation and errors do not persist it.
- **Save style to profile** changes only the style of the profile used when opening the workshop. Saving is unavailable without a profile, during requests, or after switching or deleting the profile; stale editors cannot save.
- Updated translations and the guide; added checks for independent styles, empty values, legacy profiles, temporary overrides and explicit saving.

### Tracker updates after a new reply — October 24, 2026 (no version change)

- Replaced the nonexistent `markdownToHtml` call used after cleaning a hidden block from a visible message with Tavern's native `updateMessageBlock`.
- This error no longer interrupts calculation before refreshing character cards and asking for a new character's initial relationship. Previously, data could update while the panel retained its old roster.
- Character cards and relationship values refresh after a reply without closing and reopening the panel. The reporter verified the fix in their local Tavern instance.
- Added visible and non-rendered message regression checks covering block removal, stored updates, HUD refresh and a single initial relationship prompt.

### Automatic GPT Image portrait dimensions — October 23, 2026 (no version change)

- Automatic GPT Image 2/2.5 dimensions now respect the maximum pixel count. Square and 3:4 portraits using 4K no longer fail local size validation; dimensions are reduced and rounded to multiples of 16.
- Explicit custom dimensions remain unchanged and are validated separately. Updated the READMEs and portrait guide, with regression checks for generation and reference-edit requests.

### Repeated persona and scene text processing — October 20, 2026 (no version change)

- User persona names are collected once within each synchronous calculation. Checking a large character roster no longer reparses the persona description for every name.
- Hidden-block removal and string normalization reuse results keyed by the complete input within the current operation. Looking for different character mentions no longer processes the same scene text repeatedly.
- Caches are released after each operation, including failures. Subsequent calculations see persona, text, swipe and chat changes; different strings of equal length are checked separately.
- Added regression checks for reuse, same-length edits, persona changes and cache release after failures.

### Fewer repeated calculations and hidden editors — October 20, 2026 (no version change)

- Similar-name pair comparisons repeat when the registry or merge suggestions change. Routine profile reads and avatar edits reuse the persona state's cache. Registry coverage checks names and aliases in one pass.
- Character editors are created on first opening instead of building every hidden editor on each render. Buttons, image uploads and cropping use panel event handlers; closing and reopening preserves drafts until the next HUD render.
- Response received, rendered and ended notifications are coalesced within 16 ms. Edits, deletions and swipes still recalculate immediately; chat or persona changes cancel stale work. Generation and direct social prompt reads, including Custom API, flush pending calculations synchronously.
- Relationship, memory and branch rules remain unchanged. Added checks for cache refresh, editors, event handling and prompt freshness.

### Store avatars outside chat metadata — October 20, 2026 (no version change)

- New avatars and source images are stored as files on the Tavern server; profiles and new branch states hold short paths. Editing a description without changing the image or crop reuses the saved avatar.
- Added a Data action to move embedded images in the current chat, including other personas and branch history. A full JSONL backup is downloaded first. References change together after byte-for-byte verification; errors, context changes and concurrent edits cancel the transfer.
- Snapshot export through settings still embeds images for moving between servers; import stores them as files before applying. The JSON limit is now 100 MiB to accept large snapshots with originals. Preserved v1 format and compatibility with embedded images.
- Relationship calculations and response processing are unchanged. Added checks for uploads, failure rollback, backups, card saving, branch history and portable snapshots.

### Persona check optimization — October 17, 2026 (no version change)

- Background checks reuse an existing persona binding without indexing the entire history. Fallback polling runs every 2.5 seconds; SillyTavern events are handled immediately.
- Repeated lookups within one synchronous calculation share a scope ownership index. The cache is released after the operation and invalidated when records change during calculation.
- Removed duplicate recalculations on application readiness and chat changes. Persona, swipe, branch and snapshot safeguards remain covered; relationship scores and rules are unchanged.

### Contact discovery and relationship labels — October 16, 2026 (no version change)

- Clarified model instructions: named characters are registered on direct interaction even without a relationship change, including people introduced earlier in the story. Neutral contacts do not award trust or attraction points.
- Relationship labels respect established family ties independently of scores. Valid labels such as “worthy daughter and master” are no longer rejected because they contain an occupation or role word.
- Missing or rejected automatic labels now show “Status not set” with a “Set status” action instead of falling back to “Stranger.” Rejected model suggestions are available in the editor.
- Labels can be set or edited manually without changing scores. Manual labels take priority over model output and persist in profiles and snapshots; “Automatic” restores the automatic label.
- Added regression coverage for neutral contacts, labels, persistence, cancellation and editor safeguards when switching chats or personas.

### Character card isolation — October 10, 2026 (no version change)

- Profile and portrait generation only matches cards belonging to the current character or current group members. Unrelated same-name cards can no longer inject biographies or appearance from another story or AU.
- The active character takes priority when names overlap. Ambiguous group matches without an active match are omitted while other current-scene sources remain available.
- Existing saved profiles and portraits are unchanged. Edit or regenerate them if unrelated details were already included.

### Portrait parameters — October 10, 2026 (no version change)

- Ported Comic Forge image parameter modes: OpenAI-compatible, GPT Image 1 / 1.5 / Mini, GPT Image 2, GPT Image 2.5 and Grok. Existing connections and profiles use compatible behavior; Comic Forge installation is not required.
- Added resolution, aspect ratio (square by default), quality and optional exact GPT dimensions. Only the GPT Image 2.5 mode offers `xhigh` / `max`; Grok offers 1K / 2K and its own quality choices. Profiles retain the new parameters.
- GPT sends references as files, Grok as JSON `/images/edits`, preserving appearance/style instructions and the four-image limit. Only the explicit `images[].image_url is required` proxy rejection allows one `image_url` retry with the original references.
- Improved settings layout: full-width mode and exact size, aligned parameter pairs, one column on narrow panels and separately collapsible help.
- Added coverage for parameters, references, profile compatibility and visible errors. Actual parameter availability depends on the proxy.

### Interactive Map 2.0 integration — October 4, 2026 (no version change)

- Added an optional “Use map context” switch for VN response-option generation. Off by default.
- Each request resolves the active chat’s saved map; without a map or with the setting disabled, generation works normally.

### Minor update — September 30, 2026 (no version change)

- VNE no longer schedules an automatic save before chat messages and integrity metadata have loaded, protecting an existing file from an empty startup save.
- Large character portraits are stored once across revision history. Legacy history is compacted on the next save without dropping revisions, and branch restoration resolves the selected portraits.

### Minor update — September 29, 2026 (no version change)

- The VNE tab sits outside the sliding panel for mobile Opera compatibility, with its animation synchronized to the panel.
- The panel and tab stay hidden outside chats. The tab fades in on entry; on exit, an open panel slides closed with the tab before it fades out. Retained messages no longer keep the panel open after leaving a chat.
- Fixed page width expanding in mobile Firefox. The panel content and tab now receive the same position on each animation frame. The tab no longer depends on a clipping container or stylesheet wait; drag gestures remain available.

### Minor update — September 28, 2026 (no version change)

- New chat branches restore the relationship baseline at the selected message. Later imports and edits in the parent do not carry into an earlier branch.
- Data now has one relationship editor: edit or hide chat and imported memories and traits, or remove unwanted characters, journal entries, and moments from the imported baseline. Search, preview, and undo are available.
- Chat relationship changes can also be edited: changing the reason, emotion, or scores, or disabling an event, recalculates relationships, memories, and the journal for the selected swipe. Branches retain edits at their selected message.
- The Characters filter includes current chat characters even when their relationship scores are zero.
- Older chats without revision history show a warning when the exact branch state cannot be verified.

### 3.2.2 — 2026-09-23

- Added movable VNE and Scene Director tabs with saved vertical positions.
- The drawer can be opened with a normal click or progressively pulled out with a horizontal drag; drag state is reset reliably after closing.
- Fixed Scene Director tab positioning on narrow mobile screens.

### 3.2.1 — 2026-09-21

- Fixed lost appearance details at the end of long personas and lore when building portraits. Included depth, author-note, example and outlet lore entries, and the target name in lore scanning.
- A sufficient-appearance assessment now requires a quote found in the supplied sources; missing or fabricated quotes trigger the completion offer.

- Portrait prompt building now includes persona descriptions and world context from the active card, with instructions against borrowing another character’s appearance.
- Insufficient appearance details offer opt-in AI completion using the world context or manual editing. AI completion is a separate request; errors and cancellation preserve the existing draft.

### 3.2.0 — 2026-09-21

- Increased the portrait prompt budget from 900 to 8192 tokens. Chat Completion profile text responses are checked for truncation; a limit error preserves the previous prompt instead of accepting partial text.

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


### 2026-07-23 — snapshot fix

- Events after import, including regenerated swipes and manual debug entries below the import cutoff, are replayed while retaining the imported baseline.
- Debug entries in the log use the actual event time.

Source: [d1cda86](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/d1cda86). No separate release number was assigned to this fix.

### 3.1.0 — 2026-04-28

- Split event impact on friendship and romance into independent scales.

Source: [78557dc](https://github.com/maxkara14/BB-Visual-Novel-Engine/commit/78557dc), including its manifest version. Earlier release history has not been reconstructed here.
