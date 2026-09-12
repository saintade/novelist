update public.book_translation_settings
set reference_mode = 'continuation', revision = revision + 1
where reference_mode = 'same_novel';